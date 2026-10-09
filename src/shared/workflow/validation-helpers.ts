/**
 * @module shared/workflow/validation-helpers
 *
 * Supporting helpers for Workflow Validation: bundled prompt loading, local CI
 * execution, manual QA handoffs, agent-turn repair, and post-merge publication
 * proof. The validation loop itself lives in `validation.ts`; this module holds
 * the pieces it calls out to.
 */

import { dirname, fromFileUrl } from "@std/path";
import { AGENTS, isPlannedChangeClassification, SUBAGENTS } from "../../constants.js";
import { loadPlan } from "../../plan-store.js";

import { getAgentDisplayName } from "../session/agents.js";

import { runIsolatedAgentSession } from "../session/session.js";
import { type LocalCIPort, runLocalCI } from "./validation-local-ci.ts";
import { verifyPostMergeCandidatePublished } from "./validation-merge-verification.ts";
import { buildValidationUserMessage } from "./validation-user-messages.ts";
import { loadManualQaPrompt, loadReviewerFeedbackEngineerDef, loadReviewerPrompt } from "./validation-prompts.ts";
import {
    completeValidationProgress,
    createValidationProgress,
    emitRunWieldSystemStatus,
    updateValidationProgress,
} from "./validation-progress.ts";

import { runValidationAgentUntilEvent } from "../session/agent-workflow-step.ts";
import { settleWorkflowToolEvent } from "./workflow-tool-events.ts";
import { createManualQaCompletedTool } from "../../tools/manual-qa-completed.ts";
import { logValidationFailure } from "./validation-state-errors.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { runActiveAgentTurn, switchActiveAgent } from "../session/agent-switching.js";
import {
    requestHostedSessionInteraction,
    RuntimeInteractionOutcomes,
    RuntimeInteractionTypes,
} from "../session/session-runtime-interactions.js";

import { recordWorkflowMetric } from "./metrics.js";

import { autoGenerateWorkRecordForCompletedPlan } from "../work-records/auto-generation.js";
import type { WorkRecordMnemotecaPort } from "../work-records/mnemoteca-port.ts";
import {
    confirmWorkRecordSupersessionProposal,
    rejectWorkRecordSupersessionProposal,
} from "../work-records/supersession.ts";
import type { WorkRecordSupersessionCandidate } from "../work-records/schema.ts";

export type WorkRecordSupersessionDecision = "confirm" | "reject" | "later";

export interface ResolveWorkRecordSupersessionProposalsOptions {
    projectRoot: string;
    successorRecordId: string;
    proposals: WorkRecordSupersessionCandidate[];
    mnemotecaPort: WorkRecordMnemotecaPort;
    choose: (proposal: WorkRecordSupersessionCandidate) => Promise<WorkRecordSupersessionDecision | null>;
    notify: (message: string, warning?: boolean) => void;
}

/** Prompt for and apply decisions without making a completed workflow non-terminal. */
export async function resolveWorkRecordSupersessionProposals({
    projectRoot,
    successorRecordId,
    proposals,
    mnemotecaPort,
    choose,
    notify,
}: ResolveWorkRecordSupersessionProposalsOptions): Promise<void> {
    for (const proposal of proposals) {
        let decision: WorkRecordSupersessionDecision | null = null;
        try {
            decision = await choose(proposal);
            if (decision === "confirm") {
                const result = await confirmWorkRecordSupersessionProposal(projectRoot, {
                    successorRecordId,
                    predecessorRecordId: proposal.recordId,
                    mnemotecaPort,
                });
                notify(`Confirmed Work Record supersession: ${proposal.recordId} -> ${successorRecordId}.`);
                if (result.indexWarning) notify(result.indexWarning, true);
                continue;
            }
            if (decision === "reject") {
                const result = await rejectWorkRecordSupersessionProposal(projectRoot, {
                    successorRecordId,
                    predecessorRecordId: proposal.recordId,
                    mnemotecaPort,
                });
                notify(`Rejected Work Record supersession proposal: ${proposal.recordId} -> ${successorRecordId}.`);
                if (result.indexWarning) notify(result.indexWarning, true);
                continue;
            }
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            notify(`Could not resolve supersession proposal for ${proposal.recordId}: ${reason}`, true);
        }
        notify(
            `Supersession proposal remains pending: ${proposal.recordId} -> ${successorRecordId}. Run wld wr supersede ${successorRecordId}.`,
        );
    }
}

export interface ResolveWorkRecordSupersessionProposalsWithUiOptions {
    projectRoot: string;
    successorRecordId: string;
    proposals: WorkRecordSupersessionCandidate[];
    mnemotecaPort: WorkRecordMnemotecaPort;
    uiAPI: Pick<import("../../ui/tui/types.js").UiAPI, "promptSelect" | "appendSystemMessage">;
}

/** Resolve generated proposals on a direct TUI surface. */
export function resolveWorkRecordSupersessionProposalsWithUi({
    projectRoot,
    successorRecordId,
    proposals,
    mnemotecaPort,
    uiAPI,
}: ResolveWorkRecordSupersessionProposalsWithUiOptions): Promise<void> {
    return resolveWorkRecordSupersessionProposals({
        projectRoot,
        successorRecordId,
        proposals,
        mnemotecaPort,
        choose: async (proposal) => {
            const answer = await uiAPI.promptSelect(
                buildValidationUserMessage({
                    kind: "work_record_prompt",
                    recordId: proposal.recordId,
                    reason: proposal.reason,
                }),
                [
                    { value: "confirm", label: "Confirm supersession" },
                    { value: "reject", label: "Reject proposal" },
                    { value: "later", label: "Decide later" },
                ],
            );
            return ["confirm", "reject", "later"].includes(String(answer))
                ? answer as WorkRecordSupersessionDecision
                : null;
        },
        notify: (message, warning = false) =>
            uiAPI.appendSystemMessage(
                buildValidationUserMessage({ kind: "work_record_notice", message }),
                warning,
                "RunWield",
            ),
    });
}

export const __dirname = dirname(fromFileUrl(import.meta.url));
type AgentMessage = import("@earendil-works/pi-agent-core").AgentMessage;
interface WorkflowValidationResult {
    kind: "verified" | "paused" | "failed";
    planName: string;
    projectRoot: string;
    classification?: string;
    reason?: string;
    epicContinuation?: {
        completedPlanName: string;
        projectRoot: string;
        resolution?: import("./epic-continuation.ts").EpicContinuationResolution;
    };
}

interface RunManualQaChecklistPromptOptions {
    hostedSession: import("../session/hosted-session.js").HostedSession;
    name: string;
    classification: "QUICK_FIX" | "PLANNED_CHANGE" | "FEATURE";
    context: string;
    cwd: string;
}

/**
 * Run a transient, tool-free prompt that presents manual checks to the user
 * after automated verification succeeds.
 *
 * @param {Object} args
 * @param {import('../session/hosted-session.js').HostedSession} args.hostedSession
 * @param {string} args.name
 * @param {"QUICK_FIX"|"PLANNED_CHANGE"|"FEATURE"} args.classification
 * @param {string} args.context
 * @param {string} args.cwd
 * @returns {Promise<import('@earendil-works/pi-agent-core').AgentMessage[]>}
 */
export async function runManualQaChecklistPrompt({
    hostedSession,
    name,
    classification,
    context,
    cwd,
}: RunManualQaChecklistPromptOptions) {
    const normalizedClassification = classification === "FEATURE" ? "PLANNED_CHANGE" : classification;
    const userRequest = [
        "Prepare the post-verification checklist from this source material.",
        `Name: ${name}`,
        `Classification: ${normalizedClassification}`,
        "",
        "### Source context",
        context,
    ].join("\n");

    const { event } = await runValidationAgentUntilEvent({ runIsolatedAgentSession }, {
        hostedSession,
        agentName: AGENTS.OPERATOR,
        userRequest: userRequest + "\nCall manual_qa_completed with the checklist. Do not finish with plain text.",
        cwd,
        sessionManager: SessionManager.inMemory(cwd),
        subAgentDefinition: { id: SUBAGENTS.MANUAL_QA },
        includeEditFallback: false,
        customTools: [createManualQaCompletedTool({ hostedSession, name, classification: normalizedClassification })],
    }, "manual_qa_completed");
    if (!event) throw new Error("Manual QA has not submitted a checklist.");
    settleWorkflowToolEvent(hostedSession, event);
    return [];
}

interface PresentManualQaChecklistOptions {
    hostedSession: import("../session/hosted-session.js").HostedSession;
    name: string;
    classification: "QUICK_FIX" | "PLANNED_CHANGE" | "FEATURE";
    context: string;
    cwd: string;
}

/**
 * Checklist generation is a post-verification handoff. A model failure should
 * be visible, but must not retroactively fail successful validation.
 *
 * @param {Object} args
 * @param {import('../session/hosted-session.js').HostedSession} args.hostedSession
 * @param {string} args.name
 * @param {"QUICK_FIX"|"PLANNED_CHANGE"|"FEATURE"} args.classification
 * @param {string} args.context
 * @param {string} args.cwd
 * @returns {Promise<void>}
 */
async function presentManualQaChecklist(
    { hostedSession, name, classification, context, cwd }: PresentManualQaChecklistOptions,
) {
    try {
        await runManualQaChecklistPrompt({ hostedSession, name, classification, context, cwd });
    } catch (error) {
        await logValidationFailure(error instanceof Error ? error : new Error(String(error)), "manual_qa");
        emitRunWieldSystemStatus(
            hostedSession,
            buildValidationUserMessage({ kind: "manual_qa_failed" }),
            true,
        );
    }
}

interface RunFeaturePostVerificationHandoffsOptions {
    pendingPublication?: boolean;
    hostedSession: import("../session/hosted-session.js").HostedSession;
    planName: string;
    planContent: string;
    projectRoot: string;
    mnemotecaPort: WorkRecordMnemotecaPort;
}

/**
 * @param {Object} args
 * @param {import('../session/hosted-session.js').HostedSession} args.hostedSession
 * @param {string} args.planName
 * @param {string} args.planContent
 * @param {string} args.projectRoot
 * @param {WorkRecordMnemotecaPort} args.mnemotecaPort
 */
export async function runFeaturePostVerificationHandoffs({
    hostedSession,
    planName,
    planContent,
    projectRoot,
    mnemotecaPort,
    pendingPublication,
}: RunFeaturePostVerificationHandoffsOptions) {
    const plan = await loadPlan(projectRoot, planName).catch(() => null);
    const isEpicChild = typeof plan?.attrs.parentPlan === "string" && plan.attrs.parentPlan.trim().length > 0;
    if (!isEpicChild) {
        emitRunWieldSystemStatus(
            hostedSession,
            buildValidationUserMessage({ kind: "manual_qa_start" }),
        );
    }
    const manualQaPromise = isEpicChild ? Promise.resolve() : presentManualQaChecklist({
        hostedSession,
        name: planName,
        classification: "PLANNED_CHANGE",
        context: planContent,
        cwd: projectRoot,
    });
    emitRunWieldSystemStatus(
        hostedSession,
        buildValidationUserMessage({ kind: "work_record_start" }),
        "info",
    );
    const workRecordPromise = autoGenerateWorkRecordForCompletedPlan({
        cwd: projectRoot,
        planName,
        mnemotecaPort,
        pendingPublication,
    }).catch(async (error) => {
        await logValidationFailure(error instanceof Error ? error : new Error(String(error)), "work_record");
        return {
            status: "failed" as const,
            planName,
            reason: undefined,
            message: buildValidationUserMessage({ kind: "work_record_result", status: "failed" }),
        };
    });
    const [, workRecordResult] = await Promise.all([manualQaPromise, workRecordPromise]);
    emitRunWieldSystemStatus(
        hostedSession,
        buildValidationUserMessage({
            kind: "work_record_result",
            status: workRecordResult.status,
            reason: workRecordResult.reason,
        }),
        workRecordResult.status === "failed"
            ? "warning"
            : workRecordResult.status === "generated" || workRecordResult.status === "linked"
            ? "success"
            : "info",
    );
    if (
        (workRecordResult.status === "generated" || workRecordResult.status === "linked") &&
        workRecordResult.recordId && workRecordResult.supersessionProposals?.length
    ) {
        await resolveWorkRecordSupersessionProposals({
            projectRoot,
            successorRecordId: workRecordResult.recordId,
            proposals: workRecordResult.supersessionProposals,
            mnemotecaPort,
            choose: async (proposal) => {
                const response = await requestHostedSessionInteraction(
                    hostedSession,
                    {
                        type: RuntimeInteractionTypes.SELECT,
                        prompt: buildValidationUserMessage({
                            kind: "work_record_prompt",
                            recordId: proposal.recordId,
                            reason: proposal.reason,
                        }),
                        options: [
                            { value: "confirm", label: "Confirm supersession" },
                            { value: "reject", label: "Reject proposal" },
                            { value: "later", label: "Decide later" },
                        ],
                    },
                    undefined,
                    hostedSession.getManagedOperationCapability?.() || null,
                );
                return response.outcome === RuntimeInteractionOutcomes.SELECTED &&
                        ["confirm", "reject", "later"].includes(String(response.value))
                    ? response.value as WorkRecordSupersessionDecision
                    : null;
            },
            notify: (message, warning = false) =>
                emitRunWieldSystemStatus(
                    hostedSession,
                    buildValidationUserMessage({ kind: "work_record_notice", message }),
                    warning ? "warning" : "info",
                ),
        });
    }
}

interface RunCompletionGatedRepairOptions {
    agentName: string;
    userRequest: string;
    images?: Array<{ base64: string; mimeType: string }>;
    sessionManager: import("@earendil-works/pi-coding-agent").SessionManager | undefined;
    cwd?: string;
    hostedSession: import("../session/hosted-session.js").HostedSession;
}

async function runCompletionGatedRepair({
    agentName,
    userRequest,
    images = [],
    sessionManager,
    cwd,
    hostedSession,
}: RunCompletionGatedRepairOptions): Promise<boolean> {
    const { event } = await runValidationAgentUntilEvent({ runIsolatedAgentSession: runActiveAgentTurn }, {
        hostedSession,
        agentName,
        userRequest,
        images,
        sessionManager,
        cwd: cwd || hostedSession.cwd,
        dispatchKind: "validation_repair",
    }, "task_completed");
    if (!event) return false;
    settleWorkflowToolEvent(hostedSession, event);
    return true;
}

/**
 * Open ledger identities a review result failed to mention.
 *
 * The ledger only converges if every round returns a verdict on every open item.
 * An omission is not neutral: it would let an approval merge over a finding
 * nobody addressed, and it makes a re-reported issue arrive as a new identity
 * beside the original, so one defect becomes two and the count grows each round.
 *
 * @param {import('./review-ledger.ts').ReviewLedger} ledger
 * @param {import('../../tools/review-complete.ts').ReviewFinding[] | undefined} findings
 * @returns {string[]}
 */
export { unaccountedOpenItems } from "./review-ledger.ts";

/**
 * HumanReviewDecision is declared below as a TypeScript union.
 */

type HumanReviewDecision = "not_required" | "skipped" | "approved";

interface HumanReviewMetadata {
    humanReviewMode: "none" | "ask" | "always";
    humanReviewDecision: HumanReviewDecision;
    humanReviewedAt: string | null;
}

/**
 * @param {import('../../tools/plan-written.ts').TriageMeta} triageMeta
 * @returns {boolean}
 */
export function shouldRunWorkflowValidation(triageMeta: import("../../tools/plan-written.ts").TriageMeta) {
    return isPlannedChangeClassification(triageMeta?.classification) || triageMeta?.classification === "PROJECT";
}

/**
 * @param {import('../../tools/plan-written.ts').TriageMeta} triageMeta
 * @returns {boolean}
 */
export function shouldContinueParentEpicAfterValidation(triageMeta: import("../../tools/plan-written.ts").TriageMeta) {
    const parentPlan = triageMeta?.parentPlan;
    return isPlannedChangeClassification(triageMeta?.classification) &&
        typeof parentPlan === "string" &&
        parentPlan.trim().length > 0;
}

interface RunMechanicalValidationOptions {
    sessionManager: import("@earendil-works/pi-coding-agent").SessionManager | undefined;
    hostedSession?: import("../session/hosted-session.js").HostedSession;
    cwd?: string;
    manualQaName?: string;
    manualQaContext?: string;
}

/**
 * No-plan Mechanical Validation for direct QUICK_FIX work. Runs configured local
 * CI and sends failures back to Engineer, without Plan lifecycle, semantic
 * review, code review, implementation diff checks, worktree merge-back, or
 * worktree registry updates.
 *
 * @param {Object} args
 * @param {import('@earendil-works/pi-coding-agent').SessionManager | undefined} args.sessionManager
 * @param {import('../session/hosted-session.js').HostedSession} [args.hostedSession]
 * @param {string} [args.cwd]
 * @param {string} [args.manualQaName]
 * @param {string} [args.manualQaContext]
 * @param {LocalCIPort} localCI External local-CI process boundary. Required on
 *   purpose: a port with a production default is an override bag wearing a port's
 *   name, because a caller that passes nothing gets the real thing silently.
 * @returns {Promise<{ passed: boolean, attempts: number, reason?: string }>}
 */
export async function runMechanicalValidation({
    sessionManager,
    hostedSession,
    cwd,
    manualQaName = "quick-fix",
    manualQaContext = "The QUICK_FIX implementation completed and passed automated verification.",
}: RunMechanicalValidationOptions, localCI: LocalCIPort): Promise<{
    passed: boolean;
    attempts: number;
    reason?: string;
}> {
    if (!hostedSession) throw new Error("runMechanicalValidation: hostedSession is required");
    const projectRoot = hostedSession?.cwd || cwd;
    if (!projectRoot) throw new Error("runMechanicalValidation: hostedSession or cwd is required");
    const metricProjectRoot = projectRoot;
    const validationCwd = cwd || hostedSession?.getActiveExecutionCwd?.() || projectRoot;
    function recordWorkflowMetricImpl(metric: Parameters<typeof recordWorkflowMetric>[0]) {
        return recordWorkflowMetric(metric, metricProjectRoot);
    }
    /** @param {string} agentName */
    const activateAgent = async (agentName: string) => {
        if (!hostedSession) return;
        await switchActiveAgent(hostedSession, { agentName });
    };
    const maxRepairAttempts = 3;
    let repairAttempts = 0;
    let progress = createValidationProgress({
        kind: "mechanical",
        outcome: "running",
        stage: "ci",
        checks: { ci: "running", semanticReview: "skipped", humanReview: "skipped", merge: "skipped" },
    });

    await recordWorkflowMetricImpl({
        category: "validation",
        event: "mechanical_validation_started",
        planName: "quick-fix",
        details: { maxRepairAttempts },
    });
    emitRunWieldSystemStatus(
        hostedSession,
        buildValidationUserMessage({ kind: "quick_fix_start" }),
        "info",
        progress,
    );

    while (true) {
        progress = updateValidationProgress(progress, {
            outcome: "running",
            stage: "ci",
            repairAttempt: repairAttempts > 0 ? repairAttempts : null,
            maxRepairAttempts: repairAttempts > 0 ? maxRepairAttempts : null,
            checks: { ci: "running" },
        });
        emitRunWieldSystemStatus(
            hostedSession,
            buildValidationUserMessage({
                kind: "quick_fix_running",
                attempt: repairAttempts,
                maxAttempts: maxRepairAttempts,
            }),
            "info",
            progress,
        );
        const ciResult = await localCI.run({ hostedSession, cwd: validationCwd });

        await recordWorkflowMetricImpl({
            category: "validation",
            event: "mechanical_ci_attempt",
            planName: "quick-fix",
            details: {
                attempt: repairAttempts + 1,
                exitCode: ciResult.kind === "completed" ? ciResult.exitCode : 130,
                passed: ciResult.kind === "completed" && ciResult.exitCode === 0,
                canceled: ciResult.kind === "canceled",
            },
        });
        if (ciResult.kind === "operational_failure") {
            progress = updateValidationProgress(progress, {
                outcome: "paused",
                stage: "terminal",
                message: ciResult.failure.message,
                checks: { ci: "canceled" },
            });
            emitRunWieldSystemStatus(hostedSession, ciResult.failure.message, "warning", progress);
            await activateAgent(AGENTS.ENGINEER);
            return { passed: false, attempts: repairAttempts, reason: ciResult.failure.message };
        }
        if (ciResult.kind === "canceled") {
            progress = updateValidationProgress(progress, {
                outcome: "paused",
                stage: "terminal",
                message: buildValidationUserMessage({ kind: "quick_fix_canceled" }),
                checks: { ci: "canceled" },
            });
            emitRunWieldSystemStatus(
                hostedSession,
                buildValidationUserMessage({ kind: "quick_fix_canceled" }),
                false,
                progress,
            );
            await recordWorkflowMetricImpl({
                category: "validation",
                event: "mechanical_validation_finished",
                planName: "quick-fix",
                details: { passed: false, canceled: true, attempts: repairAttempts },
            });
            await activateAgent(AGENTS.ENGINEER);
            return { passed: false, attempts: repairAttempts, reason: "canceled" };
        }
        if (ciResult.exitCode === 0) {
            progress = updateValidationProgress(progress, { checks: { ci: "passed" } });
            emitRunWieldSystemStatus(
                hostedSession,
                buildValidationUserMessage({ kind: "quick_fix_ci_passed" }),
                "success",
                progress,
            );
            await recordWorkflowMetricImpl({
                category: "validation",
                event: "mechanical_validation_finished",
                planName: "quick-fix",
                details: { passed: true, attempts: repairAttempts },
            });
            progress = updateValidationProgress(progress, {
                outcome: "running",
                stage: "manual_qa",
                message: "Preparing QUICK_FIX manual QA checklist.",
            });
            emitRunWieldSystemStatus(
                hostedSession,
                buildValidationUserMessage({ kind: "quick_fix_qa" }),
                "info",
                progress,
            );
            await presentManualQaChecklist({
                hostedSession,
                name: manualQaName,
                classification: "QUICK_FIX",
                context: manualQaContext,
                cwd: validationCwd,
            });
            progress = completeValidationProgress(
                progress,
                true,
                buildValidationUserMessage({ kind: "quick_fix_passed" }),
            );
            emitRunWieldSystemStatus(
                hostedSession,
                buildValidationUserMessage({ kind: "quick_fix_passed" }),
                "success",
                progress,
            );
            await activateAgent(AGENTS.ENGINEER);
            return { passed: true, attempts: repairAttempts };
        }

        if (repairAttempts >= maxRepairAttempts) {
            const reason =
                `QUICK_FIX Mechanical Validation failed after ${maxRepairAttempts} Engineer repair attempts.`;
            progress = completeValidationProgress(
                updateValidationProgress(progress, { checks: { ci: "failed" } }),
                false,
                buildValidationUserMessage({ kind: "quick_fix_failed", maxAttempts: maxRepairAttempts }),
            );
            emitRunWieldSystemStatus(
                hostedSession,
                buildValidationUserMessage({ kind: "quick_fix_failed", maxAttempts: maxRepairAttempts }),
                true,
                progress,
            );
            await recordWorkflowMetricImpl({
                category: "validation",
                event: "mechanical_validation_finished",
                planName: "quick-fix",
                details: { passed: false, attempts: repairAttempts, reason: "max_repair_attempts" },
            });
            await activateAgent(AGENTS.ENGINEER);
            return { passed: false, attempts: repairAttempts, reason };
        }

        repairAttempts++;
        await recordWorkflowMetricImpl({
            category: "validation",
            event: "mechanical_repair_dispatched",
            agentName: AGENTS.ENGINEER,
            planName: "quick-fix",
            details: { repairAttempt: repairAttempts },
        });
        progress = updateValidationProgress(progress, {
            outcome: "running",
            stage: "engineer_repair",
            repairAttempt: repairAttempts,
            maxRepairAttempts,
            checks: { ci: "failed" },
        });
        emitRunWieldSystemStatus(
            hostedSession,
            buildValidationUserMessage({
                kind: "quick_fix_repair",
                agent: getAgentDisplayName(AGENTS.ENGINEER, projectRoot),
                attempt: repairAttempts,
                maxAttempts: maxRepairAttempts,
            }),
            true,
            progress,
        );
        const completed = await runCompletionGatedRepair({
            agentName: AGENTS.ENGINEER,
            userRequest:
                "The no-plan QUICK_FIX failed Mechanical Validation. Fix the following CI errors, do not expand scope, " +
                "run appropriate verification, then call task_completed when the repair is complete. " +
                "If something blocks the repair, do not call task_completed: end your turn in plain text with what " +
                "you fixed and what stopped you. " +
                "If the repair involves tests, follow the write-tests skill for sound testing behavior:\n\n" +
                ciResult.output,
            sessionManager,
            cwd: validationCwd,
            hostedSession,
        });
        await recordWorkflowMetricImpl({
            category: "validation",
            event: "mechanical_repair_completed",
            agentName: AGENTS.ENGINEER,
            planName: "quick-fix",
            details: { repairAttempt: repairAttempts, taskCompletedObserved: Boolean(completed) },
        });
        if (!completed) {
            const reason = `${
                getAgentDisplayName(AGENTS.ENGINEER, projectRoot)
            } stopped on a blocker during the QUICK_FIX repair. Its last message says what stopped it.`;
            progress = updateValidationProgress(progress, {
                outcome: "paused",
                message: buildValidationUserMessage({
                    kind: "quick_fix_waiting",
                    agent: getAgentDisplayName(AGENTS.ENGINEER, projectRoot),
                }),
            });
            emitRunWieldSystemStatus(
                hostedSession,
                buildValidationUserMessage({
                    kind: "quick_fix_waiting",
                    agent: getAgentDisplayName(AGENTS.ENGINEER, projectRoot),
                }),
                true,
                progress,
            );
            await recordWorkflowMetricImpl({
                category: "validation",
                event: "mechanical_validation_finished",
                planName: "quick-fix",
                details: { passed: false, attempts: repairAttempts, reason: "repair_without_task_completed" },
            });
            hostedSession?.setActiveExecutionWorkflow({
                planName: "quick-fix",
                triageMeta: { classification: "QUICK_FIX" },
                executionAgent: AGENTS.ENGINEER as "engineer",
                executionCwd: validationCwd,
                validationContinuation: true,
                manualQaName,
                manualQaContext,
            });
            await activateAgent(AGENTS.ENGINEER);
            return { passed: false, attempts: repairAttempts, reason };
        }
    }
}

export { verifyPostMergeCandidatePublished };

export { loadManualQaPrompt, loadReviewerFeedbackEngineerDef, loadReviewerPrompt };

export { runLocalCI };
