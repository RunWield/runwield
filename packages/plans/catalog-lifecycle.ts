import type { ProjectStoreIdentity } from "@runwield/projects";
import { isRecoverableWorktreeStatus, isTerminalArchivableStatus, type PlanId } from "./format.ts";
import type { ArchiveProjectPlan } from "./lifecycle.ts";
import {
    archivedPlanPackageMetadata,
    archivePlanPackage,
    renamePlanPackage,
    restoredPlanPackageMetadata,
    restorePlanPackage,
    withPlanPackageLocks,
} from "./package-storage.ts";
import { requiresLifecycleOperationDocument, stageLifecycleOperationDocument } from "./operation-receipts.ts";
import { projectPlanDocumentFields, projectPlanFiles } from "./project-plan-files.ts";
import { PlanNotFoundError, StalePlanWriteError } from "./store-errors.ts";

interface ArchiveCatalogPlan extends Omit<ArchiveProjectPlan, "expectedRevision"> {
    expectedRevision?: string;
    now?: string;
    abandonedWorktree?: boolean;
}

interface RestoreCatalogPlan {
    expectedRevision?: string;
    destination?: string;
}

function requireObservedRevision(expected: string | undefined, actual: string): void {
    if (expected !== undefined && expected !== actual) throw new StalePlanWriteError(expected, actual);
}

/** Canonical catalog transitions keep source checks, history, and commit under the same Plan locks. */
export const catalogPlanLifecycle = {
    async archive(owner: ProjectStoreIdentity, planId: PlanId, options: ArchiveCatalogPlan) {
        const files = projectPlanFiles.forOwner(owner);
        return await withPlanPackageLocks(owner, [planId], async () => {
            const target = { planId };
            const source = await files.readResource(target, undefined, true);
            requireObservedRevision(options.expectedRevision, source.revision);
            const worktreeStatus = options.abandonedWorktree ? "abandoned" : source.attrs.worktreeStatus;
            if (isRecoverableWorktreeStatus(worktreeStatus))
                throw new Error(`Cannot archive ${source.name}: worktreeStatus ${worktreeStatus} is recoverable.`);
            if (!options.force && !isTerminalArchivableStatus(source.attrs.status))
                throw new Error(`Cannot archive ${source.name} with status ${source.attrs.status} without --force.`);
            const selected = await files.select(target);
            const reason = options.reason || "";
            const now = options.now ?? new Date().toISOString();
            if (requiresLifecycleOperationDocument(planId)) {
                const metadata = archivedPlanPackageMetadata(selected, reason, now);
                stageLifecycleOperationDocument(
                    await files.projectLifecycleGeneration({ ...selected, metadata }, planId),
                );
            }
            await archivePlanPackage(owner, planId, selected.metadata.revision, reason, now);
            return { source, document: await files.readArchived(planId) };
        });
    },
    async restore(owner: ProjectStoreIdentity, planId: PlanId, options: RestoreCatalogPlan) {
        const files = projectPlanFiles.forOwner(owner);
        return await withPlanPackageLocks(owner, [planId], async () => {
            const target = { planId };
            const source = await files.readArchivedResource(target);
            if (!source) throw new PlanNotFoundError(planId);
            requireObservedRevision(options.expectedRevision, source.revision);
            const selected = await files.select(target);
            const metadata =
                options.destination && options.destination !== source.name
                    ? await renamePlanPackage(owner, planId, selected.metadata.revision, options.destination)
                    : selected.metadata;
            const now = new Date().toISOString();
            if (requiresLifecycleOperationDocument(planId)) {
                const current = metadata === selected.metadata ? selected : await files.select(target);
                const generation = { ...current, metadata: restoredPlanPackageMetadata(metadata, now) };
                stageLifecycleOperationDocument(await files.projectLifecycleGeneration(generation, planId));
            }
            await restorePlanPackage(owner, planId, metadata.revision, now);
            const restored = await files.readResource(target, undefined, true);
            return { source, restored, document: { ...projectPlanDocumentFields(restored), planId } };
        });
    },
};
