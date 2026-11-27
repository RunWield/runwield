import { samePackagePublicationReference } from "@runwield/plans/publication-copies";
import { projects } from "@runwield/projects";
import {
    managedPlanStoreActive,
    mutateManagedPlan,
    readManagedActivePlanById,
    readManagedPlan,
    readManagedExecution,
} from "./managed.ts";
import { packageWorkflowLocks } from "./workflows.ts";
import { plans, type PlanFrontMatter } from "@runwield/plans";
import {
    buildStalePlanStatusMessage,
    type PlanEvent,
    type PlanStatus,
    type PlanEventDetails,
} from "@runwield/plans/lifecycle";
import { selectPlanAccess, withPlanAccess, type PlanAccess } from "./handles.ts";
import { withLocalPlanWorkflow } from "./access.ts";
import {
    selectedPackage,
    capturePackageWorkflowInput,
    assertPackageWorkflowInput,
    updatePackageWorkflowMetadata,
    currentPackageSelection,
} from "./workflows.ts";
import { preparePlanWorkflow } from "./preparation.ts";
import { loadPlan as queryPlan } from "./queries.ts";
import { getPlanDocumentRoot, updatePlanFrontMatter, loadPlan } from "../plan-store.ts";
import {
    isPlannedChangeClassification,
    isProjectPlan,
    getDeclaredPlanStatus,
    isPlanDependencySatisfiedStatus,
    normalizeDeliveryEvidence,
    normalizeExecutionMode,
} from "@runwield/plans/format";
import { SHARED_PLAN_LOCK_REPAIR, SharedPlanLockError } from "../shared/collaboration/lock.ts";
import { runPlanLifecycleEventTransition, type TransitionResource, type TransitionResult } from "./transitions.ts";
import { resolveWorkflowPlanLocation } from "./location.ts";
import { hasRetainedCheckoutSource } from "@runwield/plans/retained-checkout";
import { findCompletionSiblings, prepareCompletionSiblings } from "./index.ts";

export interface RecordPlanEventRequest {
    cwd: string;
    planName: string;
    event: PlanEvent;
    currentStatus?: PlanStatus;
    details?: PlanEventDetails;
    expectedRevision?: string;
    expectedPlanId?: string;
    packageSelection?: PlanAccess;
}
interface ParentCompletion extends Omit<RecordPlanEventRequest, "currentStatus"> {
    updatedAttrs: PlanFrontMatter;
}
interface AppliedEvent {
    attrs: PlanFrontMatter;
    details: PlanEventDetails;
}
interface CompletionChild {
    name: string;
    revision: string | undefined;
    attrs: PlanFrontMatter;
}
export interface StageValidationRequest {
    projectRoot: string;
    executionCwd: string;
    planName: string;
    details?: PlanEventDetails;
}
export interface ValidationPassedStagingResult {
    attrs: PlanFrontMatter;
    planPaths: string[];
}
export class PlanLifecycleTransitionError extends Error {
    readonly transition: TransitionResult;
    readonly status: TransitionResult["status"];
    readonly recoveryActions: TransitionResult["recoveryActions"];
    constructor(transition: TransitionResult, message?: string) {
        super(message || transition.message || `Plan Lifecycle transition ${transition.operation} did not commit.`);
        this.name = "PlanLifecycleTransitionError";
        this.transition = transition;
        this.status = transition.status;
        this.recoveryActions = transition.recoveryActions || [];
    }
}
/** @param {import('@runwield/plans').PlanFrontMatter} attrs */
function hasModeAppropriateDeliveryEvidence(attrs: PlanFrontMatter) {
    if (!isPlannedChangeClassification(attrs.classification)) return true;
    const executionMode = normalizeExecutionMode(attrs.executionMode);
    const deliveryEvidence = normalizeDeliveryEvidence(attrs.deliveryEvidence);
    if (!executionMode || !deliveryEvidence) return false;
    if (executionMode === "worktree") return deliveryEvidence.mode === "worktree_merge";
    if (executionMode === "non_git_in_place") return deliveryEvidence.mode === "non_git_in_place";
    return false;
}

/**
 * An Epic with its own branch completes from delivered children and the
 * integration gate (`epic-integration.ts`), never from child statuses alone.
 * Epics without one, and Sequences, keep the legacy status-based completion.
 *
 * @param {Partial<import('@runwield/plans').PlanFrontMatter>} attrs
 * @returns {boolean}
 */
function hasEpicBranch(attrs: Partial<PlanFrontMatter>) {
    if (attrs.type === "sequence") return false;
    return typeof attrs.targetBranch === "string" && attrs.targetBranch.trim() !== "";
}

/**
 * @param {Object} opts
 * @param {string} opts.cwd
 * @param {string} opts.planName
 * @param {PlanEvent} opts.event
 * @param {import('@runwield/plans').PlanFrontMatter} opts.updatedAttrs
 * @param {PlanEventDetails} [opts.details]
 * @returns {Promise<void>}
 */
async function advanceParentEpicWhenAllChildrenVerified({
    cwd,
    planName,
    event,
    updatedAttrs,
    details = {},
}: ParentCompletion): Promise<void> {
    if (event !== "validation_passed" && event !== "manual_user_verified") return;
    if (isProjectPlan(updatedAttrs)) return;

    const parentPlanName = typeof updatedAttrs.parentPlan === "string" ? updatedAttrs.parentPlan : "";
    if (!parentPlanName) return;

    const parent = await loadPlan(cwd, parentPlanName);
    if (!parent || !isProjectPlan(parent.attrs)) return;
    if (isPlanDependencySatisfiedStatus(parent.attrs.status)) return;
    if (parent.attrs.status !== "ready_for_work") return;
    if (hasEpicBranch(parent.attrs)) return;

    const children = await findCompletionSiblings(cwd, parentPlanName);
    if (!children.length) return;
    if (
        children.some(
            (child) =>
                !isPlanDependencySatisfiedStatus(child.attrs.status) ||
                (child.attrs.status === "verified" && !hasModeAppropriateDeliveryEvidence(child.attrs)),
        )
    )
        return;

    await recordPlanEvent({
        cwd,
        planName: parentPlanName,
        event: "epic_done_enough",
        currentStatus: "ready_for_work",
        details: {
            triageMeta: parent.attrs,
            epicDoneEnoughSummary: `All ${children.length} child plans are completed after ${planName}.`,
            now: details.now,
        },
    });
}

/**
 * Record a Plan Event and persist the resulting Plan Front Matter.
 *
 * @param {Object} opts
 * @param {string} opts.cwd
 * @param {string} opts.planName
 * @param {PlanEvent} opts.event
 * @param {PlanStatus} opts.currentStatus
 * @param {PlanEventDetails} [opts.details]
 * @param {string} [opts.expectedRevision]
 * @param {import("./workflows.ts").PackageWorkflowSelection} [opts.packageSelection]
 * @returns {Promise<import('@runwield/plans').PlanFrontMatter>}
 */
async function packageEventWorkflow(planName: string, event: PlanEvent) {
    const selected = await selectedPackage(planName);
    const workflow = { ...selected.metadata.workflow };
    if (event === "readiness_passed" || event === "execution_started") {
        const input = event === "readiness_passed" ? workflow.review : workflow.readiness;
        if (!input) throw new Error("Current package review/readiness evidence is required.");
        await assertPackageWorkflowInput(planName, input);
    }
    if (event === "hold_reset_to_draft") {
        workflow.review = undefined;
        workflow.readiness = undefined;
    }
    if (event === "implementation_finished" && workflow.attempt)
        await assertPackageWorkflowInput(planName, workflow.readiness || workflow.attempt.input);
    if (event === "epic_integration_passed") workflow.integration = await capturePackageWorkflowInput(planName);
    if (event === "epic_integration_stale" || event === "epic_integration_failed") workflow.integration = undefined;
    if (event === "review_approved") workflow.review = await capturePackageWorkflowInput(planName);
    if (event === "readiness_passed") workflow.readiness = await capturePackageWorkflowInput(planName);
    return workflow;
}

export const MANAGED_LIFECYCLE_DECISIONS = [
    "manual_status_change",
    "manual_closed_without_verification",
    "manual_user_verified",
    "plan_held",
    "hold_resumed",
    "validation_invalidated",
    "recovery_continue",
    "review_reopened",
    "epic_done_enough",
    "epic_children_delivered",
    "epic_integration_passed",
    "epic_integration_failed",
    "epic_integration_stale",
] as const;
export interface ManagedLifecycleDecision {
    event: (typeof MANAGED_LIFECYCLE_DECISIONS)[number];
    details: Pick<
        PlanEventDetails,
        | "manualTargetStatus"
        | "holdReason"
        | "closedWithoutVerificationReason"
        | "closedWithoutVerificationAt"
        | "userVerificationNote"
        | "holdStalenessBaseline"
        | "heldFromStatus"
        | "epicDoneEnoughSummary"
        | "epicDeliveryTargetBranch"
        | "integrationCommit"
        | "integrationReport"
        | "failureReason"
    >;
}
export function managedLifecycleDetails(details: PlanEventDetails): ManagedLifecycleDecision["details"] {
    const {
        manualTargetStatus,
        holdReason,
        closedWithoutVerificationReason,
        closedWithoutVerificationAt,
        userVerificationNote,
        holdStalenessBaseline,
        heldFromStatus,
        epicDoneEnoughSummary,
        epicDeliveryTargetBranch,
        integrationCommit,
        integrationReport,
        failureReason,
    } = details;
    return {
        manualTargetStatus,
        holdReason,
        closedWithoutVerificationReason,
        closedWithoutVerificationAt,
        userVerificationNote,
        holdStalenessBaseline,
        heldFromStatus,
        epicDoneEnoughSummary,
        epicDeliveryTargetBranch,
        integrationCommit,
        integrationReport,
        failureReason,
    };
}
export function isManagedLifecycleDecision(event: string): event is ManagedLifecycleDecision["event"] {
    return MANAGED_LIFECYCLE_DECISIONS.some((allowed) => allowed === event);
}
export interface ManagedExecutionCheckpoint {
    event:
        | "validation_checkpoint_saved"
        | "execution_started"
        | "execution_failed"
        | "implementation_finished"
        | "mechanical_validation_failed"
        | "mechanical_validation_passed"
        | "semantic_review_feedback"
        | "semantic_review_passed"
        | "validation_passed"
        | "validation_failed";
    details: Pick<
        PlanEventDetails,
        | "failureReason"
        | "executionReport"
        | "executionBaselineTree"
        | "validationCiAttempts"
        | "validationSemanticRounds"
        | "mechanicalFailureKind"
        | "validationCheckpoint"
        | "humanReviewMode"
        | "humanReviewDecision"
        | "humanReviewedAt"
    >;
}
/** Checkpoints retain reserved input; Git publication and non-Git settlement prove completion separately. */
export async function recordManagedExecutionCheckpoint(
    cwd: string,
    planName: string,
    attemptId: string,
    expectedRevision: string,
    checkpoint: ManagedExecutionCheckpoint,
) {
    if (!projects.home.current()) throw new Error("Managed checkpoint requires its personal owner.");
    return await packageWorkflowLocks([planName], async () => {
        const selected = await selectedPackage(planName);
        if (selected.metadata.workflow?.attempt?.attemptId !== attemptId)
            throw new Error("Execution checkpoint belongs to another attempt.");
        if (
            checkpoint.event === "validation_passed" &&
            selected.metadata.workflow.attempt.executionMode !== "non_git_in_place"
        )
            throw new Error("Managed in-place completion requires its reserved non-Git attempt.");
        const before = await loadPlan(cwd, planName);
        if (!before || before.revision !== expectedRevision) throw new Error("Plan revision changed.");
        if (checkpoint.event === "validation_checkpoint_saved")
            return await updatePackageWorkflowMetadata(
                planName,
                { validationCheckpoint: checkpoint.details.validationCheckpoint },
                expectedRevision,
            );
        const workflow = await packageEventWorkflow(planName, checkpoint.event);
        const updates = plans.lifecycle.changesFor(checkpoint.event, before.attrs.status, {
            ...checkpoint.details,
            worktreeId: attemptId,
            worktreeBaseBranch: before.attrs.deliveryBranch || before.attrs.targetBranch,
            nonGitInPlace: selected.metadata.workflow?.attempt?.executionMode === "non_git_in_place",
            ...(checkpoint.event === "validation_passed"
                ? {
                      executionMode: "non_git_in_place" as const,
                      deliveryEvidence: { version: 1 as const, mode: "non_git_in_place" as const },
                      pendingPublication: true,
                  }
                : {}),
            triageMeta: before.attrs,
        });
        return await updatePackageWorkflowMetadata(planName, updates, expectedRevision, workflow);
    });
}

export async function recordPlanEvent({
    cwd,
    planName,
    event,
    currentStatus,
    details = {},
    expectedRevision,
    expectedPlanId,
    packageSelection,
}: RecordPlanEventRequest): Promise<PlanFrontMatter> {
    if (managedPlanStoreActive()) {
        const readBefore = () =>
            expectedPlanId ? readManagedActivePlanById(cwd, expectedPlanId) : readManagedPlan(cwd, planName);
        if (
            [
                "execution_started",
                "execution_failed",
                "implementation_finished",
                "mechanical_validation_failed",
                "mechanical_validation_passed",
                "semantic_review_feedback",
                "semantic_review_passed",
                "validation_passed",
                "validation_failed",
            ].includes(event)
        ) {
            const before = await readBefore();
            if (!before?.attrs.planId) throw new Error("Managed Plan is unavailable.");
            const execution = await readManagedExecution(cwd, before.attrs.planId);
            if (!execution || (details.worktreeId && details.worktreeId !== execution.attemptId))
                throw new Error("Execution checkpoint belongs to another attempt.");
            const {
                failureReason,
                executionReport,
                executionBaselineTree,
                validationCiAttempts,
                validationSemanticRounds,
                mechanicalFailureKind,
                validationCheckpoint,
                humanReviewMode,
                humanReviewDecision,
                humanReviewedAt,
            } = details;
            await mutateManagedPlan(cwd, {
                kind: "execution-checkpoint",
                operationId: crypto.randomUUID(),
                planId: before.attrs.planId,
                expectedRevision: expectedRevision || before.revision,
                attemptId: execution.attemptId,
                checkpoint: {
                    event: event as ManagedExecutionCheckpoint["event"],
                    details: {
                        failureReason,
                        executionReport,
                        executionBaselineTree,
                        validationCiAttempts,
                        validationSemanticRounds,
                        mechanicalFailureKind,
                        validationCheckpoint,
                        humanReviewMode,
                        humanReviewDecision,
                        humanReviewedAt,
                    },
                },
            });
            const after = await readManagedActivePlanById(cwd, before.attrs.planId);
            if (!after) throw new Error("Managed Plan is unavailable after its checkpoint.");
            return after.attrs;
        }
        if (isManagedLifecycleDecision(event)) {
            const before = await readBefore();
            if (!before?.attrs.planId || (currentStatus && currentStatus !== before.attrs.status))
                throw new Error("Plan status changed.");
            await mutateManagedPlan(cwd, {
                kind: "lifecycle-decision",
                operationId: crypto.randomUUID(),
                planId: before.attrs.planId,
                expectedRevision: expectedRevision || before.revision,
                decision: { event, details: managedLifecycleDetails(details) },
            });
            const after = await readManagedActivePlanById(cwd, before.attrs.planId);
            if (!after) throw new Error("Lifecycle decision Plan is unavailable.");
            return after.attrs;
        }
        if (
            event !== "review_approved" &&
            event !== "review_feedback" &&
            event !== "hold_reset_to_draft" &&
            event !== "readiness_passed" &&
            event !== "epic_readiness_passed"
        )
            throw new Error("Managed lifecycle transition requires matched execution evidence.");
        const before = await readBefore();
        if (!before?.attrs.planId) throw new Error("Managed Plan is unavailable.");
        if (currentStatus && currentStatus !== before.attrs.status) throw new Error("Plan status changed.");
        await mutateManagedPlan(cwd, {
            kind: "record-event",
            event,
            operationId: crypto.randomUUID(),
            planId: before.attrs.planId,
            expectedRevision: expectedRevision || before.revision,
        });
        const after = await readManagedActivePlanById(cwd, before.attrs.planId);
        if (!after) throw new Error("Managed Plan is unavailable after its event.");
        return after.attrs;
    }
    const retained = hasRetainedCheckoutSource(cwd);
    if (expectedPlanId && !retained && !packageSelection && !currentPackageSelection())
        return await withLocalPlanWorkflow(
            cwd,
            planName,
            () =>
                recordPlanEvent({
                    cwd,
                    planName,
                    event,
                    currentStatus,
                    details,
                    expectedRevision,
                    expectedPlanId,
                }),
            expectedPlanId,
        );
    if (!packageSelection && !currentPackageSelection()) packageSelection = await selectPlanAccess(cwd, planName);
    if (packageSelection)
        return await withPlanAccess(
            cwd,
            packageSelection,
            () => recordPlanEvent({ cwd, planName, event, currentStatus, details, expectedRevision, expectedPlanId }),
            planName,
        );
    if (expectedPlanId !== undefined && !retained && currentPackageSelection()?.planId !== expectedPlanId)
        throw new Error("Lifecycle event source changed Plan ID.");
    if (projects.home.current()) {
        if (
            !isManagedLifecycleDecision(event) &&
            ![
                "review_approved",
                "review_feedback",
                "hold_reset_to_draft",
                "readiness_passed",
                "epic_readiness_passed",
            ].includes(event)
        )
            throw new Error("This lifecycle event requires execution-host evidence.");
        return await packageWorkflowLocks([planName], async () => {
            const before = await loadPlan(cwd, planName);
            if (!before) throw new Error("Plan is unavailable.");
            if (expectedRevision && before.revision !== expectedRevision) throw new Error("Plan revision changed.");
            if (currentStatus && before.attrs.status !== currentStatus) throw new Error("Plan status changed.");
            const updates = plans.lifecycle.changesFor(event, before.attrs.status, {
                ...details,
                triageMeta: before.attrs,
            });
            const workflow = await packageEventWorkflow(planName, event);
            return await updatePackageWorkflowMetadata(
                planName,
                updates,
                before.revision,
                workflow,
                event === "review_approved" ? "approved" : undefined,
            );
        });
    }
    if (currentPackageSelection() && event === "validation_passed") {
        const selected = await selectedPackage(planName);
        const receipt = selected.metadata.workflow?.delivery;
        if (!details.pendingPublication && !receipt)
            throw new Error("Package completion requires applicable publication evidence.");
        if (receipt && !details.pendingPublication) {
            const { readPlanPackagePublication } = await import("@runwield/plans/package-storage");
            const selection = currentPackageSelection();
            if (!selection) throw new Error("Package completion requires explicit admission.");
            const retained = await readPlanPackagePublication(selection.identity, receipt.source);
            if (
                selected.metadata.workflow?.attempt ||
                selected.metadata.definition.status !== "verified" ||
                !samePackagePublicationReference(selected.metadata.workflow?.publication, receipt.source) ||
                receipt.validatedCommit !== retained.validatedCommit ||
                receipt.targetBranch !== retained.targetBranch
            )
                throw new Error("A historical package receipt cannot complete another execution.");
        }
    }
    await preparePlanWorkflow(cwd, planName);
    // The caller's project root locates the controller, not necessarily the Plan.
    // Resolve once before the transaction, then keep that document locked even
    // if the event retires its execution attempt.
    const location = await resolveWorkflowPlanLocation(cwd, planName);
    if (expectedPlanId !== undefined && location.plan?.attrs.planId !== expectedPlanId)
        throw new Error("Lifecycle event source changed Plan ID.");
    cwd = location.documentRoot;
    /**
     * @param {Awaited<ReturnType<typeof loadPlan>>} beforePlan
     * @returns {Promise<{ attrs: import('@runwield/plans').PlanFrontMatter, details: Record<string, unknown> }>}
     */
    const applyChildEvent = async (beforePlan: Awaited<ReturnType<typeof loadPlan>>): Promise<AppliedEvent> => {
        if (!beforePlan) throw new Error(`Plan not found: ${planName}`);
        const canonicalStatus = beforePlan.attrs.status;
        if (currentStatus && currentStatus !== canonicalStatus) {
            throw new Error(buildStalePlanStatusMessage(planName, currentStatus, canonicalStatus));
        }
        const canonicalDetails = {
            ...details,
            // Authority-sensitive lifecycle facts (status, classification,
            // hierarchy, identity, worktree attempt, target ref) come from the
            // canonical Plan bytes read under the Plan lock. Caller metadata may
            // carry auxiliary fields such as timestamps or reports, but must not
            // override locked Plan front matter.
            triageMeta: { ...(details.triageMeta || {}), ...beforePlan.attrs },
        };
        const updates = plans.lifecycle.changesFor(event, canonicalStatus, canonicalDetails);
        if (currentPackageSelection()) {
            const workflow = await packageEventWorkflow(planName, event);
            const integration = event === "epic_publication_confirmed" ? workflow.integration : undefined;
            const integrated = integration?.inputs.find((input) => input.planId === beforePlan.attrs.planId);
            if (integration && !integrated) throw new Error("Epic integration evidence omits its Plan input.");
            const attrs = await updatePackageWorkflowMetadata(
                planName,
                updates,
                beforePlan.revision,
                workflow,
                event === "review_approved" ? "approved" : integrated ? { delivered: integrated } : undefined,
            );
            return { attrs, details: canonicalDetails };
        }
        const attrs = await updatePlanFrontMatter(cwd, planName, updates, canonicalDetails.triageMeta, {
            expectedRevision: beforePlan.revision,
            expectedPlanId,
        });
        return { attrs, details: canonicalDetails };
    };
    const run = async () => {
        const transition = await runPlanLifecycleEventTransition({
            projectRoot: cwd,
            planName,
            event,
            expectedRevision,
            record: async ({ beforePlan }) => await applyChildEvent(beforePlan),
        });
        if (transition.status !== "committed") {
            throw new PlanLifecycleTransitionError(
                transition,
                transition.message || `Plan Lifecycle transition ${event} did not commit for ${planName}.`,
            );
        }
        const value =
            /** @type {{ attrs: import('@runwield/plans').PlanFrontMatter, details: Record<string, unknown> }} */
            transition.value as AppliedEvent;
        await advanceParentEpicWhenAllChildrenVerified({
            cwd,
            planName,
            event,
            updatedAttrs: value.attrs,
            details: value.details,
        });
        return value.attrs;
    };
    try {
        if (event === "validation_passed" || event === "manual_user_verified") {
            const preflightPlan = await loadPlan(cwd, planName);
            const parentPlanName =
                preflightPlan &&
                !isProjectPlan(preflightPlan.attrs) &&
                typeof preflightPlan.attrs.parentPlan === "string"
                    ? preflightPlan.attrs.parentPlan
                    : "";
            if (parentPlanName) await preparePlanWorkflow(cwd, parentPlanName);
            const siblings = parentPlanName ? await prepareCompletionSiblings(cwd, parentPlanName) : [];
            const siblingPaths = new Map(siblings.map((child) => [child.name, child.path]));
            /** @type {import('./transitions.ts').TransitionResource[]} */
            const resources: TransitionResource[] = [
                { kind: "catalog", root: location.registryRoot },
                { kind: "plan", id: planName },
                ...(parentPlanName ? [{ kind: "plan" as const, id: parentPlanName }] : []),
                ...siblings
                    .filter((child) => child.name !== planName && !child.path.includes(":docs/plans/"))
                    .map((child) => ({
                        kind: "plan" as const,
                        id: child.name,
                        root: currentPackageSelection() ? cwd : getPlanDocumentRoot(child.path),
                    })),
            ];
            const transition = await runPlanLifecycleEventTransition({
                projectRoot: cwd,
                planName,
                event,
                resources,
                expectedRevision,
                record: async ({ beforePlan }) => {
                    if (!beforePlan) throw new Error(`Plan not found: ${planName}`);
                    const canonicalStatus = beforePlan.attrs.status;
                    if (currentStatus && currentStatus !== canonicalStatus) {
                        throw new Error(buildStalePlanStatusMessage(planName, currentStatus, canonicalStatus));
                    }
                    const canonicalDetails = {
                        ...details,
                        triageMeta: { ...(details.triageMeta || {}), ...beforePlan.attrs },
                    };
                    const childUpdates = plans.lifecycle.changesFor(event, canonicalStatus, canonicalDetails);
                    const childParentPlanName =
                        typeof beforePlan.attrs.parentPlan === "string" ? beforePlan.attrs.parentPlan : "";
                    if (childParentPlanName !== parentPlanName) {
                        throw new Error(`Plan hierarchy changed while applying ${event} for ${planName}.`);
                    }

                    /** @type {{ name: string, revision: string | undefined, attrs: import('@runwield/plans').PlanFrontMatter }[]} */
                    let childrenBeforeWrite: CompletionChild[] = [];
                    /** @type {Awaited<ReturnType<typeof loadPlan>>} */
                    let lockedParent: Awaited<ReturnType<typeof loadPlan>> = null;
                    /** @type {Record<string, unknown> | null} */
                    let parentUpdates: Partial<PlanFrontMatter> | null = null;
                    if (parentPlanName && !isProjectPlan(beforePlan.attrs)) {
                        const lockedSiblings = await findCompletionSiblings(cwd, parentPlanName);
                        if (
                            lockedSiblings.length !== siblings.length ||
                            lockedSiblings.some((child) => siblingPaths.get(child.name) !== child.path)
                        ) {
                            throw new Error(`Child Plan set changed while applying ${event} for ${planName}.`);
                        }
                        lockedParent = await loadPlan(cwd, parentPlanName);
                        childrenBeforeWrite = await Promise.all(
                            lockedSiblings.map(async (child) => {
                                if (child.name === planName) {
                                    return { name: planName, revision: beforePlan.revision, attrs: beforePlan.attrs };
                                }
                                // A target-branch snapshot has no editable document or local Plan lock.
                                if (child.path.includes(":docs/plans/")) {
                                    return { name: child.name, revision: undefined, attrs: child.attrs };
                                }
                                const lockedChild = await loadPlan(
                                    currentPackageSelection() ? cwd : getPlanDocumentRoot(child.path),
                                    child.name,
                                );
                                if (!lockedChild) throw new Error(`Child Plan disappeared: ${child.name}`);
                                return { name: child.name, revision: lockedChild.revision, attrs: lockedChild.attrs };
                            }),
                        );
                        if (
                            lockedParent &&
                            isProjectPlan(lockedParent.attrs) &&
                            lockedParent.attrs.status === "ready_for_work" &&
                            !hasEpicBranch(lockedParent.attrs)
                        ) {
                            const projectedChildren = childrenBeforeWrite.map((child) =>
                                child.name === planName
                                    ? { ...child, attrs: { ...child.attrs, ...childUpdates } }
                                    : child,
                            );
                            const allChildrenDone =
                                projectedChildren.length > 0 &&
                                projectedChildren.every(
                                    (child) =>
                                        (isPlanDependencySatisfiedStatus(child.attrs.status) ||
                                            (details.pendingPublication &&
                                                child.name === planName &&
                                                child.attrs.status === "reviewed")) &&
                                        (child.attrs.status !== "verified" ||
                                            hasModeAppropriateDeliveryEvidence(child.attrs)),
                                );
                            if (allChildrenDone) {
                                const parentDetails = {
                                    triageMeta: lockedParent.attrs,
                                    epicDoneEnoughSummary: `All ${projectedChildren.length} child plans are completed after ${planName}.`,
                                    now: details.now,
                                };
                                parentUpdates = plans.lifecycle.changesFor(
                                    "epic_done_enough",
                                    "ready_for_work",
                                    parentDetails,
                                );
                                parentUpdates.status = details.pendingPublication ? "reviewed" : "verified";
                            }
                        }
                    }

                    let childAttrs;
                    try {
                        childAttrs = await updatePlanFrontMatter(
                            cwd,
                            planName,
                            childUpdates,
                            canonicalDetails.triageMeta,
                            {
                                expectedRevision: beforePlan.revision,
                                expectedPlanId,
                            },
                        );
                        if (parentUpdates && lockedParent) {
                            await updatePlanFrontMatter(cwd, parentPlanName, parentUpdates, lockedParent.attrs, {
                                expectedRevision: lockedParent.revision,
                            });
                        }
                    } catch (error) {
                        // Do not blindly restore the child bytes after a parent-write
                        // failure. The child write is CAS-protected, but a later read
                        // of the current child revision does not prove no unmanaged
                        // editor/Git change happened after our write. Leave the
                        // semantic transition journal to drive explicit recovery.
                        void childAttrs;
                        throw error;
                    }
                    return { attrs: childAttrs, details: canonicalDetails };
                },
            });
            if (transition.status !== "committed") {
                throw new PlanLifecycleTransitionError(
                    transition,
                    transition.message || `Plan Lifecycle transition ${event} did not commit for ${planName}.`,
                );
            }
            return /** @type {{ attrs: import('@runwield/plans').PlanFrontMatter }} */ (
                transition.value as AppliedEvent
            ).attrs;
        }
        return await run();
    } catch (error) {
        if (error instanceof SharedPlanLockError) {
            throw new SharedPlanLockError(error.collaboration, {
                reason: "Lifecycle status changes must use the collaboration workflow.",
                repair: SHARED_PLAN_LOCK_REPAIR,
            });
        }
        throw error;
    }
}

/**
 * @typedef {Object} ValidationPassedStagingResult
 * @property {import('@runwield/plans').PlanFrontMatter} attrs
 * @property {string[]} planPaths
 */

/**
 * Record validation_passed in the authoritative execution-worktree Plan. A
 * previously validated copy is returned unchanged so publication retries keep
 * its original evidence and never dirty the Plan again.
 *
 * @param {Object} opts
 * @param {string} opts.projectRoot
 * @param {string} opts.executionCwd
 * @param {string} opts.planName
 * @param {PlanEventDetails} [opts.details]
 * @returns {Promise<ValidationPassedStagingResult>}
 */
export async function stageValidationPassedInExecutionWorktree({
    projectRoot: _projectRoot,
    executionCwd,
    planName,
    details = {},
}: StageValidationRequest): Promise<ValidationPassedStagingResult> {
    await preparePlanWorkflow(executionCwd, planName);
    const planPath = `docs/plans/${planName}.md`;
    const executionPlan = await queryPlan(executionCwd, planName);
    if (!executionPlan) throw new Error(`Plan not found in its execution worktree: ${planName}`);
    if (executionPlan.attrs.status !== "reviewed" && executionPlan.attrs.status !== "validated") {
        throw new Error(`Cannot prepare publication for ${planName} at "${executionPlan.attrs.status}".`);
    }
    if (managedPlanStoreActive() && details.executionMode === "worktree") {
        const execution = executionPlan.attrs.planId
            ? await readManagedExecution(executionCwd, executionPlan.attrs.planId)
            : null;
        if (!execution || (details.worktreeId && details.worktreeId !== execution.attemptId))
            throw new Error("Publication staging belongs to another execution attempt.");
        if (executionPlan.attrs.status !== "reviewed")
            throw new Error("Managed Git publication requires its reviewed Plan.");
        // The managed seal checks this attempt's review evidence; Git settlement records completion.
        return { attrs: executionPlan.attrs, planPaths: [planPath] };
    }
    const prepared =
        executionPlan.attrs.status === "reviewed" &&
        Boolean(executionPlan.attrs.validatedAt && executionPlan.attrs.deliveryEvidence);
    const attrs = prepared
        ? executionPlan.attrs
        : executionPlan.attrs.status === "reviewed"
          ? await recordPlanEvent({
                cwd: executionCwd,
                planName,
                event: "validation_passed",
                currentStatus: "reviewed",
                details: {
                    ...details,
                    triageMeta: executionPlan.attrs,
                    pendingPublication: true,
                    cleanupMergedWorktrees: false,
                    ...(getDeclaredPlanStatus(executionPlan.markdown) === "validated" && executionPlan.attrs.validatedAt
                        ? { now: () => new Date(String(executionPlan.attrs.validatedAt)) }
                        : {}),
                },
            })
          : await updatePlanFrontMatter(executionCwd, planName, { status: "reviewed" }, executionPlan.attrs, {
                expectedRevision: executionPlan.revision,
            });
    const planPaths = [planPath];
    if (attrs.parentPlan) {
        const parent = await loadPlan(executionCwd, attrs.parentPlan);
        if (parent?.attrs.status === "reviewed" && parent.attrs.epicCompletionMode === "done_enough") {
            planPaths.push(`docs/plans/${attrs.parentPlan}.md`);
        }
    }
    return { attrs, planPaths };
}
