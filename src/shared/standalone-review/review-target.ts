import { checkAuth, fetchPR, fetchPRContext } from "@plannotator/shared/pr-provider.ts";
import { parsePRUrl, type PRMetadata, type PRRef, type PRRuntime } from "@plannotator/shared/pr-types.ts";
import { parseRemoteHost, parseRemoteUrl } from "@plannotator/shared/repo.ts";
import { getReviewDiff } from "../workflow/git-snapshot.ts";
import { createPRRuntime } from "./forge-review.ts";
import { git } from "./git.ts";
import type { ReviewWorktree } from "./review-worktree.ts";
interface ReviewTargetBase {
    projectRoot: string;
    gitRef: string;
    baseLabel: string;
    baseRef: string;
    worktree?: ReviewWorktree;
    reviewContext?: string;
    computeDiff(cwd?: string): Promise<string>;
}
export interface PRReviewTarget extends ReviewTargetBase {
    mode: "pr";
    ref: PRRef;
    metadata: PRMetadata;
    remote: string;
    recoveryReason?: string;
    runtime: PRRuntime;
    runtimeForCwd(cwd: string): PRRuntime;
}
export interface BranchReviewTarget extends ReviewTargetBase {
    mode: "branch";
    branch: string;
}
export interface UncommittedReviewTarget extends ReviewTargetBase {
    mode: "uncommitted";
}
export type ReviewTarget = PRReviewTarget | BranchReviewTarget | UncommittedReviewTarget;
export async function refreshPRTarget(target: PRReviewTarget): Promise<void> {
    const { metadata } = await fetchPR(target.runtime, target.ref);
    const number = target.ref.platform === "github" ? target.ref.number : target.ref.iid;
    await git(target.projectRoot, [
        "fetch",
        target.remote,
        `${target.ref.platform === "github" ? "pull" : "merge-requests"}/${number}/head`,
        `refs/heads/${metadata.baseBranch}`,
    ]);
    await git(target.projectRoot, ["rev-parse", "--verify", `${metadata.headSha}^{commit}`]);
    await git(target.projectRoot, ["rev-parse", "--verify", `${metadata.baseSha}^{commit}`]);
    target.recoveryReason = undefined;
    if (target.worktree && metadata.headSha !== target.metadata.headSha) {
        const cwd = target.worktree.path;
        if (await git(cwd, ["status", "--porcelain"])) {
            target.recoveryReason =
                "PR head changed. Local edits are preserved in the review worktree. Ask the Engineer to reconcile them before posting.";
        } else if ((await git(cwd, ["rev-parse", "HEAD"])) !== target.metadata.headSha) {
            target.recoveryReason =
                "PR head changed. Local commits are preserved in the review worktree. Ask the Engineer to reconcile them before posting.";
        } else {
            try {
                await git(cwd, ["merge", "--ff-only", metadata.headSha]);
            } catch {
                target.recoveryReason =
                    "PR history changed and cannot fast-forward. The review worktree is preserved. Ask the Engineer to reconcile the rewritten history before posting.";
            }
        }
    }
    target.metadata = metadata;
    target.baseRef = metadata.baseSha;
    target.baseLabel = metadata.baseBranch;
    target.gitRef = metadata.headSha;
}
/** Required Forge subprocess capabilities. Local Git resolution is never replaceable. */
export async function resolveReviewTargetWithForge(
    projectRoot: string,
    arg: string | undefined,
    runtime: PRRuntime,
    runtimeForCwd: (cwd: string) => PRRuntime,
): Promise<ReviewTarget> {
    try {
        projectRoot = await git(projectRoot, ["rev-parse", "--show-toplevel"]);
    } catch {
        throw new Error("wld review requires a Git repository.");
    }
    if (!arg) {
        if (!(await git(projectRoot, ["status", "--porcelain"]))) {
            throw new Error("There are no uncommitted changes to review.");
        }
        return {
            mode: "uncommitted",
            projectRoot,
            gitRef: "Working tree",
            baseLabel: "HEAD",
            baseRef: "HEAD",
            computeDiff: async (cwd = projectRoot) =>
                await getReviewDiff(cwd, { baseRef: "HEAD", head: { kind: "worktree" } }),
        };
    }
    if (/^https?:\/\//.test(arg)) {
        const ref = parsePRUrl(arg);
        if (
            !ref ||
            !/^https?:\/\/[^/]+\/(?:[^/]+\/[^/]+\/pull\/\d+|.+\/-\/merge_requests\/\d+)(?:\/(?:files|commits|diffs))?\/?$/.test(
                arg,
            )
        )
            throw new Error("Expected a PR or MR URL.");
        const project = ref.platform === "github" ? `${ref.owner}/${ref.repo}` : ref.projectPath;
        const remote = (await git(projectRoot, ["remote", "-v"]))
            .split("\n")
            .map((line) => line.split(/\s+/))
            .find(
                (entry) =>
                    parseRemoteHost(entry[1])?.toLowerCase() === ref.host.toLowerCase() &&
                    parseRemoteUrl(entry[1])?.toLowerCase() === project.toLowerCase(),
            )?.[0];
        if (!remote) {
            throw new Error(
                "The PR repository must match a remote of this checkout. RunWield does not clone repositories.",
            );
        }
        const cli = ref.platform === "github" ? "gh" : "glab";
        try {
            await checkAuth(runtime, ref);
        } catch {
            throw new Error(`PR review requires ${cli} installed and signed in. Run ${cli} auth login.`);
        }
        const { metadata } = await fetchPR(runtime, ref);
        const target: PRReviewTarget = {
            mode: "pr",
            projectRoot,
            ref,
            metadata,
            remote,
            runtime,
            runtimeForCwd,
            baseRef: metadata.baseSha,
            baseLabel: metadata.baseBranch,
            gitRef: metadata.headSha,
            computeDiff: async (cwd = target.worktree?.path || projectRoot) =>
                await getReviewDiff(cwd, {
                    baseRef: target.baseRef,
                    head: target.worktree ? { kind: "worktree" } : { kind: "ref", ref: target.metadata.headSha },
                }),
        };
        await refreshPRTarget(target);
        const context = await fetchPRContext(runtime, ref);
        target.reviewContext = `${metadata.title}\n\n${context.body}`;
        return target;
    }
    if (arg.includes("://")) throw new Error("Expected a PR or MR URL.");
    try {
        await git(projectRoot, ["rev-parse", "--verify", `refs/heads/${arg}^{commit}`]);
    } catch {
        throw new Error(`Branch does not exist: ${arg}`);
    }
    const current = await git(projectRoot, ["symbolic-ref", "--short", "HEAD"]).catch(() => "HEAD");
    if (current === arg) throw new Error("This is the current branch. Use wld review to review uncommitted changes.");
    const baseRef = await git(projectRoot, ["rev-parse", "HEAD"]);
    const target: BranchReviewTarget = {
        mode: "branch",
        projectRoot,
        branch: arg,
        gitRef: `refs/heads/${arg}`,
        baseLabel: current,
        baseRef,
        computeDiff: async (cwd = target.worktree?.path || projectRoot) =>
            await getReviewDiff(cwd, {
                baseRef,
                head: target.worktree ? { kind: "worktree" } : { kind: "ref", ref: `refs/heads/${arg}` },
            }),
    };
    return target;
}

/** Resolve local review sources using the system Forge subprocess capability. */
export function resolveReviewTarget(projectRoot: string, arg?: string): Promise<ReviewTarget> {
    return resolveReviewTargetWithForge(projectRoot, arg, createPRRuntime(projectRoot), createPRRuntime);
}
