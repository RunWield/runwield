/** A saved receipt is historical evidence, not proof for a different execution or target. */
import type { PlanFrontMatter } from "../../plan-store.js";
import { effectiveDeliveryBranch } from "./plan-branch.ts";

type ReceiptPlan = Pick<
    PlanFrontMatter,
    "publicationReceipt" | "validatedCommit" | "deliveryEvidence" | "targetBranch" | "deliveryBranch" | "worktreeId"
>;

export function hasApplicablePublicationReceipt(attrs: ReceiptPlan): boolean {
    const receipt = attrs.publicationReceipt;
    if (!receipt || attrs.worktreeId) return false;
    if (!receipt.validatedCommit || !receipt.publishedCommit || !receipt.targetBranch) return false;
    const target = effectiveDeliveryBranch(attrs);
    if (target && target !== receipt.targetBranch) return false;
    if (attrs.validatedCommit && attrs.validatedCommit !== receipt.validatedCommit) return false;
    const delivery = attrs.deliveryEvidence;
    if (
        delivery?.mode === "worktree_merge" &&
        (delivery.executionCommit !== receipt.validatedCommit || delivery.targetBranch !== receipt.targetBranch)
    )
        return false;
    return true;
}
