/** Action-owned runtime preparation. Passive lookups must not call this module. */
import {
    ensurePlanIdentity,
    findPlansByParent,
    isProjectPlan,
    loadPlan,
    parsePlanFrontMatter,
} from "../../plan-store.js";
import { findActiveByPlanName, prepareWorktreeRegistry } from "../worktree-registry.js";
import {
    assertControllerDocumentAvailable,
    listControllerDocumentWorktrees,
    prepareControllerView,
    readControllerRecord,
    writeControllerState,
} from "./controller-registry.ts";
import { verifyRecordedPublication } from "./validation-merge-verification.ts";
import { effectiveDeliveryBranch } from "./plan-branch.ts";
import { findTargetBranchPlan } from "./planning-worktree.ts";
import { executionWorktreePathExists } from "./execution-worktree-rescue.ts";
import { needsSessionPlanningWorktree, resolveWorkflowPlanLocation } from "./plan-location.ts";

/** Prepare legacy controller state from the document, never from its read projection. */
async function prepareDocument(cwd: string, planName: string, prepareIdentity = false) {
    const plan = await loadPlan(cwd, planName);
    if (!plan) return;
    if (prepareIdentity && !plan.attrs.planId && plan.hasFrontMatter) await ensurePlanIdentity(cwd, planName);
    const attrs = parsePlanFrontMatter((await loadPlan(cwd, planName))?.markdown || plan.markdown).attrs;
    await prepareControllerView(cwd, { planId: attrs.planId, planName }, attrs);
}

/** Admit a deliberate Plan action before it selects authority or checks revisions. */
export async function preparePlanController(projectRoot: string, planName: string) {
    // Registry preparation enters the runtime before taking its own lock.
    await prepareWorktreeRegistry(projectRoot);
    const registered = (await listControllerDocumentWorktrees(projectRoot)).find(
        (entry) => entry.planName === planName,
    );
    if (registered && (await executionWorktreePathExists(registered.path)))
        assertControllerDocumentAvailable(registered);
    const documentRoot = registered?.path || projectRoot;
    await prepareDocument(documentRoot, planName);
    return documentRoot;
}

/** Prepare controller authority, then select the actionable document. */
export async function preparePlanWorkflow(projectRoot: string, planName: string) {
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
