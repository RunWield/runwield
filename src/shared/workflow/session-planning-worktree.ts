import { loadPlan, mergeFrontMatterText } from "../../plan-store.js";
import { resolvePrimaryCheckoutRoot } from "../primary-checkout.ts";
import { findActiveByPlanName } from "../worktree-registry.js";
import { executionWorktreePathExists, recoverMissingExecutionWorktree } from "./execution-worktree-rescue.ts";
import { isPublicationCleanupPending } from "./publication-attempt.ts";
import { isGitRepository } from "../git.ts";
import { ensureExecutionPlanFile } from "./execution-plan-file.js";
import { ensureEpicBranch } from "./epic-branch.ts";
import { needsSessionPlanningWorktree, resolveWorkflowPlanLocation } from "./plan-location.ts";
import { preparePlanningWorktreeForPlan } from "./planning-worktree.ts";

/** Prepare the authoritative Plan document immediately before a workflow session starts. */
export async function prepareSessionPlanningWorktree(projectRoot: string, planName: string) {
    const registryRoot = resolvePrimaryCheckoutRoot(projectRoot);
    const attempt = await findActiveByPlanName(registryRoot, planName);
    if (
        attempt &&
        !isPublicationCleanupPending(attempt.publication) &&
        !(await executionWorktreePathExists(attempt.path))
    ) {
        await recoverMissingExecutionWorktree(registryRoot, attempt);
    }
    const location = await resolveWorkflowPlanLocation(projectRoot, planName, { readOnly: true });
    if (
        !location.plan ||
        (!location.planningNotStarted && !needsSessionPlanningWorktree(location.plan.attrs)) ||
        !(await isGitRepository(location.registryRoot))
    )
        return location;

    if (location.plan.attrs.parentPlan) {
        await ensureEpicBranch(location.registryRoot, location.plan.attrs.parentPlan, { seedChildren: false });
    }
    const planning = await preparePlanningWorktreeForPlan(location.registryRoot, planName, location.plan.attrs);
    // Sequence review can save the approved child in its parent's worktree before the child has its own.
    if (location.parentDocument && !planning.reused) {
        const result = await ensureExecutionPlanFile({
            executionCwd: planning.entry.path,
            planName,
            canonicalSource: {
                kind: "loaded",
                ...location.plan,
                attrs: { ...location.plan.attrs, planId: planning.plan.attrs.planId },
                markdown: mergeFrontMatterText(location.plan.markdown, { planId: planning.plan.attrs.planId }),
                relativePath: `docs/plans/${planName}.md`,
            },
            replaceFromCanonical: true,
        });
        if (!["present", "restored", "reconciled"].includes(result.kind)) {
            throw new Error(result.reason || `Cannot prepare the saved child Plan ${planName}.`);
        }
        const plan = await loadPlan(planning.entry.path, planName);
        if (plan) planning.plan = plan;
    }
    return { ...location, documentRoot: planning.entry.path, plan: planning.plan, planningNotStarted: false };
}
