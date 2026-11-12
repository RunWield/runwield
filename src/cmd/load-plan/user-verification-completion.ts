import { retainUserVerifiedPlan, clearPlanRecoveryAfterCleanup } from "../../plan-store/index.ts";
import { loadPlan } from "../../plan-store/index.ts";
import { resolvePrimaryCheckoutRoot } from "../../shared/primary-checkout.ts";
import { discardWorktreeGitArtifacts, validateWorktreeDiscard } from "../../shared/worktree.js";
import { listEntries, pruneEntry } from "../../shared/worktree-registry.js";
import { resolveWorkflowPlanLocation } from "../../plan-store/index.ts";
import { runPlanRecoveryEffects } from "../../plan-store/index.ts";
import { hasWorktreeContext, resolveRecoveryWorktree } from "./plan-recovery-worktree.ts";
import type { HoldablePlan } from "./plan-hold.ts";
import type { PlanSessionSurface } from "./plan-session-types.ts";
import type { UiAPI } from "../../ui/tui/types.js";

interface CompleteUserVerificationOptions {
    projectRoot: string;
    plan: HoldablePlan;
    uiAPI: UiAPI;
    session: PlanSessionSurface;
}

/** Carry the accepted document home before asking permission to discard its execution checkout. */
export async function completeUserVerification({
    projectRoot,
    plan,
    uiAPI,
    session,
}: CompleteUserVerificationOptions): Promise<boolean> {
    const primaryRoot = resolvePrimaryCheckoutRoot(projectRoot);
    const location = await resolveWorkflowPlanLocation(projectRoot, plan.planName);
    const accepted = location.plan;
    if (!accepted || accepted.attrs.status !== "user_verified") {
        throw new Error("User Verification must be recorded before completing the worktree.");
    }
    const recorded = await resolveRecoveryWorktree(primaryRoot, { planName: plan.planName, attrs: accepted.attrs });
    // A declined or interrupted cleanup leaves a retired record so the next
    // Archive action can retry without making the old document authoritative.
    const retired =
        !recorded &&
        (await listEntries(primaryRoot))
            .filter(
                (entry) =>
                    entry.planName === plan.planName &&
                    entry.planId === accepted.attrs.planId &&
                    entry.status === "abandoned",
            )
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const attempt = recorded || retired || null;
    await retainUserVerifiedPlan(projectRoot, plan.planName, accepted.revision, attempt?.id);
    if (session.getActiveExecutionWorkflow()?.planName === plan.planName) await session.clearActiveExecutionWorkflow();
    if (session.cwd !== primaryRoot && (session.cwd === location.documentRoot || session.cwd === attempt?.path)) {
        await session.switchAgent(session.getEffectiveAgentName() || "planner", {
            cwd: primaryRoot,
            forceRebuild: true,
        });
    }
    Object.assign(plan, await loadPlan(primaryRoot, plan.planName));
    if (hasWorktreeContext(attempt)) {
        uiAPI.appendSystemMessage(
            "The User Verified Plan is saved in the primary checkout. Removing its worktree discards remaining uncommitted changes; branches with unmerged commits are kept.",
            false,
            "RunWield",
        );
        const answer = await uiAPI.promptSelect(`Remove the worktree for ${plan.planName}?`, [
            { value: "confirm", label: "Remove worktree and clear its records" },
            { value: "cancel", label: "Keep worktree for now" },
        ]);
        if (answer !== "confirm") {
            Object.assign(plan, await loadPlan(primaryRoot, plan.planName));
            return false;
        }
        await validateWorktreeDiscard({ projectRoot: primaryRoot, ...attempt });
    }
    if (hasWorktreeContext(attempt)) {
        const cleanup = await runPlanRecoveryEffects({
            projectRoot: primaryRoot,
            planName: plan.planName,
            planId: accepted.attrs.planId,
            worktreeId: attempt?.id,
            action: "recover",
            recover: async ({ markEffect }) => {
                for await (const result of discardWorktreeGitArtifacts({ projectRoot: primaryRoot, ...attempt })) {
                    if (result.status === "blocked") throw new Error(result.message);
                    await markEffect(`user_verified_cleanup_${result.status}`, { ...result });
                    if (result.status !== "path_removed") uiAPI.appendSystemMessage(result.message, false, "RunWield");
                }
                if (attempt?.id) await pruneEntry(primaryRoot, attempt.id);
                await clearPlanRecoveryAfterCleanup(primaryRoot, plan.planName, accepted.attrs.planId);
            },
        });
        if (cleanup.status !== "committed") {
            throw new Error(cleanup.message || "User Verification cleanup is incomplete.");
        }
    }
    const primary = await loadPlan(primaryRoot, plan.planName);
    if (primary) Object.assign(plan, primary);
    return true;
}
