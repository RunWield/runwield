/**
 * @module shared/workflow/validation-session-adapter
 * The only session/Pi-coupled module in the session-independent validation engine.
 *
 * Implements {@link ValidationSessionPort} over the real HostedSession machinery:
 * workflow state, phase position, progress panel, interactions, escape-cancel
 * registration, completion-gated repair turns, isolated Agent sessions, display
 * names, and post-verification handoffs. The engine never imports Pi/session
 * modules; everything it needs arrives through the port this module builds.
 *
 * The opaque handle casts happen here and only here: `SessionManagerHandle` and
 * `OpaqueToolDefinition` are phantom-branded, and the Pi `SessionManager` /
 * `ToolDefinition` values are cast to them exactly once per boundary crossing.
 * Accepted tools carry workflow outcomes. Provider failure metadata is handled
 * separately and can never count as review feedback or repair completion.
 */

import { SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { HostedSession } from "../session/hosted-session.js";
import { runIsolatedAgentSession } from "../session/session.js";
import { emitAssistantMessage, type RuntimeValidationProgress } from "../session/session-runtime-events.js";
import { requestHostedSessionInteraction } from "../session/session-runtime-interactions.js";
import { getAgentDisplayName as getSessionAgentDisplayName } from "../session/agents.js";
import { ClaudeCliBackendError } from "../session/backends/claude-cli/failure.ts";
import { INTEGRATION_REVIEWER_SUBAGENT_TOOLS, REVIEWER_SUBAGENT_TOOLS } from "../session/subagent-definitions.ts";
import { AGENTS, SUBAGENTS } from "../../constants.js";
import {
    emitRunWieldSystemStatus,
    getCurrentValidationProgress,
    setCurrentValidationProgress,
} from "./validation-progress.ts";
import { clearValidationPosition, rememberValidationPosition } from "./validation-position.ts";
import { runFeaturePostVerificationHandoffs } from "./validation-helpers.ts";
import { runValidationAgentUntilEvent } from "../session/agent-workflow-step.ts";
import { logValidationFailure } from "./validation-state-errors.ts";
import { loadPlan, updatePlanFrontMatter } from "../../plan-store.js";
import { makeValidationCheckpoint } from "./validation-checkpoint.ts";
import { renderOpenItems } from "./review-ledger.ts";
import { recordValidationRepairCompletion } from "./validation-supervisor.ts";
import { createReviewDiffTool } from "./review-diff-tool.js";
import { createReviewCompletedTool } from "../../tools/review-complete.ts";
import { createQaChecklistGeneratedTool } from "../../tools/qa-checklist-generated.ts";
import { settleWorkflowToolEvent } from "./workflow-tool-events.ts";
import { switchActiveAgent } from "../session/agent-switching.js";
import type {
    AgentTurnOutcome,
    IndependentRepairTurnRequest,
    IsolatedAgentSessionOutcome,
    IsolatedAgentSessionRequest,
    OpaqueToolDefinition,
    SessionManagerHandle,
    ValidationSessionPort,
} from "./validation-ports.ts";
import {
    classifyValidationOperationalError,
    type ProviderErrorKind,
    type ValidationOperation,
    type ValidationOperationalFailure,
} from "./validation-operational-errors.ts";

/**
 * The options shape the pre-existing isolated-session boundary takes.
 *
 * Kept structurally identical to the shape `runIsolatedAgentSession` in
 * `session.js` consumes, so injected `semanticReviewPort` fixtures and the system
 * implementation both see exactly what they saw before the split.
 */
export type IsolatedAgentSessionOptions = {
    signal?: AbortSignal;
    hostedSession: HostedSession;
    agentName: string;
    userRequest: string;
    images?: Array<{ base64: string; mimeType: string }>;
    cwd: string;
    subAgentDefinition?: {
        id: import("../session/subagent-definitions.ts").SubAgentDefinitionId;
        options?: import("../session/subagent-definitions.ts").LoadSubAgentDefinitionOptions;
    };
    toolNames?: string[];
    customTools?: ToolDefinition[];
    includeEditFallback?: boolean;
    sessionManager?: SessionManager;
    dispatchKind?: import("../session/request-dispatch.ts").RequestDispatchKind;
};

export type SemanticReviewPort = {
    runIsolatedAgentSession: (options: IsolatedAgentSessionOptions) => Promise<AgentMessage[]>;
};

export const SYSTEM_SEMANTIC_REVIEW_PORT: SemanticReviewPort = Object.freeze({
    runIsolatedAgentSession,
});

const pendingRepairManagers = new WeakMap<HostedSession, Map<string, SessionManager>>();
type RepairSession = { manager: SessionManager; cwd: string; agentName: string; planName?: string };
const lastRepairSessions = new WeakMap<HostedSession, RepairSession>();

function getPendingRepairManager(hostedSession: HostedSession, cwd: string, userRequest: string): SessionManager {
    let managers = pendingRepairManagers.get(hostedSession);
    if (!managers) {
        managers = new Map();
        pendingRepairManagers.set(hostedSession, managers);
    }
    const key = `${cwd}\u0000${userRequest}`;
    let manager = managers.get(key);
    if (!manager) {
        manager = SessionManager.inMemory(cwd);
        managers.set(key, manager);
    }
    return manager;
}

function clearPendingRepairManager(hostedSession: HostedSession, cwd: string, userRequest: string): void {
    pendingRepairManagers.get(hostedSession)?.delete(`${cwd}\u0000${userRequest}`);
}

type ProviderFailureIdentity = {
    kind: ProviderErrorKind;
    code?: string;
};

function providerFailureIdentity(error: Error): ProviderFailureIdentity {
    if (error instanceof ClaudeCliBackendError) {
        switch (error.kind) {
            case "auth_failed":
                return { kind: "authentication", code: error.kind };
            case "bridge_disconnected":
                return { kind: "network", code: error.kind };
            case "bridge_startup_failed":
                return { kind: "service_unavailable", code: error.kind };
            case "missing_executable":
            case "non_zero_exit":
            case "malformed_stream":
            case "canceled":
                return { kind: "legacy_text", code: error.kind };
        }
    }

    switch (error.name) {
        case "RateLimitError":
            return { kind: "rate_limited", code: error.name };
        case "APIConnectionTimeoutError":
        case "TimeoutError":
            return { kind: "timeout", code: error.name };
        case "APIConnectionError":
        case "NetworkError":
            return { kind: "network", code: error.name };
        case "InternalServerError":
        case "ServiceUnavailableError":
            return { kind: "service_unavailable", code: error.name };
        case "AuthenticationError":
            return { kind: "authentication", code: error.name };
        case "PermissionDeniedError":
            return { kind: "permission_denied", code: error.name };
        default:
            return { kind: "legacy_text" };
    }
}

function classifyProviderFailure(
    operation: ValidationOperation,
    message: string,
    identity: ProviderFailureIdentity,
): ValidationOperationalFailure {
    return classifyValidationOperationalError({
        source: "provider",
        kind: identity.kind,
        operation,
        message,
        code: identity.code,
    });
}

function classifyIsolatedAgentExecutionFailure(
    request: IsolatedAgentSessionRequest,
    error: Error,
): Extract<IsolatedAgentSessionOutcome, { outcome: "operational_failure" }> {
    const operation: ValidationOperation = request.kind === "reviewer" ? "semantic_review" : "agent_session";
    const identity = providerFailureIdentity(error);
    return {
        kind: request.kind,
        outcome: "operational_failure",
        failure: classifyProviderFailure(
            operation,
            "The model provider could not complete this operation.",
            identity,
        ),
    };
}

function readReviewerProviderFailure(messages: AgentMessage[]): ValidationOperationalFailure | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role !== "assistant") continue;
        if (message.stopReason !== "error") return undefined;
        return classifyProviderFailure(
            "semantic_review",
            "The model provider could not complete AI review.",
            { kind: "service_unavailable", code: "provider/turn_failed" },
        );
    }
    return undefined;
}

type ReviewDiffToolOptions = Parameters<typeof createReviewDiffTool>[1];
type ReviewDiffToolWithOptions = ToolDefinition & {
    __runwieldReviewDiffs?: Parameters<typeof createReviewDiffTool>[0];
    __runwieldReviewOptions?: ReviewDiffToolOptions;
};
type QaChecklistToolOptions = Parameters<typeof createQaChecklistGeneratedTool>[0];
type QaChecklistToolWithOptions = ToolDefinition & { __runwieldQaChecklistOptions?: QaChecklistToolOptions };

function bindReviewDiffTools(hostedSession: HostedSession, customTools: OpaqueToolDefinition[]): ToolDefinition[] {
    return (customTools as unknown as ToolDefinition[]).flatMap((tool) => {
        const tagged = tool as ReviewDiffToolWithOptions;
        if (tagged.name !== "review_diff" || tagged.__runwieldReviewDiffs === undefined) return tool;
        const options: ReviewDiffToolOptions = { ...tagged.__runwieldReviewOptions, hostedSession };
        return [
            createReviewDiffTool(tagged.__runwieldReviewDiffs, options),
            createReviewCompletedTool({
                hostedSession,
                inspection: options.inspection,
                ledger: options.ledger,
            }),
        ];
    });
}

function bindQaChecklistTools(hostedSession: HostedSession, customTools: OpaqueToolDefinition[]): ToolDefinition[] {
    return (customTools as unknown as ToolDefinition[]).map((tool) => {
        const tagged = tool as QaChecklistToolWithOptions;
        if (tagged.name !== "qa_checklist_generated" || !tagged.__runwieldQaChecklistOptions) return tool;
        return createQaChecklistGeneratedTool({ ...tagged.__runwieldQaChecklistOptions, hostedSession });
    });
}

/**
 * Build the engine's session port over a real HostedSession.
 *
 * `semanticReviewPort` is an optional external Agent-session boundary used by
 * tests. Production uses the system implementation. Every repair session owns an
 * in-memory manager so it cannot inherit or extend the root execution transcript.
 */
/**
 * Run an isolated Agent until its accepted completion tool supplies a typed
 * outcome. Non-generic internally so the request discriminant
 * narrows naturally; the generic port method wraps it with a single boundary cast.
 */
async function runIsolatedRequest(
    hostedSession: HostedSession,
    isolatedSessions: SemanticReviewPort,
    request: IsolatedAgentSessionRequest,
): Promise<IsolatedAgentSessionOutcome> {
    if (request.kind === "reviewer") {
        const result = await runValidationAgentUntilEvent(isolatedSessions, {
            hostedSession,
            agentName: request.agentName,
            userRequest: request.userRequest,
            cwd: request.cwd,
            // The Epic integration gate runs its own reviewer, with its own prompt and tool ceiling.
            subAgentDefinition: request.reviewerMode === "integration"
                ? { id: SUBAGENTS.INTEGRATION_REVIEWER }
                : { id: SUBAGENTS.REVIEWER, options: { reviewerMode: request.reviewerMode } },
            toolNames: request.reviewerMode === "integration"
                ? [...INTEGRATION_REVIEWER_SUBAGENT_TOOLS]
                : [...REVIEWER_SUBAGENT_TOOLS],
            customTools: bindReviewDiffTools(hostedSession, request.customTools),
            includeEditFallback: false,
            sessionManager: request.sessionManager as unknown as SessionManager || SessionManager.inMemory(request.cwd),
        }, "review_complete");
        const { event: reviewEvent, diffEvent, messages } = result;
        const reviewOutcome = reviewEvent?.kind === "review_complete"
            ? reviewEvent.payload as import("./workflow-tool-events.ts").ReviewCompleteEventPayload
            : null;
        const providerFailure = reviewOutcome ? undefined : readReviewerProviderFailure(messages);
        if (providerFailure) {
            if (diffEvent) settleWorkflowToolEvent(hostedSession, diffEvent);
            return {
                kind: "reviewer",
                outcome: "operational_failure",
                failure: providerFailure,
            };
        }
        if (reviewEvent) settleWorkflowToolEvent(hostedSession, reviewEvent);
        if (diffEvent) settleWorkflowToolEvent(hostedSession, diffEvent);
        return {
            kind: "reviewer",
            outcome: "completed",
            reviewOutcome,
            usedDiffTool: Boolean(diffEvent),
            trustedOpaqueMcpReview: Boolean(
                reviewEvent?.owningSession && "kind" in reviewEvent.owningSession &&
                    (reviewEvent.owningSession.kind === "claude-cli" || reviewEvent.owningSession.kind === "agy-cli"),
            ),
        };
    }
    if (request.kind === "manual_qa") {
        const manualQaManager = request.sessionManager
            ? request.sessionManager as unknown as SessionManager
            : SessionManager.inMemory(request.cwd);
        const { event: qaEvent } = await runValidationAgentUntilEvent(isolatedSessions, {
            hostedSession,
            agentName: request.agentName,
            userRequest: request.userRequest,
            cwd: request.cwd,
            subAgentDefinition: { id: SUBAGENTS.MANUAL_QA },
            customTools: bindQaChecklistTools(hostedSession, request.customTools),
            includeEditFallback: false,
            sessionManager: manualQaManager,
        }, "qa_checklist_generated");
        if (qaEvent?.kind !== "qa_checklist_generated") {
            return {
                kind: "manual_qa",
                outcome: "missing_tool_call",
                warning: "Manual QA Agent did not call qa_checklist_generated.",
            };
        }
        settleWorkflowToolEvent(hostedSession, qaEvent);
        const payload = qaEvent.payload as import("./workflow-tool-events.ts").QaChecklistGeneratedEventPayload;
        return {
            kind: "manual_qa",
            outcome: payload.outcome,
            relativePath: payload.artifactPath,
        };
    }
    const repairManager = request.sessionManager
        ? request.sessionManager as unknown as SessionManager
        : getPendingRepairManager(hostedSession, request.cwd, request.userRequest);
    await prepareRepairInvocation(hostedSession, request.cwd);
    // An automatic repair is fresh non-generated work, not a continuation of the completed task.
    hostedSession.backgroundTasks.resumeDelivery();
    const { event } = await runValidationAgentUntilEvent(isolatedSessions, {
        hostedSession,
        agentName: request.agentName,
        userRequest: request.userRequest,
        dispatchKind: "validation_repair",
        ...(request.images ? { images: request.images } : {}),
        cwd: request.cwd,
        subAgentDefinition: { id: SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER },
        customTools: bindReviewDiffTools(hostedSession, request.customTools),
        sessionManager: repairManager,
    }, "task_completed");
    const report = await acceptedRepairOutcome(hostedSession, event);
    lastRepairSessions.set(hostedSession, {
        manager: repairManager,
        cwd: request.cwd,
        agentName: request.agentName,
        planName: hostedSession.getActiveExecutionWorkflow()?.planName,
    });
    if (!request.sessionManager && report.completed) {
        clearPendingRepairManager(hostedSession, request.cwd, request.userRequest);
    }
    return {
        kind: "feedback_engineer",
        outcome: "completed",
        taskReport: report,
    };
}

/** Returned messages are presentation only; only an accepted tool can complete repair. */
async function acceptedRepairOutcome(
    hostedSession: HostedSession,
    event: import("./workflow-tool-events.ts").WorkflowToolEvent | null,
    kind: IndependentRepairTurnRequest["kind"] = "validation",
): Promise<AgentTurnOutcome> {
    if (event?.kind !== "task_completed") {
        return {
            completed: false,
            report: "",
            blockerText: "The Engineer has not reported completion. Continue the repair to finish it.",
        };
    }
    const payload = event.payload as import("./workflow-tool-events.ts").TaskCompletedEventPayload;
    const workflow = event.workflow;
    if (kind === "validation" && workflow?.validationRepairGeneration && workflow.executionCwd) {
        await recordValidationRepairCompletion({
            projectRoot: workflow.executionCwd,
            planName: workflow.planName,
            repairGeneration: workflow.validationRepairGeneration,
            report: payload.message,
        });
    }
    settleWorkflowToolEvent(hostedSession, event);
    return { completed: true, report: payload.message };
}

/** Bind every repair invocation to current durable state, never a cached prior repair. */
async function prepareRepairInvocation(hostedSession: HostedSession, cwd: string): Promise<void> {
    const workflow = hostedSession.getActiveExecutionWorkflow();
    if (!workflow?.planName) return;
    const plan = await loadPlan(cwd, workflow.planName);
    if (!plan) return;
    const prior = plan.attrs.validationCheckpoint;
    const repairGeneration = prior?.state === "awaiting_repair" && !prior.repairCompletedOperationId
        ? prior.repairGeneration || crypto.randomUUID()
        : crypto.randomUUID();
    const reviewState = prior?.reviewState || (workflow.reviewLedger && workflow.repairBaselineTree
        ? {
            semanticRound: workflow.semanticRound || 0,
            reviewLedger: workflow.reviewLedger,
            repairBaselineTree: workflow.repairBaselineTree,
            lastRepairReport: workflow.lastRepairReport,
        }
        : undefined);
    const checkpoint = makeValidationCheckpoint({
        attemptId: workflow.worktreeId || "in-place",
        generation: prior?.generation || workflow.validationGeneration || crypto.randomUUID(),
        status: plan.attrs.status,
        phase: "mechanical",
        state: "awaiting_repair",
        repairKind: reviewState ? "semantic" : "ci",
        repairGeneration,
        reviewState,
        lastSettledOperationId: prior?.lastSettledOperationId,
    });
    await updatePlanFrontMatter(cwd, workflow.planName, { validationCheckpoint: checkpoint }, plan.attrs, {
        expectedRevision: plan.revision,
        expectedControllerRevision: plan.controllerRevision,
    });
    hostedSession.setActiveExecutionWorkflow({ ...workflow, validationRepairGeneration: repairGeneration });
}

export function createValidationSessionPort(
    hostedSession: HostedSession,
    {
        semanticReviewPort,
    }: {
        semanticReviewPort?: SemanticReviewPort;
    } = {},
): ValidationSessionPort {
    const isolatedSessions = semanticReviewPort || SYSTEM_SEMANTIC_REVIEW_PORT;
    return {
        cwd: hostedSession.cwd,
        getActiveWorkflow: () => hostedSession.getActiveExecutionWorkflow?.() || null,
        setActiveWorkflow: (workflow) => hostedSession.setActiveExecutionWorkflow?.(workflow),
        rememberPosition: (planName, position) => rememberValidationPosition(hostedSession, planName, position),
        clearPosition: (planName) => clearValidationPosition(hostedSession, planName),
        getCurrentProgress: () => getCurrentValidationProgress(hostedSession),
        setCurrentProgress: (progress) => setCurrentValidationProgress(hostedSession, progress),
        emitStatus: (message, level, progress) => {
            const capability = hostedSession.getManagedOperationCapability?.();
            if (progress?.deliveryReport && capability) {
                progress = {
                    ...progress,
                    deliveryReport: {
                        ...progress.deliveryReport,
                        artifacts: progress.deliveryReport.artifacts.map((artifact) => {
                            if (
                                artifact.artifactId || artifact.path.startsWith("../") || artifact.path.startsWith("/")
                            ) return artifact;
                            const reference = capability.registerArtifact({
                                kind: artifact.kind,
                                path: artifact.path,
                                title: artifact.title,
                                registeredBy: "delivery-report",
                            });
                            return { ...artifact, artifactId: reference.artifactId };
                        }),
                    },
                };
            }
            emitRunWieldSystemStatus(
                hostedSession,
                message,
                level,
                progress as RuntimeValidationProgress | undefined,
            );
        },
        emitAssistantMessage: (agentName, text, options) => {
            emitAssistantMessage(hostedSession, agentName, text, options);
        },
        requestInteraction: (request) =>
            requestHostedSessionInteraction(
                hostedSession,
                request,
                undefined,
                hostedSession.getManagedOperationCapability?.() || null,
            ),
        registerActiveInteraction: (id, abortController) => hostedSession.addActiveInteraction(id, { abortController }),
        unregisterActiveInteraction: (id) => hostedSession.removeActiveInteraction(id),
        runIndependentRepairTurn: async ({ kind, userRequest, cwd }) => {
            const agentName = SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER;
            const repairManager = getPendingRepairManager(hostedSession, cwd, userRequest);
            if (kind === "validation") {
                await prepareRepairInvocation(hostedSession, cwd);
            } else {
                // Publication owns its saved attempt and Git checkout. It must not
                // manufacture a CI/review checkpoint in that independent clone.
                const workflow = hostedSession.getActiveExecutionWorkflow();
                if (workflow) {
                    hostedSession.setActiveExecutionWorkflow({ ...workflow, validationRepairGeneration: undefined });
                }
            }
            hostedSession.backgroundTasks.resumeDelivery();
            const { event } = await runValidationAgentUntilEvent(isolatedSessions, {
                hostedSession,
                agentName,
                userRequest,
                cwd,
                dispatchKind: "validation_repair",
                subAgentDefinition: { id: SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER },
                sessionManager: repairManager,
            }, "task_completed");
            const completion = await acceptedRepairOutcome(hostedSession, event, kind);
            if (kind === "validation") {
                lastRepairSessions.set(hostedSession, {
                    manager: repairManager,
                    cwd,
                    agentName,
                    planName: hostedSession.getActiveExecutionWorkflow()?.planName,
                });
            }
            if (completion.completed) clearPendingRepairManager(hostedSession, cwd, userRequest);
            return completion;
        },
        continueLastRepairTurn: async (userRequest) => {
            let repair = lastRepairSessions.get(hostedSession);
            const workflow = hostedSession.getActiveExecutionWorkflow();
            if (repair && repair.planName !== workflow?.planName) repair = undefined;
            let prompt = userRequest;
            if (!repair) {
                const cwd = workflow?.executionCwd || hostedSession.cwd;
                const plan = workflow?.planName ? await loadPlan(cwd, workflow.planName) : null;
                const review = plan?.attrs.validationCheckpoint?.reviewState;
                prompt = [
                    "Continue the interrupted validation repair in this checkout. Inspect the current files before editing.",
                    plan?.markdown || "",
                    review ? renderOpenItems(review.reviewLedger) : "",
                    review?.lastRepairReport || workflow?.lastRepairReport || "",
                    String(plan?.attrs.failureReason || ""),
                    "User follow-up:",
                    userRequest,
                    "After completing the repair, call task_completed. RunWield will rerun CI.",
                ].filter(Boolean).join("\n\n");
                repair = {
                    manager: SessionManager.inMemory(cwd),
                    cwd,
                    agentName: SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER,
                    planName: workflow?.planName,
                };
                lastRepairSessions.set(hostedSession, repair);
            }
            await prepareRepairInvocation(hostedSession, repair.cwd);
            hostedSession.backgroundTasks.resumeDelivery();
            const { event } = await runValidationAgentUntilEvent(isolatedSessions, {
                hostedSession,
                agentName: repair.agentName,
                userRequest: prompt,
                cwd: repair.cwd,
                dispatchKind: "validation_repair",
                subAgentDefinition: { id: SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER },
                sessionManager: repair.manager,
            }, "task_completed");
            return acceptedRepairOutcome(hostedSession, event);
        },
        createInMemorySessionManager: (cwd) => SessionManager.inMemory(cwd) as unknown as SessionManagerHandle,
        runIsolatedAgentSession: async <K extends IsolatedAgentSessionRequest["kind"]>(
            request: Extract<IsolatedAgentSessionRequest, { kind: K }>,
        ): Promise<Extract<IsolatedAgentSessionOutcome, { kind: K }>> => {
            try {
                const outcome = await runIsolatedRequest(hostedSession, isolatedSessions, request);
                return outcome as Extract<IsolatedAgentSessionOutcome, { kind: K }>;
            } catch (error) {
                const failureError = error instanceof Error ? error : new Error(String(error));
                await logValidationFailure(failureError, `validation_${request.kind}`);
                const outcome = classifyIsolatedAgentExecutionFailure(request, failureError);
                return outcome as Extract<IsolatedAgentSessionOutcome, { kind: K }>;
            }
        },
        getAgentDisplayName: (agentName, projectRoot) => getSessionAgentDisplayName(agentName, projectRoot),
        handoffVerifiedPublication: async (projectRoot) => {
            if (!hostedSession.getRootAgentSession?.()) return;
            await switchActiveAgent(hostedSession, {
                agentName: AGENTS.ENGINEER,
                cwd: projectRoot,
                forceRebuild: true,
            });
        },
        runPostVerificationHandoffs: async (
            { planName, planContent, projectRoot, mnemotecaPort, pendingPublication },
        ) => {
            await runFeaturePostVerificationHandoffs({
                hostedSession,
                planName,
                planContent,
                projectRoot,
                mnemotecaPort,
                pendingPublication,
            });
        },
    };
}
