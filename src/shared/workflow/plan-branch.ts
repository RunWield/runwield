import { isPlannedChangeClassification } from "../../constants.js";
import type { PlanFrontMatter } from "../../plan-store.js";
import { shouldAutoMergePlansIntoTargetBranch } from "../settings.js";
import { ensureTargetBranchRef, slugify } from "../worktree.js";

export const PLAN_BRANCH_PREFIX = "plan/";

/** Use the same full-name slug as execution worktrees. */
export function defaultPlanBranchName(planName: string): string {
    return `${PLAN_BRANCH_PREFIX}${slugify(planName)}`;
}

interface PlanBranchOptions {
    projectRoot: string;
    planName: string;
    sourceBranch?: string;
}

/** Keep existing branches intact; create missing branches without touching a checkout. */
export async function ensurePlanBranch({ projectRoot, planName, sourceBranch }: PlanBranchOptions) {
    return await ensureTargetBranchRef(projectRoot, defaultPlanBranchName(planName), sourceBranch?.trim());
}

/** One owner for landing selection. Legacy Plans still honor target edits. */
export function effectiveDeliveryBranch(attrs: Partial<PlanFrontMatter>): string | undefined {
    return attrs.deliveryBranch?.trim() || attrs.targetBranch?.trim() || undefined;
}

export function isStandalonePlannedChange(attrs: Partial<PlanFrontMatter>): boolean {
    return isPlannedChangeClassification(attrs.classification) && !attrs.parentPlan?.trim();
}

/** Epic children, recorded attempts, and authored Plan Branches keep their landing. */
export function shouldAdoptPlanBranch(projectRoot: string, attrs: Partial<PlanFrontMatter>): boolean {
    return isStandalonePlannedChange(attrs) && !attrs.deliveryBranch?.trim() &&
        !attrs.targetBranch?.trim().startsWith(PLAN_BRANCH_PREFIX) &&
        !shouldAutoMergePlansIntoTargetBranch(projectRoot);
}
