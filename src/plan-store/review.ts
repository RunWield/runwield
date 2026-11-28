import type { IndividualReviewSource, SharedPlanReviewEvidence } from "@runwield/plans/live-review";
import { managedPlanStoreActive, applyManagedReview } from "./managed.ts";
import { withPlanAccess, type PlanAccess } from "./handles.ts";
import { selectPlanAccess } from "./handles.ts";
import {
    selectedPackage,
    packageController,
    loadPackageWorkflowPlan,
    assertPackageWorkflowInput,
    capturePackageWorkflowInput,
    updatePackageWorkflowMetadata,
} from "./workflows.ts";
import { currentPackageSelection } from "./workflows.ts";
import { savePlanDocument } from "./index.ts";
import { preparePlanWorkflow } from "./index.ts";
import { resolvePlanQuestions } from "../shared/plan-questions.ts";
import {
    projectPlanType,
    injectFrontMatter,
    parsePlanFrontMatter,
    splitPlanMarkdownBody,
    getPlanRevisionForText,
    planDocumentMarkdown,
} from "@runwield/plans/format";
import { resolve } from "node:path";
import { reviewSourceStillMatches } from "@runwield/plans/review-markdown";
import { getStoredPlanPath, loadPlanFileStrict, writePlanMarkdownWithRevision } from "../plan-store.ts";

import { loadPlan } from "./queries.ts";
import { buildPlanEventUpdates, isPlanReviewableWithoutReopen, reopensReviewOnEdit } from "@runwield/plans/lifecycle";
import { recordPlanEvent } from "./events.ts";
import { assertSharedPlanWriteAllowed } from "@runwield/plans/collaboration-lock";
import { runPlanReviewDecisionTransition, withOrderedTransitionResources } from "./transitions.ts";
import {
    readPendingRetainedReview,
    retainPlanReviewOperationResult,
    type RetainedReviewCommit,
} from "./operation-results.ts";
import { captureBatchOperation } from "@runwield/plans/operation-receipts";
import { PLAN_APPROVAL_ACTIONS } from "../shared/workflow/plan-approval.ts";
import { pickControllerState, stripRuntimeFields } from "@runwield/plans/controller-state";
import { controllerStatesEqual, readControllerRecord, writeControllerState } from "./controllers.ts";
import { loadPlanActionEvidence } from "../shared/workflow/plan-actions.ts";
import { resolveWorkflowPlanLocation } from "./index.ts";
import type { PlanFrontMatter } from "@runwield/plans";
import type { PlanApprovalAction, PlanReviewContent } from "@runwield/plans/lifecycle";
import type { PlanWorktreeExpectation } from "@runwield/plans/lifecycle";

export interface SharedPlanReviewDecision extends PlanReviewContent {
    approved?: boolean;
    conversationTurn?: boolean;
    approvalAction?: PlanApprovalAction;
}

export interface SharedPlanReviewActionOptions extends IndividualReviewSource {
    packageSelection?: PlanAccess;
    operationId?: string;
    allowPackageTimestampChanges?: boolean;
    requireExactPlanRevision?: boolean;
    decision: SharedPlanReviewDecision;
}

export interface SharedPlanReviewActionResult {
    approved: boolean;
    conversationTurn?: boolean;
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

export class StaleRetainedReviewWriteError extends Error {}

function reviewTransitionRejected(
    transition: { status: string; message?: string; transitionId?: string },
    fallback: string,
): SharedPlanReviewActionResult {
    const message = transition.message || fallback;
    return {
        ...reviewRejected(message),
        ...(transition.status === "needs_recovery" &&
            transition.transitionId && {
                recoveryRequired: { message, entryIds: [transition.transitionId] },
            }),
    };
}

function validatedClassification(
    classification: PlanFrontMatter["classification"] | undefined,
): "PROJECT" | "PLANNED_CHANGE" | null {
    if (classification === "PROJECT" || classification === "PLANNED_CHANGE") return classification;
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

async function finishRetainedReviewWrite(
    cwd: string,
    proof: RetainedReviewCommit,
    reviewEvidence?: SharedPlanReviewEvidence,
) {
    const location = await resolveWorkflowPlanLocation(cwd, proof.planName, { readOnly: true });
    const current = location.plan;
    if (
        !current ||
        current.attrs.planId !== proof.planId ||
        resolve(current.path) !== resolve(proof.path) ||
        ![proof.beforeRevision, proof.afterRevision].includes(current.revision)
    )
        throw new StaleRetainedReviewWriteError(
            "The reviewed Plan changed outside the decision. Current edits were preserved.",
        );
    if (current.revision === proof.beforeRevision) {
        const issue = await validateReviewEvidence(cwd, proof.planName, reviewEvidence);
        if (issue) throw new StaleRetainedReviewWriteError(issue.feedback);
    }
    const identity = { planName: proof.planName, planId: proof.planId };
    const controller = await readControllerRecord(location.documentRoot, identity);
    const revision = controller?.revision || 0;
    const alreadyWritten =
        controllerStatesEqual(controller?.state || {}, proof.controllerState) &&
        JSON.stringify(controller?.recovery) === JSON.stringify(proof.controllerRecovery);
    if (revision !== proof.controllerRevision && (!alreadyWritten || revision !== proof.controllerRevision + 1))
        throw new StaleRetainedReviewWriteError(
            "The Plan controller changed after review. Current edits were preserved.",
        );
    if (current.revision !== proof.afterRevision)
        await writePlanMarkdownWithRevision(current.path, proof.markdown, proof.beforeRevision);
    if (!alreadyWritten) {
        const clears = Object.fromEntries(Object.keys(controller?.state || {}).map((field) => [field, undefined]));
        await writeControllerState(
            location.documentRoot,
            identity,
            { ...clears, ...proof.controllerState },
            {
                expectedRevision: revision,
                recovery: proof.controllerRecovery ?? null,
            },
        );
    }
}

/** Resume only the exact generations recorded before a retained checkout review started writing. */
export async function resumeRetainedReviewWrite(
    cwd: string,
    source: IndividualReviewSource,
): Promise<SharedPlanReviewActionResult | undefined> {
    const pending = readPendingRetainedReview();
    const proof = pending?.retained;
    if (!proof || !pending) return undefined;
    if (
        proof.planId !== source.originalAttrs.planId ||
        proof.planName !== source.planName ||
        resolve(proof.path) !== resolve(source.planPath)
    )
        throw new Error("Retained review write belongs to a different Plan source.");
    return await withOrderedTransitionResources(
        cwd,
        [
            { kind: "plan", id: proof.planName },
            ...(proof.worktreeId ? [{ kind: "attempt" as const, id: proof.worktreeId }] : []),
        ],
        async () => {
            await finishRetainedReviewWrite(cwd, proof, source.reviewEvidence);
            return pending.result;
        },
    );
}

export async function applySharedPlanReviewDecision(
    options: SharedPlanReviewActionOptions,
): Promise<SharedPlanReviewActionResult> {
    if (managedPlanStoreActive()) return await applyManagedReview(options);
    if (!options.packageSelection && !currentPackageSelection()) {
        const selection = await selectPlanAccess(options.cwd, options.planName);
        if (selection) return await applySharedPlanReviewDecision({ ...options, packageSelection: selection });
    }
    if (options.packageSelection)
        return await withPlanAccess(
            options.cwd,
            options.packageSelection,
            () => applySharedPlanReviewDecisionInScope(options),
            options.planName,
        );
    return await applySharedPlanReviewDecisionInScope(options);
}
async function applySharedPlanReviewDecisionInScope({
    packageInput,
    cwd,
    planName,
    planPath,
    planWithFrontMatter,
    planRevision,
    expectedControllerRevision,
    originalAttrs,
    allowPackageTimestampChanges,
    requireExactPlanRevision,
    trustedClassification,
    trustedWorkKind,
    expectedSessionId,
    reviewEvidence,
    decision,
}: SharedPlanReviewActionOptions): Promise<SharedPlanReviewActionResult> {
    const exactPlanRevision = requireExactPlanRevision ? planRevision : undefined;
    if (!currentPackageSelection()) await preparePlanWorkflow(cwd, planName);
    const location = currentPackageSelection()
        ? { plan: await loadPackageWorkflowPlan(planName), documentRoot: cwd }
        : await resolveWorkflowPlanLocation(cwd, planName);
    if (location.plan && resolve(location.plan.path) === resolve(planPath)) {
        cwd = location.documentRoot;
    } else if (location.plan && resolve(getStoredPlanPath(cwd, planName)) === resolve(planPath)) {
        const reviewedBody = currentPackageSelection()
            ? planWithFrontMatter
            : splitPlanMarkdownBody(planWithFrontMatter).body;
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
    const conversationTurn = decision.conversationTurn === true;
    const approved = !conversationTurn && decision.approved === true;
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

    if (currentPackageSelection()) {
        if (!packageInput) return reviewRejected("Package review requires the complete retained input.");
        const result = {
            approved,
            ...(conversationTurn ? { conversationTurn: true } : {}),
            feedback: decision.feedback,
            approvalAction: decision.approvalAction,
        };
        const transition = await runPlanReviewDecisionTransition({
            projectRoot: cwd,
            planName,
            approved,
            decide: async ({ beforePlan }) => {
                if (!beforePlan || beforePlan.attrs.status !== originalAttrs.status)
                    throw new Error("Plan Status changed after review opened.");
                if (exactPlanRevision !== undefined && beforePlan.revision !== exactPlanRevision)
                    throw new Error("Plan changed after review opened. Refresh the review before deciding.");
                if (
                    expectedControllerRevision !== undefined &&
                    beforePlan.controllerRevision !== expectedControllerRevision &&
                    !(
                        allowPackageTimestampChanges &&
                        controllerStatesEqual(
                            { ...originalAttrs, updatedAt: undefined },
                            { ...beforePlan.attrs, updatedAt: undefined },
                        )
                    )
                )
                    throw new Error("Plan changed after review opened. Refresh the review before deciding.");
                await assertPackageWorkflowInput(planName, packageInput, { kind: "markdown" });
                const current = await selectedPackage(planName);
                if (current.metadata.archive && !current.metadata.archive.restoredAt)
                    throw new Error("This Plan package is archived.");
                assertSharedPlanWriteAllowed(await packageController(current));
                let text = typeof decision.plan === "string" ? decision.plan : beforePlan.markdown;
                if (approved) text = resolvePlanQuestions(text, decision.questionAnswers);
                if (conversationTurn) {
                    retainPlanReviewOperationResult(result);
                    await savePlanDocument(current.metadata.planId, "context.md", beforePlan.revision, text);
                    return await loadPackageWorkflowPlan(planName);
                }

                const nextAttrs = {
                    ...beforePlan.attrs,
                    classification: canonicalClassification,
                    ...(trustedWorkKind ? { workKind: trustedWorkKind } : {}),
                    ...(approved && approvedPolicy ? approvedPolicy : {}),
                };
                if (canonicalClassification === "PROJECT") {
                    nextAttrs.executionAgent = undefined;
                    nextAttrs.collaborationRecommendation = undefined;
                    nextAttrs.frontend = undefined;
                }
                if (!isPlanReviewableWithoutReopen(nextAttrs.status))
                    Object.assign(
                        nextAttrs,
                        buildPlanEventUpdates("review_reopened", nextAttrs.status, { triageMeta: nextAttrs }),
                    );
                Object.assign(
                    nextAttrs,
                    buildPlanEventUpdates(approved ? "review_approved" : "review_feedback", nextAttrs.status, {
                        triageMeta: nextAttrs,
                        failureReason: decision.feedback,
                    }),
                );
                const nextDefinition = {
                    ...current.metadata.definition,
                    classification: canonicalClassification,
                    ...(trustedWorkKind ? { workKind: trustedWorkKind } : {}),
                    ...(approved && approvedPolicy ? approvedPolicy : {}),
                    status: nextAttrs.status!,
                };
                if (canonicalClassification === "PROJECT") {
                    delete nextDefinition.executionAgent;
                    delete nextDefinition.collaborationRecommendation;
                }
                const retained = await capturePackageWorkflowInput(planName, nextDefinition, text);
                await assertPackageWorkflowInput(planName, packageInput, { kind: "markdown" });
                await updatePackageWorkflowMetadata(
                    planName,
                    nextAttrs,
                    beforePlan.revision,
                    { review: approved ? retained : undefined, readiness: undefined },
                    approved ? "approved" : undefined,
                    { text, input: retained, result },
                );
                return await loadPackageWorkflowPlan(planName);
            },
        });
        if (transition.status !== "committed") return reviewTransitionRejected(transition, "Package review changed.");
        const current = transition.value as Awaited<ReturnType<typeof loadPackageWorkflowPlan>>;
        return {
            ...result,
            revision: current.revision,
            ...(approved ? { planAttrs: current.attrs } : {}),
        };
    }

    // A chat message is not a lifecycle decision. Validate the saved source even
    // when there is no edit, but do not normalize or rewrite its bytes.
    if (conversationTurn && (typeof decision.plan !== "string" || decision.plan === planWithFrontMatter)) {
        const current = await loadPlanFileStrict(planPath);
        if (
            current.kind !== "loaded" ||
            (exactPlanRevision !== undefined && current.revision !== exactPlanRevision) ||
            (expectedControllerRevision !== undefined && current.controllerRevision !== expectedControllerRevision) ||
            (current.revision !== planRevision &&
                !reviewSourceStillMatches(current, originalAttrs, splitPlanMarkdownBody(planWithFrontMatter).body))
        )
            return reviewRejected("Plan changed while review was open. Reload the Plan and review again.");
        const result = {
            approved: false,
            conversationTurn: true,
            feedback: decision.feedback,
            revision: current.revision,
        };
        retainPlanReviewOperationResult(result);
        return result;
    }

    let reviewedPlan = typeof decision.plan === "string" ? decision.plan : planWithFrontMatter;
    if (approved) reviewedPlan = resolvePlanQuestions(reviewedPlan, decision.questionAnswers);
    const canonicalReviewOverrides = {
        planId: originalAttrs.planId,
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
    const meaningChanged = !reviewSourceStillMatches(
        { attrs: reviewedAttrs, body: splitPlanMarkdownBody(reviewedPlan).body },
        originalAttrs,
        reviewBaseBody,
    );
    const revisionCancelsApproval = meaningChanged && reopensReviewOnEdit(originalAttrs.status);
    if (resolve(getStoredPlanPath(cwd, planName)) !== resolve(planPath))
        return reviewRejected("The selected review document is no longer the Plan's saved source.");
    const reopenWorktreeId = isPlanReviewableWithoutReopen(originalAttrs.status)
        ? undefined
        : (originalAttrs.worktreeId ?? undefined);
    const decide = async (beforePlan: Awaited<ReturnType<typeof loadPlan>>): Promise<SharedPlanReviewActionResult> => {
        if (
            !beforePlan ||
            resolve(beforePlan.path) !== resolve(planPath) ||
            beforePlan.attrs.planId !== originalAttrs.planId
        )
            throw new Error("The reviewed Plan document is no longer the selected source.");
        if (
            (exactPlanRevision !== undefined && beforePlan.revision !== exactPlanRevision) ||
            (expectedControllerRevision !== undefined &&
                beforePlan.controllerRevision !== expectedControllerRevision) ||
            (beforePlan.revision !== planRevision &&
                !reviewSourceStillMatches(beforePlan, originalAttrs, reviewBaseBody))
        ) {
            throw new Error("Plan changed after review opened; reload the review before applying this decision.");
        }
        let nextMarkdown = reviewedPlan;
        let nextAttrs = { ...beforePlan.attrs, ...stripRuntimeFields(reviewedAttrs) };
        let status = beforePlan.attrs.status;
        if ((!conversationTurn && !isPlanReviewableWithoutReopen(status)) || revisionCancelsApproval) {
            const reopenUpdates = buildPlanEventUpdates("review_reopened", status, {
                triageMeta: nextAttrs,
            });
            nextMarkdown = injectFrontMatter(nextMarkdown, reopenUpdates);
            nextAttrs = { ...nextAttrs, ...reopenUpdates };
            status = "draft";
        }
        if (!conversationTurn) {
            const event = approved ? "review_approved" : "review_feedback";
            const eventUpdates = buildPlanEventUpdates(event, status, {
                triageMeta: nextAttrs,
                failureReason: decision.feedback,
            });
            nextMarkdown = injectFrontMatter(nextMarkdown, eventUpdates);
            nextAttrs = { ...nextAttrs, ...eventUpdates };
        }
        const decisionResult = {
            approved,
            ...(conversationTurn && { conversationTurn: true }),
            feedback: decision.feedback,
            ...(decision.approvalAction && { approvalAction: decision.approvalAction }),
        };
        const identity = { planName, planId: beforePlan.attrs.planId };
        const updates = pickControllerState(nextAttrs);
        if (captureBatchOperation() && identity.planId) {
            const controller = await readControllerRecord(cwd, identity);
            const markdown = planDocumentMarkdown(nextMarkdown);
            const revision = await getPlanRevisionForText(markdown);
            const proof: RetainedReviewCommit = {
                path: beforePlan.path,
                planId: identity.planId,
                planName,
                beforeRevision: beforePlan.revision,
                afterRevision: revision,
                markdown,
                controllerRevision: beforePlan.controllerRevision,
                controllerState: { ...controller?.state, ...updates },
                controllerRecovery: reopenWorktreeId ? undefined : controller?.recovery,
                worktreeId: reopenWorktreeId,
            };
            const result = {
                ...decisionResult,
                revision,
                ...(approved && { planAttrs: nextAttrs }),
            };
            retainPlanReviewOperationResult(result, proof);
            await finishRetainedReviewWrite(cwd, proof, reviewEvidence);
            return result;
        }
        await writeControllerState(cwd, identity, updates, {
            expectedRevision: beforePlan.controllerRevision,
            ...(reopenWorktreeId ? { recovery: null } : {}),
        });
        const revision = await writePlanMarkdownWithRevision(beforePlan.path, nextMarkdown, beforePlan.revision);
        return {
            ...decisionResult,
            revision,
            ...(approved && { planAttrs: (await loadPlan(cwd, planName))?.attrs || nextAttrs }),
        };
    };
    if (captureBatchOperation()) {
        return await withOrderedTransitionResources(
            cwd,
            [
                { kind: "plan", id: planName },
                ...(reopenWorktreeId ? [{ kind: "attempt" as const, id: reopenWorktreeId }] : []),
            ],
            async () => await decide(await loadPlan(cwd, planName)),
        );
    }
    const transition = await runPlanReviewDecisionTransition({
        projectRoot: cwd,
        planName,
        approved,
        worktreeId: reopenWorktreeId,
        decide: ({ beforePlan }) => decide(beforePlan),
    });
    return transition.status === "committed"
        ? (transition.value as SharedPlanReviewActionResult)
        : reviewTransitionRejected(transition, "Plan changed while review was open. Reload the Plan and review again.");
}

/** Bind approval, readiness and the returned revision under the same owner locks. */
export async function applyPlanReviewForExecution(options: SharedPlanReviewActionOptions) {
    if (managedPlanStoreActive()) {
        const applied = await applyManagedReview(options);
        if (!applied.approved) return { ...applied, approvalControllerRevision: undefined };
        await recordPlanEvent({
            cwd: options.cwd,
            planName: options.planName,
            event: "readiness_passed",
            expectedRevision: applied.revision,
        });
        return {
            ...applied,
            approvalControllerRevision: (await loadPlan(options.cwd, options.planName))?.controllerRevision,
        };
    }
    const { withOrderedTransitionResources } = await import("./transitions.ts");
    return await withOrderedTransitionResources(
        options.cwd,
        [{ kind: "catalog" }, { kind: "plan", id: options.planName }],
        async () => {
            const applied = await applySharedPlanReviewDecision(options);
            if (applied.cancellationReason || applied.recoveryRequired)
                throw new Error(applied.feedback || "The Plan changed. Reload this review.");
            if (!applied.approved) return { ...applied, approvalControllerRevision: undefined };
            await recordPlanEvent({
                cwd: options.cwd,
                planName: options.planName,
                event: "readiness_passed",
                currentStatus: "approved",
                expectedRevision: applied.revision,
            });
            const ready = await loadPlan(options.cwd, options.planName);
            if (!ready) throw new Error(`Plan not found: ${options.planName}`);
            return { ...applied, approvalControllerRevision: ready.controllerRevision };
        },
    );
}
