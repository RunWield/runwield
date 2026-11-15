import { realpath as fsRealpath } from "node:fs/promises";
import { captureForegroundProcess } from "../shared/captured-process.ts";
import { loadPlan, type PlanFrontMatter } from "../plan-store.js";
import { slugify } from "../shared/worktree.js";
import { WORKTREE_BRANCH_PREFIX } from "../constants.js";
import {
    findActiveByPlanName as findWorktreeByPlanName,
    findById as findWorktreeById,
} from "../shared/worktree-registry.js";
export interface PlanRecoveryIdentity {
    planName: string;
    attrs: PlanFrontMatter;
    revision?: string;
}
export interface RecoveryWorktreeContext {
    id?: string;
    path?: string;
    branch?: string;
    baseBranch?: string;
    status?: string;
    baseRef?: string;
    baseCommit?: string;
    baseTree?: string;
    executionBaselineTree?: string;
    publication?: import("../shared/workflow/publication-attempt.ts").PublicationAttempt;
}
interface AttachedWorktreeRecord {
    path: string;
    branch: string;
}

async function canonicalPath(path: string): Promise<string | null> {
    try {
        return await fsRealpath(path);
    } catch {
        return null;
    }
}

async function listAttachedWorktrees(projectRoot: string): Promise<AttachedWorktreeRecord[]> {
    const command = captureForegroundProcess("git", { args: ["worktree", "list", "--porcelain"], cwd: projectRoot });
    const output = await command;
    if (output.code !== 0) return [];
    return new TextDecoder()
        .decode(output.stdout)
        .trim()
        .split("\n\n")
        .filter(Boolean)
        .map((block) => {
            const lines = block.split("\n");
            return {
                path:
                    lines
                        .find((line) => line.startsWith("worktree "))
                        ?.slice("worktree ".length)
                        .trim() || "",
                branch:
                    lines
                        .find((line) => line.startsWith("branch "))
                        ?.slice("branch ".length)
                        .trim() || "",
            };
        })
        .filter((record) => Boolean(record.path && record.branch));
}

async function discoverAttachedPlanWorktree(
    projectRoot: string,
    plan: PlanRecoveryIdentity,
): Promise<RecoveryWorktreeContext | null> {
    const projectPath = await canonicalPath(projectRoot);
    const matches: RecoveryWorktreeContext[] = [];
    // Execution branches are created only as `worktree/<plan-slug>-<attempt-id>`, a
    // prefix target branches may not use, and attempt IDs contain no dash. A child
    // Plan's slug extends its Epic's with another dash, so only this Plan's own
    // attempts can match; reading every other checkout's Plan would cost a runtime
    // entry each.
    const executionBranchPrefix = `refs/heads/${WORKTREE_BRANCH_PREFIX}${slugify(plan.planName)}-`;
    const isOwnExecutionBranch = (branch: string) =>
        branch.startsWith(executionBranchPrefix) && !branch.slice(executionBranchPrefix.length).includes("-");
    for (const record of await listAttachedWorktrees(projectRoot)) {
        if (!isOwnExecutionBranch(record.branch)) continue;
        const recordPath = await canonicalPath(record.path);
        if (!recordPath || recordPath === projectPath) continue;
        const executionPlan = await loadPlan(record.path, plan.planName).catch(() => null);
        if (!executionPlan || executionPlan.attrs.executionMode !== "worktree") continue;
        const attrs = executionPlan.attrs;
        if (
            !attrs.planId ||
            !attrs.worktreeId ||
            !attrs.worktreePath ||
            !attrs.worktreeBranch ||
            !attrs.worktreeBaseBranch
        )
            continue;
        if (plan.attrs.planId && plan.attrs.planId !== attrs.planId) continue;
        if ((await canonicalPath(attrs.worktreePath)) !== recordPath) continue;
        if (record.branch !== `refs/heads/${attrs.worktreeBranch}`) continue;
        if (!["in_progress", "failed", "implemented", "validated_ci", "reviewed", "validated"].includes(attrs.status))
            continue;
        matches.push({
            id: attrs.worktreeId,
            path: record.path,
            branch: attrs.worktreeBranch,
            baseBranch: attrs.worktreeBaseBranch,
            executionBaselineTree: attrs.executionBaselineTree || undefined,
            status: attrs.worktreeStatus || undefined,
        });
    }
    return matches.length === 1 ? matches[0] : null;
}

export async function resolveRecoveryWorktree(
    projectRoot: string,
    plan: PlanRecoveryIdentity,
): Promise<RecoveryWorktreeContext | null> {
    let entry = null;
    if (plan.attrs.worktreeId) entry = await findWorktreeById(projectRoot, plan.attrs.worktreeId);
    if (!entry) entry = await findWorktreeByPlanName(projectRoot, plan.planName);
    if (!entry && !plan.attrs.worktreePath && !plan.attrs.worktreeBranch && !plan.attrs.worktreeId) {
        const discovered = await discoverAttachedPlanWorktree(projectRoot, plan);
        if (discovered) return discovered;
    }
    const path = entry?.path || plan.attrs.worktreePath || undefined;
    const branch = entry?.branch || plan.attrs.worktreeBranch || undefined;
    const id = entry?.id || plan.attrs.worktreeId || undefined;
    const recordedBaseBranch = entry?.baseBranch || plan.attrs.worktreeBaseBranch || undefined;
    const baseBranch = recordedBaseBranch === "HEAD" ? undefined : recordedBaseBranch;
    if (!path && !branch && !id) return null;
    return {
        id,
        path,
        branch,
        baseBranch,
        // Once execution starts, the registry records operational attempt state.
        // The primary-checkout Plan is intentionally immutable during publication,
        // so its older worktreeStatus must not hide a failed push or conflict.
        status: entry?.status || plan.attrs.worktreeStatus || undefined,
        baseRef: entry?.baseRef || plan.attrs.worktreeBaseCommit || undefined,
        baseCommit: entry?.baseCommit || plan.attrs.worktreeBaseCommit || undefined,
        baseTree: entry?.baseTree,
        executionBaselineTree: entry?.executionBaselineTree || plan.attrs.executionBaselineTree || undefined,
        publication: entry?.publication,
    };
}
