/** Repairs bind execution evidence through the same Plan owner that persists normal transitions. */
import { loadPlan, updatePlanFrontMatter, withPlanLock } from "../plan-store.js";
import { withLocalPlanWorkflow } from "./access.ts";
import { findById } from "../shared/worktree-registry.js";

export async function restoreNonGitPlanExecution(cwd: string, planName: string, expectedRevision: string) {
    return await withLocalPlanWorkflow(cwd, planName, () =>
        withPlanLock(cwd, planName, async () => {
            return await updatePlanFrontMatter(
                cwd,
                planName,
                {
                    executionMode: "non_git_in_place",
                    deliveryEvidence: null,
                    validatedCommit: null,
                },
                {},
                { expectedRevision },
            );
        }),
    );
}

export async function reconcilePlanExecutionBinding(cwd: string, planName: string, worktreeId: string) {
    return await withLocalPlanWorkflow(cwd, planName, () =>
        withPlanLock(cwd, planName, async () => {
            const plan = await loadPlan(cwd, planName);
            if (!plan) return { identityRepaired: false, legacyExecutionMode: false };
            const attempt = await findById(cwd, worktreeId);
            if (!attempt || attempt.planName !== planName) throw new Error("Recorded execution identity changed.");
            const identityRepaired = Boolean(attempt.planId && plan.attrs.planId !== attempt.planId);
            const missingAttempt = plan.attrs.status !== "validated" && !plan.attrs.worktreeId;
            if (identityRepaired || missingAttempt)
                await updatePlanFrontMatter(
                    cwd,
                    planName,
                    {
                        ...(identityRepaired ? { planId: attempt.planId } : {}),
                        ...(missingAttempt ? { worktreeId } : {}),
                    },
                    plan.attrs,
                    { expectedRevision: plan.revision },
                );
            return { identityRepaired, legacyExecutionMode: plan.attrs.executionMode !== "worktree" };
        }),
    );
}

import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
/** Explicit retained checkpoint evidence, never an alternative source for a live Plan read. */
export async function readRetainedExecutionPlan(cwd: string, documentPath: string): Promise<string> {
    const root = resolve(cwd, "docs/plans");
    const path = resolve(cwd, documentPath);
    const child = relative(root, path);
    if (!child || child === ".." || child.startsWith("../") || isAbsolute(child) || !child.endsWith(".md"))
        throw new Error("Execution checkpoint does not identify a retained Plan document.");
    return await readFile(path, "utf8");
}
