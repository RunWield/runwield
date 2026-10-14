import { rename as fsRename } from "node:fs/promises";
import { captureForegroundProcess } from "../captured-process.ts";
import {
    lstat as fsLstat,
    mkdir as fsMkdir,
    readFile as fsReadFile,
    realpath as fsRealpath,
    writeFile as fsWriteFile,
} from "node:fs/promises";
/** Recover a changed, unpublished source without reusing stale validation evidence. */
import { join } from "node:path";
import { loadPlan, parsePlanFrontMatter, updatePlanFrontMatter, withPlanLock } from "../../plan-store.js";
import { resolveTargetedWorkRecordSource } from "../work-records/auto-generation.ts";
import { listWorkRecords } from "../work-records/store.js";
import { gitStatusPaths } from "../git-runtime-safety.ts";
import { recoverSealedPlanFormatting } from "../publication-plan-formatting.ts";
import { isRunWieldOwnedRuntimePath } from "../runwield-owned-paths.ts";
import { findActiveByPlanName, retirePublicationForRevalidation, updatePublication } from "../worktree-registry.js";
import type { PublicationAttempt } from "./publication-attempt.ts";
import { makeValidationCheckpoint } from "./validation-checkpoint.ts";

export const PUBLICATION_REVALIDATION_MESSAGE =
    "The source history or files changed. Checking the current work before publishing it.";

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

async function sourceNeedsRevalidation(attempt: PublicationAttempt, head: string): Promise<boolean> {
    const sealed = attempt.artifactCommit || attempt.validatedCommit;
    const available = await git(attempt.executionCwd, ["cat-file", "-e", `${sealed}^{commit}`]);
    if (!available.success) return true;
    const ancestry = await git(attempt.executionCwd, ["merge-base", "--is-ancestor", sealed, head]);
    if (ancestry.code === 1) return true;
    if (!ancestry.success) throw new Error("Could not inspect publication source history.");
    if (attempt.phase !== "candidate_sealed") {
        await recoverSealedPlanFormatting({
            executionCwd: attempt.executionCwd,
            sealedExecutionCommit: sealed,
            allowedPlanPaths: attempt.planPaths || [],
        });
    }
    const changes = await git(attempt.executionCwd, ["diff", "--name-only", "-z", sealed, head]);
    if (!changes.success) throw new Error("Could not inspect the sealed publication files.");
    const paths = [...changes.text.split("\0").filter(Boolean), ...(await gitStatusPaths(attempt.executionCwd))];
    if (attempt.phase !== "candidate_sealed") return paths.some((path) => !isRunWieldOwnedRuntimePath(path));
    // A Recorder wait permits only its exact record and lifecycle/backlink edits,
    // not new implementation files or changes to the reviewed Plan's prose.
    const { source } = await resolveTargetedWorkRecordSource(attempt.executionCwd, attempt.planName, true);
    const planPaths = new Set([`docs/plans/${attempt.planName}.md`, ...(source ? [source.relativePath] : [])]);
    let recordPath = source?.attrs.workRecord?.path;
    const recorder = source?.attrs.validationCheckpoint?.hostRecorder;
    if (!recordPath && source && recorder?.sections) {
        // The canonical record can be durable before generation saves its backlink.
        const records = await listWorkRecords(attempt.executionCwd, { createDir: false });
        recordPath = records.find(
            (record) =>
                record.attrs.recordId === recorder.recordId &&
                record.attrs.provenance?.sourcePlans?.includes(source.planId),
        )?.relativePath;
    }
    for (const path of new Set(paths)) {
        if (isRunWieldOwnedRuntimePath(path)) continue;
        if (path === recordPath && /^docs\/work-records\/[^/]+\.md$/.test(path)) continue;
        if (!planPaths.has(path)) return true;
        const before = await git(attempt.executionCwd, ["show", `${sealed}:${path}`]);
        if (!before.success) return true;
        const current = await fsReadFile(join(attempt.executionCwd, path), "utf8").catch(() => "");
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
    return await withPlanLock(projectRoot, planName, async () => {
        const entry = await findActiveByPlanName(projectRoot, planName);
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
        return await withPlanLock(executionCwd, planName, async () => {
            let attempt = publication;
            // Never repair a stale registry path or a checkout switched to another branch.
            const branch = await git(executionCwd, ["symbolic-ref", "--quiet", "HEAD"]);
            if (!branch.success || branch.text !== `refs/heads/${entry.branch}`) {
                throw new Error("The publication source checkout no longer has its recorded branch.");
            }
            const head = await git(executionCwd, ["rev-parse", "HEAD"]);
            if (!head.success) throw new Error("Could not read the publication source commit.");
            if (!attempt.revalidation) {
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
                await updatePublication(projectRoot, entry.id, current.revision, attempt);
            }
            await preserveAttempt(attempt);
            const plan = await loadPlan(executionCwd, planName);
            if (!plan || plan.attrs.planId !== entry.planId) throw new Error("Publication Plan identity changed.");
            const checkpoint = plan.attrs.validationCheckpoint;
            await updatePlanFrontMatter(
                executionCwd,
                planName,
                {
                    status: "implemented",
                    validatedCommit: null,
                    deliveryEvidence: null,
                    validatedAt: null,
                    verifiedAt: null,
                    failureReason: null,
                    failedAt: null,
                    validationCheckpoint:
                        checkpoint?.state === "running"
                            ? makeValidationCheckpoint({
                                  attemptId: entry.id,
                                  generation: checkpoint.generation,
                                  status: "implemented",
                                  phase: "mechanical",
                                  state: "running",
                                  ownerPid: checkpoint.ownerPid,
                                  ownerHostname: checkpoint.ownerHostname,
                                  lastSettledOperationId: checkpoint.lastSettledOperationId,
                              })
                            : null,
                    validationCiAttempts: 0,
                    validationSemanticRounds: 0,
                    humanReviewDecision: null,
                    humanReviewedAt: null,
                    worktreeStatus: "active",
                },
                {},
                { expectedRevision: plan.revision, expectedControllerRevision: plan.controllerRevision },
            );
            await retirePublicationForRevalidation(projectRoot, entry.id, attempt.revision);
            return attempt.revalidation!.archiveRoot;
        });
    });
}
