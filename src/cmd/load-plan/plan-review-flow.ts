import { isSequencePlan } from "../../shared/project-plan.ts";
import { applySequenceReviewDecision, prepareSequenceReview } from "../../shared/workflow/sequence-review.ts";
/**
 * @module cmd/load-plan/plan-review-flow
 * Direct Plan Review handling for Plans loaded from disk.
 *
 * This module owns the shortcut that opens Plannotator without first running
 * Planner or Architect. The review decision still routes through the normal
 * lifecycle, planning, execution, and Slicer handoffs.
 */

import { AGENTS, CLI_BIN } from "../../constants.js";
import { loadPlan, type PlanFrontMatter, resolvePlanExecutionPolicy } from "../../plan-store.js";
import { decidePostExecution, decidePostPlanning } from "../../shared/workflow/decisions.ts";
import { isPlanReviewableWithoutReopen, isProjectPlan, recordPlanEvent } from "../../shared/workflow/plan-lifecycle.js";
import { resolveWorkflowPlanLocation } from "../../shared/workflow/plan-location.ts";
import { loadPlanActionEvidence } from "../../shared/workflow/plan-actions.ts";
import { normalizePlanApprovalAction, PLAN_APPROVAL_ACTIONS } from "../../shared/workflow/plan-approval.ts";
import {
    appendSessionCompleteGuidance,
    requestRecoverablePlanReview,
    SESSION_COMPLETE_GUIDANCE,
} from "../../shared/workflow/plan-review-recovery.js";
import { RuntimeInteractionOutcomes } from "../../shared/session/session-runtime-interactions.js";
import type { UiAPI } from "../../ui/tui/types.js";
import { buildReReviewRevisionRequest } from "./plan-presentation.ts";
import {
    confirmAffectedPathChangesBeforeExecution,
    executePostPlanningDecision,
    prepareApprovedPlanForWork,
    shouldKeepPlanningAgentActive,
    validatePlanExecutionPolicyForReadiness,
    validatePostExecutionDecision,
} from "./plan-execution.ts";
import { assertRecoveryWorktreeIsManaged, resolveRecoveryWorktree } from "./plan-recovery-worktree.ts";
import type { PlanSessionSurface } from "./plan-session-types.ts";

interface ReviewableLoadedPlan {
    planName: string;
    path: string;
    attrs: PlanFrontMatter;
    body?: string;
    markdown?: string;
}

interface DirectReviewOptions {
    projectRoot: string;
    plan: ReviewableLoadedPlan;
    agentName: string;
    activatePlanningAgent?: boolean;
    deferExecution?: boolean;
    uiAPI: UiAPI;
    executePlan: PlanSessionSurface["executePlan"];
    continueWorkflowValidation: PlanSessionSurface["runValidation"];
    runPlanningAgent: PlanSessionSurface["runPlanningAgent"];
    runSlicerAgent: PlanSessionSurface["runSlicerAgent"];
    session: PlanSessionSurface;
}

export interface DirectPlanReviewEligibility {
    eligible: boolean;
    reason?: "unsupported_status" | "invalid_execution_policy";
    message?: string;
}

export interface DirectPlanReviewResult {
    keepPlanAgentActive: boolean;
    reviewUnanswered?: boolean;
    executionToStart?: {
        options: Parameters<PlanSessionSurface["executePlan"]>[0];
        fallbackPlanContent: string;
    };
}

const DIRECT_REVIEW_STATUSES = new Set(["draft", "feedback", "approved", "ready_for_work"]);

export function getDirectPlanReviewEligibility(
    plan: { attrs: PlanFrontMatter },
): DirectPlanReviewEligibility {
    if (!DIRECT_REVIEW_STATUSES.has(plan.attrs.status || "")) {
        return { eligible: false, reason: "unsupported_status" };
    }
    if (isProjectPlan(plan.attrs)) return { eligible: true };

    const policy = resolvePlanExecutionPolicy(plan.attrs);
    if (!policy.ok) {
        return { eligible: false, reason: "invalid_execution_policy", message: policy.error };
    }

    return { eligible: true };
}

export async function reviewLoadedPlanDirectly({
    projectRoot,
    plan,
    agentName,
    activatePlanningAgent = true,
    deferExecution = false,
    uiAPI,
    executePlan,
    continueWorkflowValidation,
    runPlanningAgent,
    runSlicerAgent,
    session,
}: DirectReviewOptions): Promise<DirectPlanReviewResult> {
    assertRecoveryWorktreeIsManaged(
        plan.planName,
        await resolveRecoveryWorktree(projectRoot, plan),
    );

    if (isSequencePlan(plan.attrs)) {
        // Freeze the complete saved set before presentation. No Planner turn is needed to open it.
        const { documentRoot } = await resolveWorkflowPlanLocation(projectRoot, plan.planName);
        const documents = await prepareSequenceReview(documentRoot, plan.planName);
        const recovered = await requestRecoverablePlanReview({
            requestReview: () =>
                session.reviewPlan({
                    planName: plan.planName,
                    planPath: documents[0].planPath,
                    documentRoot,
                    planningAgentName: agentName,
                    triageMeta: documents[0].frontmatter,
                    sequenceDocuments: documents,
                }),
            requestRetry: async ({ response }) => {
                if (response?.cancellationReason === "runtime_cancel") {
                    return { outcome: RuntimeInteractionOutcomes.CANCELED, value: false };
                }
                const answer = await uiAPI.promptSelect("Review the Sequence again?", [
                    { value: "yes", label: "Yes" },
                    { value: "no", label: "No" },
                ]);
                return answer === "yes"
                    ? { outcome: RuntimeInteractionOutcomes.ACCEPTED, value: true }
                    : { outcome: RuntimeInteractionOutcomes.CANCELED, value: false };
            },
        });
        if (recovered.kind === "complete") {
            uiAPI.appendSystemMessage(SESSION_COMPLETE_GUIDANCE, false, "RunWield");
            return { keepPlanAgentActive: true, reviewUnanswered: true };
        }
        const response = recovered.response;
        if (!response.sequenceDecision) {
            uiAPI.appendSystemMessage(
                "The review response omitted the Sequence decisions. Reopen the complete review.",
                true,
                "RunWield",
            );
            return { keepPlanAgentActive: true };
        }
        const applied = await applySequenceReviewDecision({
            cwd: documentRoot,
            documents,
            decision: response.sequenceDecision,
        });
        if (applied.cancellationReason) {
            uiAPI.appendSystemMessage(applied.feedback || "Reopen the complete Sequence review.", true, "RunWield");
            return { keepPlanAgentActive: true };
        }
        const outcome = applied.workflowOutcome!;
        if (!applied.approved) {
            const planningResult = await runPlanningAgent({
                agentName,
                initialRequest: buildReReviewRevisionRequest(plan.planName, applied.feedback),
                triageMeta: applied.planAttrs || plan.attrs,
                images: outcome.images,
                planName: plan.planName,
                associationPurpose: "review",
            });
            const decision = decidePostPlanning(planningResult, {
                planningAgentName: agentName,
                fallbackTriageMeta: applied.planAttrs || plan.attrs,
            });
            await executePostPlanningDecision({
                decision,
                fallbackPlanContent: plan.markdown || plan.body || "",
                uiAPI,
                executePlan,
                continueWorkflowValidation,
                runSlicerAgent,
                session,
            });
            return { keepPlanAgentActive: shouldKeepPlanningAgentActive(decision) };
        }
        if (applied.approvalAction !== PLAN_APPROVAL_ACTIONS.RUN) {
            uiAPI.appendSystemMessage(
                appendSessionCompleteGuidance(`Plan saved. Resume later with: ${CLI_BIN} load-plan ${plan.planName}`),
                false,
                "RunWield",
            );
            return { keepPlanAgentActive: true };
        }
        if (!outcome.planName) throw new Error("The Sequence has no first child to execute.");
        const child = await loadPlan(documentRoot, outcome.planName);
        if (!child || child.attrs.planId !== outcome.triageMeta?.planId) {
            uiAPI.appendSystemMessage(
                "The first Sequence child changed. Reopen its saved Plan before execution.",
                true,
                "RunWield",
            );
            return { keepPlanAgentActive: true };
        }
        const confirmed = await confirmAffectedPathChangesBeforeExecution({
            projectRoot,
            planName: outcome.planName,
            triageMeta: child.attrs,
            uiAPI,
        });
        if (!confirmed) return { keepPlanAgentActive: false };
        const approvalEvidence = await loadPlanActionEvidence(documentRoot, child.attrs.planId || "");
        if (approvalEvidence.kind !== "success") {
            uiAPI.appendSystemMessage(approvalEvidence.message, true, "RunWield");
            return { keepPlanAgentActive: true };
        }
        const executionOptions = {
            planName: outcome.planName,
            triageMeta: child.attrs,
            approvalEvidence: approvalEvidence.evidence,
            reviewFeedback: outcome.feedback,
            reviewImages: outcome.images,
        };
        if (deferExecution) {
            return {
                keepPlanAgentActive: false,
                executionToStart: {
                    options: executionOptions,
                    fallbackPlanContent: child.markdown || child.body || "",
                },
            };
        }
        const execRes = await executePlan(executionOptions);
        const policy = resolvePlanExecutionPolicy(child.attrs);
        const executionDecision = decidePostExecution(execRes, {
            planName: outcome.planName,
            triageMeta: child.attrs,
            executionAgentName: policy.ok ? policy.policy.executionAgent : AGENTS.ENGINEER,
        });
        await validatePostExecutionDecision({
            executionDecision,
            executionResult: execRes,
            fallbackPlanContent: child.markdown || child.body || "",
            continueWorkflowValidation,
            session,
            uiAPI,
        });
        return { keepPlanAgentActive: false };
    }
    // Reopening only inspects the Plan. A model is needed only if feedback starts an Agent turn.
    if (activatePlanningAgent) await session.switchAgent(agentName);

    const recoverableReview = await requestRecoverablePlanReview({
        requestReview: () =>
            session.reviewPlan({
                planName: plan.planName,
                planPath: plan.path,
                planningAgentName: agentName,
                triageMeta: plan.attrs,
            }),
        requestRetry: async ({ response }) => {
            if (response?.cancellationReason === "runtime_cancel") {
                return { outcome: RuntimeInteractionOutcomes.CANCELED, value: false };
            }
            const value = await uiAPI.promptSelect("Review the Plan again?", [
                { value: "yes", label: "Yes" },
                { value: "no", label: "No" },
            ]);
            return value === "yes"
                ? { outcome: RuntimeInteractionOutcomes.ACCEPTED, value: true }
                : { outcome: RuntimeInteractionOutcomes.CANCELED, value: false };
        },
        onUnanswered: ({ reason }) => {
            uiAPI.appendSystemMessage(
                `Plan review ended without an answer (${reason}).`,
                false,
                "RunWield",
            );
        },
    });

    if (recoverableReview.kind === "complete") {
        uiAPI.appendSystemMessage(SESSION_COMPLETE_GUIDANCE, false, "RunWield");
        return { keepPlanAgentActive: true, reviewUnanswered: true };
    }

    const reviewResult = recoverableReview.response;

    if (reviewResult.remoteReview) {
        uiAPI.appendSystemMessage(
            reviewResult.message || `Plan saved for remote review: ${plan.planName}`,
            false,
            "RunWield",
        );
        return { keepPlanAgentActive: true };
    }

    if (!isPlanReviewableWithoutReopen(plan.attrs.status)) {
        await session.clearActiveExecutionWorkflow();
    }

    if (reviewResult.approved) {
        let reloadedAfterReview = false;
        try {
            const { plan: latestPlan } = await resolveWorkflowPlanLocation(projectRoot, plan.planName);
            if (latestPlan) {
                plan.attrs = reviewResult.planAttrs
                    ? { ...latestPlan.attrs, ...reviewResult.planAttrs }
                    : latestPlan.attrs;
                plan.body = latestPlan.body;
                plan.markdown = latestPlan.markdown || latestPlan.body || plan.markdown;
                plan.path = latestPlan.path;
                reloadedAfterReview = true;
            }
        } catch {
            // Keep the in-memory Plan if a test fake does not support reloading after review.
        }
        if (!reloadedAfterReview && reviewResult.planAttrs) {
            plan.attrs = { ...plan.attrs, ...reviewResult.planAttrs };
        }
        const approvalAction = normalizePlanApprovalAction({
            classification: plan.attrs.classification,
            action: reviewResult.approvalAction,
        });
        if (isProjectPlan(plan.attrs)) {
            if (!validatePlanExecutionPolicyForReadiness(plan, uiAPI)) {
                return { keepPlanAgentActive: true };
            }
            await recordPlanEvent({
                cwd: projectRoot,
                planName: plan.planName,
                event: "epic_readiness_passed",
                currentStatus: "approved",
                details: { triageMeta: plan.attrs },
            });
            plan.attrs.status = "ready_for_decomposition";
            uiAPI.appendSystemMessage(
                `PROJECT Epic ready for decomposition or child plan selection: ${plan.planName}`,
                false,
                "RunWield",
            );
            if (approvalAction === PLAN_APPROVAL_ACTIONS.DECOMPOSE) {
                await runSlicerAgent({
                    planName: plan.planName,
                    triageMeta: plan.attrs,
                    reviewFeedback: reviewResult.feedback,
                    reviewImages: reviewResult.images,
                });
            } else {
                uiAPI.appendSystemMessage(
                    appendSessionCompleteGuidance(
                        `Plan saved. Resume later with: ${CLI_BIN} load-plan ${plan.planName}`,
                    ),
                    false,
                    "RunWield",
                );
            }
            return { keepPlanAgentActive: true };
        }

        const ready = await prepareApprovedPlanForWork(
            projectRoot,
            plan,
            uiAPI,
        );
        if (!ready) {
            return { keepPlanAgentActive: true };
        }
        if (approvalAction === PLAN_APPROVAL_ACTIONS.RUN) {
            const confirmed = await confirmAffectedPathChangesBeforeExecution({
                projectRoot,
                planName: plan.planName,
                triageMeta: plan.attrs,
                uiAPI,
            });
            if (!confirmed) return { keepPlanAgentActive: false };

            const approvalEvidence = await loadPlanActionEvidence(projectRoot, plan.attrs.planId || "");
            if (approvalEvidence.kind !== "success") {
                uiAPI.appendSystemMessage(approvalEvidence.message, true, "RunWield");
                return { keepPlanAgentActive: true };
            }
            const executionOptions = {
                planName: plan.planName,
                triageMeta: plan.attrs,
                approvalEvidence: approvalEvidence.evidence,
                reviewFeedback: reviewResult.feedback,
                reviewImages: reviewResult.images,
            };
            if (deferExecution) {
                return {
                    keepPlanAgentActive: false,
                    executionToStart: {
                        options: executionOptions,
                        fallbackPlanContent: plan.markdown || plan.body || "",
                    },
                };
            }
            const execRes = await executePlan(executionOptions);
            const policy = resolvePlanExecutionPolicy(plan.attrs);
            const executionDecision = decidePostExecution(execRes, {
                planName: plan.planName,
                triageMeta: plan.attrs,
                executionAgentName: policy.ok ? policy.policy.executionAgent : AGENTS.ENGINEER,
            });
            await validatePostExecutionDecision({
                executionDecision,
                executionResult: execRes,
                fallbackPlanContent: plan.markdown || plan.body || "",
                continueWorkflowValidation,
                session,
                uiAPI,
            });
        } else {
            uiAPI.appendSystemMessage(
                appendSessionCompleteGuidance(
                    `Plan saved. Resume later with: ${CLI_BIN} load-plan ${plan.planName}`,
                ),
                false,
                "RunWield",
            );
            return { keepPlanAgentActive: true };
        }
        return { keepPlanAgentActive: false };
    }

    const outcome = await runPlanningAgent({
        agentName,
        initialRequest: buildReReviewRevisionRequest(plan.planName, reviewResult.feedback),
        triageMeta: plan.attrs,
        images: reviewResult.images,
        planName: plan.planName,
        associationPurpose: "review",
    });

    const planningDecision = decidePostPlanning(outcome, {
        planningAgentName: agentName,
        fallbackTriageMeta: plan.attrs,
    });
    const postPlanningResult = await executePostPlanningDecision({
        decision: planningDecision,
        fallbackPlanContent: plan.markdown || plan.body || "",
        uiAPI,
        executePlan,
        continueWorkflowValidation,
        runSlicerAgent,
        session,
    });
    return {
        keepPlanAgentActive: postPlanningResult === "verified" || shouldKeepPlanningAgentActive(planningDecision),
    };
}
