import { effectiveDeliveryBranch } from "./plan-branch.ts";
/**
 * @module shared/workflow/validation-merge-verification
 *
 * Post-merge publication proof. The paired precondition,
 * `assertPreMergeCandidateUnchanged`, runs in worktree.js before the target ref
 * moves; this runs after it moved and answers whether everything that had to
 * reach the target branch actually did.
 */

import { getDeclaredPlanStatus, planDocumentMarkdown, type PlanFrontMatter } from "../../plan-store.js";
import { isCommitPublishedToTarget } from "../isolated-publication.ts";
import { dirname, join, resolve } from "@std/path";

/** Detect Git on disk so a missing/broken Git executable cannot imply non-Git completion. */
async function hasGitDirectory(projectRoot: string): Promise<boolean> {
    let directory = resolve(projectRoot);
    while (true) {
        try {
            await Deno.lstat(join(directory, ".git"));
            return true;
        } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        const parent = dirname(directory);
        if (parent === directory) return false;
        directory = parent;
    }
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
async function runGitForMergeVerification(cwd: string, args: string[]) {
    const command = new Deno.Command("git", { args, cwd, stdout: "piped", stderr: "piped" });
    const output = await command.output();
    const decoder = new TextDecoder();
    return {
        exitCode: output.code,
        stdout: decoder.decode(output.stdout),
        stderr: decoder.decode(output.stderr),
    };
}

interface MergeVerificationResult {
    merged: boolean;
    message: string;
}

export interface RecordedPublicationResult {
    published: boolean;
    targetBranch?: string;
    unavailable?: boolean;
}

interface PublicationPlanDocument {
    planName: string;
    markdown: string;
}

/**
 * Prove the terminal publication state that intentionally has no worktree record.
 *
 * Once Direct Delivery succeeds, RunWield removes the attempt from the worktree
 * registry. A verified Plan or a legacy validated document can retain publication
 * proof after controller removal; an effective reviewed state may still need Git reconciliation.
 */
export async function verifyRecordedPublication(
    projectRoot: string,
    attrs: PlanFrontMatter,
    document?: PublicationPlanDocument,
): Promise<RecordedPublicationResult> {
    if (!["reviewed", "validated", "verified", "user_verified"].includes(attrs.status || "")) {
        return { published: false };
    }
    if (!(await hasGitDirectory(projectRoot))) return { published: attrs.status !== "reviewed" };
    const evidence = attrs.deliveryEvidence;
    const legacy = evidence?.mode === "worktree_merge" ? evidence : undefined;
    const targetBranch = effectiveDeliveryBranch(attrs) || legacy?.targetBranch;
    if (!targetBranch) return { published: false };
    const commit = attrs.validatedCommit || legacy?.executionCommit;
    let unavailable = false;
    if (commit) {
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit)) return { published: false, targetBranch };
        try {
            const published = await isCommitPublishedToTarget({ projectRoot, targetBranch, commit });
            if (published || attrs.validatedCommit) return { published, targetBranch };
        } catch {
            // An unavailable Git remote must not crash load-plan or masquerade
            // as successful publication. Keep the ordinary continuation available.
            if (attrs.validatedCommit) return { published: false, targetBranch, unavailable: true };
            unavailable = true;
        }
    }
    // Older published Plans predate the stamp. Exact committed document equality
    // proves their completion without inventing evidence or rewriting the Plan.
    if (
        document && ["validated", "verified", "user_verified"].includes(getDeclaredPlanStatus(document.markdown) || "")
    ) {
        const saved = await runGitForMergeVerification(projectRoot, [
            "show",
            `refs/heads/${targetBranch}:docs/plans/${document.planName}.md`,
        ]).catch(() => null);
        if (!saved) return { published: false, targetBranch, unavailable: true };
        if (saved.exitCode === 0 && planDocumentMarkdown(saved.stdout) === planDocumentMarkdown(document.markdown)) {
            return { published: true, targetBranch };
        }
    }
    return { published: false, targetBranch, ...(unavailable ? { unavailable: true } : {}) };
}

export interface RepairedMergeCandidate {
    executionCommit: string;
    metadataCommit: string;
    targetHeadBeforeMerge: string;
}

/**
 * Recover the frozen publication candidate embedded in a completed repair merge.
 *
 * A detached repair merge has the target head as its first parent and the staged
 * execution metadata commit as its second. That metadata commit's first parent is
 * the implementation commit Workflow Validation sealed before staging the verified
 * Plan. While repair is unresolved Git exposes the same frozen metadata parent as
 * MERGE_HEAD; after completion it is HEAD^2. Returning the same evidence in both
 * states prevents a retry from advancing the execution branch before Agent repair.
 */
export async function readRepairedMergeCandidate(
    repairWorktreePath: string,
): Promise<RepairedMergeCandidate | null> {
    let metadata = await runGitForMergeVerification(repairWorktreePath, ["rev-parse", "HEAD^2"]);
    let completedMerge = "HEAD";
    let completed = metadata.exitCode === 0 && Boolean(metadata.stdout.trim());
    if (!completed) {
        metadata = await runGitForMergeVerification(repairWorktreePath, ["rev-parse", "MERGE_HEAD"]);
        if (metadata.exitCode !== 0 || !metadata.stdout.trim()) {
            const merge = await runGitForMergeVerification(repairWorktreePath, [
                "rev-list",
                "--merges",
                "-n",
                "1",
                "HEAD",
            ]);
            if (merge.exitCode !== 0 || !merge.stdout.trim()) return null;
            completedMerge = merge.stdout.trim();
            metadata = await runGitForMergeVerification(repairWorktreePath, [
                "rev-parse",
                `${completedMerge}^2`,
            ]);
            completed = metadata.exitCode === 0 && Boolean(metadata.stdout.trim());
            if (!completed) return null;
        }
    }
    const target = await runGitForMergeVerification(
        repairWorktreePath,
        ["rev-parse", completed ? `${completedMerge}^1` : "HEAD"],
    );
    const execution = await runGitForMergeVerification(
        repairWorktreePath,
        ["rev-parse", `${metadata.stdout.trim()}^1`],
    );
    if (target.exitCode !== 0 || execution.exitCode !== 0) {
        const reason = target.stderr || execution.stderr || "repair merge ancestry is incomplete";
        throw new Error(`Could not recover repaired Direct Delivery candidate: ${reason.trim()}`);
    }
    return {
        executionCommit: execution.stdout.trim(),
        metadataCommit: metadata.stdout.trim(),
        targetHeadBeforeMerge: target.stdout.trim(),
    };
}

interface VerifyPostMergeCandidatePublishedOptions {
    projectRoot: string;
    worktreeBranch: string;
    worktreeBaseBranch: string | undefined;
    git: import("../git-port.ts").GitPort;
    executionCommit?: string;
    metadataCommit?: string;
    targetBranch?: string;
}

/**
 * Post-merge proof: everything that had to reach the target branch did.
 *
 * The paired precondition is `assertPreMergeCandidateUnchanged` in worktree.js, which
 * runs before the ref moves. This runs after, and answers three questions that used to
 * be asked separately at each call site:
 *
 * 1. Is the validated candidate commit contained in the target branch? (the work)
 * 2. Is the metadata commit contained in it? (the Plan Front Matter that went with it)
 * 3. Is the execution branch itself contained in it? (nothing left behind)
 *
 * They are genuinely different subjects — a commit and a branch are not the same claim,
 * and they only coincide when the branch tip happens to be the metadata commit. Asking
 * them here rather than inline means one verdict, one message format, and no call site
 * that checks two of the three and calls it proof.
 *
 * Returns a verdict instead of throwing: the caller decides whether an unproven
 * publication is a halt, a repair, or a reconciliation recipe.
 *
 * @param {Object} opts
 * @param {string} opts.projectRoot
 * @param {string} opts.worktreeBranch
 * @param {string | undefined} opts.worktreeBaseBranch
 * @param {import('../git-port.ts').GitPort} opts.git
 * @param {string} [opts.executionCommit] Validated candidate, when Delivery Evidence names one.
 * @param {string} [opts.metadataCommit] Commit carrying the staged Plan metadata.
 * @param {string} [opts.targetBranch] Branch the evidence says was published to.
 * @returns {Promise<MergeVerificationResult>}
 */
export async function verifyPostMergeCandidatePublished(
    { projectRoot, worktreeBranch, worktreeBaseBranch, git, executionCommit, metadataCommit, targetBranch }:
        VerifyPostMergeCandidatePublishedOptions,
) {
    // Commit containment first: it names the exact thing validation approved, so its
    // failure is more specific than "the branch is not contained".
    if (targetBranch && executionCommit) {
        if (!(await git.isAncestor(projectRoot, executionCommit, targetBranch))) {
            return {
                merged: false,
                message: `Validated candidate ${executionCommit} is not contained in ${targetBranch}.`,
            };
        }
        if (metadataCommit && !(await git.isAncestor(projectRoot, metadataCommit, targetBranch))) {
            return {
                merged: false,
                message: `Validation metadata commit ${metadataCommit} is not contained in ${targetBranch}.`,
            };
        }
    }
    try {
        const targetRef = worktreeBaseBranch ? `refs/heads/${worktreeBaseBranch}` : "HEAD";
        const branchResult = await runGitForMergeVerification(projectRoot, ["rev-parse", "--verify", worktreeBranch]);
        if (branchResult.exitCode !== 0) {
            return {
                merged: false,
                message: `Could not verify execution branch ${worktreeBranch}: ${branchResult.stderr.trim()}`,
            };
        }

        const targetResult = await runGitForMergeVerification(projectRoot, ["rev-parse", "--verify", targetRef]);
        if (targetResult.exitCode !== 0) {
            return {
                merged: false,
                message: `Could not verify merge target ${targetRef}: ${targetResult.stderr.trim()}`,
            };
        }

        const ancestorResult = await runGitForMergeVerification(projectRoot, [
            "merge-base",
            "--is-ancestor",
            worktreeBranch,
            targetRef,
        ]);
        if (ancestorResult.exitCode === 0) {
            return { merged: true, message: `${worktreeBranch} is contained in ${targetRef}.` };
        }

        const mergeBaseResult = await runGitForMergeVerification(projectRoot, [
            "merge-base",
            worktreeBranch,
            targetRef,
        ]);
        const mergeBase = mergeBaseResult.stdout.trim();
        if (mergeBaseResult.exitCode === 0 && mergeBase) {
            const treeDiffResult = await runGitForMergeVerification(projectRoot, [
                "diff",
                "--quiet",
                mergeBase,
                worktreeBranch,
            ]);
            if (treeDiffResult.exitCode === 0) {
                return {
                    merged: true,
                    message:
                        `${worktreeBranch} has no unmerged tree changes beyond ${targetRef}; latest branch-only metadata commit can be safely treated as merged.`,
                };
            }
        }

        const detail = (ancestorResult.stderr || ancestorResult.stdout).trim();
        return {
            merged: false,
            message: detail
                ? `${worktreeBranch} still has changes that are not merged into ${targetRef}: ${detail}`
                : `${worktreeBranch} still has changes that are not merged into ${targetRef}.`,
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { merged: false, message: `Could not run merge verification: ${reason}` };
    }
}
