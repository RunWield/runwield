import { realpath as fsRealpath } from "node:fs/promises";
import {
    canonicalizeStoredPlanName,
    canonicalPlanStatus,
    findPlanEvidenceById,
    getDeclaredPlanStatus,
    loadPlan,
    resolvePlan,
    updatePlanFrontMatter,
} from "../../plan-store.js";
import {
    type MissingExecutionWorktreeRecovery,
    resolveWorkflowPlanLocation,
} from "../../shared/workflow/plan-location.ts";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { resolvePrimaryCheckoutRoot } from "../../shared/primary-checkout.ts";
import { listEntries } from "../../shared/worktree-registry.js";
import { cleanupStoredPublication, loadPublicationAttempt } from "../../shared/workflow/publication-machine.ts";
import { isPublicationCleanupPending } from "../../shared/workflow/publication-attempt.ts";

type ResolvedPlan = Awaited<ReturnType<typeof resolvePlan>>;

function isPlanIdArgument(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

export interface LoadPlanResolution {
    plan: ResolvedPlan;
    recoveredWorktree?: MissingExecutionWorktreeRecovery;
    recoveredStatus?: { from: string; to: string };
}

export interface PublicationCleanupNotice {
    planName: string;
    targetBranch: string;
    complete: boolean;
    details: string[];
    preservedFiles?: string;
}

async function canonicalFilePath(path: string): Promise<string> {
    try {
        return await fsRealpath(path);
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        const parent = dirname(path);
        return parent === path ? path : resolve(await canonicalFilePath(parent), basename(path));
    }
}

async function normalizePlanArgument(projectRoot: string, planArg: string): Promise<string> {
    const pathArgument = await canonicalFilePath(resolve(projectRoot, planArg));
    // A path into this project's Plan directory is the same resource as its name,
    // even when that primary file is absent. Only genuinely external files bypass
    // controller selection.
    for (const root of [projectRoot, resolvePrimaryCheckoutRoot(projectRoot)]) {
        const storedPath = relative(await canonicalFilePath(resolve(root, "docs/plans")), pathArgument).replaceAll("\\", "/");
        if (!isAbsolute(storedPath) && storedPath !== ".." && !storedPath.startsWith("../")) {
            planArg = storedPath;
            break;
        }
    }
    return planArg;
}

async function repairRetiredPlanStatus(
    documentRoot: string,
    planName: string,
    plan: ResolvedPlan,
): Promise<Pick<LoadPlanResolution, "plan" | "recoveredStatus">> {
    const declaredStatus = getDeclaredPlanStatus(plan.markdown);
    const canonicalStatus = canonicalPlanStatus(declaredStatus);
    if (!declaredStatus || !canonicalStatus || declaredStatus === canonicalStatus) return { plan };

    await updatePlanFrontMatter(documentRoot, planName, { status: canonicalStatus }, {}, {
        expectedRevision: plan.revision,
    });
    const repaired = await loadPlan(documentRoot, planName);
    if (!repaired) throw new Error(`Plan not found after repairing its retired status: ${planName}`);
    return {
        plan: { ...repaired, planName },
        recoveredStatus: { from: declaredStatus, to: canonicalStatus },
    };
}

/** Explicitly requested cleanup, independent of an already-removed Plan directory. */
export async function resumePlanPublicationCleanup(
    projectRoot: string,
    planArg: string,
): Promise<PublicationCleanupNotice[]> {
    const registryRoot = resolvePrimaryCheckoutRoot(projectRoot);
    const planName = canonicalizeStoredPlanName(await normalizePlanArgument(projectRoot, planArg)).name;
    const entries = (await listEntries(registryRoot, { migrate: false }))
        .filter((entry) => entry.status !== "abandoned" && entry.planName === planName);
    if (entries.some((entry) => entries.filter((candidate) => candidate.planName === entry.planName).length > 1)) {
        throw new Error(
            "More than one execution attempt owns this Plan. Inspect the saved worktree records before cleanup.",
        );
    }
    const notices: PublicationCleanupNotice[] = [];
    for (const entry of entries) {
        if (!isPublicationCleanupPending(entry.publication)) continue;
        const publication = await loadPublicationAttempt(registryRoot, entry.id);
        if (!publication) continue;
        const cleanup = await cleanupStoredPublication(registryRoot, publication);
        notices.push({
            planName: publication.planName,
            targetBranch: publication.targetBranch,
            complete: cleanup.complete,
            details: cleanup.details,
            preservedFiles: cleanup.preservedFiles,
        });
    }
    return notices;
}

/**
 * Execution owns its document. A missing or edited primary copy is irrelevant.
 */
export async function resolvePlanWithPrimaryRecovery(
    projectRoot: string,
    planArg: string,
): Promise<LoadPlanResolution> {
    if (isPlanIdArgument(planArg)) return { plan: await findPlanEvidenceById(projectRoot, planArg) };
    planArg = await normalizePlanArgument(projectRoot, planArg);
    let name: string;
    try {
        name = canonicalizeStoredPlanName(planArg).name;
    } catch {
        return { plan: await resolvePlan(projectRoot, planArg) };
    }
    const location = await resolveWorkflowPlanLocation(projectRoot, name, { migrateRegistry: false });
    if (location.archived) {
        throw new Error(`This Plan is archived. Run wld plans archive restore ${name} before continuing it.`);
    }
    const resolvedPlan = location.plan ? { ...location.plan, planName: name } : await resolvePlan(projectRoot, planArg);
    const repaired = await repairRetiredPlanStatus(location.documentRoot, name, resolvedPlan);
    return { ...repaired, recoveredWorktree: location.recoveredWorktree };
}
