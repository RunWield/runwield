import { resolvePlanQuestions, type PlanQuestionAnswer } from "../plan-questions.ts";
import { projectPlanType } from "../project-plan.ts";
import { resolve } from "node:path";
import { Marked } from "marked";
import {
    getStoredPlanPath,
    injectFrontMatter,
    loadPlan,
    loadPlanFileStrict,
    parsePlanFrontMatter,
    planDocumentMarkdown,
    splitPlanMarkdownBody,
    StalePlanWriteError,
    writePlanMarkdownWithRevision,
} from "../../plan-store.js";
import { buildPlanEventUpdates, isPlanReviewableWithoutReopen, recordPlanEvent } from "./plan-lifecycle.js";
import { runPlanReviewDecisionTransition } from "./state-transition.ts";
import { PLAN_APPROVAL_ACTIONS } from "./plan-approval.ts";
import { pickControllerState, stripRuntimeFields } from "./controller-state.ts";
import { writeControllerState } from "./controller-registry.ts";
import { loadPlanActionEvidence } from "./plan-actions.ts";
import { resolveWorkflowPlanLocation } from "./plan-location.ts";
import type { PlanFrontMatter } from "../../plan-store.js";
import type { PlanApprovalAction } from "./plan-approval.ts";
import type { PlanWorktreeExpectation } from "./plan-actions.ts";

export interface SharedPlanReviewDecision {
    approved?: boolean;
    questionAnswers?: PlanQuestionAnswer[];
    feedback?: string;
    approvalAction?: PlanApprovalAction;
    plan?: string;
    executionAgent?: "engineer" | "frontend-engineer";
    collaborationRecommendation?: "autonomous" | "pair";
}

export interface SharedPlanReviewEvidence {
    planId: string;
    runwieldSessionId?: string;
    status: string;
    worktree: PlanWorktreeExpectation;
}

export interface SharedPlanReviewActionOptions {
    cwd: string;
    planName: string;
    planPath: string;
    planWithFrontMatter: string;
    planRevision: string;
    originalAttrs: PlanFrontMatter;
    trustedClassification?: PlanFrontMatter["classification"];
    trustedWorkKind?: PlanFrontMatter["workKind"];
    expectedSessionId?: string;
    reviewEvidence?: SharedPlanReviewEvidence;
    decision: SharedPlanReviewDecision;
}

export interface SharedPlanReviewActionResult {
    approved: boolean;
    feedback?: string;
    approvalAction?: PlanApprovalAction;
    planAttrs?: PlanFrontMatter;
    revision?: string;
    recoveryRequired?: { message: string; entryIds: string[] };
    cancellationReason?: "stale_plan_review";
}

function readApprovedExecutionPolicy(
    decision: SharedPlanReviewDecision,
): { executionAgent: "engineer" | "frontend-engineer"; collaborationRecommendation: "autonomous" | "pair" } | null {
    const executionAgent = decision.executionAgent;
    const collaborationRecommendation = decision.collaborationRecommendation;
    if (executionAgent !== "engineer" && executionAgent !== "frontend-engineer") return null;
    if (collaborationRecommendation !== "autonomous" && collaborationRecommendation !== "pair") return null;
    return { executionAgent, collaborationRecommendation };
}

function reviewRejected(message: string): SharedPlanReviewActionResult {
    return { approved: false, feedback: message, cancellationReason: "stale_plan_review" };
}

// Only prose soft breaks are formatting. Keep code, raw HTML, hard breaks,
// links, and document structure in the comparison. This HTML is never displayed.
const reviewMarkdown = new Marked({
    gfm: true,
    breaks: false,
    walkTokens(token) {
        if (token.type === "text" && token.escaped !== true && typeof token.text === "string") {
            token.text = token.text.replace(/\r?\n/g, " ");
        }
    },
});

/**
 * Compare what the user reviewed with the current human-owned Plan document.
 *
 * A revision hashes the exact bytes, so YAML formatting alone makes it stale.
 * Review approval cares about meaning: canonicalize document Front Matter, omit
 * controller-owned projections, and compare Markdown meaning without prose wrapping
 * or table padding. The eventual write still uses the current byte revision as
 * its atomic compare-and-set.
 */
export function reviewSourceStillMatches(
    current: { attrs: PlanFrontMatter; body: string },
    originalAttrs: PlanFrontMatter,
    originalBody: string,
): boolean {
    const canonicalAttrs = (attrs: PlanFrontMatter) =>
        planDocumentMarkdown(injectFrontMatter("", stripRuntimeFields(attrs)));
    const bodyMatches =
        current.body === originalBody ||
        reviewMarkdown.parse(current.body, { async: false }) === reviewMarkdown.parse(originalBody, { async: false });
    return bodyMatches && canonicalAttrs(current.attrs) === canonicalAttrs(originalAttrs);
}

function validatedClassification(
    classification: PlanFrontMatter["classification"] | undefined,
): "PROJECT" | "PLANNED_CHANGE" | null {
    if (classification === "PROJECT") return "PROJECT";
    if (classification === "PLANNED_CHANGE" || classification === "FEATURE") return "PLANNED_CHANGE";
    return null;
}

function approvalActionAllowed(classification: "PROJECT" | "PLANNED_CHANGE", action: PlanApprovalAction | undefined) {
    if (!action) return false;
    if (action === PLAN_APPROVAL_ACTIONS.LATER) return true;
    if (classification === "PROJECT") return action === PLAN_APPROVAL_ACTIONS.DECOMPOSE;
    return action === PLAN_APPROVAL_ACTIONS.RUN;
}

function sameWorktreeEvidence(left: PlanWorktreeExpectation, right: PlanWorktreeExpectation): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

async function validateReviewEvidence(
    cwd: string,
    planName: string,
    reviewEvidence?: SharedPlanReviewEvidence,
): Promise<SharedPlanReviewActionResult | null> {
    if (!reviewEvidence) return null;
    const evidence = await loadPlanActionEvidence(cwd, reviewEvidence.planId);
    if (evidence.kind === "recovery_required") {
        return {
            approved: false,
            feedback: evidence.message,
            recoveryRequired: { message: evidence.message, entryIds: evidence.entryIds },
        };
    }
    if (evidence.kind !== "success") return reviewRejected(evidence.message);
    if (evidence.evidence.planName !== planName || evidence.evidence.planId !== reviewEvidence.planId) {
        return reviewRejected("Live review Plan evidence does not match this Plan. Reload the Plan and review again.");
    }
    // The locked decision transaction below compares the current Plan document
    // semantically. A byte revision can change solely because RunWield or a
    // formatter normalized YAML, which is not a reason to discard approval.
    if (evidence.evidence.status !== reviewEvidence.status) {
        return reviewRejected("Plan Status changed after review opened. Reload the Plan and review again.");
    }
    if (!sameWorktreeEvidence(evidence.evidence.worktree, reviewEvidence.worktree)) {
        return reviewRejected("Plan worktree evidence changed after review opened. Reload the Plan and review again.");
    }
    return null;
}

export async function applySharedPlanReviewDecision({
    cwd,
    planName,
    planPath,
    planWithFrontMatter,
    planRevision,
    originalAttrs,
    trustedClassification,
    trustedWorkKind,
    expectedSessionId,
    reviewEvidence,
    decision,
}: SharedPlanReviewActionOptions): Promise<SharedPlanReviewActionResult> {
    const location = await resolveWorkflowPlanLocation(cwd, planName);
    if (location.plan && resolve(location.plan.path) === resolve(planPath)) {
        cwd = location.documentRoot;
    } else if (location.plan && resolve(getStoredPlanPath(cwd, planName)) === resolve(planPath)) {
        const reviewedBody = splitPlanMarkdownBody(planWithFrontMatter).body;
        if (!reviewSourceStillMatches(location.plan, originalAttrs, reviewedBody)) {
            return reviewRejected(
                "Review is out of date. The Plan changed while this review was open. Reload this review, then send your decision again.",
            );
        }
        cwd = location.documentRoot;
        planPath = location.plan.path;
        planWithFrontMatter = location.plan.markdown;
        planRevision = location.plan.revision;
        originalAttrs = location.plan.attrs;
    }
    try {
        if (projectPlanType(location.plan?.attrs || originalAttrs) === "sequence") {
            return reviewRejected("Review the Sequence and every child together through plan_written.");
        }
    } catch (error) {
        return reviewRejected(error instanceof Error ? error.message : String(error));
    }
    const approved = decision.approved === true;
    const canonicalClassification = validatedClassification(trustedClassification);
    if (!canonicalClassification) return reviewRejected("Plan review classification is not supported.");
    if (expectedSessionId && reviewEvidence?.runwieldSessionId !== expectedSessionId) {
        return reviewRejected(
            "Live review Session evidence does not match this Session. Reload the Plan and review again.",
        );
    }
    if (approved && !approvalActionAllowed(canonicalClassification, decision.approvalAction)) {
        return reviewRejected("Plan review approval action is not supported for this Plan.");
    }
    const approvedPolicy = readApprovedExecutionPolicy(decision);
    if (
        approved &&
        decision.approvalAction === PLAN_APPROVAL_ACTIONS.RUN &&
        canonicalClassification === "PLANNED_CHANGE" &&
        !approvedPolicy
    ) {
        return reviewRejected("Plan review execution policy is not valid.");
    }
    const evidenceIssue = await validateReviewEvidence(cwd, planName, reviewEvidence);
    if (evidenceIssue) return evidenceIssue;

    let reviewedPlan = typeof decision.plan === "string" ? decision.plan : planWithFrontMatter;
    if (approved) reviewedPlan = resolvePlanQuestions(reviewedPlan, decision.questionAnswers);
    const canonicalReviewOverrides = {
        classification: canonicalClassification,
        type: originalAttrs.type,
        ...(trustedWorkKind ? { workKind: trustedWorkKind } : {}),
    };
    if (canonicalClassification === "PROJECT") {
        Object.assign(canonicalReviewOverrides, {
            executionAgent: null,
            collaborationRecommendation: null,
            frontend: null,
        });
    } else if (approved && approvedPolicy) {
        Object.assign(canonicalReviewOverrides, {
            executionAgent: approvedPolicy.executionAgent,
            collaborationRecommendation: approvedPolicy.collaborationRecommendation,
            frontend: null,
        });
    }
    reviewedPlan = injectFrontMatter(reviewedPlan, canonicalReviewOverrides);
    const reviewedAttrs = parsePlanFrontMatter(reviewedPlan).attrs;
    const reviewBaseBody = splitPlanMarkdownBody(planWithFrontMatter).body;
    const canonicalPlanPath = getStoredPlanPath(cwd, planName);
    let lifecycleMeta: PlanFrontMatter = reviewedAttrs;
    let committedRevision: string | undefined;
    if (resolve(canonicalPlanPath) === resolve(planPath)) {
        const reopenWorktreeId = isPlanReviewableWithoutReopen(originalAttrs.status)
            ? undefined
            : (originalAttrs.worktreeId ?? undefined);
        const reviewTransition = await runPlanReviewDecisionTransition({
            projectRoot: cwd,
            planName,
            approved,
            worktreeId: reopenWorktreeId,
            decide: async ({ beforePlan }) => {
                if (!beforePlan) throw new Error(`Plan not found: ${planName}`);
                if (
                    beforePlan.revision !== planRevision &&
                    !reviewSourceStillMatches(beforePlan, originalAttrs, reviewBaseBody)
                ) {
                    throw new Error(
                        "Plan changed after review opened; reload the review before applying this decision.",
                    );
                }
                let nextMarkdown = reviewedPlan;
                let nextAttrs = { ...beforePlan.attrs, ...stripRuntimeFields(reviewedAttrs) };
                let status = beforePlan.attrs.status;
                if (!isPlanReviewableWithoutReopen(status)) {
                    const reopenUpdates = buildPlanEventUpdates("review_reopened", status, {
                        triageMeta: nextAttrs,
                    });
                    nextMarkdown = injectFrontMatter(nextMarkdown, reopenUpdates);
                    nextAttrs = { ...nextAttrs, ...reopenUpdates };
                    status = "feedback";
                }
                const event = approved ? "review_approved" : "review_feedback";
                const eventUpdates = buildPlanEventUpdates(event, status, {
                    triageMeta: nextAttrs,
                    failureReason: decision.feedback,
                });
                nextMarkdown = injectFrontMatter(nextMarkdown, eventUpdates);
                nextAttrs = { ...nextAttrs, ...eventUpdates };
                await writeControllerState(
                    cwd,
                    { planName, planId: beforePlan.attrs.planId },
                    pickControllerState(nextAttrs),
                    {
                        expectedRevision: beforePlan.controllerRevision,
                        ...(reopenWorktreeId ? { recovery: null } : {}),
                    },
                );
                const revision = await writePlanMarkdownWithRevision(
                    beforePlan.path,
                    nextMarkdown,
                    beforePlan.revision,
                );
                return { attrs: (await loadPlan(cwd, planName))?.attrs || nextAttrs, revision };
            },
        });
        if (reviewTransition.status !== "committed") {
            return {
                approved: false,
                feedback:
                    reviewTransition.message || "Plan changed while review was open. Reload the Plan and review again.",
                cancellationReason: "stale_plan_review",
            };
        }
        const transitionValue = reviewTransition.value as { attrs?: PlanFrontMatter; revision?: string } | undefined;
        lifecycleMeta = transitionValue?.attrs || reviewedAttrs;
        committedRevision = transitionValue?.revision;
    } else {
        try {
            const current = await loadPlanFileStrict(planPath);
            if (current.kind !== "loaded") {
                return reviewRejected("Plan could not be read after review. Reload the Plan and review again.");
            }
            if (
                current.revision !== planRevision &&
                !reviewSourceStillMatches(current, originalAttrs, reviewBaseBody)
            ) {
                return reviewRejected("Plan changed while review was open. Reload the Plan and review again.");
            }
            committedRevision = await writePlanMarkdownWithRevision(planPath, reviewedPlan, current.revision);
        } catch (error) {
            if (error instanceof StalePlanWriteError) {
                return {
                    approved: false,
                    feedback: "Plan changed while review was open. Reload the Plan and review again.",
                    cancellationReason: "stale_plan_review",
                };
            }
            throw error;
        }

        const statusAllowsReview = isPlanReviewableWithoutReopen(originalAttrs.status);
        if (!statusAllowsReview) {
            const reopenedMeta = await recordPlanEvent({
                cwd,
                planName,
                event: "review_reopened",
                currentStatus: originalAttrs.status,
                details: { triageMeta: lifecycleMeta },
                expectedRevision: committedRevision,
            });
            if (reopenedMeta) lifecycleMeta = { ...lifecycleMeta, ...reopenedMeta };
        }
        const postReopenStatus = statusAllowsReview ? originalAttrs.status : "feedback";
        if (approved) {
            const approvedMeta = await recordPlanEvent({
                cwd,
                planName,
                event: "review_approved",
                currentStatus: postReopenStatus,
                details: { triageMeta: lifecycleMeta },
                expectedRevision: committedRevision,
            });
            if (approvedMeta) lifecycleMeta = { ...lifecycleMeta, ...approvedMeta };
        } else {
            const feedbackMeta = await recordPlanEvent({
                cwd,
                planName,
                event: "review_feedback",
                currentStatus: postReopenStatus,
                details: { triageMeta: lifecycleMeta, failureReason: decision.feedback },
                expectedRevision: committedRevision,
            });
            if (feedbackMeta) lifecycleMeta = { ...lifecycleMeta, ...feedbackMeta };
        }
        const latestPlan = await loadPlan(cwd, planName).catch(() => null);
        if (latestPlan?.revision) committedRevision = latestPlan.revision;
    }

    return {
        approved,
        feedback: decision.feedback,
        ...(decision.approvalAction && { approvalAction: decision.approvalAction }),
        ...(approved && { planAttrs: lifecycleMeta }),
        ...(committedRevision && { revision: committedRevision }),
    };
}
