import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { removeWorktreeGitArtifacts, resolveWorktreeParent } from "../worktree.js";
import type { ReviewTarget } from "./review-target.ts";
import { git } from "./git.ts";
export interface ReviewWorktree {
    path: string;
    branch: string;
    created: boolean;
    projectRoot: string;
    setupReady?: boolean;
    initialHead?: string;
}
export async function ensureReviewWorktree(target: ReviewTarget): Promise<ReviewWorktree> {
    if (target.worktree && target.worktree.setupReady !== false) return target.worktree;
    if (
        target.worktree &&
        ((await git(target.worktree.path, ["status", "--porcelain"])) ||
            (await git(target.worktree.path, ["rev-parse", "HEAD"])) !== target.worktree.initialHead)
    ) {
        throw new Error(`Review checkout setup is incomplete. Local work is preserved at ${target.worktree.path}.`);
    }
    if (target.mode === "uncommitted") {
        return (target.worktree = {
            path: target.projectRoot,
            branch: await git(target.projectRoot, ["symbolic-ref", "--short", "HEAD"]).catch(() => "HEAD"),
            created: false,
            projectRoot: target.projectRoot,
        });
    }
    if (target.mode === "branch") {
        const entries = (await git(target.projectRoot, ["worktree", "list", "--porcelain"])).split("\n\n");
        const existing = entries.find((entry) => entry.split("\n").includes(`branch refs/heads/${target.branch}`));
        if (existing) {
            return (target.worktree = {
                path: existing.split("\n")[0].slice(9),
                branch: target.branch,
                created: false,
                projectRoot: target.projectRoot,
            });
        }
    }
    const parent = join(dirname(resolveWorktreeParent(target.projectRoot, undefined)), "review-worktrees");
    await mkdir(parent, { recursive: true });
    const path = target.worktree?.path || join(parent, crypto.randomUUID());
    if (!target.worktree) {
        await git(target.projectRoot, [
            "worktree",
            "add",
            ...(target.mode === "pr" ? ["--detach"] : []),
            path,
            target.mode === "pr" ? target.metadata.headSha : target.branch,
        ]);
    }
    const worktree: ReviewWorktree = target.worktree || {
        path,
        branch: "HEAD",
        created: true,
        projectRoot: target.projectRoot,
        setupReady: false,
        initialHead: await git(path, ["rev-parse", "HEAD"]),
    };
    target.worktree = worktree; // Preserve it for cleanup even if checkout fails.
    try {
        if (target.mode === "pr") {
            const runtime = target.runtimeForCwd(path);
            const cli = target.ref.platform === "github" ? "gh" : "glab";
            const number = target.ref.platform === "github" ? target.ref.number : target.ref.iid;
            const project =
                target.ref.platform === "github"
                    ? `${target.ref.host}/${target.ref.owner}/${target.ref.repo}`
                    : `${target.ref.host}/${target.ref.projectPath}`;
            const args = [
                target.ref.platform === "github" ? "pr" : "mr",
                "checkout",
                String(number),
                "--repo",
                project,
            ];
            let result = await runtime.runCommand(cli, args);
            if (result.exitCode) {
                result = await runtime.runCommand(cli, [
                    ...args,
                    "--branch",
                    `wld-review/${target.ref.platform}-${number}-${crypto.randomUUID().slice(0, 8)}`,
                ]);
            }
            if (result.exitCode) throw new Error(result.stderr);
        }
        worktree.branch = await git(path, ["symbolic-ref", "--short", "HEAD"]).catch(() => "HEAD");
        worktree.setupReady = true;
        return worktree;
    } catch (error) {
        if ((await settleReviewWorktree(worktree)).removed) target.worktree = undefined;
        throw error;
    }
}
export async function settleReviewWorktree(worktree?: ReviewWorktree) {
    if (!worktree) return { removed: false, message: "No review worktree was created." };
    const head = await git(worktree.path, ["rev-parse", "HEAD"]);
    const upstream = await git(worktree.path, ["rev-parse", "@{u}"]).catch(() => "");
    const dirty = await git(worktree.path, ["status", "--porcelain"]);
    if (
        worktree.created &&
        !dirty &&
        (upstream === head || (worktree.setupReady === false && head === worktree.initialHead))
    ) {
        await removeWorktreeGitArtifacts({ projectRoot: worktree.projectRoot, path: worktree.path });
        return { removed: true, message: "Review worktree removed." };
    }
    return {
        removed: false,
        path: worktree.path,
        branch: worktree.branch,
        message: `Review worktree kept: ${worktree.path} (${worktree.branch})`,
    };
}
