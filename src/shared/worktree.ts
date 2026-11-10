/** Git worktree helpers for isolated Plan execution. */

import { resolveProjectRoot } from "./project-checkout.ts";
import { isMissingExecutableError } from "./foreground-process.ts";
import { captureForegroundProcess } from "./captured-process.ts";
import {
    lstat as fsLstat,
    mkdir as fsMkdir,
    readFile as fsReadFile,
    realpath as fsRealpath,
    rm as fsRm,
    stat as fsStat,
} from "node:fs/promises";

import { basename, dirname, join, resolve } from "node:path";
import { getHomeDir, RUNWIELD_DIR_NAME, WORKTREE_BRANCH_PREFIX } from "../constants.ts";
import { encodeCwdForSessionDir } from "./project-directory-key.ts";
import {
    captureWorktreeProjectContext,
    isTransferredProjectContext,
    materializeWorktreeProjectContext,
    PROJECT_CONTEXT_PATHS,
    recordedProjectContextPaths,
} from "./worktree-project-context.ts";
import { assertGitRepository, GitRepositoryRequiredError } from "./git.ts";
import { resolvePublicationUpstream } from "./publication-target.ts";
import { getWorkflowDiff, REVIEW_DIFF_FORMAT_ARGS } from "./workflow/git-snapshot.ts";
import {
    addEntry,
    listEntries,
    pruneStaleEntries,
    removeEntry,
    type WorktreeRegistryEntry,
} from "./worktree-registry.ts";
import { enterProjectRuntime, resolveProjectRuntimeLayout } from "./project-runtime-layout.ts";
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

interface GitCommandResult {
    code: number;
    stdout: string;
    stderr: string;
}

interface HasExecutionChangesSinceOptions {
    worktreePath: string;
    baseRef: string;
    targetRef?: string;
    includeWorkingTree?: boolean;
    /** Published target whose identical committed files are not local implementation. */
    publishedRef?: string;
}

interface HasOnlyExecutionPreparationChangesSinceOptions {
    worktreePath: string;
    baseRef: string;
    targetRef?: string;
}

interface WorktreeRecord {
    path: string;
    branchRef: string;
}

interface EnsuredTargetBranchRef {
    branch: string;
    created: boolean;
}

interface BuildWorktreeCommitMessageOptions {
    branch: string;
    stagedPaths: string[];
}

interface CheckpointExecutionPreparationOptions {
    worktreePath: string;
    branch: string;
    baseCommit: string;
    planName: string;
    planRelativePath: string;
    preparationToken?: string;
    phase?: "preparation" | "planning";
    relatedPlanPaths?: string[];
}

interface CheckpointExecutionPreparationResult {
    preparationCommit: string;
}

interface AssertPreMergeCandidateUnchangedOptions {
    /** Execution worktree to inspect. */
    worktreePath: string;
    /** Commit the validated candidate was sealed at. */
    sealedExecutionCommit: string;
    /** Plan paths staging is permitted to have touched. */
    allowedPlanPaths: string[];
}

interface CheckpointExecutionWorktreeOptions {
    worktreePath: string;
    branch: string;
    planName?: string;
    planDescription?: string;
    mergeTargetRef?: string;
    publicationAttemptId?: string;
    publicationPlanPaths?: string[];
}

interface CheckpointExecutionWorktreeResult {
    executionCommit: string;
}

interface ValidateWorktreeRecreationOptions {
    projectRoot: string;
    planName: string;
    planId?: string;
    baseRef: string;
}

interface CreateWorktreeGitArtifactsOptions {
    projectRoot: string;
    planName: string;
    planId: string;
    baseRef?: string;
    baseBranch?: string;
    worktreeRoot?: string;
    attemptId?: string;
}

interface GetWorktreeStatusOptions {
    projectRoot: string;
    path: string;
    branch?: string;
    baseTree?: string;
}

interface MergeRepairDetails {
    repairCwd?: string;
    mergeWorktreePath?: string;
    mergeFailureKind?: string;
    blockingPaths?: string[];
}

interface MergeWorktreeOptions {
    projectRoot: string;
    branch: string;
    worktreePath?: string;
    allowedDirtyPaths?: string[];
    preservePlanPaths?: string[];
}

interface TargetMergeRecoveryOptions {
    repairMergeWorktreePath?: string;
    expectedTargetHead?: string;
}

interface MergeExecutionWorktreeIntoTargetBranchOptions extends MergeWorktreeOptions, TargetMergeRecoveryOptions {
    targetBranch: string;
    maxAttempts?: number;
}

interface InspectExecutionWorktreeMergeRiskOptions {
    projectRoot: string;
    branch: string;
    targetBranch?: string;
    allowedDirtyPaths?: string[];
}

interface InspectExecutionWorktreeMergeRiskResult {
    ok: boolean;
    warnings: string[];
    failures: string[];
}

interface MergeExecutionWorktreeOptions extends MergeWorktreeOptions, TargetMergeRecoveryOptions {
    targetBranch?: string;
    planName?: string;
    planDescription?: string;
    sealedExecutionCommit?: string;
}

interface RemoveWorktreeGitArtifactsOptions {
    projectRoot: string;
    path: string;
    force?: boolean;
}

interface BranchDeletionResult {
    deleted: boolean;
    reason: string;
}

interface PruneMissingWorktreesOptions {
    projectRoot: string;
}

interface FindReusableWorktreeOptions {
    projectRoot: string;
    planName: string;
    planId: string;
    worktreeId?: string;
}

/** Planning checkpoints precede dependency setup; execution commits still run project hooks. */
export const PLANNING_CHECKPOINT_GIT_OPTIONS = ["-c", "core.hooksPath=/dev/null"];

async function runGit(cwd: string, args: string[]): Promise<string> {
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

async function runGitResult(cwd: string, args: string[]): Promise<GitCommandResult> {
    try {
        const { code, stdout, stderr } = await captureForegroundProcess("git", { args, cwd });
        const decoder = new TextDecoder();
        return { code, stdout: decoder.decode(stdout), stderr: decoder.decode(stderr) };
    } catch (error) {
        if (error instanceof Error && isMissingExecutableError(error)) {
            return { code: 127, stdout: "", stderr: "The git executable was not found." };
        }
        throw error;
    }
}

export function slugify(value: string) {
    const slug = value
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return slug.slice(0, 48) || "plan";
}

async function pathExists(path: string) {
    try {
        await fsStat(path);
        return true;
    } catch {
        return false;
    }
}

async function isMergeInProgress(projectRoot: string): Promise<boolean> {
    const mergeHeadPath = (await runGit(projectRoot, ["rev-parse", "--git-path", "MERGE_HEAD"])).trim();
    const absoluteMergeHeadPath = resolve(projectRoot, mergeHeadPath);
    return await pathExists(absoluteMergeHeadPath);
}

function parseStatusPaths(statusText: string): string[] {
    return statusText
        .split("\n")
        .filter(Boolean)
        .map((line) => line.slice(3).trim())
        .filter(Boolean);
}

function parseNameOnlyPaths(diffText: string): string[] {
    return diffText
        .trim()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

function parseNulPaths(output: string): string[] {
    return output.split("\0").filter((path) => path.length > 0);
}

function isAllowedDirtyPath(dirtyPath: string, allowedPaths: Set<string>) {
    if (allowedPaths.has(dirtyPath)) return true;
    for (const allowedPath of allowedPaths) {
        const normalizedAllowed = allowedPath.endsWith("/") ? allowedPath : `${allowedPath}/`;
        const normalizedDirty = dirtyPath.endsWith("/") ? dirtyPath : `${dirtyPath}/`;
        if (dirtyPath.startsWith(normalizedAllowed)) return true;
        if (normalizedAllowed.startsWith(normalizedDirty)) return true;
    }
    return false;
}

function overlapsBranchChangedPath(dirtyPath: string, branchChangedPaths: Set<string>) {
    return isAllowedDirtyPath(dirtyPath, branchChangedPaths);
}

function filterUserDirtyPaths(paths: string[], allowed: Set<string> = new Set()): string[] {
    return paths.filter((path) => !isRunWieldOwnedRuntimePath(path) && !isAllowedDirtyPath(path, allowed));
}

function isExecutionPreparationPath(path: string) {
    return path === "docs/plans" || path.startsWith("docs/plans/") || isRunWieldOwnedRuntimePath(path);
}

/**
 * Preparation owns only the deterministic ignore-rule delta. Check the index as
 * well as the working file so staging cannot silently adopt a user's partial edit.
 */
async function isPreparationChange(root: string, path: string, baseRef: string, targetRef?: string) {
    if (isExecutionPreparationPath(path)) return true;
    if (path !== ".gitignore") return await isTransferredProjectContext(root, path, targetRef);
    const before = await runGitResult(root, ["show", `${baseRef}:.gitignore`]);
    if (targetRef) {
        const after = await runGitResult(root, ["show", `${targetRef}:.gitignore`]);
        return after.code === 0 && isRunWieldOwnedGitignoreChange(before.stdout, after.stdout);
    }
    try {
        const stat = await fsLstat(join(root, path));
        if (!stat.isFile() || stat.isSymbolicLink()) return false;
        const after = await fsReadFile(join(root, path), "utf8");
        const staged = await runGitResult(root, ["show", ":.gitignore"]);
        return (
            isRunWieldOwnedGitignoreChange(before.stdout, after) &&
            (staged.code === 0 ? isRunWieldOwnedGitignoreChange(before.stdout, staged.stdout) : before.code !== 0)
        );
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
    }
}

/**
 * Detect evidence that an execution Agent already changed a reusable worktree.
 * Plan materialization, project context, the owned ignore block, and runtime files are setup—not
 * implementation evidence.
 */
export async function hasExecutionChangesSince({
    worktreePath,
    baseRef,
    targetRef = "HEAD",
    includeWorkingTree = false,
    publishedRef,
}: HasExecutionChangesSinceOptions): Promise<boolean> {
    const committed = parseNameOnlyPaths(
        await runGit(worktreePath, ["diff", "--name-only", `${baseRef}..${targetRef}`, "--"]),
    );
    const dirty = includeWorkingTree
        ? parseStatusPaths(await runGit(worktreePath, ["status", "--porcelain", "--untracked-files=all"]))
        : [];
    const checks = [
        { paths: committed, ref: targetRef },
        { paths: dirty, ref: undefined },
    ];
    for (const { paths, ref } of checks) {
        for (const path of paths) {
            if (!(await isPreparationChange(worktreePath, path, ref ? baseRef : "HEAD", ref))) {
                if (ref && publishedRef) {
                    const comparison = await runGitResult(worktreePath, [
                        "diff",
                        "--quiet",
                        publishedRef,
                        ref,
                        "--",
                        path,
                    ]);
                    if (comparison.code === 0) continue;
                    if (comparison.code !== 1) {
                        throw new Error(`Could not compare published file ${path}: ${comparison.stderr}`);
                    }
                }
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
 */
export async function hasOnlyExecutionPreparationChangesSince({
    worktreePath,
    baseRef,
    targetRef = "HEAD",
}: HasOnlyExecutionPreparationChangesSinceOptions): Promise<boolean> {
    const baseIsAncestor = await runGitResult(worktreePath, ["merge-base", "--is-ancestor", baseRef, targetRef]);
    if (baseIsAncestor.code !== 0) return false;
    const committed = parseNameOnlyPaths(
        await runGit(worktreePath, ["diff", "--name-only", `${baseRef}..${targetRef}`, "--"]),
    );
    for (const path of committed) {
        if (!(await isPreparationChange(worktreePath, path, baseRef, targetRef))) {
            return false;
        }
    }
    return committed.length > 0;
}

async function restoreExistingPathsFromHead(cwd: string, paths: string[]) {
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
 */
async function stageDirtyPathsExceptOwnedRuntime(worktreePath: string) {
    await stageGitChangesExcludingRuntime(worktreePath);
}

function parseWorktreeRecords(porcelainText: string): WorktreeRecord[] {
    return porcelainText
        .trim()
        .split("\n\n")
        .filter(Boolean)
        .map((record) => {
            const lines = record.split("\n");
            const worktreePath = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
            const branchRef = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
            return { path: worktreePath || "", branchRef: branchRef || "" };
        });
}

function findWorktreePathForBranch(porcelainText: string, branch: string): string | null {
    const record = parseWorktreeRecords(porcelainText).find((entry) => entry.branchRef === `refs/heads/${branch}`);
    return record?.path || null;
}

async function assertLocalBranchExists(projectRoot: string, branch: string) {
    await runGit(projectRoot, ["rev-parse", "--verify", `refs/heads/${branch}`]);
}

export interface PreparedTargetBranchRef {
    baseRef: string;
    baseBranch: string;
}

async function gitRefExists(projectRoot: string, ref: string): Promise<boolean> {
    const result = await runGitResult(projectRoot, ["rev-parse", "--verify", "--quiet", ref]);
    return result.code === 0;
}

async function assertValidTargetBranchName(projectRoot: string, branch: string) {
    if (!branch || branch === "HEAD") throw new Error("Target branch must be a branch name, not HEAD.");
    if (branch.startsWith("refs/")) throw new Error(`Target branch must not be a full ref: ${branch}`);
    if (branch.startsWith(WORKTREE_BRANCH_PREFIX)) {
        throw new Error(`Target branch cannot use reserved execution prefix: ${WORKTREE_BRANCH_PREFIX}`);
    }
    const result = await runGitResult(projectRoot, ["check-ref-format", "--branch", branch]);
    if (result.code !== 0) throw new Error(`Invalid target branch name: ${branch}`);
}

async function fetchPublicationTargetRef(projectRoot: string, branch: string): Promise<string | null> {
    const upstream = await resolvePublicationUpstream(projectRoot, branch);
    if (!upstream) return null;
    const remoteRef = `refs/remotes/${upstream.remote}/${upstream.branch}`;
    const fetchResult = await runGitResult(projectRoot, [
        "fetch",
        upstream.remote,
        `+refs/heads/${upstream.branch}:${remoteRef}`,
    ]);
    if (fetchResult.code !== 0) {
        const message = fetchResult.stderr || fetchResult.stdout;
        if (message.includes("couldn't find remote ref")) {
            return null;
        }
        throw new Error(
            `Could not check remote target branch ${upstream.remote}/${upstream.branch}: ${message}`.trim(),
        );
    }
    return remoteRef;
}

async function createLocalBranchFromDefault(projectRoot: string, branch: string): Promise<PreparedTargetBranchRef> {
    const defaultBranch = await resolveRepositoryDefaultBranch(projectRoot);
    const defaultRef = (await fetchPublicationTargetRef(projectRoot, defaultBranch)) ?? `refs/heads/${defaultBranch}`;
    await runGit(projectRoot, ["branch", branch, defaultRef]);
    return { baseRef: `refs/heads/${branch}`, baseBranch: branch };
}

/** Resolve the repository default, never the current checkout. */
export async function resolveRepositoryDefaultBranch(projectRoot: string): Promise<string> {
    await assertGitRepository(projectRoot, "Resolving the repository default branch");
    const remote = await runGitResult(projectRoot, ["remote", "get-url", "origin"]);
    if (remote.code === 0) {
        const head = await runGitResult(projectRoot, ["ls-remote", "--symref", "origin", "HEAD"]);
        const branch = head.code === 0 ? head.stdout.match(/^ref: refs\/heads\/([^\t\n]+)\tHEAD/m)?.[1] : undefined;
        for (const candidate of [...new Set([branch, "main", "master"].filter(Boolean))]) {
            if (candidate && (await fetchPublicationTargetRef(projectRoot, candidate))) return candidate;
        }
    }
    const configured = await runGitResult(projectRoot, ["config", "--get", "init.defaultBranch"]);
    for (const branch of [
        ...new Set([configured.code === 0 ? configured.stdout.trim() : "", "main", "master"].filter(Boolean)),
    ]) {
        if (await gitRefExists(projectRoot, `refs/heads/${branch}`)) return branch;
    }
    throw new Error("Repository default branch does not exist (main or master).");
}

/** Resolve the local branch name that a plan-authored target would record, without creating or fetching branches. */
export async function resolveTargetBranchName(projectRoot: string, branch: string): Promise<string> {
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
 */
export async function resolveCurrentCheckoutBranch(projectRoot: string): Promise<string | undefined> {
    await assertGitRepository(projectRoot, "Resolving the current checkout branch");
    const branch = (await runGit(projectRoot, ["branch", "--show-current"])).trim();
    return branch || undefined;
}

/** Prepare an unambiguous local branch ref for a plan-authored execution target. */
export async function prepareTargetBranchRef(projectRoot: string, branch: string): Promise<PreparedTargetBranchRef> {
    await assertGitRepository(projectRoot, "Preparing an execution target branch");
    const target = await resolveTargetBranchName(projectRoot, branch);
    const remoteRef = await fetchPublicationTargetRef(projectRoot, target);
    if (remoteRef) {
        return { baseRef: remoteRef, baseBranch: target };
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
 */
export async function ensureTargetBranchRef(
    projectRoot: string,
    branch: string,
    sourceBranch?: string,
): Promise<EnsuredTargetBranchRef> {
    const target = await resolveTargetBranchName(projectRoot, branch);
    if (await gitRefExists(projectRoot, `refs/heads/${target}`)) return { branch: target, created: false };
    let sourceRef;
    const remoteRef = await fetchPublicationTargetRef(projectRoot, target);
    if (remoteRef) {
        sourceRef = remoteRef;
    } else if (sourceBranch) {
        const source = await resolveTargetBranchName(projectRoot, sourceBranch);
        sourceRef =
            (await fetchPublicationTargetRef(projectRoot, source)) ??
            (!sourceBranch.startsWith("origin/") && (await gitRefExists(projectRoot, `refs/heads/${source}`))
                ? `refs/heads/${source}`
                : undefined);
        if (!sourceRef) throw new Error(`Source branch does not exist: ${sourceBranch}`);
    } else {
        await createLocalBranchFromDefault(projectRoot, target);
        return { branch: target, created: true };
    }
    await runGit(projectRoot, ["branch", target, sourceRef]);
    return { branch: target, created: true };
}

async function findCheckoutPathForBranch(projectRoot: string, branch: string): Promise<string | null> {
    const worktreeList = await runGit(projectRoot, ["worktree", "list", "--porcelain"]);
    return findWorktreePathForBranch(worktreeList, branch);
}

async function isSameFilesystemPath(a: string, b: string): Promise<boolean> {
    return (await canonicalWorktreePath(a)) === (await canonicalWorktreePath(b));
}

/** Resolve symlinked parents even when a recorded checkout has already disappeared. */
async function canonicalWorktreePath(path: string): Promise<string> {
    try {
        return await fsRealpath(path);
    } catch {
        const parent = dirname(path);
        if (parent === path) return path;
        return join(await canonicalWorktreePath(parent), basename(path));
    }
}

export interface WorktreeCommitMessageOptions {
    planName?: string;
    planDescription?: string;
    phase?: "completion" | "preparation" | "planning" | "publication";
    preparationToken?: string;
    publicationAttemptId?: string;
    publicationPlanPaths?: string[];
}

export interface WorktreeCommitMessage {
    subject: string;
    body: string;
}

function normalizeCommitMessageLine(value: string | undefined) {
    return String(value || "")
        .replace(/\s+/g, " ")
        .trim();
}

function formatStagedPaths(stagedPaths: string[]) {
    const visiblePaths = stagedPaths.slice(0, 5);
    const remaining = stagedPaths.length - visiblePaths.length;
    return remaining > 0 ? `${visiblePaths.join(", ")} and ${remaining} more` : visiblePaths.join(", ");
}

function buildWorktreeCommitMessage({
    planName,
    planDescription,
    phase,
    branch,
    stagedPaths,
    preparationToken,
    publicationAttemptId,
    publicationPlanPaths = [],
}: WorktreeCommitMessageOptions & BuildWorktreeCommitMessageOptions): WorktreeCommitMessage {
    const normalizedPlanName = normalizeCommitMessageLine(planName);
    const normalizedDescription = normalizeCommitMessageLine(planDescription);
    const subject = normalizedPlanName
        ? normalizeCommitMessageLine(
              phase === "planning"
                  ? `Prepare ${normalizedPlanName} planning`
                  : phase === "preparation"
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
    if (preparationToken) bodyLines.push(`RunWield-Preparation: ${preparationToken}`);
    if (publicationAttemptId) {
        bodyLines.push(`RunWield-Publication-Attempt: ${publicationAttemptId}`);
        for (const path of publicationPlanPaths) bodyLines.push(`RunWield-Publication-Plan-Path: ${path}`);
    }
    return { subject, body: bodyLines.join("\n") };
}

async function commitDirtyWorktreeState(
    worktreePath: string,
    branch: string,
    messageOptions: WorktreeCommitMessageOptions = {},
    allowedDirtyPaths: string[] = [],
    _mergeTargetRef: string | undefined = undefined,
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
            const description =
                messageOptions.phase === "preparation" || messageOptions.phase === "planning"
                    ? "Execution worktree contains changes outside preparation Plan paths:"
                    : "Execution worktree changed after candidate sealing outside finalized Plan paths:";
            throw new Error(description + "\n" + disallowedPaths.map((path) => `  - ${path}`).join("\n"));
        }
        const allowedPathNeedsOwnedExclusion = RUNWIELD_OWNED_RUNTIME_PATHS.some((ownedPath) =>
            isAllowedDirtyPath(ownedPath, allowedPathSet),
        );
        if (allowedPathNeedsOwnedExclusion) {
            await stageDirtyPathsExceptOwnedRuntime(worktreePath);
        } else {
            const forcedPaths = new Set();
            for (const path of await recordedProjectContextPaths(worktreePath)) {
                if (allowedPathSet.has(path) && (await isTransferredProjectContext(worktreePath, path))) {
                    await runGit(worktreePath, ["add", "-f", "--", path]);
                    forcedPaths.add(path);
                }
            }
            const ordinaryPaths = allowedDirtyPaths.filter((path) => !forcedPaths.has(path));
            if (ordinaryPaths.length > 0) {
                // Staged deletions and rename sources no longer match an add pathspec.
                const stageablePaths = parseNulPaths(
                    await runGit(worktreePath, [
                        "ls-files",
                        "--cached",
                        "--others",
                        "--exclude-standard",
                        "-z",
                        "--",
                        ...ordinaryPaths,
                    ]),
                );
                if (stageablePaths.length > 0) await runGit(worktreePath, ["add", "-A", "--", ...stageablePaths]);
            }
        }
    } else {
        await stageDirtyPathsExceptOwnedRuntime(worktreePath);
    }
    await assertNoTrackedOrIndexedRuntimePaths(worktreePath);
    const stagedDiff = await runGit(worktreePath, ["diff", "--cached", "--name-only"]);
    const stagedPaths = parseNameOnlyPaths(stagedDiff);
    if (stagedPaths.length === 0) return;
    const message = buildWorktreeCommitMessage({ ...messageOptions, branch, stagedPaths });
    await runGit(worktreePath, [
        ...(messageOptions.phase === "planning" ? PLANNING_CHECKPOINT_GIT_OPTIONS : []),
        "commit",
        "-m",
        message.subject,
        "-m",
        message.body,
    ]);
}

/**
 * Commit only RunWield's execution-preparation files before an Agent can touch
 * the worktree. The target commit remains the attempt's immutable base; this
 * commit makes the materialized Plan and copied project context ordinary tracked Git evidence.
 */
export async function checkpointExecutionPreparation({
    worktreePath,
    branch,
    baseCommit,
    planName,
    planRelativePath,
    relatedPlanPaths = [],
    preparationToken,
    phase = "preparation",
}: CheckpointExecutionPreparationOptions): Promise<CheckpointExecutionPreparationResult> {
    // Planning can leave new drafts and normalized legacy Plans outside the
    // active Epic family. Use the same preparation boundary as resume detection;
    // these files are the input baseline, never post-validation exceptions.
    const dirtyPreparationPaths = [];
    for (const path of new Set([...(await gitStatusPaths(worktreePath)), ...PROJECT_CONTEXT_PATHS])) {
        if (!isRunWieldOwnedRuntimePath(path) && (await isPreparationChange(worktreePath, path, "HEAD")))
            dirtyPreparationPaths.push(path);
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
        const committedPaths =
            baseIsAncestor.code === 0
                ? parseNameOnlyPaths(
                      await runGit(worktreePath, ["diff", "--name-only", `${baseCommit}..${headBefore}`, "--"]),
                  )
                : [];
        const unexpectedPaths = baseIsAncestor.code === 0 ? [] : ["branch history"];
        for (const path of committedPaths) {
            if (!(await isPreparationChange(worktreePath, path, baseCommit, headBefore))) {
                unexpectedPaths.push(path);
            }
        }
        if (unexpectedPaths.length > 0) {
            throw new Error(
                `Cannot checkpoint execution preparation for ${planName}: branch ${branch} moved from ${baseCommit} to ${headBefore}.`,
            );
        }
    }
    await commitDirtyWorktreeState(worktreePath, branch, { planName, phase, preparationToken }, preparationPaths);
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
    const remainingDirtyPaths = (await gitStatusPaths(worktreePath)).filter(
        (path) => !isRunWieldOwnedRuntimePath(path),
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
 */
export async function assertPreMergeCandidateUnchanged({
    worktreePath,
    sealedExecutionCommit,
    allowedPlanPaths,
}: AssertPreMergeCandidateUnchangedOptions): Promise<void> {
    const allowed = new Set(allowedPlanPaths);
    const committed = parseNameOnlyPaths(
        await runGit(worktreePath, ["diff", "--name-only", `${sealedExecutionCommit}..HEAD`, "--"]),
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

export async function checkpointExecutionWorktree({
    worktreePath,
    branch,
    planName,
    planDescription,
    mergeTargetRef,
    publicationAttemptId,
    publicationPlanPaths,
}: CheckpointExecutionWorktreeOptions): Promise<CheckpointExecutionWorktreeResult> {
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
    const remainingDirtyPaths = (await gitStatusPaths(worktreePath)).filter(
        (path) => !isRunWieldOwnedRuntimePath(path),
    );
    if (remainingDirtyPaths.length > 0) {
        throw new Error(`Execution worktree is dirty after checkpoint commit:\n${remainingDirtyPaths.join("\n")}`);
    }
    const executionCommit = (await runGit(worktreePath, ["rev-parse", "HEAD"])).trim();
    return { executionCommit };
}

export async function getBranchHead(projectRoot: string, branch: string) {
    return (await runGit(projectRoot, ["rev-parse", `refs/heads/${branch}`])).trim();
}

export async function isCommitAncestorOfBranch(projectRoot: string, commit: string, branch: string): Promise<boolean> {
    const result = await runGitResult(projectRoot, ["merge-base", "--is-ancestor", commit, `refs/heads/${branch}`]);
    return result.code === 0;
}

/**
 * A compare-and-swap proves only that the target still points where the caller
 * last saw it. Git will still replace that commit with an unrelated commit.
 * Prove reachability separately at the final publication boundary.
 */
export async function assertPublicationCandidateContainsTarget(
    projectRoot: string,
    targetCommit: string,
    candidateCommit: string,
    targetBranch: string,
): Promise<void> {
    const result = await runGitResult(projectRoot, ["merge-base", "--is-ancestor", targetCommit, candidateCommit]);
    if (result.code === 0) return;
    throw attachMergeRepairDetails(
        new Error(`Publication candidate would discard commits already on ${targetBranch}. Publication was stopped.`),
        { mergeFailureKind: "target_history_rewrite" },
    );
}

export function resolveWorktreeParent(projectRoot: string, worktreeRoot: string | undefined): string {
    if (worktreeRoot) return worktreeRoot;
    const homeDir = getHomeDir();
    if (homeDir) return join(homeDir, RUNWIELD_DIR_NAME, "worktrees", encodeCwdForSessionDir(projectRoot));
    return resolveProjectRuntimeLayout(resolveProjectRoot(projectRoot)).primary.fallbackWorktreesRoot;
}

/** Resolve creation inputs before an existing attempt is discarded. */
export async function validateWorktreeRecreation({
    projectRoot,
    planName,
    planId,
    baseRef,
}: ValidateWorktreeRecreationOptions): Promise<string> {
    await assertGitRepository(projectRoot, "Creating an execution worktree");
    if (!planId?.trim()) throw new Error(`Creating an execution worktree for ${planName} requires a stable planId.`);
    return (await runGit(projectRoot, ["rev-parse", "--verify", `${baseRef}^{commit}`])).trim();
}

/**
 * Create only the Git worktree/branch artifacts for an execution attempt. The
 * caller must settle the returned proof into the registry in the same semantic
 * transition that records Plan lifecycle metadata.
 */
export async function createWorktreeGitArtifacts({
    projectRoot,
    planName,
    planId,
    baseRef = "HEAD",
    baseBranch,
    worktreeRoot,
    attemptId,
}: CreateWorktreeGitArtifactsOptions): Promise<WorktreeRegistryEntry> {
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
    const resolvedBaseBranch = baseBranch || (await resolveCurrentCheckoutBranch(projectRoot)) || "HEAD";
    const baseCommit = (await runGit(projectRoot, ["rev-parse", baseRef])).trim();
    const baseTree = (await runGit(projectRoot, ["rev-parse", `${baseCommit}^{tree}`])).trim();

    const projectContext = await captureWorktreeProjectContext(projectRoot, baseCommit);
    await fsMkdir(parent, { recursive: true });
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

/** Settle a previously-created Git execution worktree into the durable registry. */
export async function settleWorktreeAttempt(projectRoot: string, entry: WorktreeRegistryEntry) {
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

export async function getWorktreeStatus({ path, branch, baseTree }: GetWorktreeStatusOptions) {
    if (!(await pathExists(path))) {
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
            diff = await runGit(path, ["diff", ...REVIEW_DIFF_FORMAT_ARGS]);
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

export type MergeRepairError = Error & MergeRepairDetails;

function attachMergeRepairDetails<Thrown>(error: Thrown, details: MergeRepairDetails): MergeRepairError {
    const mergeError: MergeRepairError = error instanceof Error ? error : new Error(String(error));
    if (details.repairCwd) mergeError.repairCwd = details.repairCwd;
    if (details.mergeWorktreePath) mergeError.mergeWorktreePath = details.mergeWorktreePath;
    if (details.mergeFailureKind) mergeError.mergeFailureKind = details.mergeFailureKind;
    if (details.blockingPaths?.length) mergeError.blockingPaths = details.blockingPaths;
    return mergeError;
}

async function restorePreservedPlanConflictPaths(
    cwd: string,
    branch: string,
    preservePlanPaths: string[],
): Promise<string[]> {
    if (preservePlanPaths.length === 0 || !(await isMergeInProgress(cwd))) return [];
    const preserved = new Set(preservePlanPaths.map((path) => path.replaceAll("\\", "/")));
    const unresolvedPaths = parseNameOnlyPaths(await runGit(cwd, ["diff", "--name-only", "--diff-filter=U"]));
    const preservedUnresolvedPaths = unresolvedPaths.filter((path) => preserved.has(path.replaceAll("\\", "/")));
    if (preservedUnresolvedPaths.length === 0) return [];

    await runGit(cwd, ["restore", "--staged", "--worktree", `--source=${branch}`, "--", ...preservedUnresolvedPaths]);
    await runGit(cwd, ["add", "--", ...preservedUnresolvedPaths]);
    return preservedUnresolvedPaths;
}

async function resolvePlanMergeConflicts(cwd: string, branch: string, preservePlanPaths: string[]): Promise<boolean> {
    if (!(await isMergeInProgress(cwd))) return false;
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

async function assertNoOverlappingDirtyPaths(cwd: string, branch: string, allowedDirtyPaths: string[]) {
    const allowed = new Set(allowedDirtyPaths);
    const branchChangedPaths = new Set(
        parseNulPaths(await runGit(cwd, ["diff", "--name-only", "-z", `HEAD...${branch}`, "--"])),
    );
    const blockingDirtyPaths = filterUserDirtyPaths(await gitStatusPaths(cwd), allowed).filter((path) =>
        overlapsBranchChangedPath(path, branchChangedPaths),
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

async function mergeExecutionWorktreeIntoCurrentCheckout({
    projectRoot,
    branch,
    allowedDirtyPaths = [],
    preservePlanPaths = [],
}: MergeWorktreeOptions) {
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
        const alreadyClassified = (error as MergeRepairDetails | null | undefined)?.mergeFailureKind;
        throw attachMergeRepairDetails(error, {
            repairCwd: projectRoot,
            mergeFailureKind: alreadyClassified || "current_checkout_merge_conflict",
        });
    }
}

async function cleanupDetachedMergeWorktree(projectRoot: string, mergeWorktreePath: string) {
    await runGit(projectRoot, ["worktree", "remove", "--force", mergeWorktreePath]).catch(async () => {
        if (await pathExists(mergeWorktreePath)) {
            await fsRm(mergeWorktreePath, { recursive: true }).catch(() => {});
        }
    });
}

/** true when the repaired merge was published; false when the preserved worktree was intentionally abandoned so the caller can retry a fresh detached merge. */
async function publishRepairedMergeWorktree(
    projectRoot: string,
    targetBranch: string,
    mergeWorktreePath: string,
    branch: string,
    preservePlanPaths: string[] = [],
): Promise<boolean> {
    if (!(await pathExists(mergeWorktreePath))) {
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
        const alreadyClassified = (error as MergeRepairDetails | null | undefined)?.mergeFailureKind;
        throw attachMergeRepairDetails(error, {
            repairCwd: mergeWorktreePath,
            mergeWorktreePath,
            mergeFailureKind: alreadyClassified || "detached_merge_conflict",
            blockingPaths: (error as MergeRepairDetails | null | undefined)?.blockingPaths,
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

    await assertPublicationCandidateContainsTarget(projectRoot, oldTargetCommit, mergeCommit, targetBranch);
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
}: MergeExecutionWorktreeIntoTargetBranchOptions) {
    await assertLocalBranchExists(projectRoot, branch);
    await assertLocalBranchExists(projectRoot, targetBranch);

    const checkoutPath = await findCheckoutPathForBranch(projectRoot, targetBranch);
    if (checkoutPath) {
        if (!(await isSameFilesystemPath(checkoutPath, projectRoot))) {
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
        await fsMkdir(parent, { recursive: true });
        try {
            await runGit(projectRoot, ["worktree", "add", "--detach", mergeWorktreePath, oldTargetCommit]);
            try {
                await assertNoRuntimePathsInNewHistory(mergeWorktreePath, oldTargetCommit, branch);
            } catch (error) {
                preserveMergeWorktree = true;
                throw attachMergeRepairDetails(error, {
                    repairCwd: mergeWorktreePath,
                    mergeWorktreePath,
                    mergeFailureKind: (error as MergeRepairDetails | null | undefined)?.mergeFailureKind,
                    blockingPaths: (error as MergeRepairDetails | null | undefined)?.blockingPaths,
                });
            }
            try {
                await runGit(mergeWorktreePath, ["merge", "--no-ff", branch]);
            } catch (mergeError) {
                if (!(await resolvePlanMergeConflicts(mergeWorktreePath, branch, preservePlanPaths))) {
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
                await assertPublicationCandidateContainsTarget(projectRoot, oldTargetCommit, mergeCommit, targetBranch);
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
 */
export async function inspectExecutionWorktreeMergeRisk({
    projectRoot,
    branch,
    targetBranch,
    allowedDirtyPaths = [],
}: InspectExecutionWorktreeMergeRiskOptions): Promise<InspectExecutionWorktreeMergeRiskResult> {
    const warnings: string[] = [];
    const failures: string[] = [];
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
            if (checkoutPath && !(await isSameFilesystemPath(checkoutPath, projectRoot))) {
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
            parseNulPaths(await runGit(projectRoot, ["diff", "--name-only", "-z", `${mergeTarget}...${branch}`, "--"])),
        );
        const blockingDirtyPaths = filterUserDirtyPaths(await gitStatusPaths(projectRoot), allowed).filter((path) =>
            overlapsBranchChangedPath(path, branchChangedPaths),
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

export interface MergeExecutionWorktreeResult {
    updatedPrimaryCheckout: boolean;
    executionMetadataCommit?: string;
    targetHeadBeforeMerge?: string;
}

export async function mergeExecutionWorktree({
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
}: MergeExecutionWorktreeOptions): Promise<MergeExecutionWorktreeResult | void> {
    await assertGitRepository(projectRoot, "Merging an execution worktree");
    const normalizedTargetBranch = targetBranch === "HEAD" ? undefined : targetBranch;
    let resolvedWorktreePath = worktreePath;
    if (!resolvedWorktreePath) {
        const worktreeList = await runGit(projectRoot, ["worktree", "list", "--porcelain"]);
        resolvedWorktreePath = findWorktreePathForBranch(worktreeList, branch) || undefined;
    }
    let executionMetadataCommit: string | undefined;
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
        const mergeTargetRef = (await runGit(projectRoot, ["rev-parse", normalizedTargetBranch || "HEAD"])).trim();
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
        targetCheckoutPath && (await isSameFilesystemPath(targetCheckoutPath, projectRoot)),
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

export interface DiscardWorktreeOptions {
    projectRoot: string;
    path?: string;
    branch?: string;
    baseCommit?: string;
}
export interface DiscardWorktreeResult {
    status: "path_removed" | "complete" | "retained" | "blocked";
    pathRemoved: boolean;
    branchDeleted: boolean;
    message: string;
}

/** Verify the confirmed attempt against Git before deleting any files. */
export async function validateWorktreeDiscard({ projectRoot, path, branch }: DiscardWorktreeOptions) {
    await assertGitRepository(projectRoot, "Removing an execution worktree");
    if (!path || !branch) throw new Error("The recorded worktree path and branch are required before cleanup.");
    await runGit(projectRoot, ["check-ref-format", `refs/heads/${branch}`]);
    const records = parseWorktreeRecords(await runGit(projectRoot, ["worktree", "list", "--porcelain"]));
    const primary = records[0];
    if (!primary || (await isSameFilesystemPath(primary.path, path))) {
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
    if ((await pathExists(path)) && !attached) {
        throw new Error(`The recorded path is not an attached execution worktree. Nothing was removed from ${path}.`);
    }
}

/**
 * Discard a confirmed attempt, retaining branches that contain unique commits.
 * Yield after each Git effect so the recovery transition journals it before continuing.
 */
export async function* discardWorktreeGitArtifacts(
    options: DiscardWorktreeOptions,
): AsyncGenerator<DiscardWorktreeResult, void, undefined> {
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
 */
export async function removeWorktreeGitArtifacts({
    projectRoot,
    path,
    force = false,
}: RemoveWorktreeGitArtifactsOptions) {
    await assertGitRepository(projectRoot, "Removing an execution worktree");
    const primary = parseWorktreeRecords(await runGit(projectRoot, ["worktree", "list", "--porcelain"]))[0];
    if (!primary || (await isSameFilesystemPath(primary.path, path))) {
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

export interface MergedWorktreeBranchDeletionOptions {
    projectRoot: string;
    branch: string;
    baseCommit?: string;
    ownedPreparationCommit?: string;
    targetBranch?: string;
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
 */
export async function deleteMergedWorktreeBranch({
    projectRoot,
    branch,
    baseCommit,
    ownedPreparationCommit,
    targetBranch,
}: MergedWorktreeBranchDeletionOptions): Promise<BranchDeletionResult> {
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
    const hasMergedProof =
        merged.code === 0 && merged.stdout.split("\n").some((line) => line.replace(/^\*\s*/, "").trim() === branch);
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

export interface RemotePublishedBranchDeletionOptions {
    projectRoot: string;
    branch: string;
    remote: string;
    upstreamBranch: string;
    publicationCommit: string;
    artifactCommit?: string;
}

/**
 * Delete an execution branch after an upstream publication proves its tip is
 * reachable. This fetches into a temporary RunWield ref; it never advances a
 * local target branch or changes the user's checkout.
 */
export async function deleteRemotelyPublishedWorktreeBranch({
    projectRoot,
    branch,
    remote,
    upstreamBranch,
    publicationCommit,
    artifactCommit,
}: RemotePublishedBranchDeletionOptions): Promise<BranchDeletionResult> {
    const proofRef = `refs/runwield/publication-proof/${crypto.randomUUID()}`;
    try {
        await runGit(projectRoot, ["fetch", remote, `+refs/heads/${upstreamBranch}:${proofRef}`]);
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
                    const commits =
                        descendants.code === 0
                            ? descendants.stdout
                                  .split("\n")
                                  .map((line) => line.trim())
                                  .filter(Boolean)
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

export async function pruneMissingWorktrees({ projectRoot }: PruneMissingWorktreesOptions) {
    await runGit(projectRoot, ["worktree", "prune"]).catch(() => {});
    return await pruneStaleEntries(projectRoot);
}

export async function findReusableWorktree({ projectRoot, planName, planId, worktreeId }: FindReusableWorktreeOptions) {
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
