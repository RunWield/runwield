// @ts-nocheck: extracted from checked JSDoc workflow.js; tightening types is out of scope for this structural split.
import { isEpicPlan } from "../project-plan.ts";
import { AGENTS, CLI_BIN, PLANS_DIR_NAME } from "../../constants.js";
import { resolvePlanExecutionPolicy } from "../../plan-store.js";
import { join } from "node:path";
import { emitSystemStatus } from "../session/session-runtime-events.js";
import { getAgentDisplayName } from "../session/agents.js";
import {
    requestHostedSessionInteraction,
    RuntimeInteractionOutcomes,
    RuntimeInteractionTypes,
} from "../session/session-runtime-interactions.js";
import { isExecutablePlanStatus, isProjectPlan, recordPlanEvent } from "./plan-lifecycle.js";
import { normalizePlanApprovalAction, PLAN_APPROVAL_ACTIONS } from "./plan-approval.ts";
import {
    appendSessionCompleteGuidance,
    requestPlanReviewRetryConfirmation,
    requestRecoverablePlanReview,
    SESSION_COMPLETE_GUIDANCE,
} from "./plan-review-recovery.js";
import { recordWorkflowMetric } from "./metrics.js";
import { CollaborationStyles, selectRuntimeCollaborationStyle } from "./execution-collaboration.ts";
import { finalizePlanImplementation } from "./implementation-checkpoint.ts";
import { runPlanningAgent } from "./planning-agent.ts";
import { buildExecutionSegmentContinuation } from "./execution-segment-handoff.ts";
import { loadPlanActionEvidence, type PlanActionEvidence, type PlanWorktreeExpectation } from "./plan-actions.ts";
import { runEngineerWithPlan, runEngineerWithSegmentHandoff } from "./engineer-runner.ts";
import { resolvePlanExecutionRuntimeAgent } from "./execution-agent.ts";
import { projectEngineerPlanBody } from "./engineer-plan-projection.ts";
import { createExecutionStartPorts, startActiveExecutionWorkflow } from "./execution-start.ts";
import { emitLaunchingExecutionAgent } from "./execution-preparation-progress.ts";
import { resolveWorkflowPlanLocation } from "./plan-location.ts";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { PlanFrontMatter } from "../../plan-store.js";
import type { ActiveExecutionWorkflow, HostedSession } from "../session/hosted-session.js";

function isPlanReviewRetryAccepted(response) {
    if (!response || typeof response !== "object") return false;
    if (response.outcome === RuntimeInteractionOutcomes.ACCEPTED) return true;
    if (response.value === true) return true;
    const value = String(response.value || "")
        .trim()
        .toLowerCase();
    return value === "yes" || value === "review_again" || value === "review";
}

export interface PlanExecutionResult {
    repairRequired: boolean;
    executionComplete: boolean;
    paused?: boolean;
    checkpointPending?: boolean;
    checkpointId?: string;
    canceled?: boolean;
    intentionalComplete?: boolean;
    intentionalCompleteReason?: string;
    message?: string;
    feedback?: string;
    pauseReason?: "stop" | "canceled";
    error?: string;
    completionReport?: string;
    executionContext?: ActiveExecutionWorkflow;
    executionSegmentHandoff?: import("./execution-segment-handoff.ts").ExecutionSegmentContinuation;
}

export interface ExecutePlanOptions {
    planName: string;
    triageMeta?: Partial<PlanFrontMatter>;
    sessionManager?: SessionManager;
    hostedSession: HostedSession;
    routerMessage?: string;
    reviewFeedback?: string;
    reviewImages?: Array<{ base64: string; mimeType: string }>;
    approvalEvidence?: PlanActionEvidence;
    prepareSegmentHandoff?: boolean;
}

export interface ExecuteSingleEngineerPlanOptions {
    planName: string;
    planBody: string;
    approvedMarkdown?: string;
    approvalTriageMeta?: Partial<PlanFrontMatter>;
    approvalEvidence?: PlanActionEvidence;
    triageMeta: Partial<PlanFrontMatter>;
    sessionManager?: SessionManager;
    currentStatus: import("./plan-lifecycle.js").PlanStatus;
    hostedSession: HostedSession;
    routerMessage?: string;
    reviewFeedback?: string;
    reviewImages?: Array<{ base64: string; mimeType: string }>;
    collaborationStyle?: "autonomous" | "pair";
    collaborationRecommendation?: "autonomous" | "pair";
    prepareSegmentHandoff?: boolean;
}

export async function executePlan({
    planName,
    triageMeta: _triageMeta,
    sessionManager,
    hostedSession,
    routerMessage,
    reviewFeedback,
    reviewImages,
    approvalEvidence,
    prepareSegmentHandoff = false,
}: ExecutePlanOptions): Promise<PlanExecutionResult> {
    if (!hostedSession) throw new Error("executePlan: hostedSession is required");
    const projectRoot = hostedSession.cwd;
    let effectiveReviewFeedback = reviewFeedback;
    let effectiveReviewImages = reviewImages;

    async function tryLoadPlanForExecution() {
        try {
            const location = await resolveWorkflowPlanLocation(projectRoot, planName, { readOnly: true });
            return { plan: location.plan, error: null };
        } catch (error) {
            return { plan: null, error };
        }
    }

    const initialLoad = await tryLoadPlanForExecution();
    let plan = initialLoad.plan;
    if (!plan) {
        emitSystemStatus(hostedSession, `ERROR: Could not load plan ${planName}`, {
            level: "error",
            header: "RunWield",
        });
        await recordWorkflowMetric(
            {
                category: "execution",
                event: "plan_execution_rejected",
                planName,
                details: { reason: initialLoad.error ? "plan_load_failed" : "plan_not_found" },
            },
            projectRoot,
        );

        const planPath = join(projectRoot, PLANS_DIR_NAME, `${planName}.md`);
        let recoveryAttempt = 0;
        let recoveryReason = initialLoad.error ? "plan_load_failed" : "plan_not_found";
        let recoveryResponse = { outcome: RuntimeInteractionOutcomes.UNSUPPORTED, message: recoveryReason };
        while (!plan) {
            recoveryAttempt += 1;
            const retryResponse = await requestPlanReviewRetryConfirmation(
                hostedSession,
                requestHostedSessionInteraction,
                {
                    attempt: recoveryAttempt,
                    reason: recoveryReason,
                    response: recoveryResponse,
                },
            ).catch(() => ({ outcome: RuntimeInteractionOutcomes.CANCELED, value: false }));
            if (!isPlanReviewRetryAccepted(retryResponse)) {
                emitSystemStatus(hostedSession, SESSION_COMPLETE_GUIDANCE, { header: "RunWield" });
                return {
                    repairRequired: false,
                    executionComplete: false,
                    intentionalComplete: true,
                    intentionalCompleteReason: recoveryReason,
                    message: SESSION_COMPLETE_GUIDANCE,
                };
            }

            const recoverableReview = await requestRecoverablePlanReview({
                requestReview: () =>
                    requestHostedSessionInteraction(
                        hostedSession,
                        {
                            type: RuntimeInteractionTypes.PLAN_REVIEW,
                            prompt: `Review plan "${planName}"`,
                            _meta: {
                                cwd: projectRoot,
                                planName,
                                planPath,
                                triageMeta: _triageMeta || {},
                                planningAgentName: isEpicPlan(_triageMeta) ? AGENTS.ARCHITECT : AGENTS.PLANNER,
                            },
                        },
                        undefined,
                        hostedSession.getManagedOperationCapability?.() || null,
                    ),
                requestRetry: (details) =>
                    requestPlanReviewRetryConfirmation(hostedSession, requestHostedSessionInteraction, details),
                onUnanswered: ({ reason }) => {
                    emitSystemStatus(hostedSession, `Plan review ended without an answer (${reason}).`, {
                        header: "RunWield",
                    });
                },
            });
            if (recoverableReview.kind === "complete") {
                emitSystemStatus(hostedSession, SESSION_COMPLETE_GUIDANCE, { header: "RunWield" });
                return {
                    repairRequired: false,
                    executionComplete: false,
                    intentionalComplete: true,
                    intentionalCompleteReason: recoverableReview.reason,
                    message: SESSION_COMPLETE_GUIDANCE,
                };
            }

            const reviewResponse = recoverableReview.response || {};
            const reviewMeta = /** @type {any} */ reviewResponse._meta || reviewResponse || {};
            if (reviewMeta.remoteReview === true) {
                const message = reviewResponse.message || `Plan "${planName}" saved for remote review.`;
                emitSystemStatus(hostedSession, message, { header: "RunWield" });
                return {
                    repairRequired: false,
                    executionComplete: false,
                    intentionalComplete: true,
                    intentionalCompleteReason: "remote_review",
                    message,
                };
            }
            if (!reviewMeta.approved) {
                const planningAgentName = isEpicPlan(_triageMeta) ? AGENTS.ARCHITECT : AGENTS.PLANNER;
                const revisionOutcome = await runPlanningAgent({
                    agentName: planningAgentName,
                    initialRequest: [
                        `## Plan Review Re-opened: ${planName}`,
                        "",
                        `docs/plans/${planName}.md could not be loaded for execution. The user provided this feedback while`,
                        "recovering it:",
                        "",
                        reviewMeta.feedback || "(no specific feedback provided)",
                    ].join("\n"),
                    triageMeta: _triageMeta,
                    images: Array.isArray(reviewMeta.images) ? reviewMeta.images : undefined,
                    sessionManager,
                    hostedSession,
                });
                if (revisionOutcome.outcome === "approved_execute") {
                    return await executePlan({
                        planName: revisionOutcome.planName || planName,
                        triageMeta: revisionOutcome.triageMeta || _triageMeta,
                        sessionManager,
                        hostedSession,
                        routerMessage,
                        reviewFeedback: revisionOutcome.feedback,
                        reviewImages: revisionOutcome.images,
                    });
                }
                return {
                    repairRequired: false,
                    executionComplete: false,
                    intentionalComplete: revisionOutcome.outcome === "saved" || revisionOutcome.outcome === "canceled",
                    intentionalCompleteReason: `review_${revisionOutcome.outcome}`,
                    message:
                        revisionOutcome.outcome === "saved" || revisionOutcome.outcome === "canceled"
                            ? SESSION_COMPLETE_GUIDANCE
                            : undefined,
                };
            }

            if (typeof reviewMeta.feedback === "string" && reviewMeta.feedback.trim()) {
                effectiveReviewFeedback = reviewMeta.feedback;
            }
            if (Array.isArray(reviewMeta.images) && reviewMeta.images.length > 0) {
                effectiveReviewImages = reviewMeta.images;
            }
            const approvedMeta =
                /** @type {Partial<import('../../plan-store.js').PlanFrontMatter>} */ reviewMeta.planAttrs ||
                _triageMeta ||
                {};
            const approvalAction = normalizePlanApprovalAction({
                classification: approvedMeta.classification,
                action: reviewMeta.approvalAction,
            });
            const recoveredLoad = await tryLoadPlanForExecution();
            plan = recoveredLoad.plan;
            if (!plan) {
                emitSystemStatus(
                    hostedSession,
                    `Plan could not be loaded after recovered review (${
                        recoveredLoad.error ? "load_failed" : "not_found"
                    }).`,
                    { header: "RunWield" },
                );
                recoveryReason = recoveredLoad.error ? "plan_load_failed" : "plan_not_found";
                recoveryResponse = reviewResponse;
                continue;
            }

            const currentStatus = plan.attrs?.status || "approved";
            if (currentStatus !== "ready_for_work" && currentStatus !== "ready_for_decomposition") {
                const readinessEvent =
                    approvedMeta.classification === "PROJECT" ? "epic_readiness_passed" : "readiness_passed";
                const readinessMeta = await recordPlanEvent({
                    cwd: projectRoot,
                    planName,
                    event: readinessEvent,
                    currentStatus,
                    details: { triageMeta: { ...plan.attrs, ...approvedMeta } },
                });
                const latestLoad = await tryLoadPlanForExecution();
                const latestPlan = latestLoad.plan;
                if (latestPlan) {
                    plan = latestPlan;
                    if (readinessMeta) {
                        plan.attrs = { ...plan.attrs, ...readinessMeta };
                    } else if (plan.attrs.status === currentStatus) {
                        plan.attrs = {
                            ...plan.attrs,
                            status:
                                readinessEvent === "epic_readiness_passed"
                                    ? "ready_for_decomposition"
                                    : "ready_for_work",
                        };
                    }
                } else if (readinessMeta) {
                    plan.attrs = { ...plan.attrs, ...readinessMeta };
                } else {
                    plan.attrs = {
                        ...plan.attrs,
                        status:
                            readinessEvent === "epic_readiness_passed" ? "ready_for_decomposition" : "ready_for_work",
                    };
                }
            }

            if (approvalAction !== PLAN_APPROVAL_ACTIONS.RUN) {
                emitSystemStatus(
                    hostedSession,
                    appendSessionCompleteGuidance(`Plan saved. Resume later with: ${CLI_BIN} load-plan ${planName}`),
                    { header: "RunWield" },
                );
                return {
                    repairRequired: false,
                    executionComplete: false,
                    intentionalComplete: true,
                    intentionalCompleteReason: "saved_for_later",
                    message: SESSION_COMPLETE_GUIDANCE,
                };
            }
        }
    }

    const effectiveMeta = { ...plan.attrs };
    const policy = resolvePlanExecutionPolicy(effectiveMeta);
    if (!policy.ok && policy.reason !== "project_epic") {
        emitSystemStatus(hostedSession, `ERROR: ${policy.error}`, { level: "error", header: "RunWield" });
        await recordWorkflowMetric(
            {
                category: "execution",
                event: "plan_execution_rejected",
                planName,
                details: { reason: policy.reason },
            },
            projectRoot,
        );
        return { repairRequired: false, executionComplete: false, error: policy.error };
    }
    if (policy.ok) {
        effectiveMeta.executionAgent = policy.policy.executionAgent;
        effectiveMeta.collaborationRecommendation = policy.policy.collaborationRecommendation;
    }

    if (isProjectPlan(plan.attrs)) {
        const error = `Plan ${planName} is a PROJECT Epic container and cannot be executed directly.`;
        emitSystemStatus(hostedSession, `ERROR: ${error}`, { level: "error", header: "RunWield" });
        await recordWorkflowMetric(
            {
                category: "execution",
                event: "plan_execution_rejected",
                planName,
                details: { reason: "epic_container", classification: effectiveMeta.classification },
            },
            projectRoot,
        );
        return { repairRequired: false, executionComplete: false, error };
    }

    if (!isExecutablePlanStatus(plan.attrs.status)) {
        const error = `Plan ${planName} is not ready for work (status: ${plan.attrs.status}).`;
        emitSystemStatus(hostedSession, `ERROR: ${error}`, { level: "error", header: "RunWield" });
        await recordWorkflowMetric(
            {
                category: "execution",
                event: "plan_execution_rejected",
                planName,
                details: { reason: "not_ready_for_work", status: plan.attrs.status },
            },
            projectRoot,
        );
        return { repairRequired: false, executionComplete: false, error };
    }

    const collaboration = policy.ok
        ? selectRuntimeCollaborationStyle(hostedSession, policy.policy)
        : {
              style: CollaborationStyles.AUTONOMOUS,
              recommendation: CollaborationStyles.AUTONOMOUS,
              pairCapable: false,
              resolutionReason: "legacy_autonomous",
          };
    if (policy.ok && policy.policy.executionAgent === AGENTS.FRONTEND_ENGINEER) {
        await recordWorkflowMetric(
            {
                category: "execution",
                event: "frontend_runtime_style_resolved",
                details: {
                    policySource: policy.policy.source,
                    recommendation: collaboration.recommendation,
                    runtimeStyle: collaboration.style,
                    pairCapable: collaboration.pairCapable,
                    resolutionReason: collaboration.resolutionReason,
                },
            },
            projectRoot,
        );
    }

    await recordWorkflowMetric(
        {
            category: "execution",
            event: "plan_execution_started",
            planName,
            details: { classification: effectiveMeta.classification, status: effectiveMeta.status },
        },
        projectRoot,
    );

    emitSystemStatus(hostedSession, `=== Executing Plan: ${planName} ===`, { header: "RunWield" });

    // PROJECT Epics are containers handled above; executable child planned-change plans use the normal single-plan execution path.
    const result = await executeSingleEngineerPlan({
        planName,
        planBody: projectEngineerPlanBody(plan.markdown),
        approvedMarkdown: plan.markdown,
        approvalTriageMeta: _triageMeta,
        approvalEvidence,
        triageMeta: effectiveMeta,
        sessionManager,
        currentStatus: plan.attrs.status,
        hostedSession,
        routerMessage,
        reviewFeedback: effectiveReviewFeedback,
        reviewImages: effectiveReviewImages,
        collaborationStyle: collaboration.style,
        collaborationRecommendation: collaboration.recommendation,
        prepareSegmentHandoff,
    });
    if (!result.executionComplete) {
        await recordWorkflowMetric(
            {
                category: "execution",
                event: "plan_execution_result",
                planName,
                details: {
                    executionComplete: false,
                    repairRequired: result.repairRequired,
                    hasError: Boolean(result.error),
                },
            },
            projectRoot,
        );
        return result;
    }

    const executionContext = result.executionContext || hostedSession?.getActiveExecutionWorkflow?.();
    try {
        await finalizePlanImplementation({
            projectRoot,
            planName,
            triageMeta: effectiveMeta,
            executionContext,
            executionReport: result.completionReport,
            hostedSession,
        });
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        try {
            await recordWorkflowMetric(
                {
                    category: "execution",
                    event: "implementation_checkpoint_failed",
                    planName,
                    details: {
                        executionMode: executionContext?.executionMode,
                        hasExecutionContext: Boolean(executionContext),
                    },
                },
                projectRoot,
            );
        } catch {
            // The checkpoint failure remains the authoritative error.
        }
        emitSystemStatus(
            hostedSession,
            `Implementation remains recoverable but was not marked complete because its worktree checkpoint failed: ${reason}`,
            { level: "error", header: "RunWield" },
        );
        return {
            repairRequired: true,
            executionComplete: false,
            error: reason,
            ...(executionContext ? { executionContext } : {}),
            ...(result.completionReport ? { completionReport: result.completionReport } : {}),
        };
    }
    await recordWorkflowMetric(
        {
            category: "execution",
            event: "plan_execution_result",
            planName,
            details: { executionComplete: true, repairRequired: false },
        },
        projectRoot,
    );

    emitSystemStatus(hostedSession, `✅ Plan implementation complete and checkpointed: ${planName}`, {
        header: "RunWield",
    });
    return {
        repairRequired: false,
        executionComplete: true,
        ...(executionContext ? { executionContext } : {}),
        ...(result.completionReport ? { completionReport: result.completionReport } : {}),
    };
}

export async function executeSingleEngineerPlan({
    planName,
    planBody,
    approvedMarkdown,
    approvalTriageMeta,
    approvalEvidence,
    triageMeta,
    sessionManager,
    currentStatus,
    hostedSession,
    routerMessage,
    reviewFeedback,
    reviewImages,
    collaborationStyle = CollaborationStyles.AUTONOMOUS,
    collaborationRecommendation = CollaborationStyles.AUTONOMOUS,
    prepareSegmentHandoff = false,
}: ExecuteSingleEngineerPlanOptions): Promise<PlanExecutionResult> {
    const approvalSnapshot = approvalEvidence
        ? {
              planId: approvalEvidence.planId,
              revision: approvalEvidence.revision,
              status: approvalEvidence.status,
              worktree: approvalEvidence.worktree,
          }
        : normalizeApprovalSnapshotForHandoff(approvalTriageMeta);
    if (prepareSegmentHandoff) {
        const approvalValidation = await validateApprovedPlanSnapshotForHandoff({
            projectRoot: hostedSession.cwd,
            planName,
            triageMeta,
            approvalSnapshot,
            currentStatus,
        });
        if (approvalValidation.kind !== "ok") {
            return { repairRequired: false, executionComplete: false, error: approvalValidation.message };
        }
    }
    let executionContext;
    try {
        executionContext = await startActiveExecutionWorkflow({
            planName,
            triageMeta,
            currentStatus,
            hostedSession,
            collaborationStyle,
            collaborationRecommendation,
            ports: createExecutionStartPorts(),
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failedWorkflow = hostedSession?.getActiveExecutionWorkflow?.();
        if (failedWorkflow?.planName === planName && failedWorkflow.collaborationStyle === CollaborationStyles.PAIR) {
            hostedSession?.setActiveExecutionWorkflow({
                ...failedWorkflow,
                collaborationStyle: CollaborationStyles.AUTONOMOUS,
            });
        }
        emitSystemStatus(hostedSession, `Execution did not start: ${message}`, {
            level: "error",
            header: "RunWield",
        });
        return { repairRequired: false, executionComplete: false, error: message };
    }
    const preparedPlan = (await resolveWorkflowPlanLocation(executionContext.executionCwd, planName)).plan;
    if (!preparedPlan) {
        return {
            repairRequired: false,
            executionComplete: false,
            error: `Prepared execution Plan is missing: ${planName}`,
        };
    }
    planBody = projectEngineerPlanBody(preparedPlan.markdown);
    approvedMarkdown = preparedPlan.markdown;
    if (prepareSegmentHandoff) {
        const managed = hostedSession.getManagedMetadata?.();
        if (!managed?.runwieldSessionId) {
            return {
                repairRequired: false,
                executionComplete: false,
                error: "Managed execution handoff requires Session metadata.",
            };
        }
        if (!approvalSnapshot) {
            return {
                repairRequired: false,
                executionComplete: false,
                error: "Managed execution handoff requires complete approval-time Plan action evidence.",
            };
        }
        const preparedEvidence = await loadPlanActionEvidence(
            executionContext.projectRoot || hostedSession.cwd,
            approvalSnapshot.planId,
        );
        if (preparedEvidence.kind !== "success") {
            return { repairRequired: false, executionComplete: false, error: preparedEvidence.message };
        }
        return {
            repairRequired: false,
            executionComplete: false,
            executionContext,
            executionSegmentHandoff: buildExecutionSegmentContinuation({
                runwieldSessionId: managed.runwieldSessionId,
                planId: approvalSnapshot.planId,
                planName,
                approvedRevision: approvalSnapshot.revision,
                approvedStatus: approvalSnapshot.status,
                approvedMarkdown: approvedMarkdown ? projectEngineerPlanBody(approvedMarkdown) : planBody,
                approvalFeedback: reviewFeedback,
                approvalImages: reviewImages,
                preparedEvidence: preparedEvidence.evidence,
                activeWorkflow: executionContext,
                executionOwner: resolvePlanExecutionRuntimeAgent(executionContext.executionAgent),
                collaborationStyle,
                collaborationRecommendation,
            }),
        };
    }
    const runtimeExecutionAgent = resolvePlanExecutionRuntimeAgent(executionContext.executionAgent);
    emitLaunchingExecutionAgent(
        hostedSession,
        getAgentDisplayName(runtimeExecutionAgent, executionContext.projectRoot || hostedSession?.cwd),
    );
    const engineerResult = await runEngineerWithPlan(
        planName,
        planBody,
        sessionManager,
        executionContext.executionCwd,
        hostedSession,
        executionContext.projectRoot,
        routerMessage,
        reviewFeedback,
        reviewImages,
        runtimeExecutionAgent,
    );
    if (!engineerResult.completed) {
        return {
            repairRequired: false,
            executionComplete: false,
            ...(executionContext ? { executionContext } : {}),
            ...(engineerResult.checkpointPending
                ? { checkpointPending: true, checkpointId: engineerResult.checkpointId }
                : {}),
            ...(engineerResult.paused ? { paused: true, pauseReason: engineerResult.pauseReason } : {}),
            ...(engineerResult.error ? { error: engineerResult.error } : {}),
        };
    }
    return {
        repairRequired: false,
        executionComplete: true,
        ...(executionContext ? { executionContext } : {}),
        ...(engineerResult.completionReport ? { completionReport: engineerResult.completionReport } : {}),
    };
}

async function validateApprovedPlanSnapshotForHandoff({
    projectRoot,
    planName,
    triageMeta,
    approvalSnapshot,
    currentStatus,
}) {
    if (!approvalSnapshot) {
        return {
            kind: "rejected",
            message: "Managed execution handoff requires complete approval-time Plan action evidence.",
        };
    }
    const evidence = await loadPlanActionEvidence(projectRoot, approvalSnapshot.planId);
    if (evidence.kind !== "success") return { kind: "rejected", message: evidence.message };
    if (evidence.evidence.planName !== planName) {
        return { kind: "rejected", message: "Plan action evidence no longer matches the approved Plan." };
    }
    if (triageMeta?.planId && triageMeta.planId !== approvalSnapshot.planId) {
        return { kind: "rejected", message: "Plan action evidence no longer matches the approved Plan." };
    }
    if (evidence.evidence.revision !== approvalSnapshot.revision) {
        return {
            kind: "rejected",
            message: "Plan revision changed after approval. Refresh Plan review before execution handoff.",
        };
    }
    if (evidence.evidence.status !== approvalSnapshot.status || currentStatus !== evidence.evidence.status) {
        return {
            kind: "rejected",
            message: "Plan status changed after approval. Refresh Plan review before execution handoff.",
        };
    }
    if (!samePlanWorktreeEvidence(evidence.evidence.worktree, approvalSnapshot.worktree)) {
        return {
            kind: "rejected",
            message: "Plan worktree evidence changed after approval. Refresh Plan review before execution handoff.",
        };
    }
    return { kind: "ok" };
}

function normalizeApprovalSnapshotForHandoff(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return null;
    const planId = typeof snapshot.planId === "string" && snapshot.planId.trim() ? snapshot.planId.trim() : "";
    const revision = typeof snapshot.revision === "string" && snapshot.revision.trim() ? snapshot.revision.trim() : "";
    const status = typeof snapshot.status === "string" && snapshot.status.trim() ? snapshot.status.trim() : "";
    const worktree = normalizeApprovalWorktreeEvidence(snapshot.worktree || snapshot.expectedWorktree);
    if (!planId || !revision || !status || !worktree) return null;
    return { planId, revision, status, worktree };
}

function normalizeApprovalWorktreeEvidence(worktree): PlanWorktreeExpectation | null {
    if (!worktree || typeof worktree !== "object") return null;
    if (worktree.kind === "none") return { kind: "none" };
    if (worktree.kind !== "attempt") return null;
    const id = nonEmptyString(worktree.id);
    const planId = nonEmptyString(worktree.planId);
    const status = nonEmptyString(worktree.status);
    const branch = nonEmptyString(worktree.branch);
    const baseBranch = nonEmptyString(worktree.baseBranch);
    const baseRef = nonEmptyString(worktree.baseRef);
    const baseCommit = nonEmptyString(worktree.baseCommit);
    if (!id || !planId || !status || !branch || !baseBranch || !baseRef || !baseCommit) return null;
    return { kind: "attempt", id, planId, status, branch, baseBranch, baseRef, baseCommit };
}

function nonEmptyString(value): string {
    return typeof value === "string" && value.trim() ? value.trim() : "";
}

function samePlanWorktreeEvidence(left: PlanWorktreeExpectation, right: PlanWorktreeExpectation): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export async function executePreparedPlanSegmentHandoff({
    continuation,
    sessionManager,
    hostedSession,
}: {
    continuation: import("./execution-segment-handoff.ts").ExecutionSegmentContinuation;
    sessionManager?: SessionManager;
    hostedSession: HostedSession;
}): Promise<PlanExecutionResult> {
    const workflow = continuation.activeWorkflow as ActiveExecutionWorkflow;
    hostedSession.setActiveExecutionWorkflow(workflow);
    emitLaunchingExecutionAgent(
        hostedSession,
        getAgentDisplayName(
            resolvePlanExecutionRuntimeAgent(continuation.executionOwner),
            workflow.projectRoot || hostedSession.cwd,
        ),
    );
    const engineerResult = await runEngineerWithSegmentHandoff({
        continuation,
        sessionManager,
        hostedSession,
    });
    if (!engineerResult.completed) {
        return {
            repairRequired: false,
            executionComplete: false,
            executionContext: workflow,
            ...(engineerResult.checkpointPending
                ? { checkpointPending: true, checkpointId: engineerResult.checkpointId }
                : {}),
            ...(engineerResult.paused ? { paused: true, pauseReason: engineerResult.pauseReason } : {}),
            ...(engineerResult.error ? { error: engineerResult.error } : {}),
        };
    }
    try {
        await finalizePlanImplementation({
            projectRoot: workflow.projectRoot || hostedSession.cwd,
            planName: continuation.plan.planName,
            triageMeta: workflow.triageMeta,
            executionContext: workflow,
            executionReport: engineerResult.completionReport,
            hostedSession,
        });
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
            repairRequired: true,
            executionComplete: false,
            error: reason,
            executionContext: workflow,
            ...(engineerResult.completionReport ? { completionReport: engineerResult.completionReport } : {}),
        };
    }
    return {
        repairRequired: false,
        executionComplete: true,
        executionContext: workflow,
        ...(engineerResult.completionReport ? { completionReport: engineerResult.completionReport } : {}),
    };
}
