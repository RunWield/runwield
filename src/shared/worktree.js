/**
 * @module shared/worktree
 * Git worktree helpers for isolated plan execution.
 */

import { basename, dirname, join } from "@std/path";
import { getHomeDir, RUNWIELD_DIR_NAME, WORKTREE_BRANCH_PREFIX } from "../constants.js";
import { encodeCwdForSessionDir } from "./project-directory-key.ts";
import {
    captureWorktreeProjectContext,
    isTransferredProjectContext,
    materializeWorktreeProjectContext,
    PROJECT_CONTEXT_PATHS,
    recordedProjectContextPaths,
} from "./worktree-project-context.ts";
import { assertGitRepository, GitRepositoryRequiredError } from "./git.ts";
import { getWorkflowDiff } from "./workflow/git-snapshot.ts";
import { addEntry, listEntries, pruneStaleEntries, removeEntry } from "./worktree-registry.js";
import { enterProjectRuntime, resolveProjectRoot, resolveProjectRuntimeLayout } from "./project-runtime-layout.ts";
import {
    isRunWieldOwnedGitignoreChange,
    isRunWieldOwnedRuntimePath,
    RUNWIELD_OWNED_RUNTIME_PATHS,
} from "./runwield-owned-paths.ts";
import {
    assertNoRuntimePathsInNewHistory,
    assertNoTrackedOrIndexedRuntimePaths,
    gitStatusPaths,
    stageGitChangesExcludingRuntime,
} from "./git-runtime-safety.ts";

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function runGit(cwd, args) {
    const result = await runGitResult(cwd, args);
    if (result.code !== 0) {
        const output = result.stderr || result.stdout;
        if (output.includes("not a git repository") || output.includes("not a git command")) {
            throw new GitRepositoryRequiredError(
                `Git operation requires a Git repository: git ${args.join(" ")}. ${output}`.trim(),
                { cwd, operation: `git ${args.join(" ")}`, state: "not_git" },
            );
        }
        throw new Error(`git ${args.join(" ")} failed: ${output}`.trim());
    }
    return result.stdout;
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
async function runGitResult(cwd, args) {
    try {
        const command = new Deno.Command("git", { args, cwd, stdout: "piped", stderr: "piped" });
        const { code, stdout, stderr } = await command.output();
        const decoder = new TextDecoder();
        return { code, stdout: decoder.decode(stdout), stderr: decoder.decode(stderr) };
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            return { code: 127, stdout: "", stderr: "The git executable was not found." };
        }
        throw error;
    }
}

/** @param {string} value */
export function slugify(value) {
    const slug = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return slug.slice(0, 48) || "plan";
}

/** @param {string} path */
async function pathExists(path) {
    try {
        await Deno.stat(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * @param {string} projectRoot
 * @returns {Promise<boolean>}
 */
async function isMergeInProgress(projectRoot) {
    const mergeHeadPath = (await runGit(projectRoot, ["rev-parse", "--git-path", "MERGE_HEAD"])).trim();
    const absoluteMergeHeadPath = mergeHeadPath.startsWith("/") ? mergeHeadPath : join(projectRoot, mergeHeadPath);
    return await pathExists(absoluteMergeHeadPath);
}

/**
 * @param {string} statusText
 * @returns {string[]}
 */
function parseStatusPaths(statusText) {
    return statusText.split("\n").filter(Boolean).map((line) => line.slice(3).trim()).filter(Boolean);
}

/**
 * @param {string} diffText
 * @returns {string[]}
 */
function parseNameOnlyPaths(diffText) {
    return diffText.trim().split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * @param {string} output
 * @returns {string[]}
 */
function parseNulPaths(output) {
    return output.split("\0").filter((path) => path.length > 0);
}

/**
 * @param {string} dirtyPath
 * @param {Set<string>} allowedPaths
 */
function isAllowedDirtyPath(dirtyPath, allowedPaths) {
    if (allowedPaths.has(dirtyPath)) return true;
    for (const allowedPath of allowedPaths) {
        const normalizedAllowed = allowedPath.endsWith("/") ? allowedPath : `${allowedPath}/`;
        const normalizedDirty = dirtyPath.endsWith("/") ? dirtyPath : `${dirtyPath}/`;
        if (dirtyPath.startsWith(normalizedAllowed)) return true;
        if (normalizedAllowed.startsWith(normalizedDirty)) return true;
    }
    return false;
}

/**
 * @param {string} dirtyPath
 * @param {Set<string>} branchChangedPaths
 */
function overlapsBranchChangedPath(dirtyPath, branchChangedPaths) {
    return isAllowedDirtyPath(dirtyPath, branchChangedPaths);
}

/**
 * @param {string[]} paths
 * @param {Set<string>} allowed
 * @returns {string[]}
 */
function filterUserDirtyPaths(paths, allowed = new Set()) {
    return paths.filter((path) => !isRunWieldOwnedRuntimePath(path) && !isAllowedDirtyPath(path, allowed));
}

/** @param {string} path */
function isExecutionPreparationPath(path) {
    return path === "docs/plans" || path.startsWith("docs/plans/") ||
        isRunWieldOwnedRuntimePath(path);
}

/**
 * Preparation owns only the deterministic ignore-rule delta. Check the index as
 * well as the working file so staging cannot silently adopt a user's partial edit.
 * @param {string} root
 * @param {string} path
 * @param {string} baseRef
 * @param {string} [targetRef]
 */
async function isPreparationChange(root, path, baseRef, targetRef) {
    if (isExecutionPreparationPath(path)) return true;
    if (path !== ".gitignore") return await isTransferredProjectContext(root, path, targetRef);
    const before = await runGitResult(root, ["show", `${baseRef}:.gitignore`]);
    if (targetRef) {
        const after = await runGitResult(root, ["show", `${targetRef}:.gitignore`]);
        return after.code === 0 && isRunWieldOwnedGitignoreChange(before.stdout, after.stdout);
    }
    try {
        const stat = await Deno.lstat(join(root, path));
        if (!stat.isFile || stat.isSymlink) return false;
        const after = await Deno.readTextFile(join(root, path));
        const staged = await runGitResult(root, ["show", ":.gitignore"]);
        return isRunWieldOwnedGitignoreChange(before.stdout, after) &&
            (staged.code === 0 ? isRunWieldOwnedGitignoreChange(before.stdout, staged.stdout) : before.code !== 0);
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
    }
}

/**
 * Detect evidence that an execution Agent already changed a reusable worktree.
 * Plan materialization, project context, the owned ignore block, and runtime files are setup—not
 * implementation evidence.
 *
 * @param {Object} opts
 * @param {string} opts.worktreePath
 * @param {string} opts.baseRef
 * @param {string} [opts.targetRef]
 * @param {boolean} [opts.includeWorkingTree]
 * @returns {Promise<boolean>}
 */
export async function hasExecutionChangesSince({
    worktreePath,
    baseRef,
    targetRef = "HEAD",
    includeWorkingTree = false,
}) {
    const committed = parseNameOnlyPaths(
        await runGit(worktreePath, ["diff", "--name-only", `${baseRef}..${targetRef}`]),
    );
    const dirty = includeWorkingTree
        ? parseStatusPaths(await runGit(worktreePath, ["status", "--porcelain", "--untracked-files=all"]))
        : [];
    const checks = [{ paths: committed, ref: targetRef }, { paths: dirty, ref: undefined }];
    for (const { paths, ref } of checks) {
        for (const path of paths) {
            if (!await isPreparationChange(worktreePath, path, ref ? baseRef : "HEAD", ref)) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Detect a previously completed preparation checkpoint without mistaking it for
 * Agent implementation. The original attempt base must remain an ancestor, and
 * every committed path since it must be owned preparation state.
 *
 * @param {Object} opts
 * @param {string} opts.worktreePath
 * @param {string} opts.baseRef
 * @param {string} [opts.targetRef]
 * @returns {Promise<boolean>}
 */
export async function hasOnlyExecutionPreparationChangesSince({
    worktreePath,
    baseRef,
    targetRef = "HEAD",
}) {
    const baseIsAncestor = await runGitResult(worktreePath, ["merge-base", "--is-ancestor", baseRef, targetRef]);
    if (baseIsAncestor.code !== 0) return false;
    const committed = parseNameOnlyPaths(
        await runGit(worktreePath, ["diff", "--name-only", `${baseRef}..${targetRef}`]),
    );
    for (const path of committed) {
        if (!await isPreparationChange(worktreePath, path, baseRef, targetRef)) {
            return false;
        }
    }
    return committed.length > 0;
}

/**
 * @param {string} cwd
 * @param {string[]} paths
 */
async function restoreExistingPathsFromHead(cwd, paths) {
    const existingPaths = [];
    for (const path of paths) {
        const existsInHead = await runGitResult(cwd, ["cat-file", "-e", `HEAD:${path}`]);
        if (existsInHead.code === 0) existingPaths.push(path);
    }
    if (existingPaths.length > 0) {
        await runGit(cwd, ["restore", "--worktree", "--source=HEAD", "--", ...existingPaths]);
    }
}

/**
 * Stage all changed files except RunWield-owned runtime files. Tracked updates
 * and new files are staged separately so an ignored working copy left behind
 * by an index removal is not accidentally passed back to `git add`.
 *
 * @param {string} worktreePath
 */
async function stageDirtyPathsExceptOwnedRuntime(worktreePath) {
    await stageGitChangesExcludingRuntime(worktreePath);
}

/**
 * @param {string} porcelainText
 * @returns {{ path: string, branchRef: string }[]}
 */
function parseWorktreeRecords(porcelainText) {
    return porcelainText.trim().split("\n\n").filter(Boolean).map((record) => {
        const lines = record.split("\n");
        const worktreePath = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
        const branchRef = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
        return { path: worktreePath || "", branchRef: branchRef || "" };
    });
}

/**
 * @param {string} porcelainText
 * @param {string} branch
 * @returns {string | null}
 */
function findWorktreePathForBranch(porcelainText, branch) {
    const record = parseWorktreeRecords(porcelainText).find((entry) => entry.branchRef === `refs/heads/${branch}`);
    return record?.path || null;
}

/**
 * @param {string} projectRoot
 * @param {string} branch
 */
async function assertLocalBranchExists(projectRoot, branch) {
    await runGit(projectRoot, ["rev-parse", "--verify", `refs/heads/${branch}`]);
}

/**
 * @typedef {Object} PreparedTargetBranchRef
 * @property {string} baseRef
 * @property {string} baseBranch
 */

/**
 * @param {string} projectRoot
 * @param {string} ref
 * @returns {Promise<boolean>}
 */
async function gitRefExists(projectRoot, ref) {
    const result = await runGitResult(projectRoot, ["rev-parse", "--verify", "--quiet", ref]);
    return result.code === 0;
}

/**
 * @param {string} projectRoot
 * @param {string} branch
 */
async function assertValidTargetBranchName(projectRoot, branch) {
    if (!branch || branch === "HEAD") throw new Error("Target branch must be a branch name, not HEAD.");
    if (branch.startsWith("refs/")) throw new Error(`Target branch must not be a full ref: ${branch}`);
    if (branch.startsWith(WORKTREE_BRANCH_PREFIX)) {
        throw new Error(`Target branch cannot use reserved execution prefix: ${WORKTREE_BRANCH_PREFIX}`);
    }
    const result = await runGitResult(projectRoot, ["check-ref-format", "--branch", branch]);
    if (result.code !== 0) throw new Error(`Invalid target branch name: ${branch}`);
}

/**
 * @param {string} projectRoot
 * @param {string} branch
 * @returns {Promise<boolean>}
 */
async function remoteBranchExists(projectRoot, branch) {
    const remoteResult = await runGitResult(projectRoot, ["remote", "get-url", "origin"]);
    if (remoteResult.code !== 0) return false;

    const fetchResult = await runGitResult(
        projectRoot,
        ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    );
    if (fetchResult.code !== 0) {
        const message = fetchResult.stderr || fetchResult.stdout;
        if (message.includes("couldn't find remote ref")) {
            return false;
        }
        throw new Error(`Could not check remote target branch origin/${branch}: ${message}`.trim());
    }
    return await gitRefExists(projectRoot, `refs/remotes/origin/${branch}`);
}

/**
 * @param {string} projectRoot
 * @param {string} branch
 * @returns {Promise<PreparedTargetBranchRef>}
 */
async function createLocalBranchFromDefault(projectRoot, branch) {
    const defaultBranch = await resolveRepositoryDefaultBranch(projectRoot);
    const defaultRef = await remoteBranchExists(projectRoot, defaultBranch)
        ? `refs/remotes/origin/${defaultBranch}`
        : `refs/heads/${defaultBranch}`;
    await runGit(projectRoot, ["branch", branch, defaultRef]);
    return { baseRef: `refs/heads/${branch}`, baseBranch: branch };
}

/** Resolve the repository default, never the current checkout.
 * @param {string} projectRoot
 * @returns {Promise<string>}
 */
export async function resolveRepositoryDefaultBranch(projectRoot) {
    await assertGitRepository(projectRoot, "Resolving the repository default branch");
    const remote = await runGitResult(projectRoot, ["remote", "get-url", "origin"]);
    if (remote.code === 0) {
        const head = await runGitResult(projectRoot, ["ls-remote", "--symref", "origin", "HEAD"]);
        const branch = head.code === 0 ? head.stdout.match(/^ref: refs\/heads\/([^\t\n]+)\tHEAD/m)?.[1] : undefined;
        for (const candidate of [...new Set([branch, "main", "master"].filter(Boolean))]) {
            if (candidate && await remoteBranchExists(projectRoot, candidate)) return candidate;
        }
    }
    const configured = await runGitResult(projectRoot, ["config", "--get", "init.defaultBranch"]);
    for (
        const branch of [
            ...new Set([configured.code === 0 ? configured.stdout.trim() : "", "main", "master"].filter(Boolean)),
        ]
    ) {
        if (await gitRefExists(projectRoot, `refs/heads/${branch}`)) return branch;
    }
    throw new Error("Repository default branch does not exist (main or master).");
}

/**
 * Resolve the local branch name that a plan-authored target would record, without creating or fetching branches.
 *
 * @param {string} projectRoot
 * @param {string} branch
 * @returns {Promise<string>}
 */
export async function resolveTargetBranchName(projectRoot, branch) {
    await assertGitRepository(projectRoot, "Resolving an execution target branch");
    const target = typeof branch === "string" ? branch.trim() : "";
    await assertValidTargetBranchName(projectRoot, target);
    if (await gitRefExists(projectRoot, `refs/heads/${target}`)) return target;

    if (target.startsWith("origin/")) {
        const localBranch = target.slice("origin/".length);
        await assertValidTargetBranchName(projectRoot, localBranch);
        return localBranch;
    }

    return target;
}

/**
 * Resolve the branch checked out in the primary checkout. A detached checkout
 * has no implicit merge target, so it returns undefined.
 *
 * @param {string} projectRoot
 * @returns {Promise<string | undefined>}
 */
export async function resolveCurrentCheckoutBranch(projectRoot) {
    await assertGitRepository(projectRoot, "Resolving the current checkout branch");
    const branch = (await runGit(projectRoot, ["branch", "--show-current"])).trim();
    return branch || undefined;
}

/**
 * Prepare an unambiguous local branch ref for a plan-authored execution target.
 *
 * @param {string} projectRoot
 * @param {string} branch
 * @returns {Promise<PreparedTargetBranchRef>}
 */
export async function prepareTargetBranchRef(projectRoot, branch) {
    await assertGitRepository(projectRoot, "Preparing an execution target branch");
    const target = await resolveTargetBranchName(projectRoot, branch);
    if (await remoteBranchExists(projectRoot, target)) {
        return { baseRef: `refs/remotes/origin/${target}`, baseBranch: target };
    }

    if (typeof branch === "string" && branch.trim().startsWith("origin/")) {
        throw new Error(`Remote target branch does not exist: origin/${target}`);
    }

    if (await gitRefExists(projectRoot, `refs/heads/${target}`)) {
        return { baseRef: `refs/heads/${target}`, baseBranch: target };
    }

    return await createLocalBranchFromDefault(projectRoot, target);
}

/**
 * Ensure a local delivery branch exists without changing a checkout.
 * An existing local branch wins; a remote-only branch is adopted before considering the source.
 *
 * @param {string} projectRoot
 * @param {string} branch
 * @param {string} [sourceBranch]
 * @returns {Promise<{ branch: string, created: boolean }>}
 */
export async function ensureTargetBranchRef(projectRoot, branch, sourceBranch) {
    const target = await resolveTargetBranchName(projectRoot, branch);
    if (await gitRefExists(projectRoot, `refs/heads/${target}`)) return { branch: target, created: false };
    let sourceRef;
    if (await remoteBranchExists(projectRoot, target)) {
        sourceRef = `refs/remotes/origin/${target}`;
    } else if (sourceBranch) {
        const source = await resolveTargetBranchName(projectRoot, sourceBranch);
        sourceRef = await remoteBranchExists(projectRoot, source)
            ? `refs/remotes/origin/${source}`
            : !sourceBranch.startsWith("origin/") && await gitRefExists(projectRoot, `refs/heads/${source}`)
            ? `refs/heads/${source}`
            : undefined;
        if (!sourceRef) throw new Error(`Source branch does not exist: ${sourceBranch}`);
    } else {
        await createLocalBranchFromDefault(projectRoot, target);
        return { branch: target, created: true };
    }
    await runGit(projectRoot, ["branch", target, sourceRef]);
    return { branch: target, created: true };
}

/**
 * @param {string} projectRoot
 * @param {string} branch
 * @returns {Promise<string | null>}
 */
async function findCheckoutPathForBranch(projectRoot, branch) {
    const worktreeList = await runGit(projectRoot, ["worktree", "list", "--porcelain"]);
    return findWorktreePathForBranch(worktreeList, branch);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {Promise<boolean>}
 */
async function isSameFilesystemPath(a, b) {
    return await canonicalWorktreePath(a) === await canonicalWorktreePath(b);
}

/** Resolve symlinked parents even when a recorded checkout has already disappeared. @param {string} path @returns {Promise<string>} */
async function canonicalWorktreePath(path) {
    try {
        return await Deno.realPath(path);
    } catch {
        const parent = dirname(path);
        if (parent === path) return path;
        return join(await canonicalWorktreePath(parent), basename(path));
    }
}

/**
 * @typedef {Object} WorktreeCommitMessageOptions
 * @property {string} [planName]
 * @property {string} [planDescription]
 * @property {"completion"|"preparation"|"publication"} [phase]
 * @property {string} [publicationAttemptId]
 * @property {string[]} [publicationPlanPaths]
 */

/**
 * @typedef {Object} WorktreeCommitMessage
 * @property {string} subject
 * @property {string} body
 */

/** @param {unknown} value */
function normalizeCommitMessageLine(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
}

/** @param {string[]} stagedPaths */
function formatStagedPaths(stagedPaths) {
    const visiblePaths = stagedPaths.slice(0, 5);
    const remaining = stagedPaths.length - visiblePaths.length;
    return remaining > 0 ? `${visiblePaths.join(", ")} and ${remaining} more` : visiblePaths.join(", ");
}

/**
 * @param {WorktreeCommitMessageOptions & { branch: string, stagedPaths: string[] }} options
 * @returns {WorktreeCommitMessage}
 */
function buildWorktreeCommitMessage({
    planName,
    planDescription,
    phase,
    branch,
    stagedPaths,
    publicationAttemptId,
    publicationPlanPaths = [],
}) {
    const normalizedPlanName = normalizeCommitMessageLine(planName);
    const normalizedDescription = normalizeCommitMessageLine(planDescription);
    const subject = normalizedPlanName
        ? normalizeCommitMessageLine(
            phase === "preparation"
                ? `Prepare ${normalizedPlanName} execution`
                : phase === "publication"
                ? `Finalize validated artifacts for ${normalizedPlanName}`
                : `Complete ${normalizedPlanName}`,
        )
        : "Commit execution worktree updates";
    const bodyLines = [];
    if (normalizedPlanName) bodyLines.push(`- Plan: ${normalizedPlanName}`);
    if (normalizedDescription) bodyLines.push(`- Description: ${normalizedDescription}`);
    bodyLines.push(`- Branch: ${branch}`);
    bodyLines.push(`- Files: ${formatStagedPaths(stagedPaths)}`);
    if (publicationAttemptId) {
        bodyLines.push(`RunWield-Publication-Attempt: ${publicationAttemptId}`);
        for (const path of publicationPlanPaths) bodyLines.push(`RunWield-Publication-Plan-Path: ${path}`);
    }
    return { subject, body: bodyLines.join("\n") };
}

/**
 * @param {string} worktreePath
 * @param {string} branch
 * @param {WorktreeCommitMessageOptions} [messageOptions]
 */
/**
 * @param {string} worktreePath
 * @param {string} branch
 * @param {WorktreeCommitMessageOptions} [messageOptions]
 * @param {string[]} [allowedDirtyPaths]
 * @param {string} [_mergeTargetRef]
 */
async function commitDirtyWorktreeState(
    worktreePath,
    branch,
    messageOptions = {},
    allowedDirtyPaths = [],
    _mergeTargetRef = undefined,
) {
    const currentBranch = (await runGit(worktreePath, ["branch", "--show-current"])).trim();
    if (currentBranch !== branch) {
        throw new Error(`Worktree path ${worktreePath} is on ${currentBranch || "detached HEAD"}, not ${branch}`);
    }
    await assertNoTrackedOrIndexedRuntimePaths(worktreePath);
    if (allowedDirtyPaths.length > 0) {
        const allowedPathSet = new Set(allowedDirtyPaths);
        const dirtyPaths = await gitStatusPaths(worktreePath);
        const disallowedPaths = filterUserDirtyPaths(dirtyPaths, allowedPathSet);
        if (disallowedPaths.length > 0) {
            const description = messageOptions.phase === "preparation"
                ? "Execution worktree contains changes outside preparation Plan paths:"
                : "Execution worktree changed after candidate sealing outside finalized Plan paths:";
            throw new Error(
                description + "\n" +
                    disallowedPaths.map((path) => `  - ${path}`).join("\n"),
            );
        }
        const allowedPathNeedsOwnedExclusion = RUNWIELD_OWNED_RUNTIME_PATHS.some((ownedPath) =>
            isAllowedDirtyPath(ownedPath, allowedPathSet)
        );
        if (allowedPathNeedsOwnedExclusion) {
            await stageDirtyPathsExceptOwnedRuntime(worktreePath);
        } else {
            const forcedPaths = new Set();
            for (const path of await recordedProjectContextPaths(worktreePath)) {
                if (allowedPathSet.has(path) && await isTransferredProjectContext(worktreePath, path)) {
                    await runGit(worktreePath, ["add", "-f", "--", path]);
                    forcedPaths.add(path);
                }
            }
            const ordinaryPaths = allowedDirtyPaths.filter((path) => !forcedPaths.has(path));
            if (ordinaryPaths.length > 0) await runGit(worktreePath, ["add", "-A", "--", ...ordinaryPaths]);
        }
    } else {
        await stageDirtyPathsExceptOwnedRuntime(worktreePath);
    }
    await assertNoTrackedOrIndexedRuntimePaths(worktreePath);
    const stagedDiff = await runGit(worktreePath, ["diff", "--cached", "--name-only"]);
    const stagedPaths = parseNameOnlyPaths(stagedDiff);
    if (stagedPaths.length === 0) return;
    const message = buildWorktreeCommitMessage({ ...messageOptions, branch, stagedPaths });
    await runGit(worktreePath, ["commit", "-m", message.subject, "-m", message.body]);
}

/**
 * Commit only RunWield's execution-preparation files before an Agent can touch
 * the worktree. The target commit remains the attempt's immutable base; this
 * commit makes the materialized Plan and copied project context ordinary tracked Git evidence.
 *
 * @param {Object} opts
 * @param {string} opts.worktreePath
 * @param {string} opts.branch
 * @param {string} opts.baseCommit
 * @param {string} opts.planName
 * @param {string} opts.planRelativePath
 * @param {string[]} [opts.relatedPlanPaths]
 * @returns {Promise<{ preparationCommit: string }>}
 */
export async function checkpointExecutionPreparation({
    worktreePath,
    branch,
    baseCommit,
    planName,
    planRelativePath,
    relatedPlanPaths = [],
}) {
    // Planning can leave new drafts and normalized legacy Plans outside the
    // active Epic family. Use the same preparation boundary as resume detection;
    // these files are the input baseline, never post-validation exceptions.
    const dirtyPreparationPaths = [];
    for (const path of new Set([...await gitStatusPaths(worktreePath), ...PROJECT_CONTEXT_PATHS])) {
        if (
            !isRunWieldOwnedRuntimePath(path) &&
            await isPreparationChange(worktreePath, path, "HEAD")
        ) dirtyPreparationPaths.push(path);
    }
    const preparationPaths = [...new Set([planRelativePath, ...relatedPlanPaths, ...dirtyPreparationPaths])];
    const headBefore = (await runGit(worktreePath, ["rev-parse", "HEAD"])).trim();
    if (headBefore !== baseCommit) {
        const baseIsAncestor = await runGitResult(worktreePath, [
            "merge-base",
            "--is-ancestor",
            baseCommit,
            headBefore,
        ]);
        const committedPaths = baseIsAncestor.code === 0
            ? parseNameOnlyPaths(await runGit(worktreePath, ["diff", "--name-only", `${baseCommit}..${headBefore}`]))
            : [];
        const unexpectedPaths = baseIsAncestor.code === 0 ? [] : ["branch history"];
        for (const path of committedPaths) {
            if (
                !await isPreparationChange(worktreePath, path, baseCommit, headBefore)
            ) {
                unexpectedPaths.push(path);
            }
        }
        if (unexpectedPaths.length > 0) {
            throw new Error(
                `Cannot checkpoint execution preparation for ${planName}: branch ${branch} moved from ${baseCommit} to ${headBefore}.`,
            );
        }
    }
    await commitDirtyWorktreeState(
        worktreePath,
        branch,
        { planName, phase: "preparation" },
        preparationPaths,
    );
    const preparationCommit = (await runGit(worktreePath, ["rev-parse", "HEAD"])).trim();
    if (preparationCommit === baseCommit) {
        throw new Error(`Execution preparation for ${planName} did not create its required Plan commit.`);
    }
    const committedPlan = await runGitResult(worktreePath, [
        "cat-file",
        "-e",
        `${preparationCommit}:${planRelativePath}`,
    ]);
    if (committedPlan.code !== 0) {
        throw new Error(`Execution preparation commit ${preparationCommit} does not contain ${planRelativePath}.`);
    }
    const remainingDirtyPaths = (await gitStatusPaths(worktreePath)).filter((path) =>
        !isRunWieldOwnedRuntimePath(path)
    );
    if (remainingDirtyPaths.length > 0) {
        throw new Error(`Execution worktree is dirty after preparation commit:\n${remainingDirtyPaths.join("\n")}`);
    }
    return { preparationCommit };
}

/**
 * Pre-merge proof: nothing but Plan metadata changed since the candidate was sealed.
 *
 * The paired postcondition is `verifyPostMergeCandidatePublished` in validation. This
 * one runs *before* the target ref moves and answers "is the thing we validated still
 * the thing we are about to publish?"; that one runs after and answers "did it land?".
 *
 * Single implementation on purpose. This check previously existed twice with different
 * rules — once here inside the merge, keyed on the staged Plan paths, and once in
 * validation, keyed on `docs/plans/<planName>.md` alone. The narrower rule was wrong for
 * Epic publication, where the parent Epic and siblings are staged too, so the staged
 * path set is the correct authority and prefix matching is kept.
 *
 * @param {Object} opts
 * @param {string} opts.worktreePath Execution worktree to inspect.
 * @param {string} opts.sealedExecutionCommit Commit the validated candidate was sealed at.
 * @param {string[]} opts.allowedPlanPaths Plan paths staging is permitted to have touched.
 * @returns {Promise<void>}
 */
export async function assertPreMergeCandidateUnchanged({ worktreePath, sealedExecutionCommit, allowedPlanPaths }) {
    const allowed = new Set(allowedPlanPaths);
    const committed = parseNameOnlyPaths(
        await runGit(worktreePath, ["diff", "--name-only", `${sealedExecutionCommit}..HEAD`]),
    );
    const dirty = await gitStatusPaths(worktreePath);
    const changed = [...new Set([...committed, ...dirty])];
    const disallowed = filterUserDirtyPaths(changed, allowed);
    if (disallowed.length > 0) {
        throw new Error(
            "Execution worktree changed after the validated candidate was sealed. " +
                "Run Workflow Validation again before publishing these files: " +
                disallowed.join(", "),
        );
    }
}

/**
 * @param {{ worktreePath: string, branch: string, planName?: string, planDescription?: string, mergeTargetRef?: string, publicationAttemptId?: string, publicationPlanPaths?: string[] }} opts
 * @returns {Promise<{ executionCommit: string }>}
 */
export async function checkpointExecutionWorktree({
    worktreePath,
    branch,
    planName,
    planDescription,
    mergeTargetRef,
    publicationAttemptId,
    publicationPlanPaths,
}) {
    await commitDirtyWorktreeState(
        worktreePath,
        branch,
        {
            planName,
            planDescription,
            ...(publicationAttemptId ? { phase: "publication", publicationAttemptId, publicationPlanPaths } : {}),
        },
        [],
        mergeTargetRef,
    );
    const remainingDirtyPaths = (await gitStatusPaths(worktreePath)).filter((path) =>
        !isRunWieldOwnedRuntimePath(path)
    );
    if (remainingDirtyPaths.length > 0) {
        throw new Error(`Execution worktree is dirty after checkpoint commit:\n${remainingDirtyPaths.join("\n")}`);
    }
    const executionCommit = (await runGit(worktreePath, ["rev-parse", "HEAD"])).trim();
    return { executionCommit };
}

/**
 * @param {string} projectRoot
 * @param {string} branch
 */
export async function getBranchHead(projectRoot, branch) {
    return (await runGit(projectRoot, ["rev-parse", `refs/heads/${branch}`])).trim();
}

/**
 * @param {string} projectRoot
 * @param {string} commit
 * @param {string} branch
 * @returns {Promise<boolean>}
 */
export async function isCommitAncestorOfBranch(projectRoot, commit, branch) {
    const result = await runGitResult(projectRoot, ["merge-base", "--is-ancestor", commit, `refs/heads/${branch}`]);
    return result.code === 0;
}

/**
 * A compare-and-swap proves only that the target still points where the caller
 * last saw it. Git will still replace that commit with an unrelated commit.
 * Prove reachability separately at the final publication boundary.
 *
 * @param {string} projectRoot
 * @param {string} targetCommit
 * @param {string} candidateCommit
 * @param {string} targetBranch
 * @returns {Promise<void>}
 */
export async function assertPublicationCandidateContainsTarget(
    projectRoot,
    targetCommit,
    candidateCommit,
    targetBranch,
) {
    const result = await runGitResult(projectRoot, [
        "merge-base",
        "--is-ancestor",
        targetCommit,
        candidateCommit,
    ]);
    if (result.code === 0) return;
    throw attachMergeRepairDetails(
        new Error(`Publication candidate would discard commits already on ${targetBranch}. Publication was stopped.`),
        { mergeFailureKind: "target_history_rewrite" },
    );
}

/**
 * @param {string} projectRoot
 * @param {string | undefined} worktreeRoot
 * @returns {string}
 */
export function resolveWorktreeParent(projectRoot, worktreeRoot) {
    if (worktreeRoot) return worktreeRoot;
    const homeDir = getHomeDir();
    if (homeDir) return join(homeDir, RUNWIELD_DIR_NAME, "worktrees", encodeCwdForSessionDir(projectRoot));
    return resolveProjectRuntimeLayout(resolveProjectRoot(projectRoot)).primary.fallbackWorktreesRoot;
}

/**
 * Resolve creation inputs before an existing attempt is discarded.
 * @param {{ projectRoot: string, planName: string, planId?: string, baseRef: string }} options
 * @returns {Promise<string>}
 */
export async function validateWorktreeRecreation({ projectRoot, planName, planId, baseRef }) {
    await assertGitRepository(projectRoot, "Creating an execution worktree");
    if (!planId?.trim()) throw new Error(`Creating an execution worktree for ${planName} requires a stable planId.`);
    return (await runGit(projectRoot, ["rev-parse", "--verify", `${baseRef}^{commit}`])).trim();
}

/**
 * Create only the Git worktree/branch artifacts for an execution attempt. The
 * caller must settle the returned proof into the registry in the same semantic
 * transition that records Plan lifecycle metadata.
 *
 * @param {{ projectRoot: string, planName: string, planId: string, baseRef?: string, baseBranch?: string, worktreeRoot?: string, attemptId?: string }} opts
 * @returns {Promise<import('./worktree-registry.js').WorktreeRegistryEntry>}
 */
export async function createWorktreeGitArtifacts(
    { projectRoot, planName, planId, baseRef = "HEAD", baseBranch, worktreeRoot, attemptId },
) {
    await assertGitRepository(projectRoot, "Creating an execution worktree");
    if (typeof planId !== "string" || !planId) {
        throw new Error(`Creating an execution worktree for ${planName} requires a stable planId.`);
    }
    const id = attemptId || crypto.randomUUID().slice(0, 8);
    const slug = slugify(planName);
    const branch = `${WORKTREE_BRANCH_PREFIX}${slug}-${id}`;
    const repoName = basename(projectRoot);
    if (!worktreeRoot && !getHomeDir()) await enterProjectRuntime(projectRoot);
    const parent = resolveWorktreeParent(projectRoot, worktreeRoot);
    const path = join(parent, `${repoName}-${slug}-${id}`);
    const now = new Date().toISOString();
    const resolvedBaseBranch = baseBranch || await resolveCurrentCheckoutBranch(projectRoot) || "HEAD";
    const baseCommit = (await runGit(projectRoot, ["rev-parse", baseRef])).trim();
    const baseTree = (await runGit(projectRoot, ["rev-parse", `${baseCommit}^{tree}`])).trim();

    const projectContext = await captureWorktreeProjectContext(projectRoot, baseCommit);
    await Deno.mkdir(parent, { recursive: true });
    await runGit(projectRoot, ["worktree", "add", "-b", branch, path, baseCommit]);
    try {
        await materializeWorktreeProjectContext(path, projectContext);
    } catch (error) {
        await runGit(projectRoot, ["worktree", "remove", "--force", path]);
        await runGit(projectRoot, ["branch", "-D", branch]);
        throw error;
    }
    if (await pathExists(join(path, ".gitmodules"))) {
        await runGit(path, ["submodule", "update", "--init", "--recursive"]);
    }

    return {
        id,
        planName,
        planId,
        baseBranch: resolvedBaseBranch,
        baseRef,
        baseCommit,
        baseTree,
        branch,
        path,
        status: "active",
        createdAt: now,
        updatedAt: now,
    };
}

/**
 * Settle a previously-created Git execution worktree into the durable registry.
 * @param {string} projectRoot
 * @param {import('./worktree-registry.js').WorktreeRegistryEntry} entry
 */
export async function settleWorktreeAttempt(projectRoot, entry) {
    try {
        await addEntry(projectRoot, entry);
    } catch (error) {
        // The Git artifacts already exist at this point. Reporting only the registry
        // error would leave a real worktree on a real branch with nothing naming it, so
        // say where it is: recovery needs the path and branch, not just the cause.
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Execution worktree was created but registry settlement failed for attempt ${entry.id}; ` +
                `inspect ${entry.path} on branch ${entry.branch} before removing it: ${message}`,
        );
    }
    return entry;
}

/**
 * @param {{ projectRoot: string, path: string, branch?: string, baseTree?: string }} opts
 */
export async function getWorktreeStatus({ path, branch, baseTree }) {
    if (!await pathExists(path)) {
        return { exists: false, clean: false, statusText: "missing", diff: "" };
    }
    await assertGitRepository(path, "Inspecting an execution worktree");
    const statusText = await runGit(path, ["status", "--porcelain"]);
    const clean = statusText.trim() === "";
    let currentBranch = "";
    try {
        currentBranch = (await runGit(path, ["branch", "--show-current"])).trim();
    } catch {
        currentBranch = "";
    }
    let diff = "";
    if (baseTree) {
        try {
            diff = await getWorkflowDiff(path, baseTree);
        } catch {
            diff = await runGit(path, ["diff"]);
        }
    } else {
        diff = await getWorkflowDiff(path, undefined);
    }
    return {
        exists: true,
        clean,
        branch: currentBranch,
        expectedBranch: branch,
        statusText,
        diff,
    };
}

/**
 * @typedef {Error & { repairCwd?: string, mergeWorktreePath?: string, mergeFailureKind?: string, blockingPaths?: string[] }} MergeRepairError
 */

/**
 * @param {unknown} error
 * @param {{ repairCwd?: string, mergeWorktreePath?: string, mergeFailureKind?: string, blockingPaths?: string[] }} details
 * @returns {MergeRepairError}
 */
function attachMergeRepairDetails(error, details) {
    const mergeError = /** @type {MergeRepairError} */ (error instanceof Error ? error : new Error(String(error)));
    if (details.repairCwd) mergeError.repairCwd = details.repairCwd;
    if (details.mergeWorktreePath) mergeError.mergeWorktreePath = details.mergeWorktreePath;
    if (details.mergeFailureKind) mergeError.mergeFailureKind = details.mergeFailureKind;
    if (details.blockingPaths?.length) mergeError.blockingPaths = details.blockingPaths;
    return mergeError;
}

/**
 * @param {string} cwd
 * @param {string} branch
 * @param {string[]} preservePlanPaths
 * @returns {Promise<string[]>}
 */
async function restorePreservedPlanConflictPaths(cwd, branch, preservePlanPaths) {
    if (preservePlanPaths.length === 0 || !await isMergeInProgress(cwd)) return [];
    const preserved = new Set(preservePlanPaths.map((path) => path.replaceAll("\\", "/")));
    const unresolvedPaths = parseNameOnlyPaths(await runGit(cwd, ["diff", "--name-only", "--diff-filter=U"]));
    const preservedUnresolvedPaths = unresolvedPaths.filter((path) => preserved.has(path.replaceAll("\\", "/")));
    if (preservedUnresolvedPaths.length === 0) return [];

    await runGit(cwd, [
        "restore",
        "--staged",
        "--worktree",
        `--source=${branch}`,
        "--",
        ...preservedUnresolvedPaths,
    ]);
    await runGit(cwd, ["add", "--", ...preservedUnresolvedPaths]);
    return preservedUnresolvedPaths;
}

/**
 * @param {string} cwd
 * @param {string} branch
 * @param {string[]} preservePlanPaths
 * @returns {Promise<boolean>}
 */
async function resolvePlanMergeConflicts(cwd, branch, preservePlanPaths) {
    if (!await isMergeInProgress(cwd)) return false;
    const unresolvedPaths = parseNameOnlyPaths(await runGit(cwd, ["diff", "--name-only", "--diff-filter=U"]));
    if (unresolvedPaths.length === 0) return false;
    if (unresolvedPaths.some((path) => !path.startsWith("docs/plans/") || !path.endsWith(".md"))) return false;

    const preserved = new Set(preservePlanPaths.map((path) => path.replaceAll("\\", "/")));
    for (const path of unresolvedPaths) {
        const source = preserved.has(path.replaceAll("\\", "/")) ? branch : "HEAD";
        const existsAtSource = await runGitResult(cwd, ["cat-file", "-e", `${source}:${path}`]);
        if (existsAtSource.code === 0) {
            await runGit(cwd, ["restore", "--staged", "--worktree", `--source=${source}`, "--", path]);
        } else {
            await runGit(cwd, ["rm", "--force", "--ignore-unmatch", "--", path]);
        }
    }
    await runGit(cwd, ["add", "-A", "--", ...unresolvedPaths]);

    const currentHead = (await runGit(cwd, ["rev-parse", "HEAD"])).trim();
    const mergeHead = (await runGit(cwd, ["rev-parse", "MERGE_HEAD"])).trim();
    await assertNoTrackedOrIndexedRuntimePaths(cwd);
    await assertNoRuntimePathsInNewHistory(cwd, currentHead, mergeHead);
    await runGit(cwd, ["-c", "core.editor=true", "merge", "--continue"]);
    const mergeCommit = (await runGit(cwd, ["rev-parse", "HEAD"])).trim();
    await assertNoTrackedOrIndexedRuntimePaths(cwd);
    await assertNoRuntimePathsInNewHistory(cwd, currentHead, mergeCommit);
    return true;
}

/**
 * @param {string} cwd
 * @param {string} branch
 * @param {string[]} allowedDirtyPaths
 */
async function assertNoOverlappingDirtyPaths(cwd, branch, allowedDirtyPaths) {
    const allowed = new Set(allowedDirtyPaths);
    const branchChangedPaths = new Set(
        parseNulPaths(await runGit(cwd, ["diff", "--name-only", "-z", `HEAD...${branch}`])),
    );
    const blockingDirtyPaths = filterUserDirtyPaths(await gitStatusPaths(cwd), allowed).filter((path) =>
        overlapsBranchChangedPath(path, branchChangedPaths)
    );
    if (blockingDirtyPaths.length > 0) {
        // Not a conflict, and not something an Agent may fix: these are the user's own
        // uncommitted edits, and the merge would overwrite them. Mark the failure as
        // needing the user so callers ask rather than dispatching a repair that would
        // have to throw the work away to succeed.
        throw attachMergeRepairDetails(
            new Error(
                "Primary checkout has uncommitted changes that overlap execution worktree changes; refusing to merge: " +
                    blockingDirtyPaths.join(", "),
            ),
            { mergeFailureKind: "primary_checkout_dirty", blockingPaths: blockingDirtyPaths },
        );
    }
}

/**
 * @param {{ projectRoot: string, branch: string, worktreePath?: string, allowedDirtyPaths?: string[], preservePlanPaths?: string[] }} opts
 */
async function mergeExecutionWorktreeIntoCurrentCheckout(
    { projectRoot, branch, allowedDirtyPaths = [], preservePlanPaths = [] },
) {
    try {
        if (await isMergeInProgress(projectRoot)) {
            const currentHead = (await runGit(projectRoot, ["rev-parse", "HEAD"])).trim();
            const mergeHead = (await runGit(projectRoot, ["rev-parse", "MERGE_HEAD"])).trim();
            await assertNoTrackedOrIndexedRuntimePaths(projectRoot);
            await assertNoRuntimePathsInNewHistory(projectRoot, currentHead, mergeHead);
            if (preservePlanPaths.length > 0) {
                await runGit(projectRoot, [
                    "restore",
                    "--staged",
                    "--worktree",
                    `--source=${branch}`,
                    "--",
                    ...preservePlanPaths,
                ]);
            }
            await assertNoTrackedOrIndexedRuntimePaths(projectRoot);
            await runGit(projectRoot, ["-c", "core.editor=true", "merge", "--continue"]);
            const mergeCommit = (await runGit(projectRoot, ["rev-parse", "HEAD"])).trim();
            await assertNoTrackedOrIndexedRuntimePaths(projectRoot);
            await assertNoRuntimePathsInNewHistory(projectRoot, currentHead, mergeCommit);
            if (preservePlanPaths.length > 0) {
                await restoreExistingPathsFromHead(projectRoot, preservePlanPaths);
            }
            return;
        }
        await assertNoOverlappingDirtyPaths(projectRoot, branch, allowedDirtyPaths);
        const currentHead = (await runGit(projectRoot, ["rev-parse", "HEAD"])).trim();
        await assertNoRuntimePathsInNewHistory(projectRoot, currentHead, branch);
        await runGit(projectRoot, ["merge", "--no-ff", branch]);
        const mergeCommit = (await runGit(projectRoot, ["rev-parse", "HEAD"])).trim();
        await assertNoTrackedOrIndexedRuntimePaths(projectRoot);
        await assertNoRuntimePathsInNewHistory(projectRoot, currentHead, mergeCommit);
        if (preservePlanPaths.length > 0) {
            await restoreExistingPathsFromHead(projectRoot, preservePlanPaths);
        }
    } catch (error) {
        if (await resolvePlanMergeConflicts(projectRoot, branch, preservePlanPaths)) {
            if (preservePlanPaths.length > 0) {
                await restoreExistingPathsFromHead(projectRoot, preservePlanPaths);
            }
            return;
        }
        await restorePreservedPlanConflictPaths(projectRoot, branch, preservePlanPaths);
        // Keep a kind that was already decided. `primary_checkout_dirty` is raised from
        // inside this try and is not a conflict; relabeling it here would send an Agent
        // to resolve conflict markers that do not exist.
        const alreadyClassified = /** @type {MergeRepairError} */ (error)?.mergeFailureKind;
        throw attachMergeRepairDetails(error, {
            repairCwd: projectRoot,
            mergeFailureKind: alreadyClassified || "current_checkout_merge_conflict",
        });
    }
}

/**
 * @param {string} projectRoot
 * @param {string} mergeWorktreePath
 */
async function cleanupDetachedMergeWorktree(projectRoot, mergeWorktreePath) {
    await runGit(projectRoot, ["worktree", "remove", "--force", mergeWorktreePath]).catch(async () => {
        if (await pathExists(mergeWorktreePath)) {
            await Deno.remove(mergeWorktreePath, { recursive: true }).catch(() => {});
        }
    });
}

/**
 * @param {string} projectRoot
 * @param {string} targetBranch
 * @param {string} mergeWorktreePath
 * @param {string} branch
 * @param {string[]} [preservePlanPaths]
 * @returns {Promise<boolean>} true when the repaired merge was published; false when the preserved worktree was intentionally abandoned so the caller can retry a fresh detached merge.
 */
async function publishRepairedMergeWorktree(
    projectRoot,
    targetBranch,
    mergeWorktreePath,
    branch,
    preservePlanPaths = [],
) {
    if (!await pathExists(mergeWorktreePath)) {
        throw new Error(`Recorded merge repair worktree is missing: ${mergeWorktreePath}`);
    }

    try {
        if (await isMergeInProgress(mergeWorktreePath)) {
            const repairHead = (await runGit(mergeWorktreePath, ["rev-parse", "HEAD"])).trim();
            const mergeHead = (await runGit(mergeWorktreePath, ["rev-parse", "MERGE_HEAD"])).trim();
            await assertNoTrackedOrIndexedRuntimePaths(mergeWorktreePath);
            await assertNoRuntimePathsInNewHistory(mergeWorktreePath, repairHead, mergeHead);
            await restorePreservedPlanConflictPaths(mergeWorktreePath, branch, preservePlanPaths);
            await assertNoTrackedOrIndexedRuntimePaths(mergeWorktreePath);
            await runGit(mergeWorktreePath, ["-c", "core.editor=true", "merge", "--continue"]);
            const repairedCommit = (await runGit(mergeWorktreePath, ["rev-parse", "HEAD"])).trim();
            await assertNoTrackedOrIndexedRuntimePaths(mergeWorktreePath);
            await assertNoRuntimePathsInNewHistory(mergeWorktreePath, repairHead, repairedCommit);
        }
    } catch (error) {
        const alreadyClassified = /** @type {MergeRepairError} */ (error)?.mergeFailureKind;
        throw attachMergeRepairDetails(error, {
            repairCwd: mergeWorktreePath,
            mergeWorktreePath,
            mergeFailureKind: alreadyClassified || "detached_merge_conflict",
            blockingPaths: /** @type {MergeRepairError} */ (error)?.blockingPaths,
        });
    }

    await assertNoTrackedOrIndexedRuntimePaths(mergeWorktreePath);
    const statusText = await runGit(mergeWorktreePath, ["status", "--porcelain"]);
    if (statusText.trim()) {
        throw attachMergeRepairDetails(
            new Error(`Merge repair worktree still has uncommitted changes:\n${statusText}`),
            {
                repairCwd: mergeWorktreePath,
                mergeWorktreePath,
                mergeFailureKind: "detached_merge_conflict",
            },
        );
    }

    const checkoutPath = await findCheckoutPathForBranch(projectRoot, targetBranch);
    const targetCheckedOutInPrimary = checkoutPath ? await isSameFilesystemPath(checkoutPath, projectRoot) : false;
    if (checkoutPath && !targetCheckedOutInPrimary) {
        throw attachMergeRepairDetails(
            new Error(
                `Target branch ${targetBranch} is checked out at ${checkoutPath}; refusing to update it behind ` +
                    "that worktree.",
            ),
            {
                repairCwd: mergeWorktreePath,
                mergeWorktreePath,
                mergeFailureKind: "target_checked_out",
            },
        );
    }

    if (preservePlanPaths.length > 0) {
        await runGit(mergeWorktreePath, [
            "restore",
            "--source",
            branch,
            "--staged",
            "--worktree",
            "--",
            ...preservePlanPaths,
        ]);
        const stagedPlanPaths = parseNameOnlyPaths(
            await runGit(mergeWorktreePath, ["diff", "--cached", "--name-only"]),
        );
        if (stagedPlanPaths.length > 0) await runGit(mergeWorktreePath, ["commit", "--amend", "--no-edit"]);
    }

    const mergeCommit = (await runGit(mergeWorktreePath, ["rev-parse", "HEAD"])).trim();
    let oldTargetCommit;
    try {
        oldTargetCommit = (await runGit(mergeWorktreePath, ["rev-parse", "HEAD^1"])).trim();
        await runGit(mergeWorktreePath, ["rev-parse", "HEAD^2"]);
    } catch {
        await cleanupDetachedMergeWorktree(projectRoot, mergeWorktreePath);
        return false;
    }

    await assertPublicationCandidateContainsTarget(
        projectRoot,
        oldTargetCommit,
        mergeCommit,
        targetBranch,
    );
    await assertNoRuntimePathsInNewHistory(mergeWorktreePath, oldTargetCommit, mergeCommit);

    if (targetCheckedOutInPrimary) {
        try {
            await runGit(projectRoot, ["merge", "--ff-only", mergeCommit]);
        } catch {
            await cleanupDetachedMergeWorktree(projectRoot, mergeWorktreePath);
            return false;
        }
        await assertNoTrackedOrIndexedRuntimePaths(projectRoot);
        await cleanupDetachedMergeWorktree(projectRoot, mergeWorktreePath);
        return true;
    }

    try {
        await runGit(projectRoot, ["update-ref", `refs/heads/${targetBranch}`, mergeCommit, oldTargetCommit]);
    } catch {
        await cleanupDetachedMergeWorktree(projectRoot, mergeWorktreePath);
        return false;
    }
    await cleanupDetachedMergeWorktree(projectRoot, mergeWorktreePath);
    return true;
}

/**
 * @param {{ projectRoot: string, branch: string, targetBranch: string, worktreePath?: string, allowedDirtyPaths?: string[], preservePlanPaths?: string[], repairMergeWorktreePath?: string, expectedTargetHead?: string, maxAttempts?: number }} opts
 */
async function mergeExecutionWorktreeIntoTargetBranch({
    projectRoot,
    branch,
    targetBranch,
    worktreePath,
    allowedDirtyPaths = [],
    preservePlanPaths = [],
    repairMergeWorktreePath,
    expectedTargetHead,
    maxAttempts = 3,
}) {
    await assertLocalBranchExists(projectRoot, branch);
    await assertLocalBranchExists(projectRoot, targetBranch);

    const checkoutPath = await findCheckoutPathForBranch(projectRoot, targetBranch);
    if (checkoutPath) {
        if (!await isSameFilesystemPath(checkoutPath, projectRoot)) {
            throw new Error(
                `Target branch ${targetBranch} is checked out at ${checkoutPath}; refusing to update it behind ` +
                    "that worktree. Run recovery from that checkout or close/remove that worktree first.",
            );
        }
        const currentBranch = (await runGit(projectRoot, ["branch", "--show-current"])).trim();
        if (currentBranch !== targetBranch) {
            throw new Error(
                `Target branch ${targetBranch} is recorded at ${projectRoot}, but current branch is ${currentBranch}.`,
            );
        }
        const currentTargetHead = await getBranchHead(projectRoot, targetBranch);
        if (expectedTargetHead && currentTargetHead !== expectedTargetHead) {
            throw attachMergeRepairDetails(
                new Error(`Target branch ${targetBranch} advanced before publication; rerun Workflow Validation.`),
                { mergeFailureKind: "target_branch_advanced" },
            );
        }
        if (repairMergeWorktreePath) {
            const published = await publishRepairedMergeWorktree(
                projectRoot,
                targetBranch,
                repairMergeWorktreePath,
                branch,
                preservePlanPaths,
            );
            if (published) return;
        }
        await mergeExecutionWorktreeIntoCurrentCheckout({
            projectRoot,
            branch,
            worktreePath,
            allowedDirtyPaths,
            preservePlanPaths,
        });
        return;
    }

    const initialTargetHead = await getBranchHead(projectRoot, targetBranch);
    if (expectedTargetHead && initialTargetHead !== expectedTargetHead) {
        throw attachMergeRepairDetails(
            new Error(`Target branch ${targetBranch} advanced before publication; rerun Workflow Validation.`),
            { mergeFailureKind: "target_branch_advanced" },
        );
    }

    if (repairMergeWorktreePath) {
        const published = await publishRepairedMergeWorktree(
            projectRoot,
            targetBranch,
            repairMergeWorktreePath,
            branch,
            preservePlanPaths,
        );
        if (published) return;
    }

    const parent = worktreePath ? dirname(worktreePath) : resolveWorktreeParent(projectRoot, undefined);
    const repoName = basename(projectRoot);
    let attempt = 0;
    while (attempt < maxAttempts) {
        attempt++;
        const currentCheckoutPath = await findCheckoutPathForBranch(projectRoot, targetBranch);
        if (currentCheckoutPath) {
            throw new Error(
                `Target branch ${targetBranch} is checked out at ${currentCheckoutPath}; refusing to update it behind ` +
                    "that worktree. Run recovery from that checkout or close/remove that worktree first.",
            );
        }
        const oldTargetCommit = (await runGit(projectRoot, ["rev-parse", `refs/heads/${targetBranch}`])).trim();
        if (expectedTargetHead && oldTargetCommit !== expectedTargetHead) {
            throw attachMergeRepairDetails(
                new Error(`Target branch ${targetBranch} advanced before publication; rerun Workflow Validation.`),
                { mergeFailureKind: "target_branch_advanced" },
            );
        }
        const tempId = crypto.randomUUID().slice(0, 8);
        const mergeWorktreePath = join(parent, `${repoName}-merge-${slugify(targetBranch)}-${tempId}`);
        let preserveMergeWorktree = false;
        await Deno.mkdir(parent, { recursive: true });
        try {
            await runGit(projectRoot, ["worktree", "add", "--detach", mergeWorktreePath, oldTargetCommit]);
            try {
                await assertNoRuntimePathsInNewHistory(mergeWorktreePath, oldTargetCommit, branch);
            } catch (error) {
                preserveMergeWorktree = true;
                throw attachMergeRepairDetails(error, {
                    repairCwd: mergeWorktreePath,
                    mergeWorktreePath,
                    mergeFailureKind: /** @type {MergeRepairError} */ (error)?.mergeFailureKind,
                    blockingPaths: /** @type {MergeRepairError} */ (error)?.blockingPaths,
                });
            }
            try {
                await runGit(mergeWorktreePath, ["merge", "--no-ff", branch]);
            } catch (mergeError) {
                if (!await resolvePlanMergeConflicts(mergeWorktreePath, branch, preservePlanPaths)) {
                    preserveMergeWorktree = true;
                    throw attachMergeRepairDetails(mergeError, {
                        repairCwd: mergeWorktreePath,
                        mergeWorktreePath,
                        mergeFailureKind: "detached_merge_conflict",
                    });
                }
            }
            const mergeCommit = (await runGit(mergeWorktreePath, ["rev-parse", "HEAD"])).trim();
            try {
                await assertPublicationCandidateContainsTarget(
                    projectRoot,
                    oldTargetCommit,
                    mergeCommit,
                    targetBranch,
                );
                await assertNoRuntimePathsInNewHistory(mergeWorktreePath, oldTargetCommit, mergeCommit);
                await runGit(projectRoot, ["update-ref", `refs/heads/${targetBranch}`, mergeCommit, oldTargetCommit]);
                return;
            } catch (updateError) {
                if (attempt >= maxAttempts) throw updateError;
            }
        } finally {
            if (!preserveMergeWorktree) {
                await runGit(projectRoot, ["worktree", "remove", "--force", mergeWorktreePath]).catch(() => {});
            }
        }
    }
}

/**
 * Inspect whether merging an execution worktree branch is obviously risky,
 * without mutating either checkout.
 *
 * @param {{ projectRoot: string, branch: string, targetBranch?: string, allowedDirtyPaths?: string[] }} opts
 * @returns {Promise<{ ok: boolean, warnings: string[], failures: string[] }>}
 */
export async function inspectExecutionWorktreeMergeRisk({ projectRoot, branch, targetBranch, allowedDirtyPaths = [] }) {
    /** @type {string[]} */
    const warnings = [];
    /** @type {string[]} */
    const failures = [];
    const normalizedTargetBranch = targetBranch === "HEAD" ? undefined : targetBranch;
    const mergeTarget = normalizedTargetBranch ? `refs/heads/${normalizedTargetBranch}` : "HEAD";

    try {
        await assertLocalBranchExists(projectRoot, branch);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, warnings, failures: [`Recorded worktree branch is not available: ${message}`] };
    }

    if (normalizedTargetBranch) {
        try {
            await assertLocalBranchExists(projectRoot, normalizedTargetBranch);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, warnings, failures: [`Recorded worktree target branch is not available: ${message}`] };
        }
        try {
            const checkoutPath = await findCheckoutPathForBranch(projectRoot, normalizedTargetBranch);
            if (checkoutPath && !await isSameFilesystemPath(checkoutPath, projectRoot)) {
                failures.push(
                    `Target branch ${normalizedTargetBranch} is checked out at ${checkoutPath}; refusing to update it ` +
                        "behind that worktree.",
                );
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            warnings.push(`Could not inspect target branch checkout ownership: ${message}`);
        }
    }

    try {
        const allowed = new Set(allowedDirtyPaths);
        const branchChangedPaths = new Set(
            parseNulPaths(await runGit(projectRoot, ["diff", "--name-only", "-z", `${mergeTarget}...${branch}`])),
        );
        const blockingDirtyPaths = filterUserDirtyPaths(await gitStatusPaths(projectRoot), allowed).filter((path) =>
            overlapsBranchChangedPath(path, branchChangedPaths)
        );
        if (blockingDirtyPaths.length > 0) {
            warnings.push(
                "Primary checkout has uncommitted changes that overlap execution worktree changes: " +
                    blockingDirtyPaths.join(", "),
            );
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Could not inspect primary checkout dirty-path risk: ${message}`);
    }

    try {
        await runGit(projectRoot, ["merge-tree", "--write-tree", mergeTarget, branch]);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Merge check reported possible conflicts or unsupported git merge-tree behavior: ${message}`);
    }

    return { ok: failures.length === 0, warnings, failures };
}

/**
 * @typedef {Object} MergeExecutionWorktreeResult
 * @property {boolean} updatedPrimaryCheckout
 * @property {string} [executionMetadataCommit]
 * @property {string} [targetHeadBeforeMerge]
 */

/**
 * @param {{ projectRoot: string, branch: string, targetBranch?: string, worktreePath?: string, allowedDirtyPaths?: string[], preservePlanPaths?: string[], repairMergeWorktreePath?: string, expectedTargetHead?: string, planName?: string, planDescription?: string, sealedExecutionCommit?: string }} opts
 * @returns {Promise<MergeExecutionWorktreeResult|void>}
 */
export async function mergeExecutionWorktree(
    {
        projectRoot,
        branch,
        targetBranch,
        worktreePath,
        allowedDirtyPaths = [],
        preservePlanPaths = [],
        repairMergeWorktreePath,
        expectedTargetHead,
        planName,
        planDescription,
        sealedExecutionCommit,
    },
) {
    await assertGitRepository(projectRoot, "Merging an execution worktree");
    const normalizedTargetBranch = targetBranch === "HEAD" ? undefined : targetBranch;
    let resolvedWorktreePath = worktreePath;
    if (!resolvedWorktreePath) {
        const worktreeList = await runGit(projectRoot, ["worktree", "list", "--porcelain"]);
        resolvedWorktreePath = findWorktreePathForBranch(worktreeList, branch) || undefined;
    }
    /** @type {string | undefined} */
    let executionMetadataCommit;
    if (repairMergeWorktreePath) {
        // The repair worktree is the frozen publication candidate. Reuse its
        // execution-side parent instead of checkpointing the execution branch again:
        // a new commit cannot be contained in a merge that was already repaired.
        let repairedMetadata = await runGitResult(repairMergeWorktreePath, ["rev-parse", "HEAD^2"]);
        if (repairedMetadata.code !== 0) {
            repairedMetadata = await runGitResult(repairMergeWorktreePath, ["rev-parse", "MERGE_HEAD"]);
        }
        if (repairedMetadata.code === 0) executionMetadataCommit = repairedMetadata.stdout.trim() || undefined;
    }
    if (resolvedWorktreePath && !executionMetadataCommit) {
        const mergeTargetRef = (await runGit(
            projectRoot,
            ["rev-parse", normalizedTargetBranch || "HEAD"],
        )).trim();
        await commitDirtyWorktreeState(
            resolvedWorktreePath,
            branch,
            { planName, planDescription },
            sealedExecutionCommit ? preservePlanPaths : [],
            mergeTargetRef,
        );
        executionMetadataCommit = (await runGit(resolvedWorktreePath, ["rev-parse", "HEAD"])).trim();
    }

    if (!normalizedTargetBranch) {
        await mergeExecutionWorktreeIntoCurrentCheckout({
            projectRoot,
            branch,
            worktreePath: resolvedWorktreePath,
            allowedDirtyPaths,
            preservePlanPaths,
        });
        return { updatedPrimaryCheckout: true, executionMetadataCommit };
    }

    const targetCheckoutPath = await findCheckoutPathForBranch(projectRoot, normalizedTargetBranch);
    const updatedPrimaryCheckout = Boolean(
        targetCheckoutPath && await isSameFilesystemPath(targetCheckoutPath, projectRoot),
    );
    await mergeExecutionWorktreeIntoTargetBranch({
        projectRoot,
        branch,
        targetBranch: normalizedTargetBranch,
        worktreePath: resolvedWorktreePath,
        repairMergeWorktreePath,
        expectedTargetHead,
        allowedDirtyPaths,
        preservePlanPaths,
    });
    const publishedCommit = await getBranchHead(projectRoot, normalizedTargetBranch);
    const targetHeadBeforeMerge = (await runGit(projectRoot, ["rev-parse", `${publishedCommit}^1`])).trim();
    return { updatedPrimaryCheckout, executionMetadataCommit, targetHeadBeforeMerge };
}

/**
 * @typedef {Object} DiscardWorktreeOptions
 * @property {string} projectRoot
 * @property {string} [path]
 * @property {string} [branch]
 * @property {string} [baseCommit]
 *
 * @typedef {Object} DiscardWorktreeResult
 * @property {"path_removed" | "complete" | "retained" | "blocked"} status
 * @property {boolean} pathRemoved
 * @property {boolean} branchDeleted
 * @property {string} message
 */

/** Verify the confirmed attempt against Git before deleting any files. @param {DiscardWorktreeOptions} options */
export async function validateWorktreeDiscard({ projectRoot, path, branch }) {
    await assertGitRepository(projectRoot, "Removing an execution worktree");
    if (!path || !branch) throw new Error("The recorded worktree path and branch are required before cleanup.");
    await runGit(projectRoot, ["check-ref-format", `refs/heads/${branch}`]);
    const records = parseWorktreeRecords(await runGit(projectRoot, ["worktree", "list", "--porcelain"]));
    const primary = records[0];
    if (!primary || await isSameFilesystemPath(primary.path, path)) {
        throw new Error("Recovery cannot discard the primary checkout. Its branch and files were left unchanged.");
    }
    let attached = null;
    for (const record of records) {
        const samePath = await isSameFilesystemPath(record.path, path);
        if (samePath) attached = record;
        if (record.branchRef === `refs/heads/${branch}` && !samePath) {
            throw new Error(
                `Branch ${branch} is checked out at ${record.path}, not the recorded worktree. Nothing was removed.`,
            );
        }
    }
    if (attached && attached.branchRef !== `refs/heads/${branch}`) {
        throw new Error(`The recorded worktree is on a different branch. Nothing was removed from ${path}.`);
    }
    if (await pathExists(path) && !attached) {
        throw new Error(`The recorded path is not an attached execution worktree. Nothing was removed from ${path}.`);
    }
}

/**
 * Discard a confirmed attempt, retaining branches that contain unique commits.
 * Yield after each Git effect so the recovery transition journals it before continuing.
 * @param {DiscardWorktreeOptions} options
 * @returns {AsyncGenerator<DiscardWorktreeResult>}
 */
export async function* discardWorktreeGitArtifacts(options) {
    await validateWorktreeDiscard(options);
    const { projectRoot, path, branch, baseCommit } = options;
    let pathRemoved = false;
    try {
        await removeWorktreeGitArtifacts({ projectRoot, path: String(path), force: true });
        const remaining = parseWorktreeRecords(await runGit(projectRoot, ["worktree", "list", "--porcelain"]));
        for (const record of remaining) {
            if (await isSameFilesystemPath(record.path, String(path))) {
                throw new Error(`Git still records the execution checkout at ${path}. Recovery was kept active.`);
            }
        }
        pathRemoved = true;
        yield { status: "path_removed", pathRemoved, branchDeleted: false, message: "Recorded checkout removed." };
        const exists = await runGitResult(projectRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
        if (exists.code === 1) {
            yield {
                status: "complete",
                pathRemoved,
                branchDeleted: false,
                message: "The recorded worktree and branch are gone.",
            };
            return;
        }
        if (exists.code !== 0) throw new Error(exists.stderr || "Could not inspect the recorded branch.");
        const deletion = await deleteMergedWorktreeBranch({ projectRoot, branch: String(branch), baseCommit });
        yield {
            status: deletion.deleted ? "complete" : "retained",
            pathRemoved,
            branchDeleted: deletion.deleted,
            message: deletion.deleted
                ? "The recorded worktree and branch were deleted."
                : `The worktree was removed. Branch ${branch} was kept for manual rescue because its commits are not proven merged.`,
        };
    } catch (error) {
        yield {
            status: "blocked",
            pathRemoved,
            branchDeleted: false,
            message: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Remove a worktree's Git artifacts. Never touches branches — deleting one is
 * irreversible, so it is `deleteMergedWorktreeBranch` and has to be asked for by name.
 *
 * @param {{ projectRoot: string, path: string, force?: boolean }} opts
 */
export async function removeWorktreeGitArtifacts({ projectRoot, path, force = false }) {
    await assertGitRepository(projectRoot, "Removing an execution worktree");
    const primary = parseWorktreeRecords(await runGit(projectRoot, ["worktree", "list", "--porcelain"]))[0];
    if (!primary || await isSameFilesystemPath(primary.path, path)) {
        throw new Error("Recovery cannot remove the primary checkout. Its branch and files were left unchanged.");
    }
    if (force) {
        await runGit(projectRoot, ["worktree", "remove", "--force", path]).catch(async (error) => {
            if (await pathExists(path)) throw error;
        });
    } else {
        const status = await runGit(path, ["status", "--porcelain", "--ignore-submodules=none"]);
        if (status.trim()) {
            throw new Error(`Refusing to remove dirty execution worktree:\n${status}`);
        }
        try {
            await runGit(projectRoot, ["worktree", "remove", path]);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            if (!reason.includes("working trees containing submodules cannot be moved or removed")) throw error;
            await runGit(projectRoot, ["worktree", "remove", "--force", path]);
        }
    }
}

/**
 * Delete an execution branch, but only once Git proves it is merged.
 *
 * Split out of worktree removal because it is the single most destructive operation in
 * the system: a worktree directory can be recreated from its branch, but a deleted
 * unmerged branch is gone. Removing a directory and destroying history are different
 * decisions and now read as different steps at every call site.
 *
 * Two proofs are accepted, because there are two ways to know nothing is lost:
 *
 * - The branch is merged into the publication target (HEAD by default), so its commits are reachable
 *   elsewhere.
 * - The branch never moved off the commit it was created from, so it carries no work at
 *   all. Rollback of a freshly created attempt is exactly this case, and without it a
 *   cancelled execution start left an orphan branch behind forever — a loose end doctor
 *   reports but nothing cleans up.
 *
 * Without either proof the branch is left alone and the caller is told nothing was
 * deleted, per PR-4. `baseCommit` is optional: callers that cannot prove the origin get
 * the merged check alone.
 *
 * @typedef {Object} MergedWorktreeBranchDeletionOptions
 * @property {string} projectRoot
 * @property {string} branch
 * @property {string} [baseCommit]
 * @property {string} [ownedPreparationCommit]
 * @property {string} [targetBranch]
 */

/**
 * @param {MergedWorktreeBranchDeletionOptions} opts
 * @returns {Promise<{ deleted: boolean, reason: string }>}
 */
export async function deleteMergedWorktreeBranch(
    { projectRoot, branch, baseCommit, ownedPreparationCommit, targetBranch },
) {
    if (targetBranch === branch) {
        return { deleted: false, reason: `${branch} is the publication target, so it was kept.` };
    }
    if (baseCommit) {
        const tip = await runGitResult(projectRoot, ["rev-parse", `refs/heads/${branch}`]);
        if (tip.code === 0 && tip.stdout.trim() === baseCommit) {
            await runGit(projectRoot, ["branch", "-D", branch]);
            return {
                deleted: true,
                reason: `${branch} never moved off ${baseCommit}, so it carried no work and was deleted.`,
            };
        }
        if (ownedPreparationCommit && tip.code === 0 && tip.stdout.trim() === ownedPreparationCommit) {
            const parent = await runGitResult(projectRoot, ["rev-parse", `${ownedPreparationCommit}^`]);
            if (parent.code === 0 && parent.stdout.trim() === baseCommit) {
                await runGit(projectRoot, ["branch", "-D", branch]);
                return {
                    deleted: true,
                    reason: `${branch} contained only RunWield's preparation commit and was deleted.`,
                };
            }
        }
    }
    const targetRef = targetBranch ? `refs/heads/${targetBranch}` : "HEAD";
    const merged = await runGitResult(projectRoot, ["branch", "--merged", targetRef]);
    const hasMergedProof = merged.code === 0 &&
        merged.stdout.split("\n").some((line) => line.replace(/^\*\s*/, "").trim() === branch);
    if (!hasMergedProof) {
        return {
            deleted: false,
            reason: `${branch} is not proven merged into ${targetRef}, so it was kept.`,
        };
    }
    // Git's -d checks HEAD or the source's upstream, which may be unrelated to
    // this publication. The explicit target's ancestry proof above owns cleanup.
    await runGit(projectRoot, ["branch", targetBranch ? "-D" : "-d", branch]);
    return { deleted: true, reason: `${branch} was merged into ${targetRef} and deleted.` };
}

/**
 * Delete an execution branch after an upstream publication proves its tip is
 * reachable. This fetches into a temporary RunWield ref; it never advances a
 * local target branch or changes the user's checkout.
 *
 * @typedef {Object} RemotePublishedBranchDeletionOptions
 * @property {string} projectRoot
 * @property {string} branch
 * @property {string} remote
 * @property {string} upstreamBranch
 * @property {string} publicationCommit
 * @property {string} [artifactCommit]
 */

/**
 * @param {RemotePublishedBranchDeletionOptions} opts
 * @returns {Promise<{ deleted: boolean, reason: string }>}
 */
export async function deleteRemotelyPublishedWorktreeBranch({
    projectRoot,
    branch,
    remote,
    upstreamBranch,
    publicationCommit,
    artifactCommit,
}) {
    const proofRef = `refs/runwield/publication-proof/${crypto.randomUUID()}`;
    try {
        await runGit(projectRoot, [
            "fetch",
            remote,
            `+refs/heads/${upstreamBranch}:${proofRef}`,
        ]);
        const publicationContained = await runGitResult(projectRoot, [
            "merge-base",
            "--is-ancestor",
            publicationCommit,
            proofRef,
        ]);
        if (publicationContained.code !== 0) {
            return {
                deleted: false,
                reason: `Could not confirm the published commits on ${upstreamBranch}, so ${branch} was kept.`,
            };
        }
        let contains = await runGitResult(projectRoot, ["merge-base", "--is-ancestor", branch, proofRef]);
        if (contains.code !== 0) {
            // Cleanup can be resumed by more than one process after publication.
            // If another cleanup removed the branch between our existence check
            // and this proof, the desired effect is already complete.
            const branchStillExists = await runGitResult(projectRoot, [
                "show-ref",
                "--verify",
                "--quiet",
                `refs/heads/${branch}`,
            ]);
            if (branchStillExists.code !== 0) {
                return { deleted: true, reason: `${branch} was already deleted.` };
            }
            if (artifactCommit) {
                const artifactPublished = await runGitResult(projectRoot, [
                    "merge-base",
                    "--is-ancestor",
                    artifactCommit,
                    proofRef,
                ]);
                const branchDescendsFromArtifact = await runGitResult(projectRoot, [
                    "merge-base",
                    "--is-ancestor",
                    artifactCommit,
                    `refs/heads/${branch}`,
                ]);
                if (artifactPublished.code === 0 && branchDescendsFromArtifact.code === 0) {
                    const descendants = await runGitResult(projectRoot, [
                        "rev-list",
                        "--parents",
                        `${artifactCommit}..refs/heads/${branch}`,
                    ]);
                    const commits = descendants.code === 0
                        ? descendants.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
                        : [];
                    let onlyEmptySingleParentCommits = descendants.code === 0 && commits.length > 0;
                    for (const line of commits) {
                        const [commit, parent, ...otherParents] = line.split(/\s+/);
                        if (!commit || !parent || otherParents.length > 0) {
                            onlyEmptySingleParentCommits = false;
                            break;
                        }
                        const changed = await runGitResult(projectRoot, [
                            "diff-tree",
                            "--quiet",
                            "--exit-code",
                            parent,
                            commit,
                            "--",
                        ]);
                        if (changed.code !== 0) {
                            onlyEmptySingleParentCommits = false;
                            break;
                        }
                    }
                    if (onlyEmptySingleParentCommits) contains = { ...contains, code: 0 };
                }
            }
            if (contains.code !== 0) {
                return { deleted: false, reason: `The upstream target does not contain ${branch}, so it was kept.` };
            }
        }
        const deletion = await runGitResult(projectRoot, ["branch", "-D", branch]);
        if (deletion.code !== 0) {
            const branchStillExists = await runGitResult(projectRoot, [
                "show-ref",
                "--verify",
                "--quiet",
                `refs/heads/${branch}`,
            ]);
            if (branchStillExists.code !== 0) {
                return { deleted: true, reason: `${branch} was already deleted.` };
            }
            throw new Error(deletion.stderr || deletion.stdout);
        }
        return { deleted: true, reason: `${branch} is published upstream and was deleted.` };
    } finally {
        await runGitResult(projectRoot, ["update-ref", "-d", proofRef]);
    }
}

/** @param {{ projectRoot: string }} opts */
export async function pruneMissingWorktrees({ projectRoot }) {
    await runGit(projectRoot, ["worktree", "prune"]).catch(() => {});
    return await pruneStaleEntries(projectRoot);
}

/**
 * @param {{ projectRoot: string, planName: string, planId: string, worktreeId?: string }} opts
 */
export async function findReusableWorktree({ projectRoot, planName, planId, worktreeId }) {
    if (typeof planId !== "string" || !planId) {
        throw new Error(`Finding a reusable worktree for ${planName} requires a stable planId.`);
    }
    await pruneStaleEntries(projectRoot);
    const entries = await listEntries(projectRoot);
    for (const entry of entries) {
        if (entry.planId !== planId) continue;
        if (entry.planName !== planName) continue;
        if (worktreeId && entry.id !== worktreeId) continue;
        if (["active", "completed", "execution_failed", "validation_failed", "validated"].includes(entry.status)) {
            if (await pathExists(entry.path)) return entry;
        }
    }
    return null;
}

export { removeEntry as removeWorktreeRegistryEntry };
