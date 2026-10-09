/**
 * @module shared/workflow/git-snapshot
 * Git tree snapshots for workflow-scoped validation diffs.
 */

import { dirname, isAbsolute, join } from "@std/path";
import { assertGitRepository, GitRepositoryRequiredError } from "../git.ts";

class GitCommandError extends Error {
    code: number;
    output: string;

    constructor(args: string[], code: number, output: string) {
        super(`git ${args.join(" ")} failed: ${output}`.trim());
        this.name = "GitCommandError";
        this.code = code;
        this.output = output;
    }
}

export class WorktreeReviewComparisonError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WorktreeReviewComparisonError";
    }
}

export class WorktreeReviewTargetError extends WorktreeReviewComparisonError {
    constructor(targetBranch: string) {
        const branch = targetBranch || "(missing)";
        super(`Cannot compute the worktree review diff because target ref refs/heads/${branch} is unavailable.`);
        this.name = "WorktreeReviewTargetError";
    }
}

async function runGit(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
    let output;
    try {
        const command = new Deno.Command("git", {
            args,
            cwd,
            env,
            stdout: "piped",
            stderr: "piped",
        });
        output = await command.output();
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            throw new GitRepositoryRequiredError(
                `Git operation requires a Git repository: git ${args.join(" ")}. The git executable was not found.`,
                { cwd, operation: `git ${args.join(" ")}`, state: "git_missing" },
            );
        }
        throw error;
    }
    const decoder = new TextDecoder();
    const stdoutText = decoder.decode(output.stdout);
    const stderrText = decoder.decode(output.stderr);

    if (output.code !== 0) {
        const text = stderrText || stdoutText;
        if (text.includes("not a git repository")) {
            throw new GitRepositoryRequiredError(
                `Git operation requires a Git repository: git ${args.join(" ")}. ${text}`.trim(),
                { cwd, operation: `git ${args.join(" ")}`, state: "not_git" },
            );
        }
        throw new GitCommandError(args, output.code, text);
    }

    return stdoutText;
}

function isMissingRevisionError(error: Error): boolean {
    return error instanceof GitCommandError && error.output.includes("Needed a single revision");
}

export interface GitCommitSummary {
    hash: string;
    date: string;
    subject: string;
}

/**
 * List commits on HEAD since a timestamp that touched any of the provided
 * paths.
 */
export async function listCommitsTouchingPathsSince(
    cwd: string,
    since: string | undefined,
    paths: string[],
): Promise<GitCommitSummary[]> {
    const pathspecs = (Array.isArray(paths) ? paths : [])
        .map((path) => String(path || "").trim())
        .filter(Boolean);
    if (!since || pathspecs.length === 0) return [];
    await assertGitRepository(cwd, "Checking affected path commit history");

    const output = await runGit(cwd, [
        "log",
        "HEAD",
        `--since=${since}`,
        "--date=iso-strict",
        "--format=%h%x1f%cd%x1f%s",
        "--",
        ...pathspecs,
    ]);

    return output.trim().split("\n").filter(Boolean).map((line) => {
        const [hash = "", date = "", ...subjectParts] = line.split("\x1f");
        return { hash, date, subject: subjectParts.join("\x1f") };
    });
}

/**
 * Capture the current working tree into a git tree object without mutating the
 * repository's real index.
 */
export async function captureWorktreeTree(cwd: string): Promise<string> {
    await assertGitRepository(cwd, "Capturing an execution baseline tree");
    const realIndex = (await runGit(cwd, ["rev-parse", "--git-path", "index"])).trim();
    const realIndexPath = isAbsolute(realIndex) ? realIndex : join(cwd, realIndex);
    const indexPath = await Deno.makeTempFile({ dir: dirname(realIndexPath), prefix: "runwield-index-" });
    const env = { GIT_INDEX_FILE: indexPath };

    try {
        try {
            await Deno.writeFile(indexPath, await Deno.readFile(realIndexPath));
        } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
            await Deno.remove(indexPath);
        }
        await runGit(cwd, ["add", "-A", "--", "."], env);
        return (await runGit(cwd, ["write-tree"], env)).trim();
    } finally {
        await Deno.remove(indexPath).catch(() => {});
    }
}

export async function diffTrees(cwd: string, baseTree: string, currentTree: string): Promise<string> {
    await assertGitRepository(cwd, "Computing a workflow diff");
    return await runGit(cwd, ["diff", `${baseTree}..${currentTree}`]);
}

export async function getWorkflowDiff(cwd: string, baselineTree: string | undefined): Promise<string> {
    await assertGitRepository(cwd, "Computing a workflow diff");
    if (!baselineTree) {
        return await runGit(cwd, ["diff"]);
    }

    const currentTree = await captureWorktreeTree(cwd);
    return await diffTrees(cwd, baselineTree, currentTree);
}

/**
 * Return the complete proposed patch from the recorded target branch's common
 * ancestor with execution HEAD to the current worktree files. This is the
 * shared comparison for AI review, repair context, human review, and future
 * full-review consumers.
 */
export async function getWorktreeReviewDiff(cwd: string, targetBranch: string): Promise<string> {
    await assertGitRepository(cwd, "Computing a worktree review diff");
    const branch = String(targetBranch || "").trim();
    if (!branch) throw new WorktreeReviewTargetError(branch);

    let targetCommit;
    try {
        targetCommit = (await runGit(cwd, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`])).trim();
    } catch (error) {
        if (error instanceof Error && isMissingRevisionError(error)) {
            throw new WorktreeReviewTargetError(branch);
        }
        throw error;
    }

    let executionCommit;
    try {
        executionCommit = (await runGit(cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    } catch (error) {
        if (error instanceof Error && isMissingRevisionError(error)) {
            throw new WorktreeReviewComparisonError(
                "Cannot compute the worktree review diff because execution HEAD is unavailable.",
            );
        }
        throw error;
    }

    let commonAncestor;
    try {
        commonAncestor = (await runGit(cwd, ["merge-base", targetCommit, executionCommit])).trim();
    } catch (error) {
        if (error instanceof GitCommandError && error.code === 1) {
            throw new WorktreeReviewComparisonError(
                `Cannot compute the worktree review diff because refs/heads/${branch} and execution HEAD have no common ancestor.`,
            );
        }
        throw error;
    }
    const baseTree = (await runGit(cwd, ["rev-parse", "--verify", `${commonAncestor}^{tree}`])).trim();
    const currentTree = await captureWorktreeTree(cwd);
    return await diffTrees(cwd, baseTree, currentTree);
}

/**
 * Restore the repository's real index and worktree to a previously captured
 * git tree only when the current tree already matches the target tree. This
 * fail-closed guard prevents stale baseline restores from deleting newer work.
 */
export async function restoreWorktreeTree(cwd: string, targetTree: string): Promise<void> {
    await assertGitRepository(cwd, "Restoring an execution baseline tree");
    const targetType = (await runGit(cwd, ["cat-file", "-t", targetTree])).trim();
    if (targetType !== "tree") {
        throw new Error(`Target ${targetTree} is a ${targetType}, not a git tree.`);
    }

    const currentTree = await captureWorktreeTree(cwd);
    if (currentTree !== targetTree) {
        throw new Error(
            `Refusing to restore execution baseline tree ${targetTree} because the checkout has changed. ` +
                "Resolve or save the current checkout changes before retrying.",
        );
    }

    await runGit(cwd, ["read-tree", targetTree]);
    await runGit(cwd, ["checkout-index", "-a", "-f"]);
}
