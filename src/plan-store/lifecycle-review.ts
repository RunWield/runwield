import { join, resolve } from "node:path";
import { plans, type PlanFrontMatter, type PlanId } from "@runwield/plans";
import { assertSharedPlanWriteAllowed } from "@runwield/plans/collaboration-lock";
import type {
    ApplyProjectPlanReviewEvent,
    PlanReviewDecisionInput,
    PlanReviewVersion,
    ProjectPlanReviewEventResult,
    SequenceReviewPresentation,
} from "@runwield/plans/lifecycle";
import {
    decodeLegacyPlanReviewSource,
    RetainedPlanReviewVersions,
    sequenceReviewMatchesDisplay,
    type LegacyPlanReviewMetadata,
    type ReviewSourceOwner,
    type SequenceReviewDocument,
    type SerializedPlanReviewVersion,
} from "@runwield/plans/live-review";
import { parsePlanFrontMatter } from "@runwield/plans/format";
import { currentRetainedCheckoutSource, withRetainedCheckoutSource } from "@runwield/plans/retained-checkout";
import { StalePlanWriteError } from "@runwield/plans/store";
import type { ProjectId } from "@runwield/projects";
import {
    inspectOperationReceipt,
    OperationRequestConflictError,
    operationDigest,
    planOperationReceiptDirectory,
    runReceiptedOperation,
} from "@runwield/plans/operation-receipts";
import { withPlanPackageCatalogDiscovery } from "@runwield/plans/package-storage";
import { resolveProjectRuntimeLayout } from "@runwield/project-runtime/layout";
import { loadPlanActionEvidence } from "../shared/workflow/plan-actions.ts";
import { withLocalPlanWorkflow } from "./access.ts";
import { resolveWorkflowPlanLocation } from "./location.ts";
import { checkoutPlanIdentity } from "./project-binding.ts";
import { renderPlanReviewMarkdown } from "./resources.ts";
import { findSequenceReviewOperationResult, readPlanReviewOperationResult } from "./operation-results.ts";
import { managedPlanStoreActive } from "./managed.ts";
import {
    applyPlanReviewForExecution,
    applySharedPlanReviewDecision,
    resumeRetainedReviewWrite,
    StaleRetainedReviewWriteError,
    type SharedPlanReviewDecision,
} from "./review.ts";
import { withOrderedTransitionResources } from "./transitions.ts";
import { preparePlanReviewDocument } from "./review-snapshots.ts";
import {
    applySequenceReviewDecision,
    prepareSequenceReview,
    snapshotSequenceReview,
    validateSequenceReviewDecision,
    type SequenceChildInput,
    type SequenceReviewDecision,
    type SequenceReviewResult,
} from "./sequence-review.ts";

interface PlanReviewPreparation {
    expectedRevision?: string;
    triage?: Partial<Pick<PlanFrontMatter, "classification" | "workKind" | "complexity" | "summary" | "affectedPaths">>;
    runwieldSessionId?: string;
    renderMarkdown?: boolean;
}

interface InternalProjectPlanReviewEventResult extends ProjectPlanReviewEventResult {
    approvalControllerRevision?: number;
    sequence?: NonNullable<ProjectPlanReviewEventResult["sequence"]> & {
        planAttrs?: NonNullable<SequenceReviewResult["workflowOutcome"]>["triageMeta"];
    };
}

interface PlanReviewOperationReference {
    operationId: string;
    planId: PlanId;
}

type ReviewDecision = SharedPlanReviewDecision & SequenceReviewDecision;

function reviewDecisionDigest(
    { operationId, planId }: PlanReviewOperationReference,
    decision: ReviewDecision,
    disposition?: "prepare_execution",
) {
    const conversationTurn = decision.conversationTurn === true;
    return operationDigest(
        JSON.stringify({
            operationId,
            planId,
            disposition,
            decision: { ...decision, approved: !conversationTurn && decision.approved === true, conversationTurn },
        }),
    );
}

const retainedVersions = new RetainedPlanReviewVersions<InternalProjectPlanReviewEventResult>();

/** Transfer the same prepared source through the private live Session connection. */
export function serializePlanReviewVersion(reference: PlanReviewVersion): SerializedPlanReviewVersion | undefined {
    return retainedVersions.serialize(reference);
}

/** Rebind trusted source from another process to the receiving Session. */
export function restorePlanReviewVersion(
    version: SerializedPlanReviewVersion,
    runwieldSessionId: string,
): PlanReviewVersion | undefined {
    return retainedVersions.restore(version, runwieldSessionId);
}

/** Adopt older private socket metadata only when it proves the original reviewed source. */
export function restoreLegacyPlanReviewVersion(
    meta: LegacyPlanReviewMetadata,
    runwieldSessionId: string,
    interactionId?: string,
) {
    const owner = meta.cwd && reviewOwner(meta.cwd);
    const version = owner && decodeLegacyPlanReviewSource(meta, owner, runwieldSessionId, interactionId);
    const displayedVersion = version ? restorePlanReviewVersion(version, runwieldSessionId) : undefined;
    return {
        displayedVersion,
        ...(version &&
            version.source.kind === "sequence" && {
                sequenceDocuments: version.source.documents.map(presentSequenceMember),
            }),
    };
}

function reviewOwner(cwd: string): ReviewSourceOwner | undefined {
    const identity = checkoutPlanIdentity(cwd);
    if (!identity) return undefined;
    return {
        projectId: identity.projectId,
        personalOwner: identity.personalOwner.identity,
        executionAccountHome: identity.executionAccountHome,
        repositoryId: identity.repositoryId,
    };
}

function reviewIdentity(cwd: string, plan: { planId?: string; revision: string }, runwieldSessionId?: string) {
    const owner = reviewOwner(cwd);
    const planId = plans.identity.parse(plan.planId);
    if (!owner || !planId) throw new Error("Plan review requires an admitted Project and a saved Plan ID.");
    return { owner, planId, cwd, revision: plan.revision, runwieldSessionId };
}

/** Retain the documents and operational evidence alongside the existing review presentation. */
export async function preparePlanReviewVersion(
    cwd: string,
    planName: string,
    planPath: string,
    options: PlanReviewPreparation = {},
) {
    return await withLocalPlanWorkflow(cwd, planName, async () => {
        const { document, packageInput } = await preparePlanReviewDocument(planPath, options.expectedRevision);
        assertSharedPlanWriteAllowed(document.attrs);
        const identity = reviewIdentity(
            cwd,
            { planId: document.attrs.planId, revision: document.revision },
            options.runwieldSessionId,
        );
        const evidence = await loadPlanActionEvidence(cwd, identity.planId);
        if (evidence.kind !== "success") throw new Error(evidence.message);
        if (evidence.evidence.planName !== planName || evidence.evidence.revision !== document.revision)
            throw new StalePlanWriteError(document.revision, evidence.evidence.revision);
        if (!packageInput) {
            const location = await resolveWorkflowPlanLocation(cwd, planName, { readOnly: true });
            if (!location.plan || resolve(location.plan.path) !== resolve(document.path))
                throw new Error("The selected review document is no longer the Plan's saved source.");
        }
        const classification = options.triage?.classification || document.attrs.classification;
        const workKind = options.triage?.workKind || document.attrs.workKind;
        const markdown = options.renderMarkdown
            ? renderPlanReviewMarkdown(document.body, {
                  ...document.attrs,
                  updatedAt: new Date().toISOString(),
                  classification,
                  workKind,
                  ...(options.triage?.complexity && { complexity: options.triage.complexity }),
                  ...(options.triage?.summary && { summary: options.triage.summary }),
                  ...(options.triage?.affectedPaths && { affectedPaths: options.triage.affectedPaths }),
              })
            : document.markdown;
        const displayedVersion = retainedVersions.retain({
            ...identity,
            retainedCheckout: currentRetainedCheckoutSource(),
            source: {
                kind: "individual",
                review: {
                    cwd,
                    packageInput,
                    planName,
                    planPath: document.path,
                    planWithFrontMatter: markdown,
                    planRevision: document.revision,
                    expectedControllerRevision: document.controllerRevision,
                    originalAttrs: document.attrs,
                    trustedClassification: classification,
                    trustedWorkKind: workKind,
                    expectedSessionId: options.runwieldSessionId,
                    reviewEvidence: {
                        planId: identity.planId,
                        runwieldSessionId: options.runwieldSessionId,
                        status: evidence.evidence.status,
                        worktree: evidence.evidence.worktree,
                    },
                },
            },
        });
        return { displayedVersion, document: { attrs: document.attrs, body: document.body }, markdown };
    });
}

/** Verify the entire displayed group against the current owner before retaining its input. */
export async function prepareSequenceReviewVersion(
    cwd: string,
    planName: string,
    documents: readonly Omit<SequenceReviewDocument, "packageInput">[],
    runwieldSessionId?: string,
): Promise<PlanReviewVersion> {
    const current = await snapshotSequenceReview(cwd, planName);
    const parent = current[0];
    if (!sequenceReviewMatchesDisplay(current, documents))
        throw new Error("A Plan changed before the Sequence review opened. Refresh the complete review.");
    return retainedVersions.retain({
        ...reviewIdentity(cwd, parent, runwieldSessionId),
        retainedCheckout: currentRetainedCheckoutSource(),
        source: { kind: "sequence", documents: current },
    });
}

/** Present Sequence members without exposing the retained package input. */
export async function prepareSequenceReviewPresentation(
    cwd: string,
    planName: string,
    inputs?: SequenceChildInput[],
): Promise<SequenceReviewPresentation[]> {
    return (await prepareSequenceReview(cwd, planName, inputs)).map(presentSequenceMember);
}

/** Refresh the displayed tabs after the owner updates the Sequence members. */
export async function snapshotSequenceReviewPresentation(cwd: string, planName: string) {
    return (await snapshotSequenceReview(cwd, planName)).map(presentSequenceMember);
}

function presentSequenceMember({ packageInput, ...document }: SequenceReviewDocument): SequenceReviewPresentation {
    return { ...document, body: packageInput ? document.plan : parsePlanFrontMatter(document.plan).body };
}

function staleReview(): ProjectPlanReviewEventResult {
    return {
        approved: false,
        cancellationReason: "stale_plan_review",
        feedback: "Live review source is missing or out of date. Reload the Plan and review again.",
    };
}

export function getPlanReviewOperationReference(
    displayedVersion: PlanReviewVersion,
): PlanReviewOperationReference | undefined {
    return retainedVersions.operation(displayedVersion);
}

export function presentPlanReviewResult(result: InternalProjectPlanReviewEventResult): ProjectPlanReviewEventResult {
    const { sequence, approvalControllerRevision: _controller, ...publicResult } = result;
    return {
        ...publicResult,
        ...(sequence && {
            sequence: { planId: sequence.planId, planName: sequence.planName, images: sequence.images },
        }),
    };
}

function projectSequenceResult({
    workflowOutcome,
    ...result
}: SequenceReviewResult): InternalProjectPlanReviewEventResult {
    const planName = workflowOutcome?.planName;
    const planId = workflowOutcome?.triageMeta?.planId;
    return {
        ...result,
        ...(planId &&
            planName && {
                sequence: { planId, planName, planAttrs: workflowOutcome.triageMeta, images: workflowOutcome.images },
            }),
    };
}

function readCommittedReview(
    directory: string,
    reference: PlanReviewOperationReference,
): InternalProjectPlanReviewEventResult | undefined {
    const { operationId, planId } = reference;
    const sequence = findSequenceReviewOperationResult(directory, operationId, planId);
    return sequence ? projectSequenceResult(sequence) : readPlanReviewOperationResult(directory, operationId, planId);
}

export async function recoverPlanReviewResult(
    cwd: string,
    reference: PlanReviewOperationReference,
    decision: ReviewDecision,
): Promise<ProjectPlanReviewEventResult | undefined> {
    const owner = checkoutPlanIdentity(cwd);
    if (!owner || managedPlanStoreActive() || owner.personalOwner.kind !== "execution-account") return undefined;
    const directory = planOperationReceiptDirectory(owner);
    const committed = await withPlanPackageCatalogDiscovery(owner, () => {
        const receipt = inspectOperationReceipt(
            directory,
            reference.operationId,
            reference.planId,
            reviewDecisionDigest(reference, decision),
        );
        return Promise.resolve(receipt.status === "completed" ? readCommittedReview(directory, reference) : undefined);
    });
    return committed && presentPlanReviewResult(committed);
}

function checkedVersion(projectId: ProjectId, cwd: string, planId: PlanId, displayedVersion: PlanReviewVersion) {
    const sourceCheckout = retainedVersions.checkout(displayedVersion);
    if (!sourceCheckout) return undefined;
    return retainedVersions.matching(
        displayedVersion,
        projectId,
        planId,
        reviewOwner(cwd),
        reviewOwner(sourceCheckout),
    );
}

async function inReviewCheckout<Result>(version: SerializedPlanReviewVersion, useSource: () => Promise<Result>) {
    return version.retainedCheckout
        ? await withRetainedCheckoutSource(version.retainedCheckout, useSource)
        : await useSource();
}

async function applyRetainedReview(
    version: SerializedPlanReviewVersion,
    decision: SharedPlanReviewDecision & SequenceReviewDecision,
    disposition?: "prepare_execution",
) {
    const { source, cwd } = version;
    const result = await inReviewCheckout<InternalProjectPlanReviewEventResult>(version, async () => {
        if (source.kind === "sequence") {
            return projectSequenceResult(
                await applySequenceReviewDecision({
                    cwd,
                    documents: source.documents,
                    decision,
                    operationId: version.operationId,
                }),
            );
        }
        if (decision.documents) return staleReview();
        const apply = disposition === "prepare_execution" ? applyPlanReviewForExecution : applySharedPlanReviewDecision;
        return await apply({
            ...source.review,
            decision,
            operationId: version.operationId,
            allowPackageTimestampChanges: !disposition && !managedPlanStoreActive(),
            requireExactPlanRevision: source.review.expectedControllerRevision === undefined,
        });
    });
    return {
        ...result,
        ...(result.recoveryRequired && { recoveryRequired: { message: result.recoveryRequired.message } }),
    };
}

/** Scope package writes to the same operation receipt for every restoration of the displayed review. */
async function applyReceiptedReview(
    version: SerializedPlanReviewVersion,
    decision: ReviewDecision,
    digest: string,
    disposition?: "prepare_execution",
): Promise<InternalProjectPlanReviewEventResult> {
    const owner = checkoutPlanIdentity(version.cwd);
    if (!owner || managedPlanStoreActive() || disposition)
        return await applyRetainedReview(version, decision, disposition);
    const localOwner = owner.personalOwner.kind === "execution-account";
    if (!localOwner && !version.retainedCheckout) return await applyRetainedReview(version, decision, disposition);
    const directory = localOwner
        ? planOperationReceiptDirectory(owner)
        : join(resolveProjectRuntimeLayout(version.cwd).selected.transitionJournalsDir, "plan-review-operations");
    const { operationId, planId } = version;
    const apply = async () => {
        let rejected: InternalProjectPlanReviewEventResult | undefined;
        const stopped = new Error("Plan review did not commit.");
        try {
            const receipt = await runReceiptedOperation(
                directory,
                operationId,
                digest,
                planId,
                async () => {
                    const resumed =
                        version.retainedCheckout && version.source.kind === "individual"
                            ? await resumeRetainedReviewWrite(version.cwd, version.source.review)
                            : undefined;
                    const result = resumed ?? (await applyRetainedReview(version, decision, disposition));
                    if (!result.revision || result.cancellationReason || result.recoveryRequired) {
                        rejected = result;
                        throw stopped;
                    }
                    return { revision: result.revision };
                },
                version.source.kind === "sequence",
            );
            const committed = readCommittedReview(directory, version);
            if (!committed || receipt.status !== "completed")
                throw new Error("Plan review receipt did not retain its committed outcome.");
            return committed;
        } catch (error) {
            if (error === stopped && rejected) return rejected;
            if (error instanceof OperationRequestConflictError) return staleReview();
            if (error instanceof StaleRetainedReviewWriteError || error instanceof StalePlanWriteError)
                return { ...staleReview(), feedback: error.message };
            throw error;
        }
    };
    return await inReviewCheckout(version, () =>
        localOwner
            ? withPlanPackageCatalogDiscovery(owner, apply)
            : withOrderedTransitionResources(version.cwd, [{ kind: "catalog" }], apply),
    );
}

/** Apply one approved or feedback decision against the retained source in its bound Project. */
export async function applyProjectPlanReviewEvent(
    projectId: ProjectId,
    cwd: string,
    planId: PlanId,
    { event, displayedVersion, ...decision }: ApplyProjectPlanReviewEvent,
    disposition?: "prepare_execution",
): Promise<InternalProjectPlanReviewEventResult> {
    const retained = checkedVersion(projectId, cwd, planId, displayedVersion);
    if (!retained) return staleReview();
    return await settleReviewVersion(
        retained,
        { ...decision, approved: event === "review_approved", conversationTurn: false },
        disposition,
    );
}

async function settleReviewVersion(
    retained: NonNullable<ReturnType<typeof checkedVersion>>,
    decision: ReviewDecision,
    disposition?: "prepare_execution",
) {
    const digest = reviewDecisionDigest(retained.version, decision, disposition);
    const prior = retained.application;
    if (prior) return prior.decision === digest ? await prior.result : staleReview();
    const result = applyReceiptedReview(retained.version, structuredClone(decision), digest, disposition);
    retained.application = { decision: digest, result };
    try {
        const applied = await result;
        if (applied.cancellationReason || applied.recoveryRequired) delete retained.application;
        return applied;
    } catch (error) {
        delete retained.application;
        throw error;
    }
}

/** A conversation turn uses the existing edit rules with the review source as its precondition. */
export async function applyPlanReviewConversation(
    cwd: string,
    displayedVersion: PlanReviewVersion,
    decision: PlanReviewDecisionInput,
): Promise<ProjectPlanReviewEventResult> {
    return presentPlanReviewResult(await applyRetainedPlanReviewConversation(cwd, displayedVersion, decision));
}

export async function applyRetainedPlanReviewConversation(
    cwd: string,
    displayedVersion: PlanReviewVersion,
    decision: PlanReviewDecisionInput,
): Promise<InternalProjectPlanReviewEventResult> {
    const owner = reviewOwner(cwd);
    if (!owner) return staleReview();
    const retained = checkedVersion(owner.projectId, cwd, displayedVersion.planId, displayedVersion);
    if (!retained) return staleReview();
    return await settleReviewVersion(retained, { ...decision, approved: false, conversationTurn: true });
}

/** Acknowledge a Sequence answer only when its complete displayed input can still be reviewed together. */
export async function validatePlanReviewSequence(
    cwd: string,
    displayedVersion: PlanReviewVersion,
    decision: SequenceReviewDecision,
): Promise<void> {
    const owner = reviewOwner(cwd);
    const retained = owner && checkedVersion(owner.projectId, cwd, displayedVersion.planId, displayedVersion);
    if (!retained) throw new Error(staleReview().feedback);
    const { version } = retained;
    const { source } = version;
    if (source.kind !== "sequence") throw new Error(staleReview().feedback);
    await inReviewCheckout(version, () => validateSequenceReviewDecision(version.cwd, source.documents, decision));
}
