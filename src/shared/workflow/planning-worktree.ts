import {
    PlanningPlanAttributes,
    pathExists,
    targetBranchForPlan,
    runGit,
    gitRefExists,
    prepareExistingTargetSnapshot,
} from "./planning-target.ts";
import type { LoadedPlan } from "../../plan-store/index.ts";
import {
    loadPlanningTargetForPreparation,
    withPlanningPlanIdentity,
    assertPlanningDocumentAvailable,
    bindPlanningDocument,
    installPlanningDocument,
} from "../../plan-store/index.ts";

import { loadPlan } from "../../plan-store/index.ts";
import {
    addEntry as addWorktreeRegistryEntry,
    listEntries as listWorktreeRegistryEntries,
    removeEntry as removeWorktreeRegistryEntry,
    renamePlanningWorktreePlan,
    updateEntry as updateWorktreeRegistryEntry,
    type WorktreeRegistryEntry,
} from "../worktree-registry.js";
import {
    checkpointExecutionPreparation,
    createWorktreeGitArtifacts,
    prepareTargetBranchRef,
    removeWorktreeGitArtifacts,
} from "../worktree.js";
import { runExecutionPreparationTransition } from "../../plan-store/index.ts";
import { resolvePrimaryCheckoutRoot } from "../primary-checkout.ts";

import { enterProjectRuntime, ProjectRuntimeReadPendingError } from "../project-runtime-layout.ts";
import { refreshPlanningWorktree } from "./planning-worktree-refresh.ts";

export interface PlanningWorktreeResult {
    entry: WorktreeRegistryEntry;
    plan: LoadedPlan;
    reused: boolean;
}

export async function preparePlanningWorktreeForPlan(
    cwd: string,
    planName: string,
    planAttrs: PlanningPlanAttributes,
): Promise<PlanningWorktreeResult> {
    for (;;) {
        try {
            return await preparePlanningWorktreeForPlanEntered(cwd, planName, planAttrs);
        } catch (error) {
            if (!(error instanceof ProjectRuntimeReadPendingError)) throw error;
            // A concurrent admission can briefly hold the migration lock after our
            // entry returns. The action, unlike a browser read, owns recovery.
            await enterProjectRuntime(cwd);
        }
    }
}

async function preparePlanningWorktreeForPlanEntered(
    cwd: string,
    planName: string,
    planAttrs: PlanningPlanAttributes,
): Promise<PlanningWorktreeResult> {
    const projectRoot = resolvePrimaryCheckoutRoot(cwd);
    await enterProjectRuntime(projectRoot);
    const planId = typeof planAttrs.planId === "string" ? planAttrs.planId.trim() : "";
    if (!planId)
        return await withPlanningPlanIdentity(projectRoot, planName, planAttrs, (stablePlanId) =>
            preparePlanningWorktreeForPlan(projectRoot, planName, { ...planAttrs, planId: stablePlanId }),
        );

    let existing = (await listWorktreeRegistryEntries(projectRoot)).find(
        (entry) => entry.planId === planId && entry.status !== "abandoned",
    );
    if (existing) {
        if (await pathExists(existing.path)) {
            await assertPlanningDocumentAvailable(projectRoot, existing.id);
        }
        if (existing.planName !== planName) {
            if (existing.status !== "planning") {
                throw new Error(
                    `Planning worktree for ${planName} found a different registered Plan: ${existing.planName}.`,
                );
            }
            const target = await prepareExistingTargetSnapshot(projectRoot, targetBranchForPlan(planAttrs));
            const targetPlan = await loadPlanningTargetForPreparation(
                projectRoot,
                planName,
                target.baseBranch,
                target.baseRef,
            );
            if (!targetPlan || targetPlan.attrs.planId !== planId || existing.baseBranch !== target.baseBranch) {
                throw new Error(`Target Plan ${planName} does not match the saved planning identity.`);
            }
            existing = await refreshPlanningWorktree(projectRoot, existing, target.baseRef, target.targetRef);
            const renamed = await loadPlan(existing.path, planName);
            if (!renamed || renamed.attrs.planId !== planId) {
                throw new Error(`Refreshed planning worktree is missing ${planName}. Your saved work is preserved.`);
            }
            existing = await renamePlanningWorktreePlan(projectRoot, existing.id, existing.planName, planName);
        }
        if (await pathExists(existing.path)) {
            const plan = await loadPlan(existing.path, planName);
            if (!plan) throw new Error(`Registered worktree is missing its Plan: ${existing.path}`);
            if (plan.attrs.planId !== planId) {
                throw new Error(`Registered worktree contains a different Plan ID. Your files were not changed.`);
            }
            if (existing.status !== "planning") return { entry: existing, plan, reused: true };
            const target = await prepareExistingTargetSnapshot(projectRoot, targetBranchForPlan(planAttrs));
            if (existing.baseBranch !== target.baseBranch) {
                throw new Error(
                    `Planning worktree targets ${existing.baseBranch}, but Plan targets ${target.baseBranch}.`,
                );
            }
            if (target.baseRef !== existing.baseCommit) {
                const targetPlan = await loadPlanningTargetForPreparation(
                    projectRoot,
                    planName,
                    target.baseBranch,
                    target.baseRef,
                );
                if (!targetPlan || (targetPlan.attrs.planId && targetPlan.attrs.planId !== planId)) {
                    throw new Error(
                        `Target Plan ${planName} is missing or has a different Plan ID. Your files were not changed.`,
                    );
                }
            }
            const entry = await refreshPlanningWorktree(projectRoot, existing, target.baseRef, target.targetRef);
            const refreshedPlan = await loadPlan(entry.path, planName);
            if (!refreshedPlan) throw new Error(`Registered worktree is missing its Plan: ${entry.path}`);
            return { entry, plan: refreshedPlan, reused: true };
        }
    }

    const targetBranch = targetBranchForPlan(planAttrs);
    const branch = targetBranch.replace(/^origin\//, "");
    if (!(await gitRefExists(projectRoot, `refs/heads/${branch}`))) {
        await prepareTargetBranchRef(projectRoot, targetBranch);
    }
    const target = await prepareExistingTargetSnapshot(projectRoot, targetBranch);
    const targetPlan = await loadPlanningTargetForPreparation(projectRoot, planName, target.baseBranch, target.baseRef);
    if (!targetPlan) throw new Error(`Plan ${planName} does not exist on target ${target.baseBranch}.`);
    if (targetPlan.attrs.planId && targetPlan.attrs.planId !== planId) {
        throw new Error(`Target Plan ${planName} has a different Plan ID. Your files were not changed.`);
    }
    const attemptId = crypto.randomUUID().slice(0, 8);
    const transition = await runExecutionPreparationTransition({
        projectRoot,
        planName,
        planId,
        worktreeId: attemptId,
        targetRef: targetBranch,
        expectedPlanEvent: false,
        prepare: async ({ markEffect, registerRollback }) => {
            const concurrentExisting = (await listWorktreeRegistryEntries(projectRoot)).find(
                (entry) => entry.planId === planId && entry.status !== "abandoned",
            );
            if (concurrentExisting) {
                if (concurrentExisting.planName !== planName) {
                    throw new Error(
                        `Planning worktree for ${planName} found a different registered Plan: ${concurrentExisting.planName}.`,
                    );
                }
                const plan = await loadPlan(concurrentExisting.path, planName);
                if (!plan) throw new Error(`Registered worktree is missing its Plan: ${concurrentExisting.path}`);
                if (plan.attrs.planId !== planId) {
                    throw new Error(`Registered worktree contains a different Plan ID. Your files were not changed.`);
                }
                return { entry: concurrentExisting, plan, reused: true };
            }
            const artifacts = await createWorktreeGitArtifacts({
                projectRoot,
                planName,
                planId,
                baseRef: target.baseRef,
                baseBranch: target.baseBranch,
                attemptId,
            });
            const entry: WorktreeRegistryEntry = { ...artifacts, baseRef: target.targetRef, status: "planning" };
            registerRollback("remove_clean_created_worktree_and_registry_entry", async () => {
                await removeWorktreeGitArtifacts({ projectRoot, path: entry.path, force: true });
                await removeWorktreeRegistryEntry(projectRoot, entry.id);
            });
            await markEffect("git_worktree_created", {
                worktreeId: entry.id,
                path: entry.path,
                branch: entry.branch,
                baseCommit: entry.baseCommit,
            });
            await addWorktreeRegistryEntry(projectRoot, entry);
            await markEffect("worktree_registry_settled", {
                worktreeId: entry.id,
                path: entry.path,
                branch: entry.branch,
                status: entry.status,
            });
            const planFile = await installPlanningDocument({
                projectRoot,
                executionCwd: entry.path,
                planName,
                planId,
                baseBranch: target.baseBranch,
                baseRef: target.baseRef,
            });
            if (!["present", "restored", "reconciled"].includes(planFile.kind)) {
                throw new Error(
                    `Cannot prepare planning Plan file ${planFile.relativePath}: ${planFile.reason || planFile.kind}`,
                );
            }
            const dirty = (await runGit(entry.path, ["status", "--porcelain"])).trim();
            if (dirty) {
                const preparation = await checkpointExecutionPreparation({
                    phase: "planning",
                    worktreePath: entry.path,
                    branch: entry.branch,
                    baseCommit: entry.baseCommit,
                    planName,
                    planRelativePath: planFile.relativePath,
                    relatedPlanPaths: [],
                });
                await runGit(entry.path, ["rev-parse", preparation.preparationCommit]);
                await markEffect("planning_preparation_checkpoint_settled", {
                    preparationCommit: preparation.preparationCommit,
                    worktreeId: entry.id,
                });
            }
            await updateWorktreeRegistryEntry(projectRoot, entry.id, { status: "planning" });
            const plan = await loadPlan(entry.path, planName);
            if (!plan) throw new Error(`Planning worktree is missing its Plan after preparation: ${entry.path}`);
            await bindPlanningDocument(projectRoot, planName, planId, entry.id);
            await markEffect("controller_document_worktree_recorded", { worktreeId: entry.id });
            return { entry, plan, reused: false };
        },
        verifyPreparation: (result) => ({
            planName,
            worktreeId: result.entry.id,
            status: result.entry.status,
            documentWorktreeId: result.entry.id,
        }),
    });
    if (transition.status !== "committed") {
        throw new Error(transition.message || `Planning worktree preparation did not commit for ${planName}.`);
    }
    return transition.value as PlanningWorktreeResult;
}

export { TargetBranchSnapshotUnavailableError } from "./planning-target.ts";
export {
    prepareTargetBranchPlansByParent,
    loadTargetPlan,
    findTargetBranchPlan,
    inspectTargetBranchPlansByParent,
    findTargetBranchPlansByParent,
    readTargetBranchPlanCatalogByParent,
} from "../../plan-store/index.ts";
