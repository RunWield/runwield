import { projects, type ProjectStoreIdentity } from "@runwield/projects";
import { PlanPackageError, statPackagePath } from "@runwield/plans/file-snapshots";
import {
    commitPlanPackageImport,
    findImportedPlansForMissingSource,
    readPlanPackageImportState,
    validatePlanPackageImportDestinations,
    withPlanPackageCatalogDiscovery,
    withPlanPackageLocks,
    type PlanImportResult,
    type PlanImportOptions,
} from "@runwield/plans/package-storage";
import type { ManagedProjectStoreLaunch } from "../shared/remote/project-store-launch.ts";
import {
    omitBlockedPlanImports,
    preparePlanPackageImport,
    revalidatePlanImport,
    skipPlanImportSource,
} from "./import-source.ts";

interface ManagedImportTransport {
    launch: ManagedProjectStoreLaunch;
    operationId: string;
    signal?: AbortSignal;
}

export async function importPlanPackages(
    identity: ProjectStoreIdentity,
    selection: string,
    options: PlanImportOptions = {},
): Promise<PlanImportResult> {
    return await importObservedPlanPackages(identity, selection, options);
}

export async function importManagedPlanPackages(
    identity: ProjectStoreIdentity,
    selection: string,
    transport: ManagedImportTransport,
    options: PlanImportOptions = {},
): Promise<PlanImportResult> {
    if (!projects.home.isOwner(identity)) throw new Error("Managed import requires the personal home owner.");
    return await importObservedPlanPackages(identity, selection, options, transport);
}

/** Keep source capture and revalidation with the checkout or SSH execution adapter. */
async function importObservedPlanPackages(
    identity: ProjectStoreIdentity,
    selection: string,
    options: PlanImportOptions,
    transport?: ManagedImportTransport,
): Promise<PlanImportResult> {
    try {
        return await withPlanPackageCatalogDiscovery(identity, async () => {
            const state = await readPlanPackageImportState(identity, selection, transport?.operationId);
            if ("kind" in state) return state;
            const { catalog, allocations } = state;
            if (!transport && !(await statPackagePath(selection))) {
                const imported = await findImportedPlansForMissingSource(identity, selection, catalog);
                if (imported) return imported;
            }
            const request = {
                projectId: identity.projectId,
                repositoryId: identity.repositoryId,
                personalOwner: identity.personalOwner.identity,
                selection,
                allocations,
                catalog: catalog.map(({ metadata: { planId, name, definition } }) => ({
                    metadata: { planId, name, definition },
                })),
                createdAt: new Date().toISOString(),
                ...options,
            };
            const prepared = transport
                ? await (
                      await import("../shared/remote/project-store-launch.ts")
                  ).readManagedImportSource(transport.launch, request, transport.signal)
                : await preparePlanPackageImport(
                      projects.home.requireCheckout(identity),
                      selection,
                      allocations,
                      catalog,
                      request.createdAt,
                      options,
                  );
            return await withPlanPackageLocks(
                identity,
                prepared.members.map((member) => member.metadata.planId),
                async () => {
                    if (transport)
                        await (
                            await import("../shared/remote/project-store-launch.ts")
                        ).readManagedImportSource(transport.launch, { ...request, prepared }, transport.signal);
                    else if (prepared.members.length)
                        await revalidatePlanImport(
                            projects.home.requireCheckout(identity),
                            prepared,
                            catalog,
                            allocations,
                        );
                    await validatePlanPackageImportDestinations(identity, prepared, (member, error) =>
                        skipPlanImportSource(prepared, member.evidence.source.path, error),
                    );
                    omitBlockedPlanImports(prepared, catalog);
                    if (prepared.skipped?.length) {
                        const skippedPaths = new Set(prepared.skipped.map(({ path }) => path));
                        prepared.observations = prepared.observations.filter(({ path }) => !skippedPaths.has(path));
                    }
                    return await commitPlanPackageImport(identity, prepared, transport?.operationId);
                },
            );
        });
    } catch (error) {
        return {
            kind:
                error instanceof PlanPackageError
                    ? error.kind === "collision"
                        ? "conflict"
                        : ["pending_recovery", "changed_input"].includes(error.kind)
                          ? "pending"
                          : ["malformed_metadata", "unsupported_metadata", "unsafe_path"].includes(error.kind)
                            ? "invalid"
                            : "unavailable"
                    : "unavailable",
            message: error instanceof Error ? error.message : String(error),
        };
    }
}
