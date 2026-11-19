import { canonicalizeStoredPlanName, isHiddenPlanName } from "../../plan-store.ts";
import { assertNotReservedEpicArtifactPlanName } from "../epic-artifacts.ts";
import { effectiveDeliveryBranch } from "../workflow/plan-branch.ts";
import { resolveWorkflowPlanLocation } from "../workflow/plan-location.ts";
import { prepareSessionPlanningWorktree } from "../workflow/session-planning-worktree.ts";
import type { ExistingPlanningPlan } from "./operations.ts";

/** Validate explicit selection without preparing or modifying its document. */
export async function resolvePlanningSelection(projectRoot: string, selection: ExistingPlanningPlan) {
    const planName = canonicalizeStoredPlanName(selection.planName).name;
    assertNotReservedEpicArtifactPlanName(planName);
    if (isHiddenPlanName(planName)) throw new Error(`Plan is archived or hidden: ${planName}`);
    const location = await resolveWorkflowPlanLocation(projectRoot, planName, { readOnly: true, loadFromTarget: true });
    if (!location.plan || location.plan.attrs.planId !== selection.planId) {
        throw new Error(`The selected Plan ${planName} is missing or has a different Plan ID. Nothing was changed.`);
    }
    if (selection.targetBranch && effectiveDeliveryBranch(location.plan.attrs) !== selection.targetBranch) {
        throw new Error(`The selected Plan ${planName} has a different target branch. Nothing was changed.`);
    }
    if (
        !["draft", "feedback", "approved", "ready_for_work"].includes(location.plan.attrs.status || "") ||
        location.plan.attrs.classification === "PROJECT"
    ) {
        throw new Error(`The selected Plan ${planName} is not available for FEATURE planning.`);
    }
    return { plan: { planName, planId: selection.planId }, location };
}

/** The same planning boundary used by Core sessions, with explicit identity checks on both sides. */
export async function prepareAttachedPlanning(projectRoot: string, selection: ExistingPlanningPlan) {
    const selected = await resolvePlanningSelection(projectRoot, selection);
    const prepared = await prepareSessionPlanningWorktree(projectRoot, selected.plan.planName);
    if (!prepared.plan || prepared.plan.attrs.planId !== selected.plan.planId || prepared.planningNotStarted) {
        throw new Error("Core planning preparation did not preserve the selected Plan identity. Retry planning.");
    }
    return selected.plan;
}
