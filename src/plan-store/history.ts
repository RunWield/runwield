import { randomUUID } from "node:crypto";
import { buildPlanEventUpdates } from "../shared/workflow/plan-lifecycle.ts";
import { sameReviewedMarkdown } from "./review.ts";
import { settleSequenceHistory } from "./transitions.ts";
import { readLocalHomeStore } from "./access.ts";
import { StalePlanWriteError } from "../plan-store.ts";
import { assertSharedPlanWriteAllowed } from "../shared/collaboration/lock.ts";
import {
    commitPlanPackageBatch,
    listPlanPackages,
    packageDocumentText,
    packageWorkflowRevision,
    readPackageMilestone,
    withPlanPackageCatalogDiscovery,
    withPlanPackageLocks,
    type LoadedPlanPackage,
    type PlanMilestone,
    type PackageDocuments,
    type PackageMetadataUpdate,
} from "./packages.ts";
import {
    currentPackageProject,
    packageController,
    loadPackageWorkflowPlan,
    preparePackageWorkflowUpdate,
    selectedPackage,
} from "./workflows.ts";
import {
    managedPersonalStoreActive,
    readManagedPlanHistory,
    showManagedPlanMilestone,
    mutateManagedPlan,
} from "./managed.ts";

export interface PlanHistory {
    planId: string;
    revision: string;
    milestones: PlanMilestone[];
}

async function withHistoryPlan<T>(cwd: string, reference: string, run: (plan: LoadedPlanPackage) => T | Promise<T>) {
    const missing = (): never => {
        throw new Error("Plan history requires an admitted Plan.");
    };
    return await readLocalHomeStore(
        cwd,
        async () => {
            const owner = currentPackageProject() ?? missing();
            return await withPlanPackageCatalogDiscovery(
                owner,
                async () => {
                    const catalog = await listPlanPackages(owner, true);
                    if (catalog.issues.length) throw new Error(catalog.issues[0].message);
                    const plan =
                        catalog.packages.find((plan) => plan.metadata.planId === reference) ??
                        catalog.packages.find((plan) => plan.metadata.name === reference) ??
                        missing();
                    const planId = plan.metadata.planId;
                    await settleSequenceHistory(cwd, planId);
                    return await withPlanPackageLocks(owner, [planId], async () =>
                        run(await selectedPackage({ planId })),
                    );
                },
                missing,
            );
        },
        missing,
    );
}

export async function listPlanHistory(cwd: string, reference: string): Promise<PlanHistory> {
    if (managedPersonalStoreActive()) return await readManagedPlanHistory(cwd, reference);
    return await withHistoryPlan(cwd, reference, (plan) => ({
        planId: plan.metadata.planId,
        revision: packageWorkflowRevision(plan),
        milestones: plan.metadata.history ?? [],
    }));
}

export async function showPlanMilestone(cwd: string, reference: string, version: string): Promise<PackageDocuments> {
    if (managedPersonalStoreActive()) return await showManagedPlanMilestone(cwd, reference, version);
    return await withHistoryPlan(cwd, reference, (plan) =>
        readPackageMilestone(currentPackageProject()!, plan, version),
    );
}

export async function restorePlanMilestone(
    cwd: string,
    planId: string,
    version: string,
    expectedRevision: string,
): Promise<string> {
    if (managedPersonalStoreActive()) {
        const result = await mutateManagedPlan(cwd, {
            kind: "restore-history",
            planId,
            version,
            expectedRevision,
            operationId: randomUUID(),
        });
        if (!result.revision) throw new Error("Managed history restore has no committed revision.");
        return result.revision;
    }
    return await withHistoryPlan(cwd, planId, async (plan) => {
        const { metadata } = plan;
        if (metadata.archive && !metadata.archive.restoredAt)
            throw new Error("Restore the archived Plan before editing its documents.");
        assertSharedPlanWriteAllowed(await packageController(plan));
        const revision = packageWorkflowRevision(plan);
        if (expectedRevision !== revision) throw new StalePlanWriteError(expectedRevision, revision);
        const owner = currentPackageProject()!;
        const documents = await readPackageMilestone(owner, plan, version);
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
