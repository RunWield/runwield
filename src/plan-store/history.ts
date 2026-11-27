import { StalePlanWriteError } from "@runwield/plans/store";
import { packageDocumentText } from "@runwield/plans/file-snapshots";
import { plans, type PlanId } from "@runwield/plans";
import type { ProjectStoreIdentity } from "@runwield/projects";
import type { PackageDocuments, PlanHistory } from "@runwield/plans/history";
import { planHistoryFiles } from "@runwield/plans/history-files";
import { buildPlanEventUpdates } from "@runwield/plans/lifecycle";
import { sameReviewedMarkdown } from "./review.ts";
import { settleSequenceHistory } from "./transitions.ts";

import { assertSharedPlanWriteAllowed } from "../shared/collaboration/lock.ts";
import {
    packageWorkflowRevision,
    commitPlanPackageBatch,
    listPlanPackages,
    withPlanPackageCatalogDiscovery,
    withPlanPackageLocks,
    type LoadedPlanPackage,
    type PackageMetadataUpdate,
} from "@runwield/plans/package-storage";
import {
    currentPackageProject,
    packageController,
    loadPackageWorkflowPlan,
    preparePackageWorkflowUpdate,
    selectedPackage,
} from "./workflows.ts";

function missingPlan(): never {
    throw new Error("Plan history requires an admitted Plan.");
}

/** Resolve a CLI reference against the complete canonical catalog, including archives. */
export async function resolveLocalHistoryPlan(reference: string): Promise<PlanId> {
    const owner = currentPackageProject() ?? missingPlan();
    return await withPlanPackageCatalogDiscovery(
        owner,
        async () => {
            const catalog = await listPlanPackages(owner, true);
            if (catalog.issues.length) throw new Error(catalog.issues[0].message);
            const plan =
                catalog.packages.find(({ metadata }) => metadata.planId === reference) ??
                catalog.packages.find(({ metadata }) => metadata.name === reference);
            const planId = plan?.metadata.planId;
            return plans.identity.isValid(planId) ? planId : missingPlan();
        },
        missingPlan,
    );
}

async function withHistoryPlan<T>(
    cwd: string,
    planId: PlanId,
    run: (plan: LoadedPlanPackage, owner: ProjectStoreIdentity) => T | Promise<T>,
) {
    const owner = currentPackageProject() ?? missingPlan();
    return await withPlanPackageCatalogDiscovery(
        owner,
        async () => {
            const catalog = await listPlanPackages(owner, true);
            if (catalog.issues.length) throw new Error(catalog.issues[0].message);
            if (!catalog.packages.some(({ metadata }) => metadata.planId === planId)) missingPlan();
            await settleSequenceHistory(cwd, planId);
            return await withPlanPackageLocks(owner, [planId], async () =>
                run(await selectedPackage({ planId }), owner),
            );
        },
        missingPlan,
    );
}

export async function listLocalPlanHistory(cwd: string, planId: PlanId): Promise<PlanHistory> {
    return await withHistoryPlan(cwd, planId, (plan) => ({
        planId,
        revision: packageWorkflowRevision(plan),
        milestones: plan.metadata.history ?? [],
    }));
}

export async function readLocalPlanMilestone(cwd: string, planId: PlanId, version: string): Promise<PackageDocuments> {
    return await withHistoryPlan(cwd, planId, (plan, owner) =>
        planHistoryFiles.forOwner(owner).read(plan.metadata, version),
    );
}

export async function restoreLocalPlanMilestone(
    cwd: string,
    planId: PlanId,
    version: string,
    expectedRevision: string,
): Promise<string> {
    return await withHistoryPlan(cwd, planId, async (plan, owner) => {
        const { metadata } = plan;
        if (metadata.archive && !metadata.archive.restoredAt)
            throw new Error("Restore the archived Plan before editing its documents.");
        assertSharedPlanWriteAllowed(await packageController(plan));
        const revision = packageWorkflowRevision(plan);
        if (expectedRevision !== revision) throw new StalePlanWriteError(expectedRevision, revision);
        const documents = await planHistoryFiles.forOwner(owner).read(metadata, version);
        const before = packageDocumentText(plan.documents);
        const changed =
            Object.keys(before).length !== Object.keys(documents).length ||
            plan.documents.some(
                ({ name }) => documents[name] === undefined || !sameReviewedMarkdown(before[name]!, documents[name]!),
            );
        const reopen =
            changed && ["approved", "ready_for_work", "ready_for_decomposition"].includes(metadata.definition.status);
        let update: PackageMetadataUpdate = {};
        if (reopen) {
            const { attrs } = await loadPackageWorkflowPlan({ planId: metadata.planId });
            update = await preparePackageWorkflowUpdate(
                plan,
                attrs,
                buildPlanEventUpdates("review_reopened", attrs.status, { triageMeta: attrs }),
                {
                    review: undefined,
                    readiness: undefined,
                },
            );
        }
        await commitPlanPackageBatch(owner, [
            {
                before: { metadata, documents: before },
                documents,
                metadata: {
                    ...metadata,
                    revision: metadata.revision + 1,
                    ...update,
                },
            },
        ]);
        return packageWorkflowRevision(await selectedPackage({ planId: metadata.planId }));
    });
}
