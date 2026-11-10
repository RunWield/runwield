import { getStoredPlanPath, loadPlan, withPlanLock, writePlanMarkdownWithRevision } from "../../plan-store.js";
import { resolvePrimaryCheckoutRoot } from "../../shared/project-checkout.ts";
import { discardWorktreeGitArtifacts, validateWorktreeDiscard } from "../../shared/worktree.js";
import { findById, listEntries, pruneEntry, updateEntry } from "../../shared/worktree-registry.js";
import { writeControllerState } from "../../shared/workflow/controller-registry.ts";
import { resolveWorkflowPlanLocation } from "../../shared/workflow/plan-location.ts";
import { runRecoveryTransition } from "../../shared/workflow/state-transition.ts";
import { hasWorktreeContext, resolveRecoveryWorktree } from "./plan-recovery-worktree.ts";
import type { HoldablePlan } from "./plan-hold.ts";
import type { PlanSessionSurface } from "./plan-session-types.ts";
import type { UiAPI } from "../../ui/tui/api.ts";

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
    if (location.documentRoot !== primaryRoot) {
        await withPlanLock(location.documentRoot, plan.planName, async () => {
            const current = await loadPlan(location.documentRoot, plan.planName);
            if (!current || current.revision !== accepted.revision) {
                throw new Error("The accepted Plan changed. Reload it.");
            }
            await withPlanLock(primaryRoot, plan.planName, async () => {
                const primary = await loadPlan(primaryRoot, plan.planName);
                if (primary && primary.attrs.planId !== accepted.attrs.planId) {
                    throw new Error("The primary checkout contains a different Plan. Nothing was overwritten.");
                }
                await writePlanMarkdownWithRevision(
                    primary?.path || getStoredPlanPath(primaryRoot, plan.planName),
                    accepted.markdown,
                    primary?.revision,
                );
            });
        });
    }
    const transition = await runRecoveryTransition({
        projectRoot: primaryRoot,
        planName: plan.planName,
        planId: accepted.attrs.planId,
        worktreeId: attempt?.id,
        action: "recover",
        recover: async ({ markEffect }) => {
            // Select the saved primary document before removing the execution copy.
            // A partial cleanup can then be retried without reconstructing an old Plan.
            if (attempt?.id && (await findById(primaryRoot, attempt.id))) {
                await updateEntry(primaryRoot, attempt.id, { status: "abandoned" });
            }
            await writeControllerState(
                primaryRoot,
                { planName: plan.planName, planId: accepted.attrs.planId },
                {
                    documentWorktreeId: null,
                    executionMode: null,
                    validationCheckpoint: null,
                },
                {
                    recovery:
                        attempt && !(await findById(primaryRoot, attempt.id || ""))
                            ? {
                                  worktreeId: attempt.id,
                                  worktreePath: attempt.path,
                                  worktreeBranch: attempt.branch,
                                  worktreeBaseBranch: attempt.baseBranch,
                                  worktreeStatus: "abandoned",
                              }
                            : null,
                },
            );
            await markEffect("user_verified_primary_selected", { path: getStoredPlanPath(primaryRoot, plan.planName) });
        },
    });
    if (transition.status !== "committed") {
        throw new Error(transition.message || "User Verification handoff is incomplete.");
    }
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
        const cleanup = await runRecoveryTransition({
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
                await writeControllerState(
                    primaryRoot,
                    { planName: plan.planName, planId: accepted.attrs.planId },
                    {},
                    { recovery: null },
                );
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
