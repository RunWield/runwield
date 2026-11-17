import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
    loadPlan,
    updatePlanFrontMatter,
    withPlanLock,
    getStoredPlanPath,
    writePlanMarkdownWithRevision,
    type PlanFrontMatter,
} from "../plan-store.js";
import { buildPlanEventUpdates, type PlanStatus } from "../shared/workflow/plan-lifecycle.js";
import { writeControllerState } from "./controllers.ts";
import { currentPackageProject } from "./workflows.ts";
import { findById } from "../shared/worktree-registry.js";
import { recoveryPlanSnapshot, runPlanFrontMatterTransition, runReviewReopenTransition } from "./transitions.ts";

/** Discard execution selection only after its external cleanup has settled. */
export async function detachPlanExecution(
    cwd: string,
    name: string,
    planId?: string,
    controllerRevision?: number,
): Promise<void> {
    await writeControllerState(
        cwd,
        { planName: name, planId },
        { executionMode: null, documentWorktreeId: null },
        { expectedRevision: controllerRevision, recovery: null },
    );
}

export async function resetPlanExecutionMetadata(
    cwd: string,
    name: string,
    mode: "stop" | "clear",
    expectedRevision?: string,
) {
    return await withPlanLock(cwd, name, async () => {
        const plan = await loadPlan(cwd, name);
        if (!plan) throw new Error(`Plan not found: ${name}`);
        const updates = buildPlanEventUpdates("recovery_reset", plan.attrs.status, { triageMeta: plan.attrs });
        return await updatePlanFrontMatter(
            cwd,
            name,
            {
                ...updates,
                ...(mode === "stop"
                    ? { executionMode: null, worktreeId: null }
                    : {
                          executionBaselineTree: null,
                          worktreeId: null,
                          worktreePath: null,
                          worktreeBranch: null,
                          worktreeBaseBranch: null,
                          worktreeStatus: null,
                      }),
            },
            plan.attrs,
            { expectedRevision: expectedRevision ?? plan.revision },
        );
    });
}

export async function refreshPlanExecutionReference(
    cwd: string,
    name: string,
    attemptId: string,
    expectedRevision?: string,
): Promise<PlanFrontMatter> {
    const plan = await loadPlan(cwd, name);
    if (!plan) throw new Error(`Plan not found: ${name}`);
    if (plan.attrs.status === "validated" || plan.attrs.worktreeId) return plan.attrs;
    const entry = await findById(cwd, attemptId);
    if (
        entry
            ? entry.planName !== name || entry.planId !== plan.attrs.planId
            : (
                  await (
                      await import("./recovery-source.ts")
                  ).resolveRecoveryWorktree(cwd, { planName: name, attrs: plan.attrs })
              )?.id !== attemptId
    )
        throw new Error("Recovered execution no longer belongs to this Plan.");
    const result = await runPlanFrontMatterTransition({
        projectRoot: cwd,
        planName: name,
        operation: "recovery_metadata_refresh",
        updates: { worktreeId: attemptId },
        expectedRevision,
    });
    if (result.status !== "committed")
        throw new Error(result.message || `Recovery metadata transition failed for ${name}.`);
    return result.value as PlanFrontMatter;
}

export async function reopenPlanReview(
    cwd: string,
    name: string,
    attemptId: string,
    status: PlanStatus,
    expectedRevision?: string,
) {
    const result = await runReviewReopenTransition({
        projectRoot: cwd,
        planName: name,
        worktreeId: attemptId,
        expectedRevision,
        reopen: async ({ beforePlan, markEffect }) => {
            if (!beforePlan) throw new Error(`Plan not found: ${name}`);
            const updates = buildPlanEventUpdates("review_reopened", status, { triageMeta: beforePlan.attrs });
            const attrs = await updatePlanFrontMatter(cwd, name, updates, beforePlan.attrs, {
                expectedRevision: beforePlan.revision,
            });
            await markEffect("plan_event_recorded", { planName: name, event: "review_reopened" });
            return attrs;
        },
    });
    if (result.status !== "committed")
        throw new Error(result.message || `Review reopen transition failed for ${name}.`);
}

/** Restore the owner-captured document into the freshly registered execution attempt. */
export async function restoreRecreatedPlanExecution(cwd: string, name: string, attemptId: string) {
    const source = recoveryPlanSnapshot(name);
    if (!source) throw new Error("The recovery transaction has no retained Plan source.");
    const attempt = await findById(cwd, attemptId);
    if (!attempt || attempt.planName !== name || attempt.planId !== source.attrs.planId)
        throw new Error("Recreated execution identity changed.");
    if (!currentPackageProject()) {
        const path = getStoredPlanPath(attempt.path, name);
        const current = await loadPlan(attempt.path, name);
        if (current?.attrs.planId && current.attrs.planId !== source.attrs.planId)
            throw new Error("The recreated checkout contains a different Plan.");
        await mkdir(dirname(path), { recursive: true });
        await writePlanMarkdownWithRevision(path, source.markdown, current?.revision);
    }
    const current = await loadPlan(attempt.path, name);
    if (!current) throw new Error(`Recreated execution Plan is missing: ${name}`);
    const updates = buildPlanEventUpdates("recovery_reset", source.attrs.status, {
        triageMeta: source.attrs,
        worktreeId: attempt.id,
        worktreePath: attempt.path,
        worktreeBranch: attempt.branch,
        worktreeBaseBranch: attempt.baseBranch,
        worktreeStatus: "active",
        executionBaselineTree: attempt.baseTree,
    });
    return await updatePlanFrontMatter(
        attempt.path,
        name,
        { ...updates, worktreeBaseCommit: attempt.baseCommit },
        current.attrs,
        { expectedRevision: current.revision },
    );
}

/** Keep the user-accepted document authoritative before its execution checkout is discarded. */
export async function retainUserVerifiedPlan(
    cwd: string,
    name: string,
    expectedRevision: string,
    attemptId?: string,
): Promise<void> {
    const { resolvePrimaryCheckoutRoot } = await import("../shared/primary-checkout.ts");
    const { resolveWorkflowPlanLocation } = await import("./location.ts");
    const { runRecoveryTransition } = await import("./transitions.ts");
    const { updateEntry } = await import("../shared/worktree-registry.js");
    const root = resolvePrimaryCheckoutRoot(cwd);
    const location = await resolveWorkflowPlanLocation(cwd, name);
    const accepted = location.plan;
    if (!accepted || accepted.attrs.status !== "user_verified" || accepted.revision !== expectedRevision)
        throw new Error("The accepted Plan changed. Reload it.");
    if (!currentPackageProject() && location.documentRoot !== root) {
        await withPlanLock(location.documentRoot, name, async () => {
            const current = await loadPlan(location.documentRoot, name);
            if (!current || current.revision !== expectedRevision)
                throw new Error("The accepted Plan changed. Reload it.");
            await withPlanLock(root, name, async () => {
                const primary = await loadPlan(root, name);
                if (primary && primary.attrs.planId !== accepted.attrs.planId)
                    throw new Error("The primary checkout contains a different Plan. Nothing was overwritten.");
                await writePlanMarkdownWithRevision(
                    primary?.path || getStoredPlanPath(root, name),
                    accepted.markdown,
                    primary?.revision,
                );
            });
        });
    }
    const result = await runRecoveryTransition({
        projectRoot: root,
        planName: name,
        planId: accepted.attrs.planId,
        worktreeId: attemptId,
        action: "recover",
        recover: async ({ markEffect }) => {
            const attempt = attemptId ? await findById(root, attemptId) : null;
            if (attempt) {
                if (attempt.planName !== name || attempt.planId !== accepted.attrs.planId)
                    throw new Error("Accepted Plan execution identity changed.");
                await updateEntry(root, attempt.id, { status: "abandoned" });
            }
            await writeControllerState(
                root,
                { planName: name, planId: accepted.attrs.planId },
                {
                    documentWorktreeId: null,
                    executionMode: null,
                    validationCheckpoint: null,
                },
                {
                    recovery:
                        !attempt && accepted.attrs.worktreeId
                            ? {
                                  worktreeId: accepted.attrs.worktreeId,
                                  worktreePath: accepted.attrs.worktreePath,
                                  worktreeBranch: accepted.attrs.worktreeBranch,
                                  worktreeBaseBranch: accepted.attrs.worktreeBaseBranch,
                                  worktreeStatus: "abandoned",
                              }
                            : null,
                },
            );
            await markEffect("user_verified_primary_selected", {
                path: currentPackageProject() ? accepted.path : getStoredPlanPath(root, name),
            });
        },
    });
    if (result.status !== "committed") throw new Error(result.message || "User Verification handoff is incomplete.");
}

export async function clearPlanRecoveryAfterCleanup(cwd: string, name: string, planId?: string): Promise<void> {
    await writeControllerState(cwd, { planName: name, planId }, {}, { recovery: null });
}
