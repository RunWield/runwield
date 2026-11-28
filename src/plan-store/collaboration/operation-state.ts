/** Private recovery for local collaboration effects after an external response has been accepted. */
import type { CollaborationResult } from "./operations.ts";
import type { PlanFrontMatter } from "@runwield/plans";
import { normalizeCollaborationFrontMatter } from "@runwield/plans/format";
import { COLLABORATION_LOCK_BYPASS } from "../../shared/collaboration/lock.ts";
import { findPlanEvidenceById, loadPlan } from "../queries.ts";
import { operationDigest } from "@runwield/plans/operation-receipts";
import { inspectCollaborationMutation, retainCollaborationOperationResult } from "../operation-results.ts";
export interface CollaborationMutation {
    action: "share" | "push" | "unshare";
    planName: string;
    planId: string;
    beforeBody: string;
    beforeAttrs: PlanFrontMatter;
    updates: Partial<PlanFrontMatter>;
    body?: string;
    result: CollaborationResult;
}
export async function recoverCollaborationMutation(
    cwd: string,
    directory: string,
    operationId: string,
): Promise<CollaborationResult | undefined> {
    const pending = inspectCollaborationMutation(directory, operationId);
    if (!pending) return undefined;
    const share = pending.action === "share" ? await findPlanEvidenceById(cwd, pending.planId) : undefined;
    const current = share ?? (await loadPlan(cwd, pending.planName));
    if (!current || current.attrs.planId !== pending.planId)
        throw new Error("Collaboration recovery Plan changed ownership.");
    const before = operationDigest(JSON.stringify(normalizeCollaborationFrontMatter(pending.beforeAttrs)));
    const desired = operationDigest(
        JSON.stringify(normalizeCollaborationFrontMatter(pending.action === "unshare" ? {} : pending.updates)),
    );
    const observed = operationDigest(JSON.stringify(normalizeCollaborationFrontMatter(current.attrs)));
    if (
        ![before, desired].includes(observed) ||
        ![pending.beforeBody, pending.body ?? pending.beforeBody].includes(current.body)
    )
        throw new Error("New Plan edits prevent replaying an older collaboration effect.");
    if (observed !== desired || current.body !== (pending.body ?? pending.beforeBody)) {
        const { updatePlanCollaborationMetadata, clearPlanCollaborationMetadata } = await import("../../plan-store.ts");
        if (pending.action === "unshare")
            await clearPlanCollaborationMetadata(cwd, pending.planName, COLLABORATION_LOCK_BYPASS.unshare, {
                updatedAt: pending.updates.updatedAt,
            });
        else
            await updatePlanCollaborationMetadata(
                cwd,
                share?.name ?? pending.planName,
                pending.updates,
                COLLABORATION_LOCK_BYPASS[pending.action],
                { body: pending.body, expectedPlanId: share?.planId },
            );
    }
    retainCollaborationOperationResult(pending.result);
    return pending.result;
}
