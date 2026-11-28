import type { PlanId } from "@runwield/plans";
import type { ProjectStoreIdentity } from "@runwield/projects";
import type { PackageDocuments, PlanHistory } from "@runwield/plans/history";
import { localPlanHistory } from "@runwield/plans/local-history";
import {
    withPlanPackageCatalogDiscovery,
    withPlanPackageCatalogRead,
    withPlanPackageLocks,
    type LoadedPlanPackage,
} from "@runwield/plans/package-storage";
import { PlanPackageError } from "@runwield/plans/file-snapshots";
import { assertSharedPlanWriteAllowed } from "@runwield/plans/collaboration-lock";
import { hasInterruptedSequenceHistory, settleSequenceHistory } from "./transitions.ts";
import { currentPackageProject, packageController } from "./workflows.ts";

function missingPlan(): never {
    throw new Error("Plan history requires an admitted Plan.");
}

type LocalHistoryRead<Result> =
    | { kind: "reference"; read: (owner: ProjectStoreIdentity) => Promise<Result> }
    | {
          kind: "plan";
          planId: PlanId;
          read: (owner: ProjectStoreIdentity, plan: LoadedPlanPackage) => Result | Promise<Result>;
      };

/** Keep the recovered catalog locked through the history snapshot. */
async function readLocalHistory<Result>(cwd: string, operation: LocalHistoryRead<Result>): Promise<Result> {
    const owner = currentPackageProject() ?? missingPlan();
    const snapshot = await withPlanPackageCatalogRead(owner, async () => {
        try {
            if (operation.kind === "reference") return { kind: "read", value: await operation.read(owner) } as const;
            const plan = await localPlanHistory.select(owner, operation.planId);
            if (await hasInterruptedSequenceHistory(cwd, plan.metadata)) return { kind: "interrupted" } as const;
            return { kind: "read", value: await operation.read(owner, plan) } as const;
        } catch (error) {
            if (error instanceof PlanPackageError && error.kind === "pending_recovery")
                return { kind: "interrupted" } as const;
            throw error;
        }
    });
    if (snapshot.kind === "read") return snapshot.value;

    return await withPlanPackageCatalogDiscovery(
        owner,
        async () => {
            if (operation.kind === "reference") return await operation.read(owner);
            const plan = await localPlanHistory.select(owner, operation.planId);
            await settleSequenceHistory(cwd, plan.metadata);
            return await operation.read(owner, await localPlanHistory.select(owner, operation.planId));
        },
        missingPlan,
    );
}

/** Resolve a CLI reference against the complete canonical catalog, including archives. */
export async function resolveLocalHistoryPlan(cwd: string, reference: string): Promise<PlanId> {
    return await readLocalHistory(cwd, {
        kind: "reference",
        read: (owner) => localPlanHistory.resolve(owner, reference),
    });
}

export async function listLocalPlanHistory(cwd: string, planId: PlanId): Promise<PlanHistory> {
    return await readLocalHistory(cwd, {
        kind: "plan",
        planId,
        read: (_owner, plan) => localPlanHistory.list(planId, plan),
    });
}

export async function readLocalPlanMilestone(cwd: string, planId: PlanId, version: string): Promise<PackageDocuments> {
    return await readLocalHistory(cwd, {
        kind: "plan",
        planId,
        read: (owner, plan) => localPlanHistory.read(owner, plan, version),
    });
}

async function assertHistoryRestoreAllowed(plan: LoadedPlanPackage): Promise<void> {
    if (plan.metadata.archive && !plan.metadata.archive.restoredAt)
        throw new Error("Restore the archived Plan before editing its documents.");
    assertSharedPlanWriteAllowed(await packageController(plan));
}

export async function restoreLocalPlanMilestone(
    cwd: string,
    planId: PlanId,
    version: string,
    expectedRevision: string,
): Promise<string> {
    const owner = currentPackageProject() ?? missingPlan();
    return await withPlanPackageCatalogDiscovery(
        owner,
        async () => {
            const { metadata } = await localPlanHistory.select(owner, planId);
            await settleSequenceHistory(cwd, metadata);
            return await withPlanPackageLocks(owner, [planId], async () => {
                const plan = await localPlanHistory.select(owner, planId);
                await assertHistoryRestoreAllowed(plan);
                return await localPlanHistory.restore(owner, plan, version, expectedRevision);
            });
        },
        missingPlan,
    );
}
