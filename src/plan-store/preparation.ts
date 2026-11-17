import { selectLocalPlanWorkflow, inspectLocalHomeStore, withLocalPlanWorkflow } from "./access.ts";
import { enterProjectRuntime } from "../shared/project-runtime-layout.ts";
import { healSettledTransitionRecords } from "../shared/workflow/transition-recovery.ts";
import {
    LegacyPackageContinuation,
    releaseSettledPackageAttempt,
    packageWorkflowLocks,
    currentPackageSelection,
    loadPackageWorkflowPlan,
    withPackageWorkflow,
    type PackageWorkflowSelection,
} from "./workflows.ts";
/** Action-owned runtime preparation. Passive lookups must not call this module. */
import { isProjectPlan, parsePlanFrontMatter } from "../plan-format.ts";
import { ensurePlanIdentity, findPlansByParent, loadPlan } from "./index.ts";
import { findActiveByPlanName, prepareWorktreeRegistry } from "../shared/worktree-registry.js";
import {
    assertControllerDocumentAvailable,
    listControllerDocumentWorktrees,
    prepareControllerView,
    readControllerRecord,
    writeControllerState,
} from "./controllers.ts";
import { verifyRecordedPublication } from "../shared/workflow/validation-merge-verification.ts";
import { effectiveDeliveryBranch } from "../shared/workflow/plan-branch.ts";
import { findTargetBranchPlan } from "../shared/workflow/planning-worktree.ts";
import { executionWorktreePathExists } from "../shared/workflow/execution-worktree-rescue.ts";
import { needsSessionPlanningWorktree, resolveWorkflowPlanLocation } from "./location.ts";

/** Prepare legacy controller state from the document, never from its read projection. */
async function prepareDocument(cwd: string, planName: string, prepareIdentity = false) {
    const plan = await loadPlan(cwd, planName);
    if (!plan) return;
    if (prepareIdentity && !plan.attrs.planId && plan.hasFrontMatter) await ensurePlanIdentity(cwd, planName);
    const attrs = parsePlanFrontMatter((await loadPlan(cwd, planName))?.markdown || plan.markdown).attrs;
    await prepareControllerView(cwd, { planId: attrs.planId, planName }, attrs);
}

/** Admit a deliberate Plan action before it selects authority or checks revisions. */
export async function preparePlanController(projectRoot: string, planName: string): Promise<string> {
    if (!currentPackageSelection() && inspectLocalHomeStore(projectRoot).kind === "local")
        return await withLocalPlanWorkflow(projectRoot, planName, () => preparePlanController(projectRoot, planName));
    if (currentPackageSelection()) {
        await loadPackageWorkflowPlan(planName);
        return projectRoot;
    }
    // Registry preparation enters the runtime before taking its own lock.
    await prepareWorktreeRegistry(projectRoot);
    const registered = (await listControllerDocumentWorktrees(projectRoot)).find(
        (entry) => entry.planName === planName,
    );
    const registeredExists = registered && (await executionWorktreePathExists(registered.path));
    if (registeredExists) assertControllerDocumentAvailable(registered);
    const documentRoot = registeredExists ? registered.path : projectRoot;
    await prepareDocument(documentRoot, planName);
    return documentRoot;
}

/** Prepare controller authority, then select the actionable document. */
export async function preparePlanWorkflow(
    projectRoot: string,
    planName: string,
    packageSelection?: PackageWorkflowSelection,
) {
    if (!packageSelection && !currentPackageSelection())
        packageSelection = await selectLocalPlanWorkflow(projectRoot, planName);
    if (packageSelection) {
        try {
            return await withPackageWorkflow(
                projectRoot,
                packageSelection,
                () => preparePlanWorkflowInScope(projectRoot, planName),
                planName,
            );
        } catch (error) {
            if (!(error instanceof LegacyPackageContinuation)) throw error;
            return {
                ...(await preparePlanWorkflowInScope(error.repositoryRoot, error.planName)),
                legacyContinuation: { repositoryRoot: error.repositoryRoot, attemptId: error.attemptId },
            };
        }
    }
    return await preparePlanWorkflowInScope(projectRoot, planName);
}
async function preparePlanWorkflowInScope(projectRoot: string, planName: string) {
    if (currentPackageSelection()) {
        await enterProjectRuntime(projectRoot);
        const recovery = await packageWorkflowLocks([planName], () =>
            healSettledTransitionRecords(projectRoot, { planName }),
        );
        const pending = recovery.remaining[0];
        if (pending) throw new Error(`Package transition needs current evidence: ${pending.reason}`);
        await releaseSettledPackageAttempt(planName);
        return await resolveWorkflowPlanLocation(projectRoot, planName, { readOnly: true });
    }
    await preparePlanController(projectRoot, planName);
    let location = await resolveWorkflowPlanLocation(projectRoot, planName, { readOnly: true });
    if (
        location.plan &&
        !location.publishedSnapshot &&
        !location.missingExecutionCheckout &&
        !location.planningNotStarted
    ) {
        await prepareDocument(location.documentRoot, planName, !needsSessionPlanningWorktree(location.plan.attrs));
        // Identity preparation can rewrite the document. Publication proof must
        // update that identity, not the obsolete name-only controller record.
        location = await resolveWorkflowPlanLocation(projectRoot, planName, { readOnly: true });
    }
    if (location.plan) {
        await preparePlanPublication(projectRoot, planName, location.plan);
        const branch = effectiveDeliveryBranch(location.plan.attrs);
        const target =
            branch && (location.planningNotStarted || location.publishedSnapshot)
                ? await findTargetBranchPlan(projectRoot, branch, planName)
                : null;
        if (target) await preparePlanPublication(projectRoot, planName, target);
    }
    return await resolveWorkflowPlanLocation(projectRoot, planName, { readOnly: true });
}

/** Fresh publication proof belongs to actions, including target-only documents. */
export async function preparePlanPublication(
    projectRoot: string,
    planName: string,
    plan: NonNullable<Awaited<ReturnType<typeof loadPlan>>>,
) {
    const raw = parsePlanFrontMatter(plan.markdown).attrs;
    if (raw.status !== "validated" || plan.attrs.verifiedAt || plan.attrs.worktreeId) return;
    if (isProjectPlan(plan.attrs) && plan.attrs.targetBranch) return;
    if (await findActiveByPlanName(projectRoot, planName)) return;
    const identity = { planId: raw.planId, planName };
    const before = await readControllerRecord(projectRoot, identity);
    const proof = await verifyRecordedPublication(
        projectRoot,
        { ...raw, ...plan.attrs, status: raw.status },
        {
            planName,
            markdown: plan.markdown,
        },
    ).catch(() => ({ published: false }));
    if (!proof.published) return;
    await writeControllerState(
        projectRoot,
        identity,
        { verifiedAt: new Date().toISOString() },
        {
            expectedRevision: before?.revision || 0,
        },
    );
}

/** Prepare sibling workflow facts before a selected child's dependency decision. */
export async function preparePlanDependencies(projectRoot: string, parentPlan: string) {
    for (const child of await findPlansByParent(projectRoot, parentPlan)) {
        await preparePlanWorkflow(projectRoot, child.name);
    }
}
