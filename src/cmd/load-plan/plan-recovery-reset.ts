import { loadPlan, updatePlanFrontMatter } from "../../plan-store.js";
import { dirname, join } from "@std/path";
import { buildPlanEventUpdates, recordPlanEvent } from "../../shared/workflow/plan-lifecycle.js";
import { runRecoveryTransition } from "../../shared/workflow/state-transition.ts";
import { buildPlanRecoveryUserMessage, planRecoveryMessage } from "../../shared/workflow/validation-user-messages.ts";
import {
    createWorktreeGitArtifacts,
    discardWorktreeGitArtifacts,
    settleWorktreeAttempt,
    validateWorktreeDiscard,
    validateWorktreeRecreation,
} from "../../shared/worktree.js";
import { restoreWorktreeTree } from "../../shared/workflow/git-snapshot.ts";
import { formatGitRequiredMessage, isGitRepositoryRequiredError } from "../../shared/git.ts";
import {
    confirmBaselineReset,
    confirmMetadataOnlyRecoveryCleanup,
    confirmMissingWorktreeRecreate,
    confirmWorktreeAction,
    getRecordedWorktreeRecreateBase,
    hasWorktreeContext,
    pathExists,
} from "./plan-recovery-worktree.ts";
import { executeReadyPlanWithRepair } from "./plan-execution.ts";
import { updateEntry as updateWorktreeRegistryEntry } from "../../shared/worktree-registry.js";
import { settleDiscardedRecoveryAttempt } from "./plan-recovery-discard.ts";
import { transitionFailureError } from "./transition-failure.ts";

import type { PlanFrontMatter } from "../../plan-store.js";
import type { RecoveryWorktreeContext } from "./plan-session-types.ts";
import type { RecoveryActionContext, RecoveryActionOutcome } from "./plan-recovery-actions.ts";

interface RecoveryPlanTransitionValue {
    value?: PlanFrontMatter;
}

interface RecoveryRecreateTransitionResult {
    attrs: PlanFrontMatter;
    worktree: RecoveryWorktreeContext;
}

interface RecoveryRecreateTransitionValue {
    value?: RecoveryRecreateTransitionResult;
}

export async function resetRecoveryPlan(
    context: RecoveryActionContext,
    gitRecoveryBlocked: boolean,
    gitState: string,
): Promise<RecoveryActionOutcome> {
    const { projectRoot, plan, uiAPI } = context;
    const hasWorktree = hasWorktreeContext(context.worktreeContext);
    if (!hasWorktree && !plan.attrs.executionBaselineTree) {
        uiAPI.appendSystemMessage(
            buildPlanRecoveryUserMessage({ kind: "reset_baseline_missing" }),
            true,
            "RunWield",
        );
        return { kind: "menu" };
    }
    if (gitRecoveryBlocked && !hasWorktree) {
        if (!(await confirmMetadataOnlyRecoveryCleanup(plan.planName, uiAPI))) {
            return { kind: "menu" };
        }
        const transition = await runRecoveryTransition({
            projectRoot,
            planName: plan.planName,
            planId: plan.attrs.planId,
            worktreeId: context.worktreeContext?.id,
            expectedRevision: plan.revision,
            action: "reset",
            recover: async ({ beforePlan }) => {
                if (context.worktreeContext?.id) {
                    await updateWorktreeRegistryEntry(projectRoot, context.worktreeContext.id, {
                        status: "abandoned",
                    });
                }
                const resetUpdates = buildPlanEventUpdates("recovery_reset", plan.attrs.status, {
                    triageMeta: plan.attrs,
                });
                return await updatePlanFrontMatter(
                    projectRoot,
                    plan.planName,
                    {
                        ...resetUpdates,
                        status: "ready_for_work",
                        executionBaselineTree: null,
                        worktreeId: null,
                        worktreePath: null,
                        worktreeBranch: null,
                        worktreeBaseBranch: null,
                        worktreeStatus: null,
                    },
                    plan.attrs,
                    { expectedRevision: beforePlan?.revision },
                );
            },
        });
        if (transition.status !== "committed") {
            throw transitionFailureError(transition, `Recovery reset transaction failed for ${plan.planName}.`);
        }
        const transitionValue = (transition.value || {}) as RecoveryPlanTransitionValue;
        plan.attrs = transitionValue.value as PlanFrontMatter;
        context.worktreeContext = null;
        uiAPI.appendSystemMessage(
            buildPlanRecoveryUserMessage({ kind: "reset_done" }),
            false,
            "RunWield",
        );
        await context.recordRecoveryResult("reset", "metadata_only", { gitState: gitState });
        return { kind: "handled" };
    }
    let recreatedWorktree = false;
    if (hasWorktree) {
        const recreated = await recreateRecoveryWorktree(context);
        if (!recreated) {
            return { kind: "menu" };
        }
        context.worktreeContext = recreated;
        plan.attrs = { ...plan.attrs, status: "ready_for_work" };
        recreatedWorktree = true;
    } else {
        if (!(await confirmBaselineReset(plan.planName, uiAPI))) {
            return { kind: "menu" };
        }
        try {
            await restoreWorktreeTree(projectRoot, plan.attrs.executionBaselineTree as string);
        } catch (error) {
            const message = isGitRepositoryRequiredError(error)
                ? formatGitRequiredMessage(error)
                : error instanceof Error
                ? error.message
                : String(error);
            console.error("[RunWield] Baseline reset failed", message);
            uiAPI.appendSystemMessage(planRecoveryMessage("baseline_reset_failed"), true, "RunWield");
            return { kind: "menu" };
        }
    }
    if (!recreatedWorktree) {
        const resetTransition = await runRecoveryTransition({
            projectRoot,
            planName: plan.planName,
            planId: plan.attrs.planId,
            worktreeId: context.worktreeContext?.id,
            expectedRevision: plan.revision,
            action: "reset",
            recover: async () =>
                await recordPlanEvent({
                    cwd: projectRoot,
                    planName: plan.planName,
                    event: "recovery_reset",
                    currentStatus: plan.attrs.status,
                    details: { triageMeta: plan.attrs },
                }),
        });
        if (resetTransition.status !== "committed") {
            throw transitionFailureError(resetTransition, `Recovery reset transaction failed for ${plan.planName}.`);
        }
        const resetTransitionValue = (resetTransition.value || {}) as RecoveryPlanTransitionValue;
        plan.attrs = { ...plan.attrs, ...resetTransitionValue.value, status: "ready_for_work" };
    }
    await executeReadyPlanWithRepair({
        projectRoot,
        plan,
        agentName: context.agentName,
        uiAPI,
        executePlan: context.session.executePlan,
        continueWorkflowValidation: context.session.runValidation,
        session: context.session,
    });
    await context.recordRecoveryResult("reset", "handled");
    return { kind: "handled" };
}

async function recreateRecoveryWorktree(context: RecoveryActionContext): Promise<RecoveryWorktreeContext | null> {
    const { projectRoot, plan, uiAPI } = context;
    const worktreeContext = context.worktreeContext;
    const recreateBaseRef = getRecordedWorktreeRecreateBase(worktreeContext);
    if (!recreateBaseRef) {
        uiAPI.appendSystemMessage(
            buildPlanRecoveryUserMessage({ kind: "recreate_base_missing" }),
            true,
            "RunWield",
        );
        return null;
    }
    const recordedPathExists = await pathExists(worktreeContext?.path);
    const confirmed = recordedPathExists
        ? await confirmWorktreeAction(plan.planName, uiAPI, "Delete/recreate")
        : await confirmMissingWorktreeRecreate(plan.planName, worktreeContext, uiAPI);
    if (!confirmed) {
        return null;
    }
    const recreateBaseBranch = worktreeContext?.baseBranch;
    let cleanupMessage = "";
    try {
        const resolvedBaseCommit = await validateWorktreeRecreation({
            projectRoot,
            planName: plan.planName,
            planId: plan.attrs.planId,
            baseRef: recreateBaseRef,
        });
        await validateWorktreeDiscard({ projectRoot, ...worktreeContext });
        const transition = await runRecoveryTransition({
            projectRoot,
            planName: plan.planName,
            planId: plan.attrs.planId,
            worktreeId: worktreeContext?.id,
            action: "recreate",
            recover: async ({ markEffect, registerRollback }) => {
                const nextWorktree = await createWorktreeGitArtifacts({
                    projectRoot,
                    planName: plan.planName,
                    planId: plan.attrs.planId as string,
                    baseRef: resolvedBaseCommit,
                    baseBranch: recreateBaseBranch,
                });
                await markEffect("recovery_recreate_git_worktree_created", {
                    worktreeId: nextWorktree.id,
                    path: nextWorktree.path,
                    branch: nextWorktree.branch,
                    baseCommit: nextWorktree.baseCommit,
                });
                registerRollback("remove recreated recovery worktree", async () => {
                    for await (const cleanup of discardWorktreeGitArtifacts({ projectRoot, ...nextWorktree })) {
                        if (cleanup.status === "blocked") throw new Error(cleanup.message);
                    }
                });
                let retained = false;
                for await (const cleanup of discardWorktreeGitArtifacts({ projectRoot, ...worktreeContext })) {
                    if (cleanup.status === "blocked") throw new Error(cleanup.message);
                    await markEffect(`recovery_discard_${cleanup.status}`, { ...worktreeContext, ...cleanup });
                    retained = cleanup.status === "retained";
                    cleanupMessage = cleanup.message;
                }
                await settleDiscardedRecoveryAttempt(
                    projectRoot,
                    plan.planName,
                    plan.attrs.planId,
                    worktreeContext,
                    retained,
                );
                await markEffect("recovery_discard_registry_settled", { worktreeId: worktreeContext?.id, retained });
                await settleWorktreeAttempt(projectRoot, nextWorktree);
                registerRollback("abandon recreated recovery registry entry", async () => {
                    await updateWorktreeRegistryEntry(projectRoot, nextWorktree.id, {
                        status: "abandoned",
                    });
                });
                await markEffect("recovery_recreate_registry_settled", {
                    worktreeId: nextWorktree.id,
                    path: nextWorktree.path,
                    branch: nextWorktree.branch,
                });
                const nextPlanPath = join(nextWorktree.path, "docs", "plans", `${plan.planName}.md`);
                await Deno.mkdir(dirname(nextPlanPath), { recursive: true });
                await Deno.writeTextFile(nextPlanPath, plan.markdown);
                const nextPlan = await loadPlan(nextWorktree.path, plan.planName);
                if (!nextPlan) throw new Error(`Recreated execution Plan is missing: ${plan.planName}`);
                const resetUpdates = buildPlanEventUpdates("recovery_reset", plan.attrs.status, {
                    triageMeta: plan.attrs,
                });
                const attrs = await updatePlanFrontMatter(
                    nextWorktree.path,
                    plan.planName,
                    {
                        ...resetUpdates,
                        status: "ready_for_work",
                        worktreeId: nextWorktree.id,
                        worktreePath: nextWorktree.path,
                        worktreeBranch: nextWorktree.branch,
                        worktreeBaseBranch: nextWorktree.baseBranch,
                        worktreeBaseCommit: nextWorktree.baseCommit,
                        worktreeStatus: "active",
                        executionBaselineTree: nextWorktree.baseTree,
                    },
                    nextPlan.attrs,
                    { expectedRevision: nextPlan.revision },
                );
                return { attrs, worktree: nextWorktree };
            },
        });
        if (transition.status !== "committed") {
            throw new Error(transition.message || `Recovery recreate transaction failed for ${plan.planName}.`);
        }
        const transitionValue = (transition.value || {}) as RecoveryRecreateTransitionValue;
        plan.attrs = transitionValue.value?.attrs as PlanFrontMatter;
        const recreated = transitionValue.value?.worktree;
        if (!recreated) {
            throw new Error(`Recovery recreate transaction returned no worktree for ${plan.planName}.`);
        }
        if (!recreated.path) throw new Error(`Recreated worktree has no path for ${plan.planName}.`);
        const refreshedPlan = await loadPlan(recreated.path, plan.planName);
        if (refreshedPlan?.revision) {
            plan.attrs = refreshedPlan.attrs;
            plan.revision = refreshedPlan.revision;
        }
        uiAPI.appendSystemMessage(
            buildPlanRecoveryUserMessage({ kind: "worktree_cleanup_result", detail: cleanupMessage }),
            false,
            "RunWield",
        );
        return {
            id: recreated.id,
            path: recreated.path,
            branch: recreated.branch,
            baseBranch: recreated.baseBranch,
            status: recreated.status,
            baseRef: recreated.baseRef,
            baseCommit: recreated.baseCommit,
            baseTree: recreated.baseTree,
        };
    } catch (error) {
        const message = isGitRepositoryRequiredError(error)
            ? formatGitRequiredMessage(error)
            : error instanceof Error
            ? error.message
            : String(error);
        console.error("[RunWield] Worktree recreation failed", message);
        uiAPI.appendSystemMessage(
            buildPlanRecoveryUserMessage({ kind: "worktree_cleanup_result", failed: true, detail: message }),
            true,
            "RunWield",
        );
        return null;
    }
}
