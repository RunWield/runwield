/**
 * @module shared/workflow/orchestrator
 * Workflow Orchestrator for Triage outcomes.
 *
 * When any active Agent calls `triage_report`, the tool terminates that Agent's
 * turn and returns a Triage Report. The active Agent handler consumes the tool
 * outcome and dispatches the next Agent:
 *
 * INQUIRY   → Guide
 * IDEATION  → Ideator
 * OPERATION → Operator
 * QUICK_FIX → Engineer → on `task_completed`, runs no-plan Mechanical Validation
 * PLANNED_CHANGE → Planner  → on `approved_execute`, runs `executePlan`
 * PROJECT        → Architect → on `approved_decompose`, starts Slicer decomposition
 *
 * After dispatch, the specialist remains the active root agent so follow-up
 * messages can continue the same topic with useful context. Users can start a
 * fresh routed thread with /new, or explicitly return to routing with
 * /agent router.
 *
 * Plan-feedback loops stay inside the planning session because plan_written
 * returns `feedback` non-terminating — the planner sees the tool result and
 * iterates without rebuilding LLM context.
 */

import { AGENTS, isPlannedChangeClassification } from "../../constants.js";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ensurePlansDir, loadPlan } from "../../plan-store.js";
import { probeGitRepository } from "../git.ts";
import { hasNonGitExecutionConsent, rememberNonGitExecutionConsent } from "../non-git-execution-consent.ts";
import { switchActiveAgent } from "../session/agent-switching.js";
import { runRootTurn } from "../session/session.js";
import { getAgentDisplayName } from "../session/agents.js";
import { sanitizeSessionName } from "../session-name.ts";
import { normalizeTriageOutcome, type TriageOutcome, type TriageOutcomeInput } from "./triage-outcome.ts";
import {
    emitHostedSessionRuntimeEvent,
    emitSystemStatus,
    RuntimeEventTypes,
} from "../session/session-runtime-events.js";
import { requestHostedSessionInteraction, RuntimeInteractionTypes } from "../session/session-runtime-interactions.js";
import { decidePostExecution, decidePostPlanning, summarizeWorkflowDecision } from "./decisions.ts";
import { recordWorkflowMetric } from "./metrics.js";
import { buildAgentHandoffRequest } from "./workflow-prompts.ts";
import {
    executePlan,
    extractAssistantOutput,
    resolveExecutionOwner,
    runPlanningAgent,
    runSlicerAgent,
} from "./workflow.js";
import { runMechanicalValidation, shouldRunWorkflowValidation, SYSTEM_SEMANTIC_REVIEW_PORT } from "./validation.ts";
import { runWorkflowValidationToStableBoundary } from "./validation-supervisor.ts";
import type { LocalCIPort } from "./validation-local-ci.ts";
import { createGitPort } from "../git-port.ts";
import { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } from "../work-records/mnemoteca-port.ts";
import { acknowledgeTaskCompletion, claimPendingTaskCompletion } from "../session/task-completion-session.ts";
import { waitForWorkflowToolEvent, WorkflowStepCompleted } from "./workflow-tool-events.ts";

export { runLocalCI, runMechanicalValidation } from "./validation.ts";

interface TriageToolResultMessage {
    role: "toolResult";
    toolName: string;
    details?: TriageOutcomeInput;
}

interface RootAgentSessionState {
    agent?: { state?: { messages?: AgentMessage[] } };
}

export interface DispatchPostTriageArgs {
    hostedSession: import("../session/hosted-session.js").HostedSession;
    triage: TriageOutcomeInput;
    userRequest: string;
    images?: import("../session/types.js").ImageAttachment[];
    sessionManager?: SessionManager;
    localCI: LocalCIPort;
    signal?: AbortSignal;
}

/**
 * @param {string} decoratedRequest
 * @param {import('@earendil-works/pi-agent-core').AgentMessage[]} [messages]
 * @returns {string}
 */
function buildQuickFixManualQaContext(decoratedRequest: string, messages?: AgentMessage[]): string {
    const manualQaSummary = messages ? extractAssistantOutput(messages) : null;
    return [
        decoratedRequest,
        manualQaSummary ? `## Implementation Summary\n${manualQaSummary}` : "",
    ].filter(Boolean).join("\n\n");
}

/**
 * @param {TriageOutcome} triage
 * @param {string} projectRoot
 * @param {string} manualQaName
 * @param {string} manualQaContext
 * @returns {import('../session/hosted-session.js').ActiveExecutionWorkflow}
 */
function createQuickFixWorkflow(
    triage: TriageOutcome,
    projectRoot: string,
    manualQaName: string,
    manualQaContext: string,
): import("../session/hosted-session.js").ActiveExecutionWorkflow {
    return {
        planName: "quick-fix",
        triageMeta: { ...triage, classification: "QUICK_FIX" },
        executionAgent: "engineer",
        executionStarted: true,
        executionAttemptStartedAtMs: Date.now(),
        projectRoot,
        executionCwd: projectRoot,
        manualQaName,
        manualQaContext,
    };
}

function refreshedQuickFixWorkflow(
    workflow: import("../session/hosted-session.js").ActiveExecutionWorkflow,
): import("../session/hosted-session.js").ActiveExecutionWorkflow {
    return {
        ...workflow,
        executionStarted: true,
        executionAttemptStartedAtMs: Date.now(),
    };
}

async function runRootTurnUntilTaskCompletion(args: {
    hostedSession: import("../session/hosted-session.js").HostedSession;
    agentName: string;
    userRequest: string;
    images?: import("../session/types.js").ImageAttachment[];
    dispatchKind?: import("../session/request-dispatch.ts").RequestDispatchKind;
    signal?: AbortSignal;
}): Promise<AgentMessage[]> {
    const waitController = new AbortController();
    const turnController = new AbortController();
    const abortBoth = () => {
        const reason = args.signal?.reason || new DOMException("Workflow turn canceled.", "AbortError");
        waitController.abort(reason);
        turnController.abort(reason);
    };
    if (args.signal?.aborted) abortBoth();
    args.signal?.addEventListener("abort", abortBoth, { once: true });
    const turnId = args.hostedSession.getActiveTurnId?.() || undefined;
    const eventPromise = waitForWorkflowToolEvent(args.hostedSession, {
        kinds: ["task_completed"],
        owningSession: args.hostedSession.getRootAgentSession() || null,
        ...(turnId ? { turnId } : {}),
        signal: waitController.signal,
    });
    const turnPromise = runRootTurn({
        hostedSession: args.hostedSession,
        agentName: args.agentName,
        userRequest: args.userRequest,
        images: args.images,
        dispatchKind: args.dispatchKind,
        signal: turnController.signal,
    });
    try {
        const first = await Promise.race([
            eventPromise.then(() => ({ kind: "event" as const })),
            turnPromise.then((messages) => ({ kind: "turn" as const, messages })),
        ]);
        if (first.kind === "event") {
            // Completion stops provider work, but the turn still has metrics and
            // request-attempt writes to finish before the Session can checkpoint.
            turnController.abort(new WorkflowStepCompleted());
            await turnPromise.catch(() => undefined);
            return [];
        }
        waitController.abort(new DOMException("Agent turn finished without workflow event.", "AbortError"));
        return first.messages;
    } finally {
        waitController.abort();
        await eventPromise.catch(() => undefined);
        args.signal?.removeEventListener("abort", abortBoth);
    }
}

/**
 * @param {import('../session/hosted-session.js').HostedSession} hostedSession
 * @param {string} projectRoot
 * @returns {Promise<boolean>}
 */
async function confirmNonGitQuickFixExecution(
    hostedSession: import("../session/hosted-session.js").HostedSession,
    projectRoot: string,
): Promise<boolean> {
    const response = await requestHostedSessionInteraction(
        hostedSession,
        {
            type: RuntimeInteractionTypes.SELECT,
            prompt:
                "Git is not available for this project. RunWield recommends using Git before QUICK_FIX edits so changes can be reviewed and recovered with normal Git tools. Proceeding will modify the current files directly.",
            options: [
                { value: "proceed", label: "Proceed in current files and remember for QUICK_FIX work" },
                { value: "cancel", label: "Cancel QUICK_FIX" },
            ],
        },
        undefined,
        hostedSession.getManagedOperationCapability?.() || null,
    );
    if (response.outcome !== "selected" || response.value !== "proceed") return false;
    await rememberNonGitExecutionConsent("quickFix", projectRoot);
    return true;
}

/**
 * Read the latest triage_report tool result's details from a message stream.
 * This is a compatibility helper for legacy tests and transcript display. Live
 * routing uses accepted Workflow Tool Events.
 *
 * @param {import('@earendil-works/pi-agent-core').AgentMessage[]} messages
 * @param {number} [fromIndex]
 * @returns {TriageOutcome | null}
 */
export function readLatestTriageOutcome(messages: AgentMessage[], fromIndex?: number): TriageOutcome | null {
    const start = fromIndex != null ? fromIndex : 0;
    for (let i = messages.length - 1; i >= start; i--) {
        const msg = messages[i];
        if (
            msg && "role" in msg && msg.role === "toolResult" &&
            "toolName" in msg && msg.toolName === "triage_report"
        ) {
            const toolResult = msg as AgentMessage & TriageToolResultMessage;
            const normalized = normalizeTriageOutcome(toolResult.details);
            if (normalized) return normalized;
        }
    }
    return null;
}

/**
 * @param {TriageOutcome} triage
 */
/**
 * Apply a Router-provided Session Name only when the session is currently unnamed.
 * Always mirror the effective Session Name to the Terminal Title when available.
 *
 * @param {import('@earendil-works/pi-coding-agent').SessionManager | undefined} sessionManager
 * @param {TriageOutcome} triage
 * @param {import('../session/hosted-session.js').HostedSession} hostedSession
 */
function applyAutoSessionName(
    sessionManager: SessionManager | undefined,
    triage: TriageOutcome,
    hostedSession: import("../session/hosted-session.js").HostedSession,
): void {
    if (!sessionManager) return;

    const existingName = sanitizeSessionName(sessionManager.getSessionName?.() || "");
    if (existingName) {
        emitHostedSessionRuntimeEvent(hostedSession, { type: RuntimeEventTypes.SESSION_RENAMED, name: existingName });
        return;
    }

    const sessionName = sanitizeSessionName(triage.sessionName || "");
    if (!sessionName) return;

    sessionManager.appendSessionInfo?.(sessionName);
    emitHostedSessionRuntimeEvent(hostedSession, { type: RuntimeEventTypes.SESSION_RENAMED, name: sessionName });
}

/** Dispatch the next Agent from a Triage Report and run the resulting workflow. */
export async function dispatchPostTriage({
    hostedSession,
    triage,
    userRequest,
    images,
    sessionManager,
    localCI,
    signal,
}: DispatchPostTriageArgs): Promise<Awaited<ReturnType<typeof runWorkflowValidationToStableBoundary>> | undefined> {
    if (!hostedSession || typeof hostedSession.getRootAgentName !== "function") {
        throw new Error("dispatchPostTriage: hostedSession is required");
    }
    const projectRoot = hostedSession.cwd;
    const recordMetric = (metric: Parameters<typeof recordWorkflowMetric>[0]) =>
        recordWorkflowMetric(metric, projectRoot);

    const normalizedTriage = normalizeTriageOutcome(triage);
    if (!normalizedTriage) throw new Error("dispatchPostTriage: routingIntent is required");

    const checkCanceled = () => signal?.throwIfAborted();
    const activateAgent = async (agentName: string): Promise<void> => {
        checkCanceled();
        await switchActiveAgent(hostedSession, { agentName });
        checkCanceled();
    };
    applyAutoSessionName(sessionManager, normalizedTriage, hostedSession);

    checkCanceled();
    const dispatchTarget = normalizedTriage.routingIntent === "INQUIRY"
        ? AGENTS.GUIDE
        : normalizedTriage.routingIntent === "IDEATION"
        ? AGENTS.IDEATOR
        : normalizedTriage.routingIntent === "OPERATION"
        ? AGENTS.OPERATOR
        : normalizedTriage.routingIntent === "QUICK_FIX"
        ? AGENTS.ENGINEER
        : isPlannedChangeClassification(normalizedTriage.routingIntent)
        ? AGENTS.PLANNER
        : AGENTS.ARCHITECT;
    const decoratedRequest = buildAgentHandoffRequest(
        getAgentDisplayName(dispatchTarget, projectRoot),
        userRequest,
        normalizedTriage,
    );
    await recordMetric({
        category: "routing",
        event: "dispatch_selected",
        agentName: dispatchTarget,
        details: {
            routingIntent: normalizedTriage.routingIntent,
            targetAgent: dispatchTarget,
            classification: normalizedTriage.classification,
            complexity: normalizedTriage.complexity,
        },
    });
    checkCanceled();

    if (normalizedTriage.routingIntent === "INQUIRY" || normalizedTriage.routingIntent === "IDEATION") {
        const agentName = normalizedTriage.routingIntent === "INQUIRY" ? AGENTS.GUIDE : AGENTS.IDEATOR;
        await activateAgent(agentName);

        await runRootTurn({
            hostedSession,
            agentName,
            userRequest: decoratedRequest,
            images,
            signal,
        });
        return;
    }

    if (normalizedTriage.routingIntent === "OPERATION") {
        const operatorDisplay = getAgentDisplayName(AGENTS.OPERATOR, projectRoot);
        await activateAgent(AGENTS.OPERATOR);

        await runRootTurnUntilTaskCompletion({
            hostedSession,
            agentName: AGENTS.OPERATOR,
            userRequest: decoratedRequest,
            images,
            signal,
        });
        const acceptedCompletion = claimPendingTaskCompletion(
            hostedSession,
            hostedSession.getRootAgentSession() || null,
        );
        const completed = Boolean(acceptedCompletion);
        if (acceptedCompletion) acknowledgeTaskCompletion(hostedSession, acceptedCompletion);
        await recordMetric({
            category: "execution",
            event: "operation_completed_observed",
            agentName: AGENTS.OPERATOR,
            details: { taskCompletedObserved: Boolean(completed), mechanicalValidationRan: false },
        });
        if (!completed) {
            emitSystemStatus(
                hostedSession,
                `${operatorDisplay} stopped before reporting the operation complete. Read its last message for the blocker; the operation is unfinished.`,
                { header: "RunWield" },
            );
        }
        return;
    }

    if (normalizedTriage.routingIntent === "QUICK_FIX") {
        const engineerDisplay = getAgentDisplayName(AGENTS.ENGINEER, projectRoot);
        const manualQaName = normalizedTriage.sessionName || "quick-fix";
        const initialManualQaContext = buildQuickFixManualQaContext(decoratedRequest);
        const gitProbe = await probeGitRepository(projectRoot);
        if (
            !gitProbe.ok && !hasNonGitExecutionConsent("quickFix", projectRoot) &&
            !(await confirmNonGitQuickFixExecution(hostedSession, projectRoot))
        ) {
            emitSystemStatus(
                hostedSession,
                "QUICK_FIX canceled because Git is not available and in-place edits were not approved.",
                { header: "RunWield" },
            );
            await recordMetric({
                category: "execution",
                event: "quick_fix_non_git_canceled",
                agentName: AGENTS.ENGINEER,
                details: { gitState: gitProbe.state },
            });
            return;
        }

        await activateAgent(AGENTS.ENGINEER);
        hostedSession.setActiveExecutionWorkflow(
            createQuickFixWorkflow(normalizedTriage, projectRoot, manualQaName, initialManualQaContext),
        );

        const messages = await runRootTurnUntilTaskCompletion({
            hostedSession,
            agentName: AGENTS.ENGINEER,
            userRequest: decoratedRequest,
            images,
            dispatchKind: "quick_fix",
            signal,
        });
        const acceptedCompletion = claimPendingTaskCompletion(
            hostedSession,
            hostedSession.getRootAgentSession() || null,
        );
        const completed = Boolean(acceptedCompletion);
        if (!completed) {
            await recordMetric({
                category: "execution",
                event: "quick_fix_completed_observed",
                agentName: AGENTS.ENGINEER,
                details: { taskCompletedObserved: false, mechanicalValidationRan: false },
            });
            emitSystemStatus(
                hostedSession,
                `${engineerDisplay} stopped before reporting the task complete, so Mechanical Validation did not run. Read its last message for the blocker. Staying with ${engineerDisplay}; validation resumes once the work is reported complete.`,
                { header: "RunWield" },
            );
            return;
        }

        const manualQaContext = buildQuickFixManualQaContext(decoratedRequest, messages);
        const quickFixWorkflow = hostedSession.getActiveExecutionWorkflow();
        hostedSession.clearActiveExecutionWorkflow();
        const mechanicalResult = await runMechanicalValidation({
            hostedSession,
            sessionManager,
            manualQaName,
            manualQaContext,
        }, localCI);
        if (acceptedCompletion) {
            acknowledgeTaskCompletion(hostedSession, acceptedCompletion);
        }
        if (quickFixWorkflow) {
            hostedSession.setActiveExecutionWorkflow(refreshedQuickFixWorkflow(quickFixWorkflow));
        }
        await recordMetric({
            category: "execution",
            event: "quick_fix_completed_observed",
            agentName: AGENTS.ENGINEER,
            details: {
                taskCompletedObserved: true,
                mechanicalValidationRan: true,
                mechanicalValidationPassed: mechanicalResult?.passed,
                attempts: mechanicalResult?.attempts,
            },
        });
        return;
    }

    if (isPlannedChangeClassification(normalizedTriage.routingIntent) || normalizedTriage.routingIntent === "PROJECT") {
        const isPlannedChange = isPlannedChangeClassification(normalizedTriage.routingIntent);
        const agentName = isPlannedChange ? AGENTS.PLANNER : AGENTS.ARCHITECT;
        await ensurePlansDir(projectRoot);
        checkCanceled();

        const outcome = await runPlanningAgent({
            agentName,
            initialRequest: decoratedRequest,
            triageMeta: normalizedTriage,
            sessionManager,
            hostedSession,
            signal,
        });

        const decision = decidePostPlanning(outcome, {
            planningAgentName: agentName,
            fallbackTriageMeta: normalizedTriage,
        });
        await recordMetric({
            category: "planning",
            event: "decision",
            agentName,
            planName: typeof decision.payload.planName === "string" ? decision.payload.planName : undefined,
            details: summarizeWorkflowDecision(decision),
        });
        checkCanceled();

        if (decision.kind === "start_slicer") {
            const planName = String(decision.payload.planName);
            const decisionMeta = decision.payload.triageMeta as TriageOutcomeInput | undefined;
            const slicerTriageMeta = normalizeTriageOutcome(decisionMeta) || normalizedTriage;
            const slicerResult = await runSlicerAgent({
                planName,
                triageMeta: slicerTriageMeta,
                hostedSession,
                sessionManager,
            });
            await recordMetric({
                category: "planning",
                event: "active_agent_transition",
                agentName: slicerResult.ok ? AGENTS.SLICER : agentName,
                planName,
                details: {
                    transition: slicerResult.ok ? "start_slicer" : "slicer_start_failed",
                    decisionKind: decision.kind,
                },
            });
            if (!slicerResult.ok) {
                await activateAgent(agentName);
            }
            return;
        }

        if (decision.kind === "stay_with_agent" || decision.kind === "save_plan") {
            await recordMetric({
                category: "execution",
                event: "feature_project_outcome",
                agentName,
                planName: typeof decision.payload.planName === "string" ? decision.payload.planName : undefined,
                details: {
                    routingIntent: normalizedTriage.routingIntent,
                    outcome: decision.kind === "save_plan" ? "plan_saved" : "planning_incomplete",
                    decisionKind: decision.kind,
                },
            });
            await activateAgent(agentName);
            return;
        }

        if (decision.kind !== "execute_plan") {
            await recordMetric({
                category: "execution",
                event: "feature_project_outcome",
                agentName,
                details: {
                    routingIntent: normalizedTriage.routingIntent,
                    outcome: "planning_halted",
                    decisionKind: decision.kind,
                },
            });
            emitSystemStatus(hostedSession, `Workflow halted: ${String(decision.payload.reason || "unknown reason")}`);
            await activateAgent(agentName);
            return;
        }

        const planName = String(decision.payload.planName);
        const decisionMeta = decision.payload.triageMeta as TriageOutcomeInput | undefined;
        const decisionTriageMeta = normalizeTriageOutcome(decisionMeta) || normalizedTriage;
        checkCanceled();
        let executionResult: Awaited<ReturnType<typeof executePlan>>;
        try {
            executionResult = await executePlan({
                planName,
                triageMeta: decisionTriageMeta,
                routerMessage: userRequest,
                sessionManager,
                hostedSession,
            });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const executionOwner = hostedSession.getActiveExecutionWorkflow()?.executionAgent ||
                resolveExecutionOwner(decisionTriageMeta);
            await recordMetric({
                category: "execution",
                event: "feature_project_outcome",
                agentName: executionOwner,
                planName,
                details: {
                    routingIntent: normalizedTriage.routingIntent,
                    outcome: "execution_threw",
                    hasError: Boolean(reason),
                },
            });
            emitSystemStatus(
                hostedSession,
                `Plan execution failed: ${reason}. ${
                    getAgentDisplayName(executionOwner, projectRoot)
                } may need manual intervention.`,
                { level: "error", header: "RunWield" },
            );
            await activateAgent(executionOwner);
            return;
        }

        const executionOwner = hostedSession.getActiveExecutionWorkflow()?.executionAgent ||
            resolveExecutionOwner(decisionTriageMeta);
        const executionDecision = decidePostExecution(executionResult, {
            planName,
            triageMeta: decisionTriageMeta,
            executionAgentName: executionOwner,
        });
        await recordMetric({
            category: "execution",
            event: "decision",
            agentName: executionOwner,
            planName,
            details: summarizeWorkflowDecision(executionDecision),
        });
        if (executionDecision.kind === "complete_session") {
            if (typeof executionDecision.payload.message === "string" && executionDecision.payload.message) {
                emitSystemStatus(hostedSession, executionDecision.payload.message, { header: "RunWield" });
            }
            await recordMetric({
                category: "execution",
                event: "feature_project_outcome",
                agentName,
                planName,
                details: {
                    routingIntent: normalizedTriage.routingIntent,
                    outcome: "session_complete",
                    executionDecisionKind: executionDecision.kind,
                    reason: executionDecision.payload.reason,
                },
            });
            return;
        }
        if (executionDecision.kind === "run_validation") {
            const validationRoot = executionResult.executionContext?.executionCwd || projectRoot;
            const plan = await loadPlan(validationRoot, planName);
            const validationTriageMeta = plan?.attrs ? { ...decisionTriageMeta, ...plan.attrs } : decisionTriageMeta;
            if (shouldRunWorkflowValidation(decisionTriageMeta)) {
                const validationResult = await runWorkflowValidationToStableBoundary({
                    hostedSession,
                    planName,
                    planContent: plan?.markdown || "",
                    triageMeta: validationTriageMeta,
                    sessionManager,
                    finalAgentName: agentName,
                    executionContext: executionResult.executionContext,
                    git: createGitPort(),
                    localCI,
                    workRecordMnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                    semanticReviewPort: SYSTEM_SEMANTIC_REVIEW_PORT,
                    supportsSemanticRepairHandoff: true,
                });
                await recordMetric({
                    category: "execution",
                    event: "feature_project_outcome",
                    agentName: executionOwner,
                    planName,
                    details: {
                        routingIntent: normalizedTriage.routingIntent,
                        outcome: "validation_completed",
                        executionDecisionKind: executionDecision.kind,
                    },
                });
                return validationResult;
            } else {
                await recordMetric({
                    category: "execution",
                    event: "feature_project_outcome",
                    agentName: executionOwner,
                    planName,
                    details: {
                        routingIntent: normalizedTriage.routingIntent,
                        outcome: "validation_skipped",
                        executionDecisionKind: executionDecision.kind,
                    },
                });
            }
        } else if (executionDecision.kind === "stay_with_agent") {
            const nextAgentName = typeof executionDecision.payload.agentName === "string"
                ? executionDecision.payload.agentName
                : AGENTS.ENGINEER;
            await recordMetric({
                category: "execution",
                event: "feature_project_outcome",
                agentName: nextAgentName,
                planName,
                details: {
                    routingIntent: normalizedTriage.routingIntent,
                    outcome: "execution_incomplete",
                    executionDecisionKind: executionDecision.kind,
                },
            });
            await activateAgent(nextAgentName);
        } else {
            // halt — stay with the execution owner for manual recovery
            const reason = executionDecision.payload?.reason || "unknown";
            await recordMetric({
                category: "execution",
                event: "feature_project_outcome",
                agentName: executionOwner,
                planName,
                details: {
                    routingIntent: normalizedTriage.routingIntent,
                    outcome: "execution_halted",
                    executionDecisionKind: executionDecision.kind,
                    hasReason: Boolean(reason),
                },
            });
            emitSystemStatus(
                hostedSession,
                `Execution stopped: ${reason}. Staying with ${executionOwner} for manual intervention.`,
                { level: "error", header: "RunWield" },
            );
            await activateAgent(executionOwner);
        }
    }
}
