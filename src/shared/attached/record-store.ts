import type { Dirent } from "node:fs";
import { writeJsonAtomically } from "../private-json-file.ts";
import { realpathSync } from "node:fs";
import {
    readFile as fsReadFile,
    readdir as fsReaddir,
    writeFile as fsWriteFile,
    rm as fsRm,
    mkdir as fsMkdir,
    stat as fsStat,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
    getHomeDir,
    getRunWieldRuntimeDir,
    PROJECT_INTERNAL_RUNTIME_DIR_NAME,
    RUNWIELD_DIR_NAME,
} from "../../constants.js";
import { readLockFileSnapshot, removeLockFileIfSnapshotMatches } from "../lock-file-snapshot.ts";
import { getLockHostname, isLockHolderGone, isLockHolderUnattributable } from "../process-liveness.ts";
import { resolvePrimaryCheckoutRoot } from "../primary-checkout.ts";
import { encodeCwdForSessionDir } from "../project-directory-key.ts";
import { type TriageOutcome } from "../workflow/triage-outcome.ts";
import {
    type AttachedExecution,
    type AttachedOperationName,
    type AttachedOperationResult,
    type AttachedPendingConsent,
    type AttachedPlanReference,
    type AttachedReviewRound,
    type AttachedWorkflowClosure,
    type AttachedWorkflowState,
    type PendingHostAction,
    type RecordedEvidence,
} from "./operations.ts";

import process from "node:process";
/**
 * @module shared/attached/record-store
 * Durable Attached Workflow Records under `~/.wld/attached/`.
 *
 * A record describes one host request, like a Session, so it lives in the user's home
 * keyed by the primary checkout root, not in Project Runtime State. Reading or writing
 * a record never touches the repository. With no home directory, records fall back to
 * the primary checkout's internal runtime directory, as worktrees do.
 *
 * Every write holds a per-workflow lock file, checks the expected revision, and
 * replaces the file atomically. A lock left by a dead process is reclaimed.
 */

const ATTACHED_DIR_NAME = "attached";
const WORKFLOWS_DIR_NAME = "workflows";
const LOCK_WAIT_MS = 10_000;
const LOCK_RETRY_MS = 20;
/** A lock that names no checkable holder is a crash leftover once it is this old. */
const UNATTRIBUTABLE_LOCK_STALE_MS = 30_000;

export interface AcceptedOperation {
    result: AttachedOperationResult;
    evidence: RecordedEvidence;
    acceptedAt: string;
}

export interface AttachedWorkflowRecord {
    validation?: AttachedValidationCheckpoint | null;
    schemaVersion: 1;
    workflowId: string;
    revision: number;
    /** Canonical primary checkout root: binding evidence, compared on every load. */
    projectRoot: string;
    request: { text: string; hostRequestId: string };
    evidence: RecordedEvidence;
    state: AttachedWorkflowState;
    pendingAction: PendingHostAction | null;
    acceptedOperations: Record<string, AcceptedOperation>;
    triageOutcome: TriageOutcome | null;
    plan: AttachedPlanReference | null;
    review: AttachedReviewRound | null;
    execution: AttachedExecution | null;
    pendingConsent: AttachedPendingConsent | null;
    closure: AttachedWorkflowClosure | null;
    createdAt: string;
    updatedAt: string;
}

/** Where one project's records live. */
export interface AttachedWorkflowLocation {
    projectRoot: string;
    workflowsDir: string;
    /** `~/.wld/attached`, absent when records fall back into the project. */
    homeBaseDir: string | null;
}

export type LoadedAttachedWorkflow =
    | { status: "found"; record: AttachedWorkflowRecord }
    | { status: "moved"; record: AttachedWorkflowRecord }
    | { status: "missing" };

export type AttachedRecordWriteResult =
    { status: "written" } | { status: "conflict"; current: AttachedWorkflowRecord | null } | { status: "busy" };

function canonicalPath(path: string): string {
    try {
        return realpathSync(path);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return resolve(path);
        throw error;
    }
}

export function locateAttachedWorkflows(projectRoot: string): AttachedWorkflowLocation {
    const primaryRoot = canonicalPath(resolvePrimaryCheckoutRoot(canonicalPath(projectRoot)));
    const homeDir = getHomeDir();
    if (!homeDir) {
        return {
            projectRoot: primaryRoot,
            workflowsDir: join(
                getRunWieldRuntimeDir(primaryRoot),
                PROJECT_INTERNAL_RUNTIME_DIR_NAME,
                ATTACHED_DIR_NAME,
                WORKFLOWS_DIR_NAME,
            ),
            homeBaseDir: null,
        };
    }
    const homeBaseDir = join(homeDir, RUNWIELD_DIR_NAME, ATTACHED_DIR_NAME);
    return {
        projectRoot: primaryRoot,
        workflowsDir: join(homeBaseDir, encodeCwdForSessionDir(primaryRoot), WORKFLOWS_DIR_NAME),
        homeBaseDir,
    };
}

function recordPath(workflowsDir: string, workflowId: string): string {
    return join(workflowsDir, `${workflowId}.json`);
}

async function readRecordAt(path: string): Promise<AttachedWorkflowRecord | null> {
    try {
        const record: AttachedWorkflowRecord = JSON.parse(await fsReadFile(path, "utf8"));
        return {
            ...record,
            execution: record.execution ?? null,
            pendingConsent: record.pendingConsent ?? null,
            validation: record.validation ?? null,
        };
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }
}

/** Find a record whose project folder moved: its key no longer matches this project. */
async function findMovedRecord(
    location: AttachedWorkflowLocation,
    workflowId: string,
): Promise<AttachedWorkflowRecord | null> {
    if (!location.homeBaseDir) return null;
    let entries: Dirent[];
    try {
        entries = await Array.fromAsync(await fsReaddir(location.homeBaseDir, { withFileTypes: true }));
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const workflowsDir = join(location.homeBaseDir, entry.name, WORKFLOWS_DIR_NAME);
        if (workflowsDir === location.workflowsDir) continue;
        const record = await readRecordAt(recordPath(workflowsDir, workflowId));
        if (record) return record;
    }
    return null;
}

/** Load a record. Reports `moved` instead of matching a record to another project. */
export async function loadAttachedWorkflowRecord(
    location: AttachedWorkflowLocation,
    workflowId: string,
): Promise<LoadedAttachedWorkflow> {
    const record = await readRecordAt(recordPath(location.workflowsDir, workflowId));
    if (record) return { status: record.projectRoot === location.projectRoot ? "found" : "moved", record };
    const moved = await findMovedRecord(location, workflowId);
    return moved ? { status: "moved", record: moved } : { status: "missing" };
}

/** Select only this project's latest open workflow; do not scan other project bindings. */
export async function loadLatestAttachedWorkflowRecord(
    location: AttachedWorkflowLocation,
): Promise<AttachedWorkflowRecord | null> {
    let latest: AttachedWorkflowRecord | null = null;
    try {
        for await (const entry of await fsReaddir(location.workflowsDir, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
            const record = await readRecordAt(join(location.workflowsDir, entry.name));
            if (
                record &&
                record.projectRoot === location.projectRoot &&
                record.state !== "closed" &&
                (!latest ||
                    record.updatedAt > latest.updatedAt ||
                    (record.updatedAt === latest.updatedAt && record.workflowId > latest.workflowId))
            )
                latest = record;
        }
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    return latest;
}

interface LockDocument {
    pid: number;
    hostname: string;
    token: string;
    createdAt: number;
}

async function isReclaimable(lockText: string, mtime: number): Promise<boolean> {
    if (await isLockHolderGone(lockText)) return true;
    return isLockHolderUnattributable(lockText) && Date.now() - mtime > UNATTRIBUTABLE_LOCK_STALE_MS;
}

/** Take the lock, or return null when a live holder keeps it past the wait limit. */
async function acquireLock(lockPath: string): Promise<string | null> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    const token = crypto.randomUUID();
    const document: LockDocument = { pid: process.pid, hostname: getLockHostname(), token, createdAt: Date.now() };
    while (true) {
        try {
            await fsWriteFile(lockPath, JSON.stringify(document), { flag: "wx" });
            return token;
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        }
        const snapshot = await readLockFileSnapshot(lockPath);
        if (snapshot && (await isReclaimable(snapshot.text, snapshot.mtime))) {
            await removeLockFileIfSnapshotMatches(lockPath, snapshot);
            continue;
        }
        if (Date.now() > deadline) return null;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_MS));
    }
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
    const snapshot = await readLockFileSnapshot(lockPath);
    if (snapshot?.token === token) await removeLockFileIfSnapshotMatches(lockPath, snapshot);
}

/** Temporary files from a writer that died before its rename. Only safe to remove under the lock. */
async function removeAbandonedTemporaryFiles(path: string): Promise<void> {
    const prefix = `${basename(path)}.`;
    for await (const entry of await fsReaddir(dirname(path), { withFileTypes: true })) {
        if (
            entry.isFile() &&
            entry.name.startsWith(prefix) &&
            (entry.name.endsWith(".tmp") || entry.name.startsWith(`${basename(path)}.tmp-`))
        ) {
            await fsRm(join(dirname(path), entry.name)).catch((error) => {
                if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
            });
        }
    }
}

function atomicWrite(path: string, record: AttachedWorkflowRecord): void {
    writeJsonAtomically(path, record);
}

/**
 * Replace a record when its saved revision still equals `expectedRevision`
 * (`null`: no record may exist yet). A mismatch leaves the file unchanged and
 * returns the current record.
 */
export async function writeAttachedWorkflowRecord(
    location: AttachedWorkflowLocation,
    record: AttachedWorkflowRecord,
    expectedRevision: number | null,
): Promise<AttachedRecordWriteResult> {
    const transaction = await transactAttachedWorkflowRecord<AttachedRecordWriteResult>(
        location,
        record.workflowId,
        (current) => {
            if ((current?.revision ?? null) !== expectedRevision) {
                return Promise.resolve({ result: { status: "conflict" as const, current } });
            }
            return Promise.resolve({ result: { status: "written" as const }, next: record });
        },
    );
    return transaction.status === "busy" ? transaction : transaction.result;
}

export interface AttachedRecordDecision<Result> {
    result: Result;
    next?: AttachedWorkflowRecord;
}

/** Hold the workflow lock across domain checks, external document writes, and record acceptance. */
export async function transactAttachedWorkflowRecord<Result>(
    location: AttachedWorkflowLocation,
    workflowId: string,
    decide: (current: AttachedWorkflowRecord | null) => Promise<AttachedRecordDecision<Result>>,
): Promise<{ status: "committed"; result: Result } | { status: "busy" }> {
    await fsMkdir(location.workflowsDir, { recursive: true });
    const path = recordPath(location.workflowsDir, workflowId);
    const lockPath = join(location.workflowsDir, `${workflowId}.lock`);
    const token = await acquireLock(lockPath);
    if (!token) return { status: "busy" };
    try {
        const decision = await decide(await readRecordAt(path));
        if (decision.next) {
            await removeAbandonedTemporaryFiles(path);
            await atomicWrite(path, decision.next);
        }
        return { status: "committed", result: decision.result };
    } finally {
        await releaseLock(lockPath, token);
    }
}

/** Carrier checkpoint only. The shared validation checkpoint owns all gate policy. */
export interface AttachedValidationCheckpoint {
    actionId?: string;
    request?: import("../workflow/validation-host-contract.ts").ValidationHostRequest;
    coverage: import("../workflow/review-inspection.ts").ReviewDiffSpan[];
    resume?: import("../workflow/validation-host-contract.ts").ValidationHostResume;
    operationId?: string;
    operation?: AttachedOperationName;
    evidence?: RecordedEvidence;
    holder?: AttachedValidationHolder;
    reason?: string;
    resultKind?: "paused" | "failed";
    recovery?: import("../workflow/validation-recovery.ts").ValidationRecoveryResult;
}

export interface AttachedValidationHolder {
    token?: string;
    pid: number;
    hostname: string;
}

/** A settled call must not keep a live MCP process as its operation owner.
 * This receipt uses the claim token, independently of a contended workflow lock.
 */
export async function settleAttachedValidationHolder(location: AttachedWorkflowLocation, token: string): Promise<void> {
    await fsWriteFile(join(location.workflowsDir, `validation-${token}.settled`), "settled\n", {
        flag: "wx",
    });
}

export async function attachedValidationHolderSettled(
    location: AttachedWorkflowLocation,
    holder: AttachedValidationHolder,
): Promise<boolean> {
    if (!holder.token) return false;
    try {
        await fsStat(join(location.workflowsDir, `validation-${holder.token}.settled`));
        return true;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
    }
}
