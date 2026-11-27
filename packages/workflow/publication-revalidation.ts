/** Recover a changed, unpublished source without reusing stale validation evidence. */
import {
    lstat as fsLstat,
    mkdir as fsMkdir,
    readFile as fsReadFile,
    realpath as fsRealpath,
    rename as fsRename,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { join } from "node:path";
import { parsePlanFrontMatter } from "@runwield/plans/format";
import {
    planDocumentsForCheckout,
    publicationCopiesForCheckout,
    readRetainedExecutionPlan,
    recoverSealedPlanFormatting,
    restartPlanValidation,
    withPlanPublication,
    workRecordsForCheckout,
} from "../../src/plan-store/index.ts";
import { checkpointExecutionWorktree } from "../../src/shared/worktree.ts";
import { captureForegroundProcess } from "@runwield/resources/process";
import { resolveTargetedWorkRecordSource } from "../../src/shared/work-records/auto-generation.ts";
import { gitStatusPaths } from "../../src/shared/git-runtime-safety.ts";
import { isRunWieldOwnedRuntimePath } from "../../src/shared/runwield-owned-paths.ts";
import { retirePublicationForRevalidation, updatePublication } from "../../src/shared/worktree-registry.ts";
import { candidateIdentity } from "../../src/shared/workflow/validation-scope.ts";
import { getWorktreeReviewDiff } from "../../src/shared/workflow/git-snapshot.ts";
import type { PublicationAttempt } from "./publication-attempt.ts";
import { reconcileStoredPublication } from "./publication-machine.ts";

export const PUBLICATION_REVALIDATION_MESSAGE =
    "The source history or files changed. Checking the current work before publishing it.";

export const CANDIDATE_REVALIDATION_MESSAGE =
    "The code changed after review. Running validation and Semantic Review again before Code Review.";

/** Check the reviewed candidate before phase selection, under both Plan locks. */
export async function prepareReviewedCandidateRevalidation(projectRoot: string, planName: string): Promise<boolean> {
    return await withPlanPublication(projectRoot, planName, async (entry) => {
        if (!entry || entry.publication) return false;
        return await (async () => {
            const plan = await planDocumentsForCheckout(entry.path).load(planName);
            const identity = plan?.attrs.validationCheckpoint?.candidateIdentity;
            if (plan?.attrs.status !== "reviewed" || !identity) return false;
            if (plan.attrs.planId !== entry.planId) throw new Error("Publication Plan identity changed.");
            const branch = await git(entry.path, ["symbolic-ref", "--quiet", "HEAD"]);
            if (!branch.success || branch.text !== `refs/heads/${entry.branch}`) {
                throw new Error("The publication source checkout no longer has its recorded branch.");
            }
            const current = candidateIdentity(
                await getWorktreeReviewDiff(entry.path, entry.baseBranch, entry.baseRef),
                planName,
            );
            if (current === identity) return false;
            await restartPlanValidation(entry.path, planName, entry.id, entry.planId);
            return true;
        })();
    });
}

async function git(cwd: string, args: string[]) {
    const output = await captureForegroundProcess("git", { cwd, args });
    return { ...output, text: new TextDecoder().decode(output.stdout).trim() };
}

async function exists(path: string): Promise<boolean> {
    try {
        await fsLstat(path);
        return true;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
    }
}

/** Retain the candidate before removing its proven copies commit from the branch. */
async function retirePublicationCopies(projectRoot: string, attempt: PublicationAttempt): Promise<void> {
    if (!attempt.packageInput) return;
    const retirement = await publicationCopiesForCheckout(projectRoot).prepareRetirement(attempt);
    if (!retirement) return;
    const cwd = attempt.executionCwd;
    const checkpoint = await checkpointExecutionWorktree({
        worktreePath: cwd,
        branch: attempt.executionBranch,
        planName: attempt.planName,
    });
    const backup = `refs/runwield/revalidation/${attempt.packageInput.inputId}`;
    if (!(await git(cwd, ["update-ref", backup, checkpoint.executionCommit])).success)
        throw new Error("Cannot retain the code candidate before revalidation.");
    const rebased = await git(cwd, [
        "rebase",
        "--onto",
        retirement.parent,
        retirement.copiesCommit,
        attempt.executionBranch,
    ]);
    if (!rebased.success) {
        await git(cwd, ["rebase", "--abort"]);
        throw new Error("Unpublished copies could not be separated from code; the original candidate is retained.");
    }
}

async function sourceNeedsRevalidation(attempt: PublicationAttempt, head: string): Promise<boolean> {
    const sealed = attempt.artifactCommit || attempt.validatedCommit;
    const available = await git(attempt.executionCwd, ["cat-file", "-e", `${sealed}^{commit}`]);
    if (!available.success) return true;
    const ancestry = await git(attempt.executionCwd, ["merge-base", "--is-ancestor", sealed, head]);
    if (ancestry.code === 1) return true;
    if (!ancestry.success) throw new Error("Could not inspect publication source history.");
    if (!attempt.packageInput && attempt.phase !== "candidate_sealed") {
        await recoverSealedPlanFormatting({
            executionCwd: attempt.executionCwd,
            sealedExecutionCommit: sealed,
            allowedPlanPaths: attempt.planPaths || [],
        });
    }
    const changes = await git(attempt.executionCwd, ["diff", "--name-only", "-z", sealed, head]);
    if (!changes.success) throw new Error("Could not inspect the sealed publication files.");
    const paths = [...changes.text.split("\0").filter(Boolean), ...(await gitStatusPaths(attempt.executionCwd))];
    if (attempt.packageInput) {
        const copies = new Set(await publicationCopiesForCheckout(attempt.executionCwd).uncommittedPaths(attempt));
        return paths.some((path) => !isRunWieldOwnedRuntimePath(path) && !copies.has(path));
    }
    if (attempt.phase !== "candidate_sealed") return paths.some((path) => !isRunWieldOwnedRuntimePath(path));
    // A Recorder wait permits only its exact record and lifecycle/backlink edits,
    // not new implementation files or changes to the reviewed Plan's prose.
    const { source } = await resolveTargetedWorkRecordSource(attempt.executionCwd, attempt.planName, true);
    const planPaths = new Set([`docs/plans/${attempt.planName}.md`, ...(source ? [source.relativePath] : [])]);
    let recordPath = source?.attrs.workRecord?.path;
    const recorder = source?.attrs.validationCheckpoint?.hostRecorder;
    if (!recordPath && source && recorder?.sections) {
        // The canonical record can be durable before generation saves its backlink.
        const record = await workRecordsForCheckout(attempt.executionCwd).read(recorder.recordId);
        if (record?.attrs.provenance?.sourcePlans?.includes(source.planId)) recordPath = record.relativePath;
    }
    for (const path of new Set(paths)) {
        if (isRunWieldOwnedRuntimePath(path)) continue;
        if (path === recordPath && /^docs\/work-records\/[^/]+\.md$/.test(path)) continue;
        if (!planPaths.has(path)) return true;
        const before = await git(attempt.executionCwd, ["show", `${sealed}:${path}`]);
        if (!before.success) return true;
        const current = await readRetainedExecutionPlan(attempt.executionCwd, path).catch(() => "");
        const original = parsePlanFrontMatter(before.text);
        const changed = parsePlanFrontMatter(current);
        const {
            status: _oldStatus,
            workRecord: _oldRecord,
            validatedCommit: _oldCommit,
            userVerifiedAt: _oldVerified,
            ...oldAttrs
        } = original.attrs;
        const {
            status: _newStatus,
            workRecord: _newRecord,
            validatedCommit: _newCommit,
            userVerifiedAt: _newVerified,
            ...newAttrs
        } = changed.attrs;
        if (original.body.trim() !== changed.body.trim() || JSON.stringify(oldAttrs) !== JSON.stringify(newAttrs)) {
            return true;
        }
    }
    return false;
}

async function preserveAttempt(attempt: PublicationAttempt): Promise<void> {
    const recovery = attempt.revalidation;
    if (!recovery) throw new Error("Publication revalidation has no recovery record.");
    await fsMkdir(recovery.archiveRoot, { recursive: true });
    const recordPath = join(recovery.archiveRoot, "publication.json");
    const record = `${JSON.stringify(attempt, null, 2)}\n`;
    if (await exists(recordPath)) {
        if ((await fsReadFile(recordPath, "utf8")) !== record) {
            throw new Error("Saved publication recovery evidence differs; keeping both checkouts intact.");
        }
    } else {
        const temporary = `${recordPath}.tmp`;
        await fsWriteFile(temporary, record);
        await fsRename(temporary, recordPath);
    }
    const savedCheckout = join(recovery.archiveRoot, "checkout");
    if (await exists(attempt.publicationRoot)) {
        if (await exists(savedCheckout)) throw new Error("Saved publication checkout already exists.");
        await fsRename(attempt.publicationRoot, savedCheckout);
    }
}

/**
 * Called before phase selection, under the same primary Plan lock as publication.
 * Persist intent first so a restart after any following write finishes this reset.
 * Integrated/published attempts are deliberately excluded: a push may have happened.
 */
export async function preparePublicationRevalidation(projectRoot: string, planName: string): Promise<string | null> {
    return await withPlanPublication(projectRoot, planName, async (entry) => {
        const publication = entry?.publication;
        if (!entry || !publication || !["candidate_sealed", "artifacts_committed"].includes(publication.phase)) {
            return null;
        }
        const executionCwd = publication.executionCwd;
        if ((await fsRealpath(entry.path)) !== (await fsRealpath(executionCwd))) {
            throw new Error("The publication source checkout no longer matches its registered location.");
        }
        // Formatting recovery takes this lock again. Use the recorded spelling
        // throughout: /var and /private/var can name the same macOS directory.
        return await (async () => {
            let attempt = publication;
            // Never repair a stale registry path or a checkout switched to another branch.
            const branch = await git(executionCwd, ["symbolic-ref", "--quiet", "HEAD"]);
            if (!branch.success || branch.text !== `refs/heads/${entry.branch}`) {
                throw new Error("The publication source checkout no longer has its recorded branch.");
            }
            const head = await git(executionCwd, ["rev-parse", "HEAD"]);
            if (!head.success) throw new Error("Could not read the publication source commit.");
            if (!attempt.revalidation) {
                // Recover an owned copies commit whose effect preceded its registry receipt.
                if (attempt.packageInput) {
                    attempt = await reconcileStoredPublication(projectRoot, attempt);
                    if (!["candidate_sealed", "artifacts_committed"].includes(attempt.phase)) return null;
                }
                if (!(await sourceNeedsRevalidation(attempt, head.text))) return null;
                const current = attempt;
                attempt = {
                    ...current,
                    revision: current.revision + 1,
                    updatedAt: new Date().toISOString(),
                    revalidation: {
                        sourceHead: head.text,
                        archiveRoot: `${current.publicationRoot}.revalidation-${crypto.randomUUID()}`,
                    },
                };
                await updatePublication(projectRoot, entry.id, current, attempt);
            }
            await preserveAttempt(attempt);
            await retirePublicationCopies(projectRoot, attempt);
            await restartPlanValidation(executionCwd, planName, entry.id, entry.planId);
            await retirePublicationForRevalidation(projectRoot, entry.id, attempt.revision);
            return attempt.revalidation!.archiveRoot;
        })();
    });
}
