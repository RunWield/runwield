import { readFile as fsReadFile } from "node:fs/promises";
/**
 * @module shared/workflow/validation-delivery-hierarchy
 * Direct-delivery evidence, and the sibling snapshot a publication transaction
 * takes its before-facts from.
 */

import { findPlansByParent, getPlanRevisionForText, loadPlan } from "../../plan-store.js";
import type { PlanFrontMatter } from "../../plan-store.js";

/** One sibling as captured before a publication, for later comparison. */
export interface SiblingPlanSnapshot {
    name: string;
    revision: string;
    status: string | undefined;
    deliveryEvidence: unknown;
}

export interface DirectDeliveryHierarchySnapshot {
    revision: string | undefined;
    parentPlan: string | undefined;
    siblingPlans: SiblingPlanSnapshot[];
}

/**
 * Whether a Plan's `verified` claim is backed by evidence of actual delivery.
 *
 * Fails closed only for `verified`: any other status has not claimed delivery yet,
 * so there is nothing to prove. A `verified` Plan with no delivery mode recorded is
 * the dangerous case — it reads as shipped while its work may still be unmerged.
 */
export function hasDirectDeliveryEvidence(attrs: PlanFrontMatter): boolean {
    if (attrs.status !== "validated" && attrs.status !== "verified") return true;
    const evidence = attrs.deliveryEvidence;
    return Boolean(
        evidence && typeof evidence === "object" &&
            (evidence.mode === "worktree_merge" || evidence.mode === "non_git_in_place"),
    );
}

/**
 * Capture this Plan and its siblings as they stand right now.
 *
 * Siblings are sorted by name so the snapshot is stable across runs: a transaction
 * compares these facts on the way out, and directory order is not a fact.
 */
export async function loadDirectDeliveryHierarchySnapshot(
    projectRoot: string,
    planName: string,
): Promise<DirectDeliveryHierarchySnapshot> {
    const plan = await loadPlan(projectRoot, planName);
    if (!plan) throw new Error(`Plan not found: ${planName}`);
    const parentValue = plan.attrs?.parentPlan;
    const parentPlan = typeof parentValue === "string" && parentValue.trim() ? parentValue : undefined;
    const siblingPlans: SiblingPlanSnapshot[] = [];
    if (parentPlan) {
        for (const sibling of await findPlansByParent(projectRoot, parentPlan).catch(() => [])) {
            siblingPlans.push({
                name: sibling.name,
                revision: await getPlanRevisionForText(await fsReadFile(sibling.path, "utf8")),
                status: sibling.attrs.status,
                deliveryEvidence: sibling.attrs.deliveryEvidence,
            });
        }
        siblingPlans.sort((a, b) => a.name.localeCompare(b.name));
    }
    return { revision: plan.revision, parentPlan, siblingPlans };
}
