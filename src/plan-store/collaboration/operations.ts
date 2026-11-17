/** Named personal-owner collaboration operations. Network capabilities never come from the execution checkout. */
import type { SharePlanForReviewOptions, SharedPlanReviewLink } from "./share.ts";
import type { PushPlanRevisionOptions, PushedPlanRevision } from "./push.ts";
import type { PullPlanForRevisionOptions, PulledPlanRevision } from "./pull.ts";
import type { UnsharePlanOptions, UnsharedPlan } from "./unshare.ts";
export type CollaborationIntent =
    | { action: "share"; options: Omit<SharePlanForReviewOptions, "cwd"> }
    | { action: "push"; options: Omit<PushPlanRevisionOptions, "cwd"> }
    | { action: "pull"; options: Omit<PullPlanForRevisionOptions, "cwd"> }
    | { action: "unshare"; options: Omit<UnsharePlanOptions, "cwd"> };
export type CollaborationResult =
    | { action: "share"; value: SharedPlanReviewLink }
    | { action: "push"; value: PushedPlanRevision }
    | { action: "pull"; value: PulledPlanRevision }
    | { action: "unshare"; value: UnsharedPlan };
export async function executeCollaborationIntent(
    cwd: string,
    intent: CollaborationIntent,
): Promise<CollaborationResult> {
    if (intent.action === "share")
        return {
            action: "share",
            value: await (await import("./share.ts")).sharePlanForReview({ ...intent.options, cwd }),
        };
    if (intent.action === "push")
        return {
            action: "push",
            value: await (await import("./push.ts")).pushPlanRevision({ ...intent.options, cwd }),
        };
    if (intent.action === "pull")
        return {
            action: "pull",
            value: await (await import("./pull.ts")).pullPlanForRevision({ ...intent.options, cwd }),
        };
    if (!intent.options.force && !intent.options.confirmation)
        throw new Error("Unshare requires the execution terminal's explicit confirmation.");
    return { action: "unshare", value: await (await import("./unshare.ts")).unsharePlan({ ...intent.options, cwd }) };
}

/** Collaboration edits personal documents; only local execution-account sources need workflow preparation. */
export async function prepareCollaborationPlan(cwd: string, name: string): Promise<void> {
    const { currentHomeProjectOwner } = await import("../../shared/project-identity.ts");
    if (currentHomeProjectOwner()) {
        if (!(await (await import("../queries.ts")).loadPlan(cwd, name)))
            throw new Error("Collaboration Plan is unavailable.");
        return;
    }
    await (await import("../preparation.ts")).preparePlanWorkflow(cwd, name);
}
export async function collaborationPlanLocation(cwd: string, name: string, options: { readOnly?: boolean } = {}) {
    const { currentHomeProjectOwner } = await import("../../shared/project-identity.ts");
    if (currentHomeProjectOwner())
        return { documentRoot: cwd, plan: await (await import("../queries.ts")).loadPlan(cwd, name) };
    return await (await import("../location.ts")).resolveWorkflowPlanLocation(cwd, name, options);
}
