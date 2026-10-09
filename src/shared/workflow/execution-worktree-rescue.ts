/** Recover a deleted execution checkout from Git evidence left by a manual rescue. */
import { loadPlan, parsePlanFrontMatter } from "../../plan-store.js";
import { resolvePrimaryCheckoutRoot } from "../primary-checkout.ts";
import { listControllerDocumentWorktrees } from "./controller-registry.ts";

interface GitResult {
    code: number;
    stdout: string;
    stderr: string;
}

interface RescueCandidate {
    commit: string;
    refs: string[];
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

const RESCUED_EXECUTION_STATUSES = new Set([
    "in_progress",
    "failed",
    "implemented",
    "validated_ci",
    "reviewed",
    "validated",
]);

async function runGitResult(cwd: string, args: string[]): Promise<GitResult> {
    const output = await new Deno.Command("git", {
        cwd,
        args,
        stdout: "piped",
        stderr: "piped",
    }).output();
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
        await Deno.lstat(path);
        return true;
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
    }
}

async function commitContainsExecutionPlan(
    projectRoot: string,
    attempt: RegisteredExecutionAttempt,
    commit: string,
    requireExecutionStatus: boolean,
): Promise<boolean> {
    const planPath = `docs/plans/${attempt.planName}.md`;
    const shown = await runGitResult(projectRoot, ["show", `${commit}:${planPath}`]);
    if (shown.code !== 0) return false;
    try {
        const parsed = parsePlanFrontMatter(shown.stdout);
        if (!attempt.planId || parsed.attrs.planId !== attempt.planId) return false;
        if (requireExecutionStatus && !RESCUED_EXECUTION_STATUSES.has(String(parsed.attrs.status || ""))) return false;
    } catch {
        return false;
    }
    if (attempt.baseCommit) {
        const ancestor = await runGitResult(projectRoot, [
            "merge-base",
            "--is-ancestor",
            attempt.baseCommit,
            commit,
        ]);
        if (ancestor.code !== 0) return false;
    }
    return true;
}

async function findUniqueRescueCandidate(
    projectRoot: string,
    attempt: RegisteredExecutionAttempt,
): Promise<RescueCandidate | null> {
    const refsResult = await runGitResult(projectRoot, [
        "for-each-ref",
        "--format=%(refname)%00%(objectname)",
        "refs/heads",
        "refs/remotes",
    ]);
    if (refsResult.code !== 0) return null;
    const candidatesByCommit = new Map<string, RescueCandidate>();
    for (const line of refsResult.stdout.split("\n").filter(Boolean)) {
        const [ref = "", commit = ""] = line.split("\0");
        if (!ref || !commit || /\/HEAD$/.test(ref)) continue;
        if (!await commitContainsExecutionPlan(projectRoot, attempt, commit, true)) continue;
        const existing = candidatesByCommit.get(commit);
        if (existing) existing.refs.push(ref);
        else candidatesByCommit.set(commit, { commit, refs: [ref] });
    }
    const candidates = [...candidatesByCommit.values()];
    const tips: RescueCandidate[] = [];
    for (const candidate of candidates) {
        let superseded = false;
        for (const other of candidates) {
            if (candidate.commit === other.commit) continue;
            const ancestor = await runGitResult(projectRoot, [
                "merge-base",
                "--is-ancestor",
                candidate.commit,
                other.commit,
            ]);
            if (ancestor.code === 0) {
                superseded = true;
                break;
            }
        }
        if (!superseded) tips.push(candidate);
    }
    return tips.length === 1 ? tips[0] : null;
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

    const expectedBranchRef = `refs/heads/${attempt.branch}`;
    const expectedBranch = await runGitResult(projectRoot, ["rev-parse", "--verify", expectedBranchRef]);
    let sourceRef = expectedBranchRef;
    let sourceCommit = expectedBranch.stdout;
    let createdBranch = false;
    if (
        expectedBranch.code !== 0 ||
        !await commitContainsExecutionPlan(projectRoot, attempt, sourceCommit, false)
    ) {
        const candidate = await findUniqueRescueCandidate(projectRoot, attempt);
        if (!candidate) {
            return { recovered: false, reason: "no unique matching rescue branch was found" };
        }
        sourceCommit = candidate.commit;
        sourceRef = candidate.refs.find((ref) => ref.startsWith("refs/heads/")) || candidate.refs[0];
        if (expectedBranch.code === 0) {
            return { recovered: false, reason: "the recorded branch now contains different Plan evidence" };
        }
        await runGit(projectRoot, ["branch", attempt.branch, sourceCommit]);
        createdBranch = true;
    }

    let worktreeAdded = false;
    try {
        await runGit(projectRoot, ["worktree", "prune"]);
        await runGit(projectRoot, ["worktree", "add", attempt.path, attempt.branch]);
        worktreeAdded = true;
        const restored = await loadPlan(attempt.path, attempt.planName);
        if (!restored || restored.attrs.planId !== attempt.planId) {
            throw new Error("the restored checkout did not contain the expected Plan");
        }
        return { recovered: true, branch: attempt.branch, sourceRef };
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
    const registryRoot = resolvePrimaryCheckoutRoot(cwd);
    const recovered: RecoveredExecutionWorktree[] = [];
    for (const attempt of await listControllerDocumentWorktrees(registryRoot)) {
        if (await executionWorktreePathExists(attempt.path)) continue;
        const result = await recoverMissingExecutionWorktree(registryRoot, attempt);
        if (result.recovered) recovered.push({ planName: attempt.planName, branch: attempt.branch });
    }
    return recovered;
}
