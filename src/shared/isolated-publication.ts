/**
 * Assemble Direct Delivery in a temporary clone and push it when an upstream
 * exists. Local-only projects publish through their checked-out target branch.
 */

import { basename, dirname, join } from "@std/path";
import lockfile from "proper-lockfile";
import { assertPreMergeCandidateUnchanged, mergeExecutionWorktree } from "./worktree.js";
import { prepareProjectContextPublication, settleProjectContextPublication } from "./project-context-publication.ts";
import { enterProjectRuntime, resolveProjectRuntimeLayout } from "./project-runtime-layout.ts";
import {
    assertNoRuntimePathsInNewHistory,
    assertNoTrackedOrIndexedRuntimePaths,
    stageGitChangesExcludingRuntime,
} from "./git-runtime-safety.ts";
import {
    finalizeLocalPublicationLifecycle,
    finalizePublicationLifecycle,
    recoverLocalPublicationLifecycle,
} from "./publication-lifecycle.ts";
import { recoverSealedPlanFormatting } from "./publication-plan-formatting.ts";

interface CommandResult {
    code: number;
    stdout: string;
    stderr: string;
}

export interface IsolatedPublicationArgs {
    projectRoot: string;
    executionCwd: string;
    executionBranch: string;
    targetBranch: string;
    planName: string;
    planDescription?: string;
    sealedExecutionCommit: string;
    allowedPlanPaths: string[];
    publicationRoot?: string;
    repairedPublicationRoot?: string;
    recordedTargetBaseCommit?: string;
    onProgress?: (progress: IsolatedPublicationProgress) => void;
    onIntegrated?: (evidence: PublicationIntegrationEvidence) => Promise<void>;
    onPublished?: (evidence: PublicationPublishedEvidence) => Promise<void>;
    onVerified?: (evidence: PublicationPublishedEvidence) => Promise<void>;
}

export interface PublicationIntegrationEvidence {
    targetBaseCommit: string;
    integrationCommit: string;
}

export interface PublicationPublishedEvidence extends PublicationIntegrationEvidence {
    publicationMode: "local" | "remote";
    publishedCommit: string;
    upstreamRemote?: string;
    upstreamBranch?: string;
}

export type IsolatedPublicationProgress =
    | "preparing"
    | "reading_target"
    | "using_local_target"
    | "updating_target"
    | "combining_work"
    | "publishing"
    | "verifying";

interface PublicationResultBase {
    publicationMode: "local" | "remote";
    updatedPrimaryCheckout: boolean;
    executionMetadataCommit: string;
    targetHeadBeforeMerge: string;
    deliveryCommit: string;
    publicationCommit: string;
}

export interface LocalPublicationResult extends PublicationResultBase {
    publicationMode: "local";
}

export interface RemotePublicationResult extends PublicationResultBase {
    publicationMode: "remote";
    updatedPrimaryCheckout: false;
    upstreamRemote: string;
    upstreamBranch: string;
}

export type IsolatedPublicationResult = LocalPublicationResult | RemotePublicationResult;

interface UpstreamTarget {
    remote: string;
    branch: string;
    url: string;
}

export interface UpstreamPublicationInspectionArgs {
    projectRoot: string;
    executionBranch: string;
    targetBranch: string;
    executionCommit: string;
}

export interface TargetPublicationInspectionArgs {
    projectRoot: string;
    targetBranch: string;
    commit: string;
}

export class IsolatedPublicationError extends Error {
    repairCwd?: string;
    mergeWorktreePath?: string;
    mergeFailureKind?: string;
    blockingPaths?: string[];

    constructor(message: string, details: Partial<IsolatedPublicationError> = {}) {
        super(message);
        this.name = "IsolatedPublicationError";
        Object.assign(this, details);
    }
}

async function runGitResult(cwd: string, args: string[]): Promise<CommandResult> {
    const output = await new Deno.Command("git", { cwd, args, stdout: "piped", stderr: "piped" }).output();
    return {
        code: output.code,
        stdout: new TextDecoder().decode(output.stdout).trim(),
        stderr: new TextDecoder().decode(output.stderr).trim(),
    };
}

async function runGit(cwd: string, args: string[]): Promise<string> {
    const result = await runGitResult(cwd, args);
    if (result.code === 0) return result.stdout;
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
}

async function runGitRaw(cwd: string, args: string[]): Promise<string> {
    const output = await new Deno.Command("git", { cwd, args, stdout: "piped", stderr: "piped" }).output();
    const decoder = new TextDecoder();
    const stdout = decoder.decode(output.stdout);
    const stderr = decoder.decode(output.stderr);
    if (output.code === 0) return stdout;
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`);
}

async function resolveUpstream(projectRoot: string, targetBranch: string): Promise<UpstreamTarget | null> {
    const configuredRemote = await runGitResult(projectRoot, ["config", "--get", `branch.${targetBranch}.remote`]);
    const remote = configuredRemote.code === 0 && configuredRemote.stdout ? configuredRemote.stdout : "origin";
    if (remote === ".") {
        return null;
    }
    const remoteUrl = await runGitResult(projectRoot, ["remote", "get-url", remote]);
    if (remoteUrl.code !== 0 || !remoteUrl.stdout) {
        return null;
    }
    return { remote, branch: targetBranch, url: remoteUrl.stdout };
}

async function remoteHead(cwd: string, remote: string, branch: string): Promise<string | null> {
    const result = await runGitResult(cwd, ["ls-remote", "--heads", remote, `refs/heads/${branch}`]);
    if (result.code !== 0) {
        const detail = result.stderr || result.stdout || "Git returned no error text.";
        throw new IsolatedPublicationError(
            `Could not read the upstream ${branch} branch: ${detail}`,
            { mergeFailureKind: classifyRemoteFailure(detail) },
        );
    }
    const hash = result.stdout.split(/\s+/)[0];
    return /^[0-9a-f]{40}$/i.test(hash || "") ? hash : null;
}

async function remoteRetainsPublication(
    publicationRoot: string,
    remote: string,
    branch: string,
    commit: string,
): Promise<boolean> {
    const head = await remoteHead(publicationRoot, remote, branch);
    if (!head) return false;
    if (head === commit) return true;
    await runGit(publicationRoot, ["fetch", "--no-tags", remote, `refs/heads/${branch}`]);
    const contains = await runGitResult(publicationRoot, ["merge-base", "--is-ancestor", commit, "FETCH_HEAD"]);
    return contains.code === 0;
}

type RemoteFailureKind = "permission_denied" | "policy_violation" | "remote_unavailable";

function classifyRemoteFailure(message: string): RemoteFailureKind {
    if (
        /authentication failed|permission denied|access denied|authorization failed|publickey|could not read username/i
            .test(message)
    ) {
        return "permission_denied";
    }
    if (
        /protected branch|repository rules?|rule violations?|pre-receive hook declined|hook declined|prohibited|not allowed to push|branch permissions?|GH00[136]/i
            .test(message)
    ) {
        return "policy_violation";
    }
    return "remote_unavailable";
}

function isLeaseRace(message: string): boolean {
    return /stale info|fetch first|non-fast-forward|remote ref updated since checkout|cannot lock ref.*expected/i
        .test(message);
}

async function pushPublication(
    cwd: string,
    args: string[],
    branch: string,
    repairCwd?: string,
): Promise<void> {
    const result = await runGitResult(cwd, ["push", ...args]);
    if (result.code === 0) return;
    const detail = result.stderr || result.stdout || "Git returned no error text.";
    const remoteFailure = classifyRemoteFailure(detail);
    const mergeFailureKind = isLeaseRace(detail)
        ? "target_reference_race"
        : remoteFailure === "permission_denied" || remoteFailure === "policy_violation"
        ? remoteFailure
        : /could not resolve host|unable to access|connection (?:timed out|refused|reset)|network is unreachable|connection closed/i
                .test(detail)
        ? "remote_unavailable"
        : "publication_push_failed";
    const message = mergeFailureKind === "target_reference_race"
        ? `The upstream ${branch} branch received another commit before this push completed. Git rejected the stale force-with-lease safely.`
        : `Git could not push the completed commits to upstream ${branch}: ${detail}`;
    throw new IsolatedPublicationError(message, {
        mergeFailureKind,
        ...(repairCwd ? { repairCwd } : {}),
    });
}

async function commitPublicationMetadata(
    publicationRoot: string,
    planName: string,
    sealedCommit: string,
    allowedPlanPaths: string[],
    targetBranch: string,
): Promise<string> {
    await finalizePublicationLifecycle(publicationRoot, planName, sealedCommit, allowedPlanPaths, targetBranch);
    await assertNoTrackedOrIndexedRuntimePaths(publicationRoot);
    await stageGitChangesExcludingRuntime(publicationRoot);
    await assertNoTrackedOrIndexedRuntimePaths(publicationRoot);
    const staged = await runGit(publicationRoot, ["diff", "--cached", "--name-only"]);
    if (staged) {
        await runGit(publicationRoot, [
            "commit",
            "-m",
            `Record delivery for ${planName}`,
            "-m",
            "Record the delivered commit and generated Work Record after isolated publication assembly.",
        ]);
    }
    return await runGit(publicationRoot, ["rev-parse", "HEAD"]);
}

/**
 * Check upstream reachability without fetching into or moving refs in the user's
 * primary checkout.
 */
export async function isExecutionCommitPublishedUpstream(
    args: UpstreamPublicationInspectionArgs,
): Promise<boolean> {
    return await isCommitPublishedToTarget({
        projectRoot: args.projectRoot,
        targetBranch: args.targetBranch,
        commit: args.executionCommit,
    });
}

/**
 * Prove a commit against the configured publication authority. A configured
 * upstream is authoritative even when the user's local target branch is
 * intentionally behind it.
 */
export async function isCommitPublishedToTarget(
    args: TargetPublicationInspectionArgs,
): Promise<boolean> {
    const upstream = await resolveUpstream(args.projectRoot, args.targetBranch);
    if (!upstream) {
        const localResult = await runGitResult(args.projectRoot, [
            "merge-base",
            "--is-ancestor",
            args.commit,
            `refs/heads/${args.targetBranch}`,
        ]);
        return localResult.code === 0;
    }
    const inspectionRoot = await Deno.makeTempDir({ prefix: `runwield-inspect-${basename(args.projectRoot)}-` });
    try {
        // Reachability uses Git objects only; an inspection never needs checked-out files.
        await runGit(args.projectRoot, [
            "clone",
            "--no-hardlinks",
            "--no-checkout",
            "--origin",
            "runwield-source",
            args.projectRoot,
            inspectionRoot,
        ]);
        await runGit(inspectionRoot, ["remote", "add", "publication", upstream.url]);
        const targetHead = await remoteHead(inspectionRoot, "publication", upstream.branch);
        if (!targetHead) return false;
        await runGit(inspectionRoot, [
            "fetch",
            "publication",
            `+refs/heads/${upstream.branch}:refs/remotes/publication/${upstream.branch}`,
        ]);
        const result = await runGitResult(inspectionRoot, [
            "merge-base",
            "--is-ancestor",
            args.commit,
            `refs/remotes/publication/${upstream.branch}`,
        ]);
        return result.code === 0;
    } finally {
        await Deno.remove(inspectionRoot, { recursive: true }).catch(() => {});
    }
}

/** Publish through an isolated clone for a remote, or merge into the local target. */
export async function publishExecutionWorktreeIsolated(
    args: IsolatedPublicationArgs,
): Promise<IsolatedPublicationResult> {
    await enterProjectRuntime(args.projectRoot);
    args.onProgress?.("preparing");
    await recoverSealedPlanFormatting(args);
    await assertPreMergeCandidateUnchanged({
        worktreePath: args.executionCwd,
        sealedExecutionCommit: args.sealedExecutionCommit,
        allowedPlanPaths: [],
    });
    const executionMetadataCommit = args.sealedExecutionCommit;
    args.onProgress?.("reading_target");
    const upstream = await resolveUpstream(args.projectRoot, args.targetBranch);
    if (!upstream) {
        args.onProgress?.("using_local_target");
        // The primary index and setup recovery record belong to one publication at a time.
        const internalRoot = resolveProjectRuntimeLayout(args.projectRoot).selected.internalRoot;
        const release = await lockfile.lock(args.projectRoot, {
            lockfilePath: join(internalRoot, "local-publication.lock"),
            retries: { retries: 60, factor: 1, minTimeout: 500, maxTimeout: 500 },
        });
        try {
            return await publishToLocalTarget(args, executionMetadataCommit);
        } finally {
            await release();
        }
    }
    const requestedPublicationRoot = args.repairedPublicationRoot || args.publicationRoot;
    const requestedRootExists = requestedPublicationRoot
        ? await Deno.stat(requestedPublicationRoot).then((stat) => stat.isDirectory).catch(() => false)
        : false;
    const publicationRoot = requestedPublicationRoot ||
        await Deno.makeTempDir({ prefix: `runwield-publish-${basename(args.projectRoot)}-` });
    let preserveForRecovery = Boolean(requestedPublicationRoot);
    try {
        if (requestedRootExists) {
            const unfinishedMerge = await runGitResult(publicationRoot, ["rev-parse", "--verify", "MERGE_HEAD"]);
            if (unfinishedMerge.code === 0) {
                throw new IsolatedPublicationError(
                    `The saved publication merge for ${args.planName} still has unresolved files.`,
                    {
                        repairCwd: publicationRoot,
                        mergeWorktreePath: publicationRoot,
                        mergeFailureKind: "isolated_publication_conflict",
                    },
                );
            }
            await assertNoTrackedOrIndexedRuntimePaths(publicationRoot);
            const expectedRemoteHead = await remoteHead(publicationRoot, upstream.url, upstream.branch);
            const targetHeadBeforeMerge = expectedRemoteHead || args.recordedTargetBaseCommit ||
                await runGit(publicationRoot, ["rev-parse", "HEAD^1"]);
            const publicationHistoryBase = expectedRemoteHead ? targetHeadBeforeMerge : null;
            if (expectedRemoteHead) {
                const publicationTargetRef = `refs/remotes/publication/${upstream.branch}`;
                await runGit(publicationRoot, [
                    "fetch",
                    upstream.url,
                    `+refs/heads/${upstream.branch}:${publicationTargetRef}`,
                ]);
                const containsRemoteHead = await runGitResult(publicationRoot, [
                    "merge-base",
                    "--is-ancestor",
                    expectedRemoteHead,
                    "HEAD",
                ]);
                if (containsRemoteHead.code !== 0) {
                    args.onProgress?.("updating_target");
                    try {
                        await assertNoRuntimePathsInNewHistory(
                            publicationRoot,
                            targetHeadBeforeMerge,
                            publicationTargetRef,
                        );
                        await runGit(publicationRoot, [
                            "merge",
                            "--no-ff",
                            publicationTargetRef,
                            "-m",
                            `Integrate ${upstream.remote}/${upstream.branch} before RunWield publication`,
                        ]);
                    } catch (error) {
                        const mergeError = error instanceof Error ? error : new Error(String(error));
                        const classified = mergeError as IsolatedPublicationError;
                        const runtimeRefusal = classified.mergeFailureKind === "runwield_runtime_tracked";
                        throw new IsolatedPublicationError(mergeError.message, {
                            repairCwd: publicationRoot,
                            mergeWorktreePath: publicationRoot,
                            mergeFailureKind: runtimeRefusal ? classified.mergeFailureKind : "target_sync_conflict",
                            blockingPaths: classified.blockingPaths,
                        });
                    }
                }
            }
            // The execution worktree can gain a final lifecycle commit after the
            // repair clone was created. A clone owns a separate object database, so
            // referring to that new commit by hash before fetching it produces
            // "not something we can merge" forever on every retry.
            const sourceRemote = await runGitResult(publicationRoot, ["remote", "get-url", "runwield-source"]);
            if (sourceRemote.code !== 0) {
                await runGit(publicationRoot, ["remote", "add", "runwield-source", args.projectRoot]);
            }
            await runGit(publicationRoot, [
                "fetch",
                "runwield-source",
                `+refs/heads/${args.executionBranch}:refs/remotes/runwield-source/${args.executionBranch}`,
            ]);
            args.onProgress?.("combining_work");
            const containsExecutionHead = await runGitResult(publicationRoot, [
                "merge-base",
                "--is-ancestor",
                args.sealedExecutionCommit,
                "HEAD",
            ]);
            if (containsExecutionHead.code !== 0) {
                await assertNoRuntimePathsInNewHistory(
                    publicationRoot,
                    publicationHistoryBase,
                    args.sealedExecutionCommit,
                );
                await runGit(publicationRoot, [
                    "merge",
                    "--no-ff",
                    args.sealedExecutionCommit,
                    "-m",
                    `Include final validated state for ${args.planName}`,
                ]);
            }
            const deliveryCommit = await runGit(publicationRoot, ["rev-parse", "HEAD"]);
            await assertNoRuntimePathsInNewHistory(
                publicationRoot,
                publicationHistoryBase,
                deliveryCommit,
            );
            preserveForRecovery = true;
            const publicationCommit = await commitPublicationMetadata(
                publicationRoot,
                args.planName,
                args.sealedExecutionCommit,
                args.allowedPlanPaths,
                upstream.branch,
            );
            await assertNoRuntimePathsInNewHistory(
                publicationRoot,
                publicationHistoryBase,
                publicationCommit,
            );
            await args.onIntegrated?.({
                targetBaseCommit: targetHeadBeforeMerge,
                integrationCommit: publicationCommit,
            });
            const lease = expectedRemoteHead || "";
            args.onProgress?.("publishing");
            await pushPublication(
                publicationRoot,
                [
                    `--force-with-lease=refs/heads/${upstream.branch}:${lease}`,
                    upstream.url,
                    `HEAD:refs/heads/${upstream.branch}`,
                ],
                upstream.branch,
                publicationRoot,
            );
            const publishedEvidence: PublicationPublishedEvidence = {
                targetBaseCommit: targetHeadBeforeMerge,
                integrationCommit: publicationCommit,
                publicationMode: "remote",
                publishedCommit: publicationCommit,
                upstreamRemote: upstream.remote,
                upstreamBranch: upstream.branch,
            };
            await args.onPublished?.(publishedEvidence);
            args.onProgress?.("verifying");
            if (!(await remoteRetainsPublication(publicationRoot, upstream.url, upstream.branch, publicationCommit))) {
                throw new IsolatedPublicationError(
                    `The upstream target did not retain the completed publication for ${args.planName}.`,
                    { mergeFailureKind: "publication_verification_failed", repairCwd: publicationRoot },
                );
            }
            await args.onVerified?.(publishedEvidence);
            preserveForRecovery = Boolean(requestedPublicationRoot);
            return {
                publicationMode: "remote",
                updatedPrimaryCheckout: false,
                executionMetadataCommit,
                targetHeadBeforeMerge,
                deliveryCommit,
                publicationCommit,
                upstreamRemote: upstream.remote,
                upstreamBranch: upstream.branch,
            };
        }
        await Deno.mkdir(dirname(publicationRoot), { recursive: true });
        // Keep a usable checkout if the upstream fails before preparation finishes:
        // a saved publication directory can be resumed through the repair path.
        await runGit(args.projectRoot, [
            "clone",
            "--no-hardlinks",
            "--origin",
            "runwield-source",
            args.projectRoot,
            publicationRoot,
        ]);
        await runGit(publicationRoot, ["remote", "add", "publication", upstream.url]);
        for (const key of ["user.name", "user.email"]) {
            const value = await runGitResult(args.projectRoot, ["config", "--get", key]);
            if (value.code === 0 && value.stdout) await runGit(publicationRoot, ["config", key, value.stdout]);
        }
        const expectedRemoteHead = await remoteHead(publicationRoot, "publication", upstream.branch);
        if (expectedRemoteHead) {
            await runGit(publicationRoot, [
                "fetch",
                "publication",
                `+refs/heads/${upstream.branch}:refs/remotes/publication/${upstream.branch}`,
            ]);
        }
        await runGit(publicationRoot, [
            "fetch",
            "runwield-source",
            `+refs/heads/${args.targetBranch}:refs/remotes/runwield-source/${args.targetBranch}`,
            `+refs/heads/${args.executionBranch}:refs/remotes/runwield-source/${args.executionBranch}`,
        ]);
        await runGit(publicationRoot, [
            "checkout",
            "-B",
            args.targetBranch,
            `refs/remotes/runwield-source/${args.targetBranch}`,
        ]);
        const sourceTargetHead = await runGit(publicationRoot, ["rev-parse", "HEAD"]);

        if (expectedRemoteHead) {
            const containsRemote = await runGitResult(publicationRoot, [
                "merge-base",
                "--is-ancestor",
                expectedRemoteHead,
                "HEAD",
            ]);
            if (containsRemote.code !== 0) {
                args.onProgress?.("updating_target");
                try {
                    await assertNoRuntimePathsInNewHistory(
                        publicationRoot,
                        sourceTargetHead,
                        `refs/remotes/publication/${upstream.branch}`,
                    );
                    await runGit(publicationRoot, [
                        "merge",
                        "--no-ff",
                        `refs/remotes/publication/${upstream.branch}`,
                        "-m",
                        `Integrate ${upstream.remote}/${upstream.branch} before RunWield publication`,
                    ]);
                } catch (error) {
                    preserveForRecovery = true;
                    const mergeError = error instanceof Error ? error : new Error(String(error));
                    const classified = mergeError as IsolatedPublicationError;
                    const runtimeRefusal = classified.mergeFailureKind === "runwield_runtime_tracked";
                    throw new IsolatedPublicationError(mergeError.message, {
                        repairCwd: publicationRoot,
                        mergeWorktreePath: publicationRoot,
                        mergeFailureKind: runtimeRefusal ? classified.mergeFailureKind : "target_sync_conflict",
                        blockingPaths: classified.blockingPaths,
                    });
                }
            }
        }
        const targetHeadBeforeMerge = expectedRemoteHead || sourceTargetHead;
        const publicationHistoryBase = expectedRemoteHead ? targetHeadBeforeMerge : null;
        await runGit(publicationRoot, [
            "branch",
            "-f",
            args.executionBranch,
            `refs/remotes/runwield-source/${args.executionBranch}`,
        ]);
        args.onProgress?.("combining_work");
        try {
            await assertNoRuntimePathsInNewHistory(publicationRoot, publicationHistoryBase, args.sealedExecutionCommit);
            await mergeExecutionWorktree({
                projectRoot: publicationRoot,
                branch: args.executionBranch,
                targetBranch: args.targetBranch,
                preservePlanPaths: args.allowedPlanPaths,
            });
        } catch (error) {
            preserveForRecovery = true;
            const mergeError = error instanceof Error ? error : new Error(String(error));
            const classified = mergeError as IsolatedPublicationError;
            const runtimeRefusal = classified.mergeFailureKind === "runwield_runtime_tracked";
            throw new IsolatedPublicationError(mergeError.message, {
                repairCwd: publicationRoot,
                mergeWorktreePath: publicationRoot,
                mergeFailureKind: runtimeRefusal ? classified.mergeFailureKind : "isolated_publication_conflict",
                blockingPaths: classified.blockingPaths,
            });
        }
        const deliveryCommit = await runGit(publicationRoot, ["rev-parse", "HEAD"]);
        await assertNoRuntimePathsInNewHistory(publicationRoot, publicationHistoryBase, deliveryCommit);
        preserveForRecovery = true;
        const publicationCommit = await commitPublicationMetadata(
            publicationRoot,
            args.planName,
            args.sealedExecutionCommit,
            args.allowedPlanPaths,
            upstream.branch,
        );
        await assertNoRuntimePathsInNewHistory(publicationRoot, publicationHistoryBase, publicationCommit);
        await args.onIntegrated?.({
            targetBaseCommit: targetHeadBeforeMerge,
            integrationCommit: publicationCommit,
        });
        const lease = expectedRemoteHead || "";
        args.onProgress?.("publishing");
        await pushPublication(publicationRoot, [
            `--force-with-lease=refs/heads/${upstream.branch}:${lease}`,
            "publication",
            `HEAD:refs/heads/${upstream.branch}`,
        ], upstream.branch);
        const publishedEvidence: PublicationPublishedEvidence = {
            targetBaseCommit: targetHeadBeforeMerge,
            integrationCommit: publicationCommit,
            publicationMode: "remote",
            publishedCommit: publicationCommit,
            upstreamRemote: upstream.remote,
            upstreamBranch: upstream.branch,
        };
        await args.onPublished?.(publishedEvidence);
        args.onProgress?.("verifying");
        if (!(await remoteRetainsPublication(publicationRoot, "publication", upstream.branch, publicationCommit))) {
            throw new IsolatedPublicationError(
                `The upstream target did not retain the completed publication for ${args.planName}.`,
                { mergeFailureKind: "publication_verification_failed" },
            );
        }
        await args.onVerified?.(publishedEvidence);
        preserveForRecovery = Boolean(requestedPublicationRoot);
        return {
            publicationMode: "remote",
            updatedPrimaryCheckout: false,
            executionMetadataCommit,
            targetHeadBeforeMerge,
            deliveryCommit,
            publicationCommit,
            upstreamRemote: upstream.remote,
            upstreamBranch: upstream.branch,
        };
    } finally {
        if (!preserveForRecovery) await Deno.remove(publicationRoot, { recursive: true }).catch(() => {});
    }
}

async function publishToLocalTarget(
    args: IsolatedPublicationArgs,
    executionMetadataCommit: string,
): Promise<LocalPublicationResult> {
    if (args.repairedPublicationRoot) {
        throw new IsolatedPublicationError(
            "RunWield cannot reuse a remote publication repair after the project changed to local publication.",
            { mergeFailureKind: "publication_target_changed" },
        );
    }
    await recoverLocalPublicationLifecycle(args.projectRoot, args.targetBranch, args.sealedExecutionCommit);
    const targetHeadBeforeMerge = await runGit(args.projectRoot, ["rev-parse", `refs/heads/${args.targetBranch}`]);
    const primaryBranch = await runGit(args.projectRoot, ["branch", "--show-current"]);
    const updatedPrimaryCheckout = primaryBranch === args.targetBranch;
    const savedAuthoritativePlans = new Map<string, Uint8Array>();
    try {
        if (updatedPrimaryCheckout) {
            await prepareProjectContextPublication(args.projectRoot, args.executionCwd, args.sealedExecutionCommit);
            const trackedChanges = (await runGitRaw(args.projectRoot, ["diff", "--name-only", "-z", "HEAD", "--"]))
                .split("\0")
                .filter((path) => path.length > 0);
            const allowedPrimaryChanges = new Set(args.allowedPlanPaths);
            const blockingTrackedChanges = trackedChanges.filter((path) => !allowedPrimaryChanges.has(path));
            if (blockingTrackedChanges.length > 0) {
                throw new IsolatedPublicationError(
                    `The checked-out ${args.targetBranch} branch has unsaved tracked changes. ` +
                        `Commit or discard them before retrying local publication: ${
                            blockingTrackedChanges.join(", ")
                        }.`,
                    { mergeFailureKind: "primary_checkout_dirty", blockingPaths: blockingTrackedChanges },
                );
            }
            for (const relativePath of args.allowedPlanPaths) {
                const staged = await runGitResult(args.projectRoot, [
                    "diff",
                    "--cached",
                    "--quiet",
                    "--",
                    relativePath,
                ]);
                if (staged.code !== 0) {
                    throw new IsolatedPublicationError(
                        `The project folder has a staged change to ${relativePath}. Commit or unstage it before retrying.`,
                        { mergeFailureKind: "primary_checkout_dirty", blockingPaths: [relativePath] },
                    );
                }
            }
            for (const relativePath of args.allowedPlanPaths) {
                const path = join(args.projectRoot, relativePath);
                const bytes = await Deno.readFile(path).catch((error) => {
                    if (error instanceof Deno.errors.NotFound) return null;
                    throw error;
                });
                if (!bytes) continue;
                const changed = await runGitResult(args.projectRoot, ["diff", "--quiet", "--", relativePath]);
                const tracked = await runGitResult(args.projectRoot, ["ls-files", "--error-unmatch", relativePath]);
                if (changed.code === 0 && tracked.code === 0) continue;
                savedAuthoritativePlans.set(relativePath, bytes);
                if (tracked.code === 0) {
                    await runGit(args.projectRoot, ["restore", "--worktree", "--source=HEAD", "--", relativePath]);
                } else {
                    await Deno.remove(path);
                }
            }
        }
        args.onProgress?.("combining_work");
        await assertNoRuntimePathsInNewHistory(args.projectRoot, targetHeadBeforeMerge, args.sealedExecutionCommit);
        await mergeExecutionWorktree({
            projectRoot: args.projectRoot,
            branch: args.executionBranch,
            targetBranch: args.targetBranch,
            worktreePath: args.executionCwd,
            preservePlanPaths: [],
            expectedTargetHead: targetHeadBeforeMerge,
            sealedExecutionCommit: args.sealedExecutionCommit,
            planName: args.planName,
            planDescription: args.planDescription,
        });
        args.onProgress?.("verifying");
        const publicationCommit = await finalizeLocalPublicationLifecycle(
            args.projectRoot,
            args.targetBranch,
            args.planName,
            args.sealedExecutionCommit,
            args.allowedPlanPaths,
        );
        await assertNoRuntimePathsInNewHistory(args.projectRoot, targetHeadBeforeMerge, publicationCommit);
        if (updatedPrimaryCheckout) await settleProjectContextPublication(args.projectRoot);
        await args.onIntegrated?.({
            targetBaseCommit: targetHeadBeforeMerge,
            integrationCommit: publicationCommit,
        });
        const publishedEvidence: PublicationPublishedEvidence = {
            targetBaseCommit: targetHeadBeforeMerge,
            integrationCommit: publicationCommit,
            publicationMode: "local",
            publishedCommit: publicationCommit,
        };
        await args.onPublished?.(publishedEvidence);
        const containsCandidate = await runGitResult(args.projectRoot, [
            "merge-base",
            "--is-ancestor",
            args.sealedExecutionCommit,
            publicationCommit,
        ]);
        if (containsCandidate.code !== 0) {
            throw new IsolatedPublicationError(
                `The local ${args.targetBranch} branch does not contain the validated work.`,
                { mergeFailureKind: "publication_verification_failed" },
            );
        }
        await args.onVerified?.(publishedEvidence);
        return {
            publicationMode: "local",
            updatedPrimaryCheckout,
            executionMetadataCommit,
            targetHeadBeforeMerge,
            deliveryCommit: publicationCommit,
            publicationCommit,
        };
    } catch (error) {
        const mergeHead = await runGitResult(args.projectRoot, ["rev-parse", "--verify", "MERGE_HEAD"]);
        if (updatedPrimaryCheckout && mergeHead.code === 0) await runGitResult(args.projectRoot, ["merge", "--abort"]);
        const currentTargetHead = await runGitResult(args.projectRoot, [
            "rev-parse",
            `refs/heads/${args.targetBranch}`,
        ]);
        const targetMoved = currentTargetHead.code === 0 && currentTargetHead.stdout !== targetHeadBeforeMerge;
        let restorationError: Error | undefined;
        if (!targetMoved) {
            for (const [relativePath, bytes] of savedAuthoritativePlans) {
                const path = join(args.projectRoot, relativePath);
                try {
                    await Deno.mkdir(dirname(path), { recursive: true });
                    await Deno.writeFile(path, bytes);
                } catch (restoreError) {
                    restorationError = restoreError instanceof Error ? restoreError : new Error(String(restoreError));
                }
            }
        }
        try {
            if (updatedPrimaryCheckout) await settleProjectContextPublication(args.projectRoot);
        } catch (restoreError) {
            restorationError = restoreError instanceof Error ? restoreError : new Error(String(restoreError));
        }
        if (restorationError) throw restorationError;
        if (error instanceof IsolatedPublicationError || error instanceof Error) {
            const classified = error as IsolatedPublicationError;
            if (classified.mergeFailureKind === "current_checkout_merge_conflict") {
                classified.mergeFailureKind = "local_publication_conflict";
                classified.repairCwd = undefined;
                classified.mergeWorktreePath = undefined;
            }
        }
        throw error;
    }
}
