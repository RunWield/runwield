import { effectiveDeliveryBranch } from "./plan-branch.ts";
/** Locate the editable document independently from the shared controller files. */
import { canonicalizeStoredPlanName, isCompletedPlanStatus, loadPlan } from "../../plan-store.js";
import { resolvePrimaryCheckoutRoot } from "../primary-checkout.ts";
import { findActiveByPlanName } from "../worktree-registry.js";
import { isGitRepository } from "../git.ts";
import { isSequencePlan } from "../project-plan.ts";
import { withProjectRuntimeReadScope } from "../project-runtime-layout.ts";
import { listControllerDocumentWorktrees } from "./controller-registry.ts";
import { findTargetBranchPlan } from "./planning-worktree.ts";
import { isPublicationCleanupPending } from "./publication-attempt.ts";
import {
    executionWorktreePathExists,
    readMissingExecutionPlan,
    type MissingExecutionWorktreeRecovery,
} from "./execution-worktree-rescue.ts";

export { recoverMissingExecutionWorktreesForPlanLoading } from "./execution-worktree-rescue.ts";
export type { MissingExecutionWorktreeRecovery } from "./execution-worktree-rescue.ts";

interface ResolveWorkflowPlanLocationOptions {
    migrateRegistry?: boolean;
    /** Explicit child loading reads the published family, not sibling copies in the parent's planning checkout. */
    loadFromTarget?: boolean;
    /** Return an unstarted Plan snapshot instead of requiring a writable document root. Lookups never prepare worktrees. */
    readOnly?: boolean;
}

type PlanningAttributes = NonNullable<Awaited<ReturnType<typeof loadPlan>>>["attrs"];

/** A target-backed unfinished Plan starts or refreshes its isolated document at session start. */
export function needsSessionPlanningWorktree(attrs: PlanningAttributes): boolean {
    return Boolean(
        effectiveDeliveryBranch(attrs) &&
        (attrs.parentPlan || attrs.deliveryBranch) &&
        !isCompletedPlanStatus(attrs.status) &&
        attrs.worktreeStatus !== "active",
    );
}

export class PlanningNotStartedError extends Error {
    constructor(planName: string) {
        super(`Start planning ${planName} first: load it and choose Resume planning. Nothing was changed.`);
        this.name = "PlanningNotStartedError";
    }
}

function inferParentPlanName(planName: string): string {
    const segments = planName.split("/");
    segments.pop();
    return segments.join("/");
}

/** One Plan location lookup verifies each checkout's runtime layout once. */
export async function resolveWorkflowPlanLocation(
    cwd: string,
    planName: string,
    options: ResolveWorkflowPlanLocationOptions = {},
) {
    return await withProjectRuntimeReadScope(() => resolveWorkflowPlanLocationInScope(cwd, planName, options));
}

async function resolveWorkflowPlanLocationInScope(
    cwd: string,
    planName: string,
    options: ResolveWorkflowPlanLocationOptions,
) {
    planName = canonicalizeStoredPlanName(planName).name;
    const registryRoot = resolvePrimaryCheckoutRoot(cwd);
    const registryReadOptions = options.migrateRegistry === false ? { migrate: false } : undefined;
    let registeredParentTarget = "";
    const attempt = await findActiveByPlanName(registryRoot, planName, registryReadOptions);
    if (attempt && !isPublicationCleanupPending(attempt.publication)) {
        const plan = await loadPlan(attempt.path, planName);
        const recoveredWorktree: MissingExecutionWorktreeRecovery | undefined = undefined;
        if (plan) {
            if (attempt.planId && plan.attrs.planId && plan.attrs.planId !== attempt.planId) {
                throw new Error("The execution directory contains a different Plan. Your files have not been changed.");
            }
            return { registryRoot, documentRoot: attempt.path, plan, recoveredWorktree };
        }
        if (options.readOnly && !(await executionWorktreePathExists(attempt.path))) {
            const snapshot = await readMissingExecutionPlan(registryRoot, attempt);
            if (snapshot)
                return { registryRoot, documentRoot: attempt.path, plan: snapshot, missingExecutionCheckout: true };
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
        const registered = (await listControllerDocumentWorktrees(registryRoot)).find(
            (entry) => entry.planName === planName,
        );
        if (registered) {
            const plan = await loadPlan(registered.path, planName);
            if (plan && (!registered.planId || plan.attrs.planId === registered.planId)) {
                return { registryRoot, documentRoot: registered.path, plan };
            }
            if (await loadPlan(registered.path, `archived/${planName}`)) {
                return { registryRoot, documentRoot: registered.path, plan: null, archived: true };
            }
            throw new Error(
                `The registered Plan is missing or has a different identity at ${registered.path}/docs/plans/${planName}.md. ` +
                    "Your files are unchanged. Restore that Plan file before continuing; the primary copy will not be used.",
            );
        }
        const parentName = inferParentPlanName(planName);
        const parentEntry =
            parentName &&
            (await listControllerDocumentWorktrees(registryRoot)).find((entry) => entry.planName === parentName);
        if (parentEntry) {
            const parent = await loadPlan(parentEntry.path, parentName);
            if (!parent || (parentEntry.planId && parent.attrs.planId !== parentEntry.planId)) {
                throw new Error(`The registered parent Plan ${parentName} is missing or has a different identity.`);
            }
            registeredParentTarget =
                typeof parent.attrs.targetBranch === "string" ? parent.attrs.targetBranch.trim() : "";
            // Sequence review saves the whole group in its parent's document. Epic siblings use the published branch.
            const child =
                options.loadFromTarget || !isSequencePlan(parent.attrs)
                    ? null
                    : await loadPlan(parentEntry.path, planName);
            if (child?.attrs.parentPlan === parentName) {
                const planningNotStarted = needsSessionPlanningWorktree(child.attrs);
                if (planningNotStarted && !options.readOnly) throw new PlanningNotStartedError(planName);
                return {
                    registryRoot,
                    documentRoot: parentEntry.path,
                    plan: child,
                    parentDocument: true,
                    planningNotStarted,
                };
            }
        }
    }
    if (options.loadFromTarget && !registeredParentTarget) {
        const parentName = inferParentPlanName(planName);
        const parent = parentName ? await loadPlan(cwd, parentName) : null;
        registeredParentTarget = typeof parent?.attrs.targetBranch === "string" ? parent.attrs.targetBranch.trim() : "";
    }
    // A checkout child is not an input once its parent's branch is known.
    const plan = options.loadFromTarget && registeredParentTarget ? null : await loadPlan(cwd, planName);
    if (plan?.attrs.planId) {
        const registered = (await listControllerDocumentWorktrees(registryRoot)).find(
            (entry) => entry.planId === plan.attrs.planId,
        );
        if (registered && registered.planName !== planName) {
            throw new Error(
                `This Plan is now named ${registered.planName}. Load that name to continue; the older primary copy is unchanged.`,
            );
        }
    }
    if (!(await isGitRepository(registryRoot))) return { registryRoot, documentRoot: cwd, plan };

    const localTargetBranch = plan ? effectiveDeliveryBranch(plan.attrs) || "" : "";
    const parentPlanName =
        typeof plan?.attrs.parentPlan === "string" && plan.attrs.parentPlan.trim()
            ? plan.attrs.parentPlan.trim()
            : inferParentPlanName(planName);
    let targetBranch = registeredParentTarget || localTargetBranch;
    if (!targetBranch && parentPlanName) {
        const parentPlan = await loadPlan(cwd, parentPlanName);
        targetBranch = typeof parentPlan?.attrs.targetBranch === "string" ? parentPlan.attrs.targetBranch.trim() : "";
    }
    if (targetBranch && (parentPlanName || plan?.attrs.deliveryBranch)) {
        const targetPlan = await findTargetBranchPlan(registryRoot, targetBranch, planName);
        if (targetPlan) {
            // Reading a published child must not start a fresh planning attempt after its worktree was cleaned up.
            if (!needsSessionPlanningWorktree(targetPlan.attrs)) {
                return {
                    registryRoot,
                    documentRoot: cwd,
                    // Explicit child loading reads the published snapshot; document
                    // operations and standalone Plans retain their local lifecycle state.
                    plan: options.loadFromTarget && parentPlanName ? targetPlan : plan || targetPlan,
                    publishedSnapshot: Boolean(options.loadFromTarget && parentPlanName) || !plan,
                };
            }
            if (options.readOnly) {
                return {
                    registryRoot,
                    documentRoot: cwd,
                    plan: plan || targetPlan,
                    publishedSnapshot: !plan,
                    planningNotStarted: true,
                };
            }
            throw new PlanningNotStartedError(planName);
        }
        if (options.loadFromTarget && parentPlanName && targetPlan === null) {
            throw new Error(
                `Plan ${planName} does not exist on target ${targetBranch}. The current checkout is not used.`,
            );
        }
        // A saved Plan can name a branch this checkout has not fetched yet.
        // Session preparation fetches it; lookup only returns the saved metadata.
        if (targetPlan === undefined && plan && needsSessionPlanningWorktree(plan.attrs)) {
            if (!options.readOnly) throw new PlanningNotStartedError(planName);
            return { registryRoot, documentRoot: cwd, plan, planningNotStarted: true };
        }
    }
    return { registryRoot, documentRoot: cwd, plan };
}
