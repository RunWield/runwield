import { findMissingExecutionSnapshot } from "@runwield/plans/retained-checkout";
import { projects } from "@runwield/projects";
import { captureForegroundProcess } from "@runwield/resources/process";
import { lstat as fsLstat } from "node:fs/promises";
import { listPlanExecutionDocuments, planDocumentsForCheckout } from "../../plan-store/index.ts";
import { enterProjectRuntime } from "@runwield/project-runtime/layout";
import { loadTargetPlan } from "./planning-worktree.ts";

interface GitResult {
    code: number;
    stdout: string;
    stderr: string;
}

interface RegisteredExecutionAttempt {
    id: string;
    planName: string;
    planId?: string;
    baseCommit: string;
    branch: string;
    path: string;
}

export interface MissingExecutionWorktreeRecovery {
    recovered: boolean;
    branch?: string;
    sourceRef?: string;
    reason?: string;
}

export interface RecoveredExecutionWorktree {
    planName: string;
    branch: string;
}

async function runGitResult(cwd: string, args: string[]): Promise<GitResult> {
    const output = await captureForegroundProcess("git", { cwd, args, env: { GIT_NO_LAZY_FETCH: "1" } });
    const decoder = new TextDecoder();
    return {
        code: output.code,
        stdout: decoder.decode(output.stdout).trim(),
        stderr: decoder.decode(output.stderr).trim(),
    };
}

async function runGit(cwd: string, args: string[]): Promise<string> {
    const result = await runGitResult(cwd, args);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
    return result.stdout;
}

export async function executionWorktreePathExists(path: string): Promise<boolean> {
    try {
        await fsLstat(path);
        return true;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
    }
}

/** Read recoverable execution evidence without recreating its checkout or changing refs. */
export async function readMissingExecutionPlan(projectRoot: string, attempt: RegisteredExecutionAttempt) {
    const source = await findMissingExecutionSnapshot(projectRoot, attempt, "read");
    if (source.kind !== "recorded" && source.kind !== "rescue") return null;
    return await loadTargetPlan(projectRoot, attempt.planName, source.commit);
}

/**
 * Recreate RunWield's missing checkout from Git when a user has deliberately
 * rescued its commits onto one unambiguous branch. The Plan ID, lifecycle
 * status, and original base ancestry must all agree before any branch is made.
 */
export async function recoverMissingExecutionWorktree(
    projectRoot: string,
    attempt: RegisteredExecutionAttempt,
): Promise<MissingExecutionWorktreeRecovery> {
    if (await executionWorktreePathExists(attempt.path)) {
        return { recovered: false, reason: "recorded path still exists" };
    }

    const source = await findMissingExecutionSnapshot(projectRoot, attempt, "repair");
    if (source.kind === "missing") return { recovered: false, reason: "no unique matching rescue branch was found" };
    if (source.kind === "recorded_branch_conflict") {
        return { recovered: false, reason: "the recorded branch now contains different Plan evidence" };
    }
    const createdBranch = source.kind === "rescue";
    if (createdBranch) await runGit(projectRoot, ["branch", attempt.branch, source.commit]);

    let worktreeAdded = false;
    try {
        await runGit(projectRoot, ["worktree", "prune"]);
        await runGit(projectRoot, ["worktree", "add", attempt.path, attempt.branch]);
        worktreeAdded = true;
        await enterProjectRuntime(attempt.path);
        const restored = await planDocumentsForCheckout(attempt.path).load(attempt.planName);
        if (!restored || restored.attrs.planId !== attempt.planId) {
            throw new Error("the restored checkout did not contain the expected Plan");
        }
        return { recovered: true, branch: attempt.branch, sourceRef: source.sourceRef };
    } catch (error) {
        if (worktreeAdded) {
            await runGitResult(projectRoot, ["worktree", "remove", "--force", attempt.path]);
        }
        if (createdBranch) {
            await runGitResult(projectRoot, ["branch", "-D", attempt.branch]);
        }
        return { recovered: false, reason: error instanceof Error ? error.message : String(error) };
    }
}

/** Repair dead execution checkouts before /load-plan builds its Plan picker. */
export async function recoverMissingExecutionWorktreesForPlanLoading(
    cwd: string,
): Promise<RecoveredExecutionWorktree[]> {
    const registryRoot = projects.checkout.primaryRoot(cwd);
    const recovered: RecoveredExecutionWorktree[] = [];
    for (const attempt of await listPlanExecutionDocuments(registryRoot)) {
        if (await executionWorktreePathExists(attempt.path)) continue;
        const result = await recoverMissingExecutionWorktree(registryRoot, attempt);
        if (result.recovered) recovered.push({ planName: attempt.planName, branch: attempt.branch });
    }
    return recovered;
}
