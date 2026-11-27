import { StalePlanWriteError } from "@runwield/plans/store";
import { isCanonicalPlanStatus } from "@runwield/plans/store-format";
import { isChildFeaturePlan, compareChildPlansByOrder } from "@runwield/plans/format";
import { managedPlanStoreActive, archiveManagedPlan, restoreManagedPlan, readManagedArchive } from "./managed.ts";
import { rmdir } from "node:fs/promises";
import { relative } from "node:path";
import { archivePlan, restoreArchivedPlan, loadArchivedPlan, getPlanDocumentRoot } from "../plan-store.ts";
import { loadPlan, listPlans } from "./queries.ts";
import { runArchiveTransition, type TransitionResult } from "./transitions.ts";
import { currentPackageProject, loadPackageWorkflowPlan, packageWorkflowLocks } from "./workflows.ts";
import { withLocalProjectAction } from "./access.ts";

export interface ArchivePlanOptions {
    reason?: string;
    force?: boolean;
    now?: string;
    expectedRevision?: string;
    expectedPlanId?: string;
}
interface ArchiveTransitionValue<T> {
    value: T;
}
function committedArchive<T>(result: TransitionResult): T {
    if (result.status === "committed") return (result.value as ArchiveTransitionValue<T>).value;
    const recovery = (result.recoveryActions || [])
        .map((action) => (action.command ? `${action.label}: ${action.command}` : action.label))
        .join("; ");
    throw new Error(
        `${result.operation} for Plan needs recovery: ${result.message || result.status}${recovery ? `. Recovery: ${recovery}` : ""}`,
    );
}

/** Journal, source resolution, revision preconditions and moves are one owner operation. */
export async function archiveSavedPlan(cwd: string, name: string, options: ArchivePlanOptions = {}) {
    if (managedPlanStoreActive()) return await archiveManagedPlan(cwd, name, options);
    return await withLocalProjectAction(cwd, async () => {
        return committedArchive<Awaited<ReturnType<typeof archivePlan>>>(
            await runArchiveTransition({
                projectRoot: cwd,
                planName: name,
                action: "archive",
                expectedRevision: options.expectedRevision,
                move: () => archivePlan(cwd, name, options),
            }),
        );
    });
}

export async function restoreSavedPlan(
    cwd: string,
    reference: string,
    destination?: string,
    expectedRevision?: string,
) {
    if (managedPlanStoreActive()) return await restoreManagedPlan(cwd, reference, destination, expectedRevision);
    return await withLocalProjectAction(cwd, async () => {
        const source = await loadArchivedPlan(cwd, reference, expectedRevision !== undefined);
        if (!source) throw new Error(`Archived Plan not found: ${reference}`);
        return committedArchive<Awaited<ReturnType<typeof restoreArchivedPlan>>>(
            await runArchiveTransition({
                projectRoot: cwd,
                planName: source.name,
                action: "restore",
                move: async () => {
                    if (expectedRevision === undefined)
                        return await restoreArchivedPlan(cwd, reference, { to: destination });
                    return await packageWorkflowLocks([{ planId: reference }], async () => {
                        const plan = await loadPackageWorkflowPlan({ planId: reference });
                        if (plan.revision !== expectedRevision)
                            throw new StalePlanWriteError(expectedRevision, plan.revision);
                        return await restoreArchivedPlan(cwd, reference, { to: destination, byId: true });
                    });
                },
            }),
        );
    });
}

export async function archivedPlanProjectRoot(cwd: string, reference: string): Promise<string> {
    const source = managedPlanStoreActive()
        ? await readManagedArchive(cwd, reference)
        : await loadArchivedPlan(cwd, reference);
    return source ? getPlanDocumentRoot(source.path) : cwd;
}

/** The legacy child directory is disposable only after its Plans have been archived. */
export async function archiveEpicPlanFamily(cwd: string, epicName: string, childNames: string[]) {
    return await withLocalProjectAction(cwd, async () => {
        const epic = await loadPlan(cwd, epicName);
        if (!epic) throw new Error(`Epic not found: ${epicName}`);
        const legacyDirectory =
            currentPackageProject() || managedPlanStoreActive()
                ? null
                : epic.path.endsWith(".md")
                  ? epic.path.slice(0, -3)
                  : `${epic.path}.children`;
        const now = new Date().toISOString();
        const archived: Awaited<ReturnType<typeof archiveSavedPlan>>[] = [];
        for (const child of childNames) archived.push(await archiveSavedPlan(cwd, child, { now, force: true }));
        archived.push(await archiveSavedPlan(cwd, epicName, { now }));
        let cleanupMessage: string | undefined;
        if (legacyDirectory) {
            const path = relative(cwd, legacyDirectory).replaceAll("\\", "/");
            try {
                await rmdir(legacyDirectory);
            } catch (error) {
                cleanupMessage =
                    error instanceof Error && "code" in error && error.code === "ENOENT"
                        ? `Active Epic child directory was already absent: ${path}`
                        : `Active Epic child directory was left in place because it is missing protected cleanup preconditions or is not empty: ${path}. ${error instanceof Error ? error.message : String(error)}`;
            }
        }
        return { archived, cleanupMessage };
    });
}

export async function archivePlansByStatus(
    cwd: string,
    status: import("@runwield/plans").PlanFrontMatter["status"],
    options: ArchivePlanOptions = {},
): Promise<import("../plan-store.ts").BulkArchivePlansResult> {
    if (!isCanonicalPlanStatus(status)) {
        throw new Error(`Unknown Plan status for bulk archive: ${status}`);
    }

    if (!managedPlanStoreActive()) await (await import("../shared/worktree-registry.ts")).prepareWorktreeRegistry(cwd);
    const { preparePlanWorkflow } = await import("./preparation.ts");
    for (const plan of await listPlans(cwd)) await preparePlanWorkflow(cwd, plan.name);
    const plans = await listPlans(cwd);
    const childrenByParent = new Map<string, typeof plans>();
    for (const plan of plans) {
        if (!isChildFeaturePlan(plan)) continue;
        const parentPlan = plan.attrs.parentPlan || "";
        const children = childrenByParent.get(parentPlan) || [];
        children.push(plan);
        childrenByParent.set(parentPlan, children);
    }
    for (const children of childrenByParent.values()) children.sort(compareChildPlansByOrder);

    const matchingParentPlans = plans
        .filter((plan) => !isChildFeaturePlan(plan) && plan.attrs.status === status)
        .sort((a, b) => a.name.localeCompare(b.name));
    const matchingPlans = matchingParentPlans.flatMap((plan) => [plan, ...(childrenByParent.get(plan.name) || [])]);
    const matched = matchingPlans.map((plan) => ({
        name: plan.name,
        relativePath: relative(cwd, plan.path).replaceAll("\\", "/"),
    }));
    const now = options.now || new Date().toISOString();
    const archived: import("../plan-store.ts").BulkArchivePlansResult["archived"] = [];
    const failed: import("../plan-store.ts").BulkArchivePlansResult["failed"] = [];

    for (const parentPlan of matchingParentPlans) {
        try {
            const result = await (managedPlanStoreActive()
                ? archiveManagedPlan(cwd, parentPlan.name, { ...options, now })
                : archivePlan(cwd, parentPlan.name, { ...options, now }));
            archived.push({ name: result.name, relativePath: result.relativePath });
        } catch (error) {
            failed.push({
                name: parentPlan.name,
                relativePath: relative(cwd, parentPlan.path).replaceAll("\\", "/"),
                message: error instanceof Error ? error.message : String(error),
            });
            continue;
        }

        for (const childPlan of childrenByParent.get(parentPlan.name) || []) {
            try {
                const result = await (managedPlanStoreActive()
                    ? archiveManagedPlan(cwd, childPlan.name, { ...options, force: true, now })
                    : archivePlan(cwd, childPlan.name, { ...options, force: true, now }));
                archived.push({ name: result.name, relativePath: result.relativePath });
            } catch (error) {
                failed.push({
                    name: childPlan.name,
                    relativePath: relative(cwd, childPlan.path).replaceAll("\\", "/"),
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    return { matched, archived, failed };
}
