/** Durable, content-free Project measurement journal. */
import { dirname, join } from "@std/path";
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
    journalBytes?: number;
    journalLines?: number;
    recoveryBytes?: number[];
    recoveryCorruptLines?: number[];
    outcomeEventOffsets?: { [eventId: string]: number };
}

export function isWorkflowMetricsEnabled<T>(setting: T) {
    return setting === true || (setting !== null && typeof setting === "object" &&
        !Array.isArray(setting) && "enabled" in setting && setting.enabled === true);
}

/** Identity of the next observed enabled interval, captured before queueing. */
function enabledEpoch(epoch: string): string {
    return epoch === "initial" ? "initial-enabled" : `enabled:${epoch}`;
}

/** Load the checkpoint without treating partial recovery as current epoch evidence. */
function readJournalState(filePath: string): JournalEpochState {
    let diskState: JournalEpochState | undefined;
    try {
        diskState = JSON.parse(Deno.readTextFileSync(join(dirname(filePath), "state.json")));
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound) && !(error instanceof SyntaxError)) throw error;
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
            if (
                record.v === 2 && typeof record.eventId === "string" &&
                record.eventId.startsWith(`${record.event}:`)
            ) {
                state.outcomeEventOffsets ??= {};
                state.outcomeEventOffsets[record.eventId] = offset;
            }
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
export function resolveCollectionEpoch(filePath: string, enabledAtCall = false): JournalEpochState {
    try {
        const intent = JSON.parse(Deno.readTextFileSync(join(dirname(filePath), "clear.json")));
        return intent.state;
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const state = readJournalState(filePath);
    const tail = readUncheckedTail(filePath, state);
    // An incomplete rebuild cannot authorize an observation. The locked writer
    // advances recovery; a later invocation captures the recovered epoch.
    if (tail.more) return { ...state, collectionEpoch: { id: "recovering", enabled: false } };
    scanJournalLines(tail.bytes.subarray(0, tail.end), state);
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
        file = Deno.openSync(filePath, { read: true });
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return { bytes: new Uint8Array(), end: 0, offset: 0, more: false };
        throw error;
    }
    try {
        const size = file.statSync().size;
        const offset = state.journalBytes ?? 0;
        if (offset > size) throw new Error("journal_checkpoint_ahead");
        file.seekSync(offset, Deno.SeekMode.Start);
        const pending = state.recoveryBytes ?? [];
        const length = Math.min(size - offset, MAX_RECOVERY_BYTES);
        const bytes = new Uint8Array(pending.length + length);
        bytes.set(pending);
        let read = pending.length;
        while (read < bytes.length) {
            const count = file.readSync(bytes.subarray(read));
            if (count === null) break;
            read += count;
        }
        return { bytes, end: bytes.lastIndexOf(10) + 1, offset: offset - pending.length, more: size - offset > length };
    } finally {
        file.close();
    }
}

/** Repair only new bytes; durable intent preserves gap evidence across a crash. */
function repairJournalTail(filePath: string, state: JournalEpochState): JournalCoverageGap {
    const intentPath = join(dirname(filePath), "repair.json");
    let intent: JournalRepairIntent | undefined;
    try {
        intent = JSON.parse(Deno.readTextFileSync(intentPath));
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (intent) {
        Deno.truncateSync(filePath, intent.end);
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
    if (tornBytes) {
        if (state.historyEpoch === "initial") state.historyEpoch = crypto.randomUUID();
        const gap = JSON.stringify({
            v: 1,
            event: "measurement_gap",
            ts: new Date().toISOString(),
            reason: "incomplete_append",
            tornBytes,
            corruptLines,
            historyEpoch: state.historyEpoch,
        }) + "\n";
        const end = tail.offset + tail.end;
        replaceSynced(intentPath, JSON.stringify({ end, gap }));
        Deno.truncateSync(filePath, end);
        writeSynced(filePath, gap, true);
        removeSynced(intentPath);
        state.journalLines = (state.journalLines ?? 0) + 1;
    }
    return { tornBytes, corruptLines };
}

/** @param {string} path @param {string | Uint8Array} text @param {boolean} [append] */
function writeSynced(path: string, text: string | Uint8Array, append = false) {
    const file = Deno.openSync(path, { create: true, write: true, append, truncate: !append });
    try {
        const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
        let offset = 0;
        while (offset < bytes.length) offset += file.writeSync(bytes.subarray(offset));
        file.syncSync();
    } finally {
        file.close();
    }
}

/** Commit removal so a completed repair intent cannot return after a crash. */
function removeSynced(path: string) {
    Deno.removeSync(path);
    const parent = Deno.openSync(dirname(path), { read: true });
    try {
        parent.syncSync();
    } finally {
        parent.close();
    }
}

/** Atomic replacement also syncs the parent directory.
 * @param {string} path
 * @param {string | Uint8Array} content
 */
function replaceSynced(path: string, content: string | Uint8Array) {
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    try {
        writeSynced(temporary, content);
        Deno.renameSync(temporary, path);
        const parent = Deno.openSync(dirname(path), { read: true });
        try {
            parent.syncSync();
        } finally {
            parent.close();
        }
    } finally {
        try {
            Deno.removeSync(temporary);
        } catch { /* Already renamed. */ }
    }
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
    let guard: Deno.FsFile | undefined;
    const lock: JournalLock = {
        compromised: false,
        close() {
            try {
                release?.();
            } catch { /* Do not throw into development work. */ }
            guard?.close();
        },
    };
    try {
        const directory = dirname(filePath);
        Deno.mkdirSync(directory, { recursive: true });
        const lockPath = join(directory, ".journal.lock");
        Deno.openSync(lockPath, { create: true, write: true }).close();
        // The OS lock cannot expire while its writer is paused. Keep the lease
        // lock for compatibility, but never mutate or release it without this guard.
        guard = Deno.openSync(join(directory, ".journal.guard"), { create: true, read: true, write: true });
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
        intent = JSON.parse(Deno.readTextFileSync(intentPath));
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return;
        throw error;
    }
    writeSynced(filePath, intent.marker);
    replaceSynced(join(directory, "state.json"), JSON.stringify(intent.state) + "\n");
    try {
        removeSynced(join(directory, "repair.json"));
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    removeSynced(intentPath);
}

/** Run a short authorization under the same guard as append and clear.
 * The callback must not perform network I/O or acquire an export send lock.
 */
export async function withWorkflowMetricJournalLock<T>(
    filePath: string,
    run: (historyEpoch: string) => T | Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    const lock = await acquireJournalLock(filePath, Date.now() + 1000, signal);
    try {
        finishHistoryClear(filePath);
        const state = readJournalState(filePath);
        repairJournalTail(filePath, state);
        // A first grant also needs a stable history identity. Otherwise the first
        // append looks like a post-grant clear and bypasses execution start checks.
        if (state.historyEpoch === "initial") state.historyEpoch = crypto.randomUUID();
        replaceSynced(join(dirname(filePath), "state.json"), JSON.stringify(state) + "\n");
        if (state.recoveryBytes || lock.compromised) throw new Error("journal_unavailable");
        return await run(state.historyEpoch);
    } finally {
        lock.close();
    }
}

/** Remove only one Project's measurement history; failure is explicit and retryable. */
export async function clearWorkflowMetricJournal(filePath: string): Promise<JournalResult> {
    let lock: JournalLock | undefined;
    try {
        lock = await acquireJournalLock(filePath, Date.now() + 1000);
        finishHistoryClear(filePath);
        const previous = readJournalState(filePath);
        repairJournalTail(filePath, previous);
        if (previous.recoveryBytes) {
            replaceSynced(join(dirname(filePath), "state.json"), JSON.stringify(previous) + "\n");
            return { persisted: false, reason: "recovery_pending" };
        }
        const deliveryInFlight = await metricsDeliveryInFlightForJournal(filePath).catch(() => true);
        const historyEpoch = crypto.randomUUID();
        const historyStartedAt = new Date().toISOString();
        const marker = JSON.stringify({
            v: 1,
            event: "history_epoch",
            ts: historyStartedAt,
            historyEpoch,
            collectionEpoch: previous.collectionEpoch.id,
            enabled: previous.collectionEpoch.enabled,
        }) + "\n";
        const state: JournalEpochState = {
            v: 1,
            historyEpoch,
            historyStartedAt,
            collectionEpoch: previous.collectionEpoch,
            journalBytes: new TextEncoder().encode(marker).length,
            journalLines: 1,
        };
        // Intent fences readers and stale writers even if truncation is interrupted.
        replaceSynced(join(dirname(filePath), "clear.json"), JSON.stringify({ state, marker }));
        finishHistoryClear(filePath);
        return { persisted: true, historyEpoch, deliveryInFlight };
    } catch (error) {
        return {
            persisted: false,
            reason: error instanceof Error && error.message === "lock_timeout" ? "lock_timeout" : "storage_failure",
        };
    } finally {
        lock?.close();
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
    try {
        const { getMergedCustomSetting } = await import("../settings.js");
        // Do not create a journal for an opt-out installation.
        if (!invocation.enabled && invocation.epoch === "initial") {
            return { ...failedRecord, persisted: false, reason: "disabled" };
        }
        const directory = dirname(filePath);
        lock = await acquireJournalLock(filePath, invocation.deadline);
        finishHistoryClear(filePath);
        const enabled = isWorkflowMetricsEnabled(getMergedCustomSetting("workflowMetrics", projectRoot));
        const state = readJournalState(filePath);
        const entries = [];
        const repair = repairJournalTail(filePath, state);
        if (state.recoveryBytes) {
            replaceSynced(join(directory, "state.json"), JSON.stringify(state) + "\n");
            return { ...failedRecord, persisted: false, reason: "recovery_pending" };
        }
        if (state.historyEpoch === "initial") state.historyEpoch = crypto.randomUUID();
        if (!repair.tornBytes && repair.corruptLines.length) {
            entries.push({
                v: 1,
                event: "measurement_gap",
                ts: new Date().toISOString(),
                reason: "interior_corruption",
                ...repair,
                historyEpoch: state.historyEpoch,
            });
        }
        if (
            enabled !== state.collectionEpoch.enabled ||
            (state.collectionEpoch.id === "initial" && invocation.enabled && !enabled)
        ) {
            // The pending enabled identity is shared by calls made after enablement.
            state.collectionEpoch = {
                id: enabled ? enabledEpoch(state.collectionEpoch.id) : crypto.randomUUID(),
                enabled,
            };
            entries.push({
                v: 1,
                event: "collection_epoch",
                ts: new Date().toISOString(),
                collectionEpoch: state.collectionEpoch.id,
                enabled,
                historyEpoch: state.historyEpoch,
            });
        }
        if (entries.length) {
            writeSynced(
                filePath,
                entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
                true,
            );
        }
        state.journalBytes = Deno.statSync(filePath).size;
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
        if (
            invocation.historyEpoch && invocation.historyEpoch !== "initial" &&
            invocation.historyEpoch !== state.historyEpoch
        ) {
            return { ...failedRecord, persisted: false, reason: "history_boundary" };
        }
        if (
            invocation.historyEpoch !== "initial" && state.historyStartedAt && record !== null &&
            typeof record === "object" && "ts" in record &&
            typeof record.ts === "string" && Date.parse(record.ts) < Date.parse(state.historyStartedAt)
        ) {
            return { ...failedRecord, persisted: false, reason: "history_boundary" };
        }
        const outcomeIdentity = record !== null && typeof record === "object" &&
                "v" in record && record.v === 2 && "event" in record &&
                "eventId" in record && typeof record.eventId === "string" &&
                record.eventId.startsWith(`${record.event}:`)
            ? record.eventId
            : undefined;
        const previousOffset = outcomeIdentity ? state.outcomeEventOffsets?.[outcomeIdentity] : undefined;
        if (previousOffset !== undefined) {
            const file = Deno.openSync(filePath, { read: true });
            try {
                file.seekSync(previousOffset, Deno.SeekMode.Start);
                const bytes = new Uint8Array(MAX_RECOVERY_BYTES);
                const size = file.readSync(bytes) || 0;
                const end = bytes.subarray(0, size).indexOf(10);
                if (end < 0) throw new Error("incomplete_saved_observation");
                const previous = JSON.parse(new TextDecoder().decode(bytes.subarray(0, end)));
                if (previous.eventId !== outcomeIdentity) throw new Error("observation_index_mismatch");
                return { ...previous, persisted: true };
            } finally {
                file.close();
            }
        }
        const observationOffset = state.journalBytes;
        const saved = { ...record, collectionEpoch: state.collectionEpoch.id, historyEpoch: state.historyEpoch };
        writeSynced(filePath, JSON.stringify(saved) + "\n", true);
        state.journalBytes = Deno.statSync(filePath).size;
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
        lock?.close();
    }
}
