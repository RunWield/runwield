import { updatePlanFrontMatter, type PlanFrontMatter } from "../plan-store.js";

const definitionFields = [
    "classification",
    "type",
    "summary",
    "title",
    "workKind",
    "complexity",
    "affectedPaths",
    "executionAgent",
    "collaborationRecommendation",
    "frontend",
    "devServerCommand",
    "devServerUrl",
    "devServerHmr",
    "tickets",
    "supersedes",
    "parentPlan",
    "dependencies",
    "order",
    "origin",
    "targetBranch",
    "deliveryBranch",
    "epicBaseCommit",
] as const;

export type PlanDefinitionChanges = Partial<Pick<PlanFrontMatter, (typeof definitionFields)[number]>>;
export interface PlanWritePrecondition {
    expectedRevision: string;
    expectedControllerRevision?: number;
}

/** Change authoring facts without allowing a caller to overwrite lifecycle or execution evidence. */
export async function savePlanDefinition(
    cwd: string,
    name: string,
    changes: PlanDefinitionChanges,
    precondition: PlanWritePrecondition,
) {
    for (const field of Object.keys(changes))
        if (!definitionFields.some((allowed) => allowed === field))
            throw new Error(`Plan definition cannot change protected field: ${field}`);
    return await updatePlanFrontMatter(cwd, name, changes, {}, precondition);
}

/** A validation writer replaces only its checkpoint, under the Plan and controller preconditions it observed. */
export async function savePlanValidationCheckpoint(
    cwd: string,
    name: string,
    checkpoint: PlanFrontMatter["validationCheckpoint"],
    precondition: PlanWritePrecondition,
) {
    return await updatePlanFrontMatter(cwd, name, { validationCheckpoint: checkpoint }, {}, precondition);
}

/** Retain an Epic review without changing its lifecycle or publication proof. */
export async function saveEpicIntegrationReview(
    cwd: string,
    name: string,
    review: PlanFrontMatter["epicIntegrationReview"],
    precondition: PlanWritePrecondition,
) {
    return await updatePlanFrontMatter(cwd, name, { epicIntegrationReview: review }, {}, precondition);
}

import { loadPlan, withPlanLock, StalePlanWriteError } from "../plan-store.js";
import { withLocalPlanWorkflow } from "./access.ts";
import { appendPlanDeviation, type PlanDeviationProposal } from "../shared/plan-deviations.ts";
/** Persist a confirmed requirement replacement against the exact Plan that was shown for confirmation. */
export async function recordPlanDeviation(
    cwd: string,
    name: string,
    proposal: PlanDeviationProposal,
    expectedRevision: string,
) {
    return await withLocalPlanWorkflow(cwd, name, () =>
        withPlanLock(cwd, name, async () => {
            const plan = await loadPlan(cwd, name);
            if (!plan || plan.revision !== expectedRevision)
                throw new StalePlanWriteError(expectedRevision, plan?.revision || "missing");
            const appended = appendPlanDeviation(plan.attrs.planDeviations, proposal);
            await updatePlanFrontMatter(cwd, name, { planDeviations: appended.entries }, plan.attrs, {
                expectedRevision,
            });
            return appended;
        }),
    );
}

export interface PlanHumanReviewMetadata {
    humanReviewMode: PlanFrontMatter["humanReviewMode"];
    humanReviewDecision: PlanFrontMatter["humanReviewDecision"];
    humanReviewedAt: string | null;
}
/** Record the Code Review outcome without exposing an arbitrary metadata transition. */
export async function recordPlanHumanReview(
    cwd: string,
    planName: string,
    metadata: PlanHumanReviewMetadata,
): Promise<void> {
    const { runPlanFrontMatterTransition } = await import("./transitions.ts");
    const result = await runPlanFrontMatterTransition({
        projectRoot: cwd,
        planName,
        operation: "validation_human_review_metadata",
        updates: {
            humanReviewMode: metadata.humanReviewMode,
            humanReviewDecision: metadata.humanReviewDecision,
            humanReviewedAt: metadata.humanReviewedAt,
        },
    });
    if (result.status !== "committed") throw new Error(result.message || "Code Review outcome needs recovery.");
}
