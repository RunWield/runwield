import { effectiveDeliveryBranch } from "./plan-branch.ts";
/** Locate the editable document independently from the shared controller files. */
import { canonicalizeStoredPlanName, isCompletedPlanStatus, loadPlan } from "../../plan-store.js";
import { resolvePrimaryCheckoutRoot } from "../primary-checkout.ts";
import { findActiveByPlanName } from "../worktree-registry.js";
import { isGitRepository } from "../git.ts";
import { listControllerDocumentWorktrees } from "./controller-registry.ts";
import { findTargetBranchPlan, preparePlanningWorktreeForPlan } from "./planning-worktree.ts";
import { isPublicationCleanupPending } from "./publication-attempt.ts";
import {
    executionWorktreePathExists,
    type MissingExecutionWorktreeRecovery,
    recoverMissingExecutionWorktree,
} from "./execution-worktree-rescue.ts";

export { recoverMissingExecutionWorktreesForPlanLoading } from "./execution-worktree-rescue.ts";
export type { MissingExecutionWorktreeRecovery } from "./execution-worktree-rescue.ts";

interface ResolveWorkflowPlanLocationOptions {
    migrateRegistry?: boolean;
    /**
     * Resolve the Plan without preparing a planning worktree for an unfinished child on its target branch. The local
     * copy is returned when it exists, otherwise the branch copy. Callers that only read or move the local document,
     * such as Work Record generation and archive, must not start planning attempts.
     */
    readOnly?: boolean;
}

function inferParentPlanName(planName: string): string {
    const segments = planName.split("/");
    segments.pop();
    return segments.join("/");
}

export async function resolveWorkflowPlanLocation(
    cwd: string,
    planName: string,
    options: ResolveWorkflowPlanLocationOptions = {},
) {
    planName = canonicalizeStoredPlanName(planName).name;
    const registryRoot = resolvePrimaryCheckoutRoot(cwd);
    const registryReadOptions = options.migrateRegistry === false ? { migrate: false } : undefined;
    const attempt = await findActiveByPlanName(registryRoot, planName, registryReadOptions);
    if (attempt && !isPublicationCleanupPending(attempt.publication)) {
        let plan = await loadPlan(attempt.path, planName);
        let recoveredWorktree: MissingExecutionWorktreeRecovery | undefined;
        if (!plan && !await executionWorktreePathExists(attempt.path)) {
            recoveredWorktree = await recoverMissingExecutionWorktree(registryRoot, attempt);
            if (recoveredWorktree.recovered) plan = await loadPlan(attempt.path, planName);
        }
        if (plan) {
            if (attempt.planId && plan.attrs.planId && plan.attrs.planId !== attempt.planId) {
                throw new Error("The execution directory contains a different Plan. Your files have not been changed.");
            }
            return { registryRoot, documentRoot: attempt.path, plan, recoveredWorktree };
        }
        if (await loadPlan(attempt.path, `archived/${planName}`)) {
            return { registryRoot, documentRoot: attempt.path, plan: null, archived: true };
        }
        throw new Error(
            `The execution Plan is missing at ${attempt.path}/docs/plans/${planName}.md. ` +
                "Your branch and other files are unchanged. Restore that Plan file from Git history or a backup before continuing; the primary copy will not be used.",
        );
    } else {
        // Planning and reopened documents are document authorities too. They do
        // not supply execution identity, but primary cannot shadow them.
        const registered = (await listControllerDocumentWorktrees(registryRoot))
            .find((entry) => entry.planName === planName);
        if (registered) {
            const plan = await loadPlan(registered.path, planName);
            if (
                plan && (!registered.planId || plan.attrs.planId === registered.planId)
            ) return { registryRoot, documentRoot: registered.path, plan };
            if (await loadPlan(registered.path, `archived/${planName}`)) {
                return { registryRoot, documentRoot: registered.path, plan: null, archived: true };
            }
            throw new Error(
                `The registered Plan is missing or has a different identity at ${registered.path}/docs/plans/${planName}.md. ` +
                    "Your files are unchanged. Restore that Plan file before continuing; the primary copy will not be used.",
            );
        }
        const parentName = inferParentPlanName(planName);
        const parentEntry = parentName && (await listControllerDocumentWorktrees(registryRoot))
            .find((entry) => entry.planName === parentName);
        if (parentEntry) {
            const parent = await loadPlan(parentEntry.path, parentName);
            if (!parent || (parentEntry.planId && parent.attrs.planId !== parentEntry.planId)) {
                throw new Error(`The registered parent Plan ${parentName} is missing or has a different identity.`);
            }
            const child = await loadPlan(parentEntry.path, planName);
            if (child?.attrs.parentPlan === parentName) {
                return { registryRoot, documentRoot: parentEntry.path, plan: child };
            }
        }
    }
    const plan = await loadPlan(cwd, planName);
    if (plan?.attrs.planId) {
        const registered = (await listControllerDocumentWorktrees(registryRoot))
            .find((entry) => entry.planId === plan.attrs.planId);
        if (registered && registered.planName !== planName) {
            throw new Error(
                `This Plan is now named ${registered.planName}. Load that name to continue; the older primary copy is unchanged.`,
            );
        }
    }
    if (!await isGitRepository(registryRoot)) return { registryRoot, documentRoot: cwd, plan };

    const localTargetBranch = plan ? effectiveDeliveryBranch(plan.attrs) || "" : "";
    const parentPlanName = typeof plan?.attrs.parentPlan === "string" && plan.attrs.parentPlan.trim()
        ? plan.attrs.parentPlan.trim()
        : inferParentPlanName(planName);
    let targetBranch = localTargetBranch;
    if (!targetBranch && parentPlanName) {
        const parentPlan = await loadPlan(cwd, parentPlanName);
        targetBranch = typeof parentPlan?.attrs.targetBranch === "string" ? parentPlan.attrs.targetBranch.trim() : "";
    }
    if (targetBranch && (parentPlanName || plan?.attrs.deliveryBranch)) {
        const targetPlan = await findTargetBranchPlan(registryRoot, targetBranch, planName);
        if (
            targetPlan &&
            (!plan?.attrs.planId || !targetPlan.attrs.planId || targetPlan.attrs.planId === plan.attrs.planId)
        ) {
            // Reading a published child must not start a fresh planning attempt after its worktree was cleaned up.
            if (isCompletedPlanStatus(targetPlan.attrs.status)) {
                return {
                    registryRoot,
                    documentRoot: cwd,
                    // The local document owns its bytes and carries the current shared
                    // lifecycle. A Git snapshot has neither a writable path nor newer events.
                    plan: plan || targetPlan,
                    publishedSnapshot: !plan,
                };
            }
            if (options.readOnly) {
                return { registryRoot, documentRoot: cwd, plan: plan || targetPlan, publishedSnapshot: !plan };
            }
            const planning = await preparePlanningWorktreeForPlan(registryRoot, planName, targetPlan.attrs);
            return { registryRoot, documentRoot: planning.entry.path, plan: planning.plan };
        }
        if (targetPlan) {
            throw new Error(`Target Plan ${planName} has a different Plan ID. Your files have not been changed.`);
        }
    }
    return { registryRoot, documentRoot: cwd, plan };
}
