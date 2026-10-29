import { closeSync, fstatSync, fsyncSync, openSync, readSync, writeSync } from "node:fs";
import { openNativeFileLock, type NativeFileLock } from "../native-file-lock.ts";
import { syncParentDirectory, writeTextAtomically } from "../private-json-file.ts";
import { readFileSync, truncateSync, rmSync, mkdirSync, statSync, existsSync, renameSync } from "node:fs";
/** Durable, content-free Project measurement journal. */
import { dirname, join } from "node:path";
import { getHomeDir } from "../../constants.js";
import lockfile from "proper-lockfile";
import { metricsDeliveryInFlightForJournal } from "./metrics-export-ledger.ts";

interface JournalInvocation {
    enabled: boolean;
    epoch: string;
    historyEpoch?: string;
    deadline: number;
}

interface JournalRepairIntent {
    end: number;
    gap: string;
}

interface JournalCoverageGap {
    tornBytes: number;
    corruptLines: number[];
}

export type JournalResult = {
    persisted: boolean;
    reason?: string;
    eventId?: string;
    collectionEpoch?: string;
    historyEpoch?: string;
    collectionEnabledAtCall?: boolean;
    coverageGap?: JournalCoverageGap;
    deliveryInFlight?: boolean;
};

interface JournalEpochState {
    v: number;
    collectionEpoch: { id: string; enabled: boolean };
    historyEpoch: string;
    historyStartedAt?: string;
    initialHistoryEpoch?: string;
    recordingGeneration?: string;
    journalBytes?: number;
    journalLines?: number;
    recoveryBytes?: number[];
    recoveryCorruptLines?: number[];
    outcomeEventOffsets?: { [eventId: string]: number };
}

export function isWorkflowMetricsEnabled<T>(setting: T) {
    return (
        setting === true ||
        (setting !== null &&
            typeof setting === "object" &&
            !Array.isArray(setting) &&
            "enabled" in setting &&
            setting.enabled === true)
    );
}

/** Only explicit Project consent is independent of the host recording generation. */
export function hasWorkflowMetricsEnablementOverride<T>(setting: T): boolean {
    return (
        typeof setting === "boolean" ||
        (setting !== null &&
            typeof setting === "object" &&
            !Array.isArray(setting) &&
            Object.hasOwn(setting, "enabled") &&
            "enabled" in setting &&
            typeof setting.enabled === "boolean")
    );
}

export interface WorkflowMetricLegacyAdoption {
    historyEpoch: string;
    offset: number;
}

/** The adoption history is a durable identity, retained across later clears. */
export function readWorkflowMetricLegacyAdoption(filePath: string): WorkflowMetricLegacyAdoption | undefined {
    try {
        return JSON.parse(readFileSync(join(dirname(filePath), "legacy-adoption.json"), "utf8"));
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
    }
}

interface RecordingState {
    generation: string;
}

function recordingDirectory(): string {
    return join(getHomeDir(), ".wld", "workflow-metrics");
}

function readRecordingGeneration(): string | undefined {
    try {
        const state: RecordingState = JSON.parse(readFileSync(join(recordingDirectory(), "recording.json"), "utf8"));
        if (typeof state.generation !== "string" || !state.generation) throw new Error("invalid_recording_generation");
        return state.generation;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
    }
}

/** Lock order is journal → recording. The control takes only the recording guard. */
async function acquireRecordingLock(exclusive: boolean, deadline: number): Promise<NativeFileLock> {
    const directory = recordingDirectory();
    mkdirSync(directory, { recursive: true });
    const guard = openNativeFileLock(join(directory, "recording.guard"));
    try {
        while (!guard.tryLockSync(exclusive)) {
            if (Date.now() >= deadline) throw new Error("lock_timeout");
            await new Promise((resolve) => setTimeout(resolve, Math.min(20, deadline - Date.now())));
        }
        if (Date.now() >= deadline) throw new Error("lock_timeout");
        return guard;
    } catch (error) {
        guard.close();
        throw error;
    }
}

/** Commit consent and a host-wide boundary together. Failure is retryable by the control. */
export async function setWorkflowMetricsRecording(enabled: boolean): Promise<void> {
    const guard = await acquireRecordingLock(true, Date.now() + 1000);
    try {
        const { getCustomSetting, setCustomSetting } = await import("../settings.js");
        const saved = getCustomSetting("workflowMetrics", "global");
        // Commit first: process loss can add a boundary, but cannot erase one.
        replaceSynced(
            join(recordingDirectory(), "recording.json"),
            JSON.stringify({ generation: crypto.randomUUID() }) + "\n",
        );
        await setCustomSetting(
            "workflowMetrics",
            saved && typeof saved === "object" && !Array.isArray(saved) ? { ...saved, enabled } : enabled,
            "global",
        );
    } finally {
        guard.close();
    }
}

/** Materialize the initial history while retaining its pre-first-write alias. */
function materializeHistory(state: JournalEpochState): void {
    if (state.historyEpoch !== "initial") return;
    state.historyEpoch = crypto.randomUUID();
    state.initialHistoryEpoch = state.historyEpoch;
}

/** Identity of the next observed enabled interval, captured before queueing. */
function enabledEpoch(epoch: string): string {
    return epoch === "initial" ? "initial-enabled" : `enabled:${epoch}`;
}

/** Load the checkpoint without treating partial recovery as current epoch evidence. */
function readJournalState(filePath: string): JournalEpochState {
    let diskState: JournalEpochState | undefined;
    try {
        diskState = JSON.parse(readFileSync(join(dirname(filePath), "state.json"), "utf8"));
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT") && !(error instanceof SyntaxError))
            throw error;
    }
    return diskState?.v === 1 && diskState.collectionEpoch?.id && diskState.historyEpoch
        ? diskState
        : { v: 1, collectionEpoch: { id: "initial", enabled: false }, historyEpoch: "initial" };
}

function scanJournalLines(bytes: Uint8Array, state: JournalEpochState): number[] {
    const corruptLines = [];
    const lines = new TextDecoder().decode(bytes).split("\n").slice(0, -1);
    let offset = (state.journalBytes ?? 0) - (state.recoveryBytes?.length ?? 0);
    for (const [index, line] of lines.entries()) {
        try {
            const record = JSON.parse(line);
            if (record.v === 2 && typeof record.eventId === "string" && record.eventId.startsWith(`${record.event}:`)) {
                state.outcomeEventOffsets ??= {};
                state.outcomeEventOffsets[record.eventId] = offset;
            }
            if (record.event === "history_epoch") delete state.initialHistoryEpoch;
            if (typeof record.initialHistoryEpoch === "string") state.initialHistoryEpoch = record.initialHistoryEpoch;
            if (typeof record.recordingGeneration === "string") state.recordingGeneration = record.recordingGeneration;
            if (typeof record.historyEpoch === "string") state.historyEpoch = record.historyEpoch;
            if (record.event === "history_epoch" && typeof record.ts === "string") state.historyStartedAt = record.ts;
            if (
                ["collection_epoch", "history_epoch"].includes(record.event) &&
                typeof record.collectionEpoch === "string" &&
                typeof record.enabled === "boolean"
            ) {
                state.collectionEpoch = { id: record.collectionEpoch, enabled: record.enabled };
            }
        } catch {
            corruptLines.push((state.journalLines ?? 0) + index + 1);
        }
        offset += new TextEncoder().encode(line).length + 1;
    }
    state.journalLines = (state.journalLines ?? 0) + lines.length;
    return corruptLines;
}

/** Read the latest durable epoch, not a process-local settings cache. */
export function resolveCollectionEpoch(
    filePath: string,
    enabledAtCall = false,
    projectOverride = false,
): JournalEpochState {
    let state: JournalEpochState | undefined;
    try {
        const intent: JournalClearIntent = JSON.parse(readFileSync(join(dirname(filePath), "clear.json"), "utf8"));
        state = intent.state;
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (!state) {
        state = readJournalState(filePath);
        const tail = readUncheckedTail(filePath, state);
        // An incomplete rebuild cannot authorize an observation. The locked writer
        // advances recovery; a later invocation captures the recovered epoch.
        if (tail.more) return { ...state, collectionEpoch: { id: "recovering", enabled: false } };
        scanJournalLines(tail.bytes.subarray(0, tail.end), state);
    }
    const generation = projectOverride ? undefined : readRecordingGeneration();
    if (generation && generation !== state.recordingGeneration) {
        return {
            ...state,
            recordingGeneration: generation,
            collectionEpoch: { id: `gen:${generation}`, enabled: enabledAtCall },
        };
    }
    if (enabledAtCall && !state.collectionEpoch.enabled) {
        return { ...state, collectionEpoch: { id: enabledEpoch(state.collectionEpoch.id), enabled: true } };
    }
    return state;
}

// Each locked recovery step reads a bounded chunk and commits its progress.
// Retained history is not scanned once the checkpoint is current.
const MAX_RECOVERY_BYTES = 256 * 1024;
function readUncheckedTail(filePath: string, state: JournalEpochState) {
    let file;
    try {
        file = openSync(filePath, "r");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
            return { bytes: new Uint8Array(), end: 0, offset: 0, more: false };
        throw error;
    }
    try {
        const size = fstatSync(file).size;
        const offset = state.journalBytes ?? 0;
        if (offset > size) throw new Error("journal_checkpoint_ahead");
        const pending = state.recoveryBytes ?? [];
        const length = Math.min(size - offset, MAX_RECOVERY_BYTES);
        const bytes = new Uint8Array(pending.length + length);
        bytes.set(pending);
        let read = pending.length;
        while (read < bytes.length) {
            const count = readSync(file, bytes, read, bytes.length - read, offset + read - pending.length);
            if (count === 0) break;
            read += count;
        }
        return { bytes, end: bytes.lastIndexOf(10) + 1, offset: offset - pending.length, more: size - offset > length };
    } finally {
        closeSync(file);
    }
}

/** Repair only new bytes; durable intent preserves gap evidence across a crash. */
function repairJournalTail(filePath: string, state: JournalEpochState): JournalCoverageGap {
    const intentPath = join(dirname(filePath), "repair.json");
    let intent: JournalRepairIntent | undefined;
    try {
        intent = JSON.parse(readFileSync(intentPath, "utf8"));
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (intent) {
        truncateSync(filePath, intent.end);
        writeSynced(filePath, intent.gap, true);
        removeSynced(intentPath);
    }
    const tail = readUncheckedTail(filePath, state);
    const corruptLines = [
        ...(state.recoveryCorruptLines ?? []),
        ...scanJournalLines(tail.bytes.subarray(0, tail.end), state),
    ];
    if (tail.more) {
        state.journalBytes = tail.offset + tail.bytes.length;
        state.recoveryBytes = Array.from(tail.bytes.subarray(tail.end));
        state.recoveryCorruptLines = corruptLines;
        return { tornBytes: 0, corruptLines };
    }
    delete state.recoveryBytes;
    delete state.recoveryCorruptLines;
    const tornBytes = tail.bytes.length - tail.end;
    state.journalBytes = tail.offset + tail.end;
    if (tornBytes || corruptLines.length) {
        materializeHistory(state);
        const gap =
            JSON.stringify({
                v: 1,
                event: "measurement_gap",
                ts: new Date().toISOString(),
                reason: tornBytes ? "incomplete_append" : "interior_corruption",
                tornBytes,
                corruptLines,
                historyEpoch: state.historyEpoch,
                initialHistoryEpoch: state.initialHistoryEpoch,
            }) + "\n";
        const end = tail.offset + tail.end;
        replaceSynced(intentPath, JSON.stringify({ end, gap }));
        truncateSync(filePath, end);
        writeSynced(filePath, gap, true);
        removeSynced(intentPath);
        state.journalLines = (state.journalLines ?? 0) + 1;
        state.journalBytes = end + new TextEncoder().encode(gap).length;
    }
    return { tornBytes, corruptLines };
}

/** @param {string} path @param {string | Uint8Array} text @param {boolean} [append] */
function writeSynced(path: string, text: string | Uint8Array, append = false) {
    const file = openSync(path, append ? "a" : "w", 0o600);
    try {
        const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
        let offset = 0;
        while (offset < bytes.length) offset += writeSync(file, bytes.subarray(offset));
        fsyncSync(file);
    } finally {
        closeSync(file);
    }
}

/** Commit removal so a completed repair intent cannot return after a crash. */
function removeSynced(path: string) {
    rmSync(path);
    syncParentDirectory(path);
}

/** Replace the complete checkpoint and flush its parent where the platform supports it. */
function replaceSynced(path: string, content: string | Uint8Array) {
    writeTextAtomically(path, content);
}

interface JournalClearIntent {
    state: JournalEpochState;
    marker: string;
}

interface JournalLock {
    compromised: boolean;
    close(): void;
}

/** Appends and clears share the same bounded OS guard and lease lock. */
async function acquireJournalLock(filePath: string, deadline: number, signal?: AbortSignal): Promise<JournalLock> {
    if (signal?.aborted) throw new Error("lock_canceled");
    let release: (() => void) | undefined;
    let guard: NativeFileLock | undefined;
    const lock: JournalLock = {
        compromised: false,
        close() {
            try {
                release?.();
            } catch {
                /* Do not throw into development work. */
            }
            guard?.close();
        },
    };
    try {
        const directory = dirname(filePath);
        mkdirSync(directory, { recursive: true });
        const lockPath = join(directory, ".journal.lock");
        closeSync(openSync(lockPath, "a", 0o600));
        // The OS lock cannot expire while its writer is paused. Keep the lease
        // lock for compatibility, but never mutate or release it without this guard.
        guard = openNativeFileLock(join(directory, ".journal.guard"));
        while (!guard.tryLockSync(true)) {
            if (signal?.aborted) throw new Error("lock_canceled");
            if (Date.now() >= deadline) throw new Error("lock_timeout");
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        while (!release) {
            if (signal?.aborted) throw new Error("lock_canceled");
            if (Date.now() >= deadline) throw new Error("lock_timeout");
            try {
                release = lockfile.lockSync(lockPath, {
                    realpath: false,
                    onCompromised: () => {
                        lock.compromised = true;
                    },
                });
            } catch (error) {
                if (!(error && typeof error === "object" && "code" in error && error.code === "ELOCKED")) throw error;
                await new Promise((resolve) => setTimeout(resolve, Math.min(20, deadline - Date.now())));
            }
        }
        return lock;
    } catch (error) {
        lock.close();
        throw error;
    }
}

/** Complete a clear intent after a crash, before accepting any new observation. */
function finishHistoryClear(filePath: string): void {
    const directory = dirname(filePath);
    const intentPath = join(directory, "clear.json");
    let intent: JournalClearIntent;
    try {
        intent = JSON.parse(readFileSync(intentPath, "utf8"));
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        throw error;
    }
    writeSynced(filePath, intent.marker);
    replaceSynced(join(directory, "state.json"), JSON.stringify(intent.state) + "\n");
    try {
        removeSynced(join(directory, "repair.json"));
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    removeSynced(intentPath);
}

interface LegacyMeasurementRow {
    v: number;
    event: string;
    cwdHash?: string;
    historyEpoch?: string;
}

/**
 * Adopt under the old OS guard. Publish a collision split by atomic directory rename,
 * so a crash cannot expose copied rows before their durable export boundary exists.
 */
export function adoptLegacyWorkflowMetricJournal(filePath: string, legacyPath: string, hashes: string[]): void {
    const directory = dirname(filePath);
    if (existsSync(directory) || !existsSync(legacyPath)) return;
    let guard: NativeFileLock;
    try {
        guard = openNativeFileLock(join(dirname(legacyPath), ".journal.guard"));
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT" && existsSync(directory)) return;
        throw error;
    }
    try {
        // Synchronous readers must not block the host event loop behind another writer.
        if (!guard.tryLockSync(true)) throw new Error("lock_timeout");
        if (existsSync(directory)) return;
        if (!existsSync(legacyPath)) throw new Error("legacy_journal_unavailable");
        finishHistoryClear(legacyPath);
        const state = readJournalState(legacyPath);
        const deadline = Date.now() + 1000;
        do {
            repairJournalTail(legacyPath, state);
            if (Date.now() >= deadline) throw new Error("lock_timeout");
        } while (state.recoveryBytes);
        // Preserve the checkpoint bytes when no recovery was needed.
        const text = readFileSync(legacyPath, "utf8");
        const lines = text.split("\n").filter(Boolean);
        const rows = lines.map((line) => {
            try {
                const row: LegacyMeasurementRow = JSON.parse(line);
                return row && typeof row.event === "string" ? row : undefined;
            } catch {
                return undefined;
            }
        });
        const controls = new Set(["collection_epoch", "history_epoch", "measurement_gap"]);
        const belongs = (row: LegacyMeasurementRow | undefined): row is LegacyMeasurementRow =>
            !!row && typeof row.cwdHash === "string" && hashes.includes(row.cwdHash);
        if (rows.every((row) => !!row && (controls.has(row.event) || belongs(row)))) {
            renameSync(dirname(legacyPath), directory);
            syncParentDirectory(directory);
            return;
        }
        const historyEpoch = crypto.randomUUID();
        const ts = new Date().toISOString();
        const marker = JSON.stringify({
            v: 1,
            event: "measurement_gap",
            ts,
            reason: "legacy_shared_journal",
            historyEpoch,
        });
        const copied = rows.filter(belongs).map((row) => JSON.stringify({ ...row, historyEpoch }));
        const content = [marker, ...copied].join("\n") + "\n";
        const offset = new TextEncoder().encode(content).length;
        const staging = `${directory}.adopting-${crypto.randomUUID()}`;
        mkdirSync(staging, { mode: 0o700 });
        try {
            writeSynced(join(staging, "metrics.jsonl"), content);
            replaceSynced(
                join(staging, "state.json"),
                JSON.stringify({
                    v: 1,
                    historyEpoch,
                    collectionEpoch: state.collectionEpoch,
                    journalBytes: offset,
                    journalLines: copied.length + 1,
                }) + "\n",
            );
            // The grant reader fences every start that lacks this adoption identity.
            // Later approvals capture the identity and keep their own offsets.
            replaceSynced(
                join(staging, "legacy-adoption.json"),
                JSON.stringify({
                    legacyHistoryEpoch: state.historyEpoch,
                    historyEpoch,
                    offset,
                }) + "\n",
            );
            renameSync(staging, directory);
            syncParentDirectory(directory);
        } finally {
            rmSync(staging, { recursive: true, force: true });
        }
    } catch (error) {
        if (
            error instanceof Error &&
            "code" in error &&
            ["ENOENT", "ENOTEMPTY", "EEXIST"].includes(String(error.code)) &&
            existsSync(directory)
        )
            return;
        throw error;
    } finally {
        guard.close();
    }
}

/** Run a short authorization under the same guard as append and clear.
 * The callback must not await network I/O; may hand an authorized request to a pre-spawned worker.
 * It must not acquire an export send lock.
 */
export async function withWorkflowMetricJournalLock<T>(
    filePath: string,
    run: (historyEpoch: string) => T | Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    for (;;) {
        const lock = await acquireJournalLock(filePath, Date.now() + 1000, signal);
        try {
            finishHistoryClear(filePath);
            const state = readJournalState(filePath);
            repairJournalTail(filePath, state);
            // A first grant also needs a stable history identity. Otherwise the first
            // append looks like a post-grant clear and bypasses execution start checks.
            materializeHistory(state);
            replaceSynced(join(dirname(filePath), "state.json"), JSON.stringify(state) + "\n");
            if (lock.compromised) throw new Error("journal_unavailable");
            if (!state.recoveryBytes) return await run(state.historyEpoch);
        } finally {
            lock.close();
        }
        // Release the guard and let other operations run between bounded recovery chunks.
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

const journalRecoveries = new Map<string, Promise<void>>();

function resumeJournalRecovery(filePath: string): void {
    if (journalRecoveries.has(filePath)) return;
    const recovery = withWorkflowMetricJournalLock(filePath, () => undefined)
        // On failure, the checkpoint stays pending and a later write starts another pass.
        .catch(() => {})
        .finally(() => journalRecoveries.delete(filePath));
    journalRecoveries.set(filePath, recovery);
}

/** Remove only one Project's measurement history; failure is explicit and retryable. */
export async function clearWorkflowMetricJournal(filePath: string, projectRoot: string): Promise<JournalResult> {
    try {
        return await withWorkflowMetricJournalLock(filePath, async () => {
            const previous = readJournalState(filePath);
            const deliveryInFlight = await metricsDeliveryInFlightForJournal(projectRoot).catch(() => true);
            const historyEpoch = crypto.randomUUID();
            const historyStartedAt = new Date().toISOString();
            const marker =
                JSON.stringify({
                    v: 1,
                    event: "history_epoch",
                    ts: historyStartedAt,
                    historyEpoch,
                    collectionEpoch: previous.collectionEpoch.id,
                    enabled: previous.collectionEpoch.enabled,
                    recordingGeneration: previous.recordingGeneration,
                }) + "\n";
            const state: JournalEpochState = {
                v: 1,
                historyEpoch,
                historyStartedAt,
                collectionEpoch: previous.collectionEpoch,
                recordingGeneration: previous.recordingGeneration,
                journalBytes: new TextEncoder().encode(marker).length,
                journalLines: 1,
            };
            // Intent fences readers and stale writers even if truncation is interrupted.
            replaceSynced(join(dirname(filePath), "clear.json"), JSON.stringify({ state, marker }));
            finishHistoryClear(filePath);
            return { persisted: true, historyEpoch, deliveryInFlight };
        });
    } catch (error) {
        return {
            persisted: false,
            reason: error instanceof Error && error.message === "lock_timeout" ? "lock_timeout" : "storage_failure",
        };
    }
}

/** The observation and its epoch are captured once by the caller and reused on retry. */
export async function appendWorkflowMetric<T>(
    filePath: string,
    projectRoot: string,
    record: T,
    invocation: JournalInvocation,
): Promise<T & JournalResult> {
    // Failure metadata lets an explicit retry retain its original boundary and identity.
    const failedRecord = {
        ...record,
        collectionEpoch: invocation.epoch,
        collectionEnabledAtCall: invocation.enabled,
        historyEpoch: invocation.historyEpoch,
    };
    let lock: JournalLock | undefined;
    let recordingLock: NativeFileLock | undefined;
    try {
        const { getCustomSetting, getMergedCustomSetting } = await import("../settings.js");
        // Do not create a journal for an opt-out installation.
        if (!invocation.enabled && (invocation.epoch === "initial" || !existsSync(filePath))) {
            return { ...failedRecord, persisted: false, reason: "disabled" };
        }
        const directory = dirname(filePath);
        lock = await acquireJournalLock(filePath, invocation.deadline);
        recordingLock = await acquireRecordingLock(false, invocation.deadline);
        finishHistoryClear(filePath);
        const enabled = isWorkflowMetricsEnabled(getMergedCustomSetting("workflowMetrics", projectRoot));
        const state = readJournalState(filePath);
        const entries = [];
        const repair = repairJournalTail(filePath, state);
        if (state.recoveryBytes) {
            replaceSynced(join(directory, "state.json"), JSON.stringify(state) + "\n");
            resumeJournalRecovery(filePath);
            return { ...failedRecord, persisted: false, reason: "recovery_pending" };
        }
        materializeHistory(state);
        const generation = !hasWorkflowMetricsEnablementOverride(
            getCustomSetting("workflowMetrics", "project", projectRoot),
        )
            ? readRecordingGeneration()
            : undefined;
        const generationChanged = !!generation && generation !== state.recordingGeneration;
        if (
            generationChanged ||
            enabled !== state.collectionEpoch.enabled ||
            (state.collectionEpoch.id === "initial" && invocation.enabled && !enabled)
        ) {
            // The pending enabled identity is shared by calls made after enablement.
            state.collectionEpoch = {
                id: generationChanged
                    ? `gen:${generation}`
                    : enabled
                      ? enabledEpoch(state.collectionEpoch.id)
                      : crypto.randomUUID(),
                enabled,
            };
            if (generationChanged) state.recordingGeneration = generation;
            entries.push({
                v: 1,
                event: "collection_epoch",
                ts: new Date().toISOString(),
                collectionEpoch: state.collectionEpoch.id,
                enabled,
                historyEpoch: state.historyEpoch,
                initialHistoryEpoch: state.initialHistoryEpoch,
                recordingGeneration: state.recordingGeneration,
            });
        }
        if (entries.length) {
            writeSynced(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", true);
        }
        state.journalBytes = statSync(filePath).size;
        state.journalLines = (state.journalLines ?? 0) + entries.length;
        replaceSynced(join(directory, "state.json"), JSON.stringify(state) + "\n");
        if (lock.compromised) return { ...failedRecord, persisted: false, reason: "lock_compromised" };
        if (!invocation.enabled || !enabled) return { ...failedRecord, persisted: false, reason: "disabled" };
        if (
            invocation.epoch !== state.collectionEpoch.id &&
            !(invocation.epoch === "initial" && state.collectionEpoch.id === "initial-enabled")
        ) {
            return { ...failedRecord, persisted: false, reason: "collection_boundary" };
        }
        const initialAlias =
            invocation.historyEpoch === "initial" &&
            (state.historyEpoch === "initial" || state.historyEpoch === state.initialHistoryEpoch);
        if (invocation.historyEpoch && !initialAlias && invocation.historyEpoch !== state.historyEpoch) {
            return { ...failedRecord, persisted: false, reason: "history_boundary" };
        }
        if (
            !initialAlias &&
            state.historyStartedAt &&
            record !== null &&
            typeof record === "object" &&
            "ts" in record &&
            typeof record.ts === "string" &&
            Date.parse(record.ts) < Date.parse(state.historyStartedAt)
        ) {
            return { ...failedRecord, persisted: false, reason: "history_boundary" };
        }
        const outcomeIdentity =
            record !== null &&
            typeof record === "object" &&
            "v" in record &&
            record.v === 2 &&
            "event" in record &&
            "eventId" in record &&
            typeof record.eventId === "string" &&
            record.eventId.startsWith(`${record.event}:`)
                ? record.eventId
                : undefined;
        const previousOffset = outcomeIdentity ? state.outcomeEventOffsets?.[outcomeIdentity] : undefined;
        if (previousOffset !== undefined) {
            const file = openSync(filePath, "r");
            try {
                const bytes = new Uint8Array(MAX_RECOVERY_BYTES);
                const size = readSync(file, bytes, 0, bytes.length, previousOffset);
                const end = bytes.subarray(0, size).indexOf(10);
                if (end < 0) throw new Error("incomplete_saved_observation");
                const previous = JSON.parse(new TextDecoder().decode(bytes.subarray(0, end)));
                if (previous.eventId !== outcomeIdentity) throw new Error("observation_index_mismatch");
                return { ...previous, persisted: true };
            } finally {
                closeSync(file);
            }
        }
        const observationOffset = state.journalBytes;
        const saved = {
            ...record,
            collectionEpoch: state.collectionEpoch.id,
            historyEpoch: state.historyEpoch,
            ...(state.initialHistoryEpoch ? { initialHistoryEpoch: state.initialHistoryEpoch } : {}),
        };
        writeSynced(filePath, JSON.stringify(saved) + "\n", true);
        state.journalBytes = statSync(filePath).size;
        state.journalLines = (state.journalLines ?? 0) + 1;
        if (outcomeIdentity && observationOffset !== undefined) {
            state.outcomeEventOffsets ??= {};
            state.outcomeEventOffsets[outcomeIdentity] = observationOffset;
        }
        replaceSynced(join(directory, "state.json"), JSON.stringify(state) + "\n");
        return {
            ...saved,
            persisted: true,
            ...(repair.tornBytes || repair.corruptLines.length ? { coverageGap: repair } : {}),
        };
    } catch (error) {
        return {
            ...failedRecord,
            persisted: false,
            reason: error instanceof Error && error.message === "lock_timeout" ? "lock_timeout" : "storage_failure",
        };
    } finally {
        recordingLock?.close();
        lock?.close();
    }
}
