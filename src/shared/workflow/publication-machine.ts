/**
 * Storage boundary for the durable publication state machine.
 *
 * The worktree registry entry is the only mutable publication authority. Plan
 * front matter remains validation truth, and Git refs/commits are the evidence
 * used to prove each transition.
 */

import { join } from "@std/path";
import { SYSTEM_WORK_RECORD_MNEMOTECA_PORT, type WorkRecordMnemotecaPort } from "../work-records/mnemoteca-port.ts";
import { hasFinalizedPublicationLifecycle, indexPublishedWorkRecords } from "../publication-lifecycle.ts";
import { canonicalizeStoredPlanName, isChildFeaturePlan, parsePlanFrontMatter } from "../../plan-store.js";
import { isTerminalWorkRecordParent } from "../work-records/auto-generation.ts";
import { enterProjectRuntime, resolveProjectRoot, resolveProjectRuntimeLayout } from "../project-runtime-layout.ts";
import { findById, pruneEntry, updatePublication } from "../worktree-registry.js";
import { existingPublicationSavedFiles, preserveUnregisteredPublicationFiles } from "./publication-leftover-files.ts";
import {
    deleteMergedWorktreeBranch,
    deleteRemotelyPublishedWorktreeBranch,
    removeWorktreeGitArtifacts,
} from "../worktree.js";
import { writeControllerState } from "./controller-registry.ts";
import {
    advancePublicationAttempt,
    assertPublicationAttempt,
    createPublicationAttempt,
    type PublicationAttempt,
    type PublicationFailure,
    type PublicationPhase,
    publicationPhaseAtLeast,
    type PublicationPhaseEvidence,
    recordPublicationFailure,
} from "./publication-attempt.ts";

type GitResult = { code: number; stdout: string; stderr: string };

async function git(cwd: string, args: string[]): Promise<GitResult> {
    const output = await new Deno.Command("git", { cwd, args, stdout: "piped", stderr: "piped" }).output();
    const decoder = new TextDecoder();
    return {
        code: output.code,
        stdout: decoder.decode(output.stdout).trim(),
        stderr: decoder.decode(output.stderr).trim(),
    };
}

async function gitAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
    return (await git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant])).code === 0;
}

async function artifactEvidence(attempt: PublicationAttempt): Promise<PublicationPhaseEvidence | null> {
    const head = await git(attempt.executionCwd, ["rev-parse", `refs/heads/${attempt.executionBranch}`]);
    if (head.code !== 0 || !head.stdout || head.stdout === attempt.validatedCommit) return null;
    if (!(await gitAncestor(attempt.executionCwd, attempt.validatedCommit, head.stdout))) return null;
    const count = await git(attempt.executionCwd, [
        "rev-list",
        "--count",
        `${attempt.validatedCommit}..${head.stdout}`,
    ]);
    if (count.code !== 0 || count.stdout !== "1") return null;
    const message = await git(attempt.executionCwd, ["show", "-s", "--format=%B", head.stdout]);
    if (message.code !== 0) return null;
    const attemptMarker = `RunWield-Publication-Attempt: ${attempt.attemptId}`;
    if (!message.stdout.split("\n").includes(attemptMarker)) return null;
    const planPaths = message.stdout.split("\n").flatMap((line) => {
        const prefix = "RunWield-Publication-Plan-Path: ";
        return line.startsWith(prefix) && line.slice(prefix.length).trim() ? [line.slice(prefix.length).trim()] : [];
    });
    if (planPaths.length === 0) return null;
    return { artifactCommit: head.stdout, planPaths: [...new Set(planPaths)] };
}

async function resolveRemoteTarget(
    projectRoot: string,
    targetBranch: string,
): Promise<{ remote: string; branch: string; url: string } | null> {
    const configuredRemote = await git(projectRoot, ["config", "--get", `branch.${targetBranch}.remote`]);
    const remote = configuredRemote.code === 0 && configuredRemote.stdout ? configuredRemote.stdout : "origin";
    if (remote === ".") return null;
    const url = await git(projectRoot, ["remote", "get-url", remote]);
    if (url.code !== 0 || !url.stdout) return null;
    return { remote, branch: targetBranch, url: url.stdout };
}

async function integratedEvidence(
    projectRoot: string,
    attempt: PublicationAttempt,
): Promise<PublicationPhaseEvidence | null> {
    const stat = await Deno.stat(attempt.publicationRoot).catch(() => null);
    if (!stat?.isDirectory) return null;
    if ((await git(attempt.publicationRoot, ["rev-parse", "--verify", "MERGE_HEAD"])).code === 0) return null;
    const head = await git(attempt.publicationRoot, ["rev-parse", "HEAD"]);
    if (head.code !== 0 || !head.stdout) return null;
    if (!(await gitAncestor(attempt.publicationRoot, attempt.artifactCommit || "", head.stdout))) return null;
    if (
        attempt.deliveryMetadataVersion &&
        !(await hasFinalizedPublicationLifecycle(
            attempt.publicationRoot,
            head.stdout,
            attempt.planName,
            attempt.planId,
            attempt.artifactCommit,
            attempt.planPaths,
        ))
    ) return null;
    const merges = await git(attempt.publicationRoot, ["rev-list", "--merges", "--first-parent", "HEAD"]);
    let assembledTargetBase: string | null = null;
    for (const merge of merges.stdout.split("\n").filter(Boolean)) {
        const parents = await git(attempt.publicationRoot, ["rev-parse", `${merge}^1`, `${merge}^2`]);
        if (parents.code !== 0) continue;
        const [firstParent, secondParent] = parents.stdout.split("\n");
        if (!firstParent || !secondParent) continue;
        if (
            secondParent === attempt.artifactCommit || await gitAncestor(
                attempt.publicationRoot,
                attempt.artifactCommit || "",
                secondParent,
            )
        ) {
            assembledTargetBase = firstParent;
            break;
        }
    }
    if (!assembledTargetBase) return null;

    const remote = await resolveRemoteTarget(projectRoot, attempt.targetBranch);
    if (!remote) {
        return { targetBaseCommit: assembledTargetBase, integrationCommit: head.stdout };
    }
    const remoteHeadResult = await git(attempt.publicationRoot, [
        "ls-remote",
        "--heads",
        remote.url,
        `refs/heads/${remote.branch}`,
    ]);
    if (remoteHeadResult.code !== 0) return null;
    const remoteHead = remoteHeadResult.stdout.split(/\s+/)[0] || "";
    if (!remoteHead) {
        return { targetBaseCommit: assembledTargetBase, integrationCommit: head.stdout };
    }
    if (remoteHead === head.stdout) {
        const trackedRemote = await git(attempt.publicationRoot, [
            "rev-parse",
            `refs/remotes/publication/${remote.branch}`,
        ]);
        if (
            trackedRemote.code === 0 && trackedRemote.stdout && trackedRemote.stdout !== head.stdout &&
            await gitAncestor(attempt.publicationRoot, trackedRemote.stdout, head.stdout)
        ) {
            return { targetBaseCommit: trackedRemote.stdout, integrationCommit: head.stdout };
        }
        return { targetBaseCommit: assembledTargetBase, integrationCommit: head.stdout };
    }
    if (!(await gitAncestor(attempt.publicationRoot, remoteHead, head.stdout))) return null;
    return { targetBaseCommit: remoteHead, integrationCommit: head.stdout };
}

async function publishedEvidence(
    projectRoot: string,
    attempt: PublicationAttempt,
): Promise<PublicationPhaseEvidence | null> {
    const integrationCommit = attempt.integrationCommit;
    const targetBaseCommit = attempt.targetBaseCommit;
    if (!integrationCommit || !targetBaseCommit) return null;
    let remote = attempt.publicationMode === "local"
        ? null
        : await resolveRemoteTarget(projectRoot, attempt.targetBranch);
    if (attempt.publicationMode === "remote") {
        // Once published, changed branch configuration must not change which
        // upstream supplies the proof, or silently fall back to local history.
        if (!attempt.upstreamRemote || !attempt.upstreamBranch) return null;
        const url = await git(projectRoot, ["remote", "get-url", attempt.upstreamRemote]);
        if (url.code !== 0 || !url.stdout) return null;
        remote = { remote: attempt.upstreamRemote, branch: attempt.upstreamBranch, url: url.stdout };
    }
    if (!remote) {
        const target = `refs/heads/${attempt.targetBranch}`;
        if (!(await gitAncestor(projectRoot, integrationCommit, target))) return null;
        if (
            attempt.deliveryMetadataVersion &&
            !(await hasFinalizedPublicationLifecycle(
                projectRoot,
                integrationCommit,
                attempt.planName,
                attempt.planId,
                attempt.artifactCommit,
                attempt.planPaths,
            ))
        ) return null;
        return {
            targetBaseCommit,
            integrationCommit,
            publicationMode: "local",
            publishedCommit: integrationCommit,
        };
    }
    const remoteHead = await git(projectRoot, ["ls-remote", "--heads", remote.url, `refs/heads/${remote.branch}`]);
    if (remoteHead.code !== 0) return null;
    const head = remoteHead.stdout.split(/\s+/)[0] || "";
    if (!head) return null;
    if (head !== integrationCommit || attempt.deliveryMetadataVersion) {
        // The publication clone may already have been cleaned up. Fetch into an
        // independent bare repository, never the user's checkout or its refs.
        const inspectionRoot = await Deno.makeTempDir({ prefix: "runwield-publication-proof-" });
        try {
            if ((await git(projectRoot, ["init", "--bare", inspectionRoot])).code !== 0) return null;
            const fetched = await git(projectRoot, [
                "--git-dir",
                inspectionRoot,
                "fetch",
                "--no-tags",
                remote.url,
                `refs/heads/${remote.branch}`,
            ]);
            if (fetched.code !== 0 || !(await gitAncestor(inspectionRoot, integrationCommit, "FETCH_HEAD"))) {
                return null;
            }
            if (
                attempt.deliveryMetadataVersion &&
                !(await hasFinalizedPublicationLifecycle(
                    inspectionRoot,
                    integrationCommit,
                    attempt.planName,
                    attempt.planId,
                    attempt.artifactCommit,
                    attempt.planPaths,
                ))
            ) return null;
        } finally {
            await Deno.remove(inspectionRoot, { recursive: true });
        }
    }
    return {
        targetBaseCommit,
        integrationCommit,
        publicationMode: "remote",
        publishedCommit: integrationCommit,
        upstreamRemote: remote.remote,
        upstreamBranch: remote.branch,
    };
}

export function publicationRootForAttempt(projectRoot: string, attemptId: string): string {
    return join(resolveProjectRuntimeLayout(resolveProjectRoot(projectRoot)).primary.publicationStagingRoot, attemptId);
}

export async function loadPublicationAttempt(
    projectRoot: string,
    attemptId: string,
): Promise<PublicationAttempt | null> {
    // Registry reads validate the runtime layout under their own read scope.
    // Do not repeat the same preflight immediately before entering that boundary.
    const entry = await findById(projectRoot, attemptId, { migrate: false });
    if (!entry?.publication) return null;
    assertPublicationAttempt(entry.publication);
    return entry.publication;
}

export async function startPublicationAttempt(args: {
    projectRoot: string;
    attemptId: string;
    planName: string;
    targetBranch: string;
    executionBranch: string;
    executionCwd: string;
    validatedCommit: string;
    targetHeadAtSeal: string;
}): Promise<PublicationAttempt> {
    const entry = await findById(args.projectRoot, args.attemptId, { migrate: false });
    if (!entry) throw new Error(`Worktree registry entry not found: ${args.attemptId}`);
    if (!entry.planId) throw new Error(`Worktree registry entry ${args.attemptId} has no Plan identity.`);
    if (entry.publication) {
        assertPublicationAttempt(entry.publication);
        const current = entry.publication;
        const identities = [
            ["planName", current.planName, args.planName],
            ["targetBranch", current.targetBranch, args.targetBranch],
            ["executionBranch", current.executionBranch, args.executionBranch],
            ["executionCwd", current.executionCwd, args.executionCwd],
        ];
        const mismatch = identities.find(([, currentValue, expectedValue]) => currentValue !== expectedValue);
        if (mismatch) {
            throw new Error(
                `Publication attempt ${args.attemptId} changed ${mismatch[0]} from ${mismatch[1]} to ${mismatch[2]}.`,
            );
        }
        return current;
    }
    const publication = createPublicationAttempt({
        attemptId: args.attemptId,
        planId: entry.planId,
        planName: args.planName,
        targetBranch: args.targetBranch,
        executionBranch: args.executionBranch,
        executionCwd: args.executionCwd,
        publicationRoot: publicationRootForAttempt(args.projectRoot, args.attemptId),
        validatedCommit: args.validatedCommit,
        targetHeadAtSeal: args.targetHeadAtSeal,
    });
    publication.deliveryMetadataVersion = 1;
    await updatePublication(args.projectRoot, args.attemptId, null, publication);
    return publication;
}

export async function advanceStoredPublication(
    projectRoot: string,
    current: PublicationAttempt,
    phase: PublicationPhase,
    evidence: PublicationPhaseEvidence,
): Promise<PublicationAttempt> {
    if (current.revalidation) throw new Error("Publication is waiting for validation of the current source.");
    const mismatch = Object.entries(evidence).find(([field, expected]) => {
        if (expected === undefined) return false;
        const actual = current[field as keyof PublicationAttempt];
        if (Array.isArray(actual) && Array.isArray(expected)) {
            return actual.length !== expected.length || actual.some((value, index) => value !== expected[index]);
        }
        return actual !== expected;
    });
    if (publicationPhaseAtLeast(current.phase, phase)) {
        // This path may return without a registry read or write. It still needs
        // a fresh safety check; advancing writes validate in updatePublication.
        await enterProjectRuntime(projectRoot);
        if (!mismatch) return current;
        if (current.phase !== "target_integrated" || phase !== "target_integrated") {
            const [field, expected] = mismatch;
            const actual = current[field as keyof PublicationAttempt];
            throw new Error(
                `Publication ${current.attemptId} has conflicting ${field}: ${String(actual)} != ${String(expected)}.`,
            );
        }
    }
    const next = advancePublicationAttempt(current, phase, evidence);
    try {
        await updatePublication(projectRoot, current.attemptId, current.revision, next);
        return next;
    } catch (error) {
        const refreshed = await loadPublicationAttempt(projectRoot, current.attemptId);
        if (!refreshed || refreshed.revision === current.revision) throw error;
        return await advanceStoredPublication(projectRoot, refreshed, phase, evidence);
    }
}

export async function failStoredPublication(
    projectRoot: string,
    current: PublicationAttempt,
    failure: Omit<PublicationFailure, "phase" | "recordedAt"> & { phase?: PublicationPhase },
): Promise<PublicationAttempt> {
    const next = recordPublicationFailure(current, failure);
    try {
        await updatePublication(projectRoot, current.attemptId, current.revision, next);
        return next;
    } catch (error) {
        const refreshed = await loadPublicationAttempt(projectRoot, current.attemptId);
        if (!refreshed || refreshed.revision === current.revision) throw error;
        return refreshed;
    }
}

/**
 * Advance a restarted publication only when current Git facts prove an external
 * effect completed before its registry write. No Plan status or prior error text
 * participates in this decision.
 */
export async function reconcileStoredPublication(
    projectRoot: string,
    initial: PublicationAttempt,
): Promise<PublicationAttempt> {
    await enterProjectRuntime(projectRoot);
    if (initial.revalidation) return initial;
    let current = initial;
    if (current.phase === "candidate_sealed") {
        const evidence = await artifactEvidence(current);
        if (evidence) current = await advanceStoredPublication(projectRoot, current, "artifacts_committed", evidence);
    }
    if (current.phase === "artifacts_committed") {
        const evidence = await integratedEvidence(projectRoot, current);
        if (evidence) {
            current = await advanceStoredPublication(projectRoot, current, "target_integrated", evidence);
        }
    }
    if (current.phase === "target_integrated") {
        const evidence = await publishedEvidence(projectRoot, current);
        if (evidence) current = await advanceStoredPublication(projectRoot, current, "target_published", evidence);
    }
    if (current.phase === "target_published") {
        const evidence = await publishedEvidence(projectRoot, current);
        if (evidence) {
            current = await advanceStoredPublication(projectRoot, current, "publication_verified", {
                verifiedAt: new Date().toISOString(),
            });
        }
    }
    return current;
}

export type PublicationCleanupResult = {
    complete: boolean;
    attempt: PublicationAttempt;
    worktreeKept: boolean;
    branchKept: boolean;
    details: string[];
    preservedFiles?: string;
};

async function retainPublicationCompletion(projectRoot: string, attempt: PublicationAttempt): Promise<void> {
    if (!attempt.verifiedAt) return;
    await writeControllerState(projectRoot, { planId: attempt.planId, planName: attempt.planName }, {
        verifiedAt: attempt.verifiedAt,
        publicationReceipt: attempt.publishedCommit
            ? {
                validatedCommit: attempt.validatedCommit,
                publishedCommit: attempt.publishedCommit,
                targetBranch: attempt.targetBranch,
            }
            : null,
        updatedAt: attempt.verifiedAt,
    });
}

/** Retry against current target records so an older delivery cannot undo later supersession. */
async function settlePublicationIndex(
    projectRoot: string,
    attempt: PublicationAttempt,
    port: WorkRecordMnemotecaPort,
): Promise<void> {
    if (!attempt.publishedCommit) return;
    const paths = attempt.planPaths || [`docs/plans/${attempt.planName}.md`];
    if (attempt.publicationMode === "local") {
        const head = await git(projectRoot, ["rev-parse", `refs/heads/${attempt.targetBranch}`]);
        if (head.code !== 0 || !await gitAncestor(projectRoot, attempt.publishedCommit, head.stdout)) {
            throw new Error("Published Work Record source cannot be proven on its target.");
        }
        await indexPublishedWorkRecords(projectRoot, projectRoot, head.stdout, paths, port, attempt.publishedCommit);
        return;
    }
    if (attempt.publicationMode !== "remote" || !attempt.upstreamRemote || !attempt.upstreamBranch) {
        throw new Error("Published Work Record source is unavailable.");
    }
    // Delivery fixes the upstream identity. Later branch configuration cannot
    // redirect index recovery to a different repository or branch.
    const remoteUrl = await git(projectRoot, ["remote", "get-url", attempt.upstreamRemote]);
    if (remoteUrl.code !== 0 || !remoteUrl.stdout) throw new Error("Published Work Record upstream is unavailable.");
    const inspection = await Deno.makeTempDir({ prefix: "runwield-record-index-proof-" });
    try {
        if ((await git(projectRoot, ["init", "--bare", inspection])).code !== 0) {
            throw new Error("Cannot inspect published Work Records.");
        }
        const fetched = await git(inspection, [
            "fetch",
            "--no-tags",
            remoteUrl.stdout,
            `refs/heads/${attempt.upstreamBranch}`,
        ]);
        if (fetched.code !== 0 || !await gitAncestor(inspection, attempt.publishedCommit, "FETCH_HEAD")) {
            throw new Error("Published Work Record source cannot be proven on its target.");
        }
        const head = await git(inspection, ["rev-parse", "FETCH_HEAD"]);
        if (head.code !== 0) throw new Error("Published Work Record target cannot be read.");
        await indexPublishedWorkRecords(projectRoot, inspection, head.stdout, paths, port, attempt.publishedCommit);
    } finally {
        await Deno.remove(inspection, { recursive: true });
    }
}

/**
 * Finish verified publication cleanup without requiring the execution worktree
 * to still exist. This is the restart path for a process that died after deleting
 * Git artifacts but before writing the final receipt.
 */
export async function cleanupStoredPublication(
    projectRoot: string,
    initial: PublicationAttempt,
    workRecordMnemotecaPort: WorkRecordMnemotecaPort = SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
): Promise<PublicationCleanupResult> {
    // Reconciliation validates before inspecting Git or changing any receipt.
    let attempt = await reconcileStoredPublication(projectRoot, initial);
    let preservedFiles = await existingPublicationSavedFiles(attempt.executionCwd);
    if (attempt.phase === "publication_verified" || attempt.phase === "cleanup_complete") {
        // Index availability must not hide delivery already proven by Git.
        await retainPublicationCompletion(projectRoot, attempt);
        try {
            await settlePublicationIndex(projectRoot, attempt, workRecordMnemotecaPort);
        } catch (error) {
            return {
                complete: false,
                attempt,
                worktreeKept: true,
                branchKept: true,
                details: [
                    `Delivery is confirmed. Work Record index synchronization will retry from the retained publication: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                ],
                preservedFiles,
            };
        }
    }
    if (attempt.phase === "cleanup_complete") {
        await pruneEntry(projectRoot, attempt.attemptId);
        return { complete: true, attempt, worktreeKept: false, branchKept: false, details: [], preservedFiles };
    }
    if (attempt.phase !== "publication_verified") {
        throw new Error(`Publication cleanup requires verified publication, found ${attempt.phase}.`);
    }
    const stillPublished = await publishedEvidence(projectRoot, attempt);
    if (!stillPublished) {
        const worktreeKept = await Deno.stat(attempt.executionCwd).then((value) => value.isDirectory).catch(() =>
            false
        );
        const branchKept = (await git(projectRoot, [
            "show-ref",
            "--verify",
            "--quiet",
            `refs/heads/${attempt.executionBranch}`,
        ])).code === 0;
        return {
            complete: false,
            attempt,
            worktreeKept,
            branchKept,
            details: [`Could not confirm that ${attempt.targetBranch} still contains the published commits.`],
        };
    }
    const details: string[] = [];
    let worktreeKept = false;
    let branchKept = false;
    try {
        const worktreeExists = await Deno.stat(attempt.executionCwd).then((value) => value.isDirectory).catch(() =>
            false
        );
        if (worktreeExists) {
            preservedFiles = await preserveUnregisteredPublicationFiles(projectRoot, attempt.executionCwd);
            if (!preservedFiles) {
                await removeWorktreeGitArtifacts({ projectRoot, path: attempt.executionCwd, force: false });
            }
        }
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
            worktreeKept = true;
            details.push(
                `Git kept worktree ${attempt.executionCwd}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
    try {
        const branchExists = (await git(projectRoot, [
            "show-ref",
            "--verify",
            "--quiet",
            `refs/heads/${attempt.executionBranch}`,
        ])).code === 0;
        if (branchExists) {
            const branchCleanup =
                attempt.publicationMode === "remote" && attempt.upstreamRemote && attempt.upstreamBranch
                    ? await deleteRemotelyPublishedWorktreeBranch({
                        projectRoot,
                        branch: attempt.executionBranch,
                        remote: attempt.upstreamRemote,
                        upstreamBranch: attempt.upstreamBranch,
                        publicationCommit: attempt.publishedCommit || "",
                        artifactCommit: attempt.artifactCommit,
                    })
                    : await deleteMergedWorktreeBranch({
                        projectRoot,
                        branch: attempt.executionBranch,
                        targetBranch: attempt.targetBranch,
                    });
            if (!branchCleanup.deleted) {
                branchKept = true;
                details.push(branchCleanup.reason);
            }
        }
    } catch (error) {
        branchKept = true;
        details.push(
            `Git kept branch ${attempt.executionBranch}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    await Deno.remove(attempt.publicationRoot, { recursive: true }).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) {
            details.push(`RunWield kept publication checkout ${attempt.publicationRoot}: ${String(error)}`);
        }
    });
    if (worktreeKept || branchKept || details.length > 0) {
        return { complete: false, attempt, worktreeKept, branchKept, details, preservedFiles };
    }
    attempt = await advanceStoredPublication(projectRoot, attempt, "cleanup_complete", {
        cleanedAt: new Date().toISOString(),
    });
    await pruneEntry(projectRoot, attempt.attemptId);
    return { complete: true, attempt, worktreeKept: false, branchKept: false, details: [], preservedFiles };
}

/** Read recording outcome from the sealed delivery, even after its worktree is removed. */
export async function publishedWorkRecordFailed(projectRoot: string, attempt: PublicationAttempt): Promise<boolean> {
    if (!attempt.artifactCommit) throw new Error("Published Plan artifact commit is missing.");
    for (const path of attempt.planPaths || []) {
        const result = await git(projectRoot, ["show", `${attempt.artifactCommit}:${path}`]);
        if (result.code !== 0) continue;
        const { attrs } = parsePlanFrontMatter(result.stdout);
        if (attrs.planId !== attempt.planId) continue;
        if (!isChildFeaturePlan({ attrs })) return attrs.workRecord?.status === "failed";
        // Child completion records the terminal parent, which need not be listed
        // among the child's lifecycle paths. Read it from the same sealed tree.
        const parentName = canonicalizeStoredPlanName(attrs.parentPlan || "").name;
        const parent = await git(projectRoot, ["show", `${attempt.artifactCommit}:docs/plans/${parentName}.md`]);
        if (parent.code !== 0) return false;
        const parentAttrs = parsePlanFrontMatter(parent.stdout).attrs;
        const preparedParentDelivered = ["publication_verified", "cleanup_complete"].includes(attempt.phase) &&
            ["reviewed", "validated"].includes(parentAttrs.status) &&
            parentAttrs.epicCompletionMode === "done_enough" &&
            Boolean(attempt.planPaths?.includes(`docs/plans/${parentName}.md`));
        return (isTerminalWorkRecordParent(parentAttrs) || preparedParentDelivered) &&
            parentAttrs.workRecord?.status === "failed";
    }
    throw new Error(`Published Plan ${attempt.planName} was not found in its artifact commit.`);
}
