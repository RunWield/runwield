export { archiveSavedPlan, restoreSavedPlan, archivePlansByStatus } from "../../plan-store/archiving.ts";
import { plans } from "@runwield/plans";

/** Historical checkout queries for fixtures that assert on retained and managed Plan state. */
export {
    archivePlan,
    deleteArchivedPlanUnit,
    findPlanById,
    findPlanEvidenceById,
    findPlansByParent,
    listArchivedPlans,
    listPlanResources,
    listPlans,
    loadArchivedPlan,
    loadPlan,
    loadPlanBodyById,
    loadPlanStrict,
    readPlanResourceCatalog,
    resolvePlan,
    restoreArchivedPlan,
} from "../../plan-store/queries.ts";

export {
    applyPlanReviewForExecution,
    applySharedPlanReviewDecision,
    type SharedPlanReviewActionOptions,
    type SharedPlanReviewActionResult,
    type SharedPlanReviewDecision,
} from "../../plan-store/review.ts";
export { capturePlanReviewInput, preparePlanReviewDocument } from "../../plan-store/review-snapshots.ts";
// The interruption and managed-owner process drivers still exercise the underlying transaction.
export {
    applySequenceReviewDecision,
    prepareSequenceReview,
    snapshotSequenceReview,
    validateSequenceReviewDecision,
    type SequenceChildInput,
    type SequenceDocumentDecision,
    type SequenceReviewDecision,
    type SequenceReviewResult,
} from "../../plan-store/sequence-review.ts";

async function fixturePlanStore(cwd: string) {
    const { openPlanStoreForCheckout } = await import("../../plan-store/index.ts");
    const store = openPlanStoreForCheckout(cwd);
    if (!store) throw new Error("Plan history requires an admitted Plan.");
    return store;
}

export async function listFixturePlanHistory(cwd: string, reference: string) {
    const store = await fixturePlanStore(cwd);
    return await store.history.list(await store.resolveHistoryPlan(reference));
}

export async function readFixtureMilestone(cwd: string, reference: string, version: string) {
    const store = await fixturePlanStore(cwd);
    return await store.history.read(await store.resolveHistoryPlan(reference), version);
}

export async function restoreFixtureMilestone(cwd: string, planId: string, version: string, expectedRevision: string) {
    if (!plans.identity.isValid(planId)) throw new Error("Plan history requires an admitted Plan.");
    const store = await fixturePlanStore(cwd);
    return await store.history.restore(planId, version, expectedRevision);
}
