/** Journal discovery, serialized authorization, bounded delivery, and public status. */
import { join } from "@std/path";
import {
    type InstalledMetricsExporter,
    metricsExporterStillApproved,
    resolveApprovedMetricsExporters,
} from "../extensions/metrics-exporter.ts";
import { remotePersonalResourcesActive } from "../remote/personal-resources.ts";
import { getWorkflowMetricsFilePath } from "./metrics.js";
import { resolveCollectionEpoch, withWorkflowMetricJournalLock } from "./metrics-journal.ts";
import {
    grantMatchesExporter,
    type MetricsExportDestinationGrant,
    type MetricsExportProjectStart,
    readMetricsExportCredentials,
    readMetricsExportGrants,
    readMetricsExportHostIdentity,
} from "./metrics-export-grants.ts";
import {
    appendMetricsExportLedger,
    type MetricsDeliveryItem,
    readMetricsExportLedger,
} from "./metrics-export-ledger.ts";
import {
    buildMetricsExportObservation,
    isExportableMetric,
    type MetricsExportObservation,
    metricsExportReference,
    type MetricsJournalRow,
} from "./metrics-export-record.ts";
import {
    exportDestinationDirectory,
    replaceExportFile,
    tryExportLock,
    withExportConfigurationLock,
} from "./metrics-export-storage.ts";
import type { MetricsExportContext, MetricsExporterRequest } from "./metrics-exporter-worker.ts";

export const METRICS_EXPORT_INTERVAL_MS = 60_000;
export const METRICS_EXPORT_DEADLINE_MS = 30_000;
interface PendingPosition {
    offset: number;
    eventId: string;
}
interface ProjectCursor {
    grantId: string;
    startEpoch: string;
    startOffset: number;
    historyEpoch: string;
    offset: number;
    excludedExecutions?: string[];
    pending: PendingPosition[];
}
interface CursorFile {
    [projectRef: string]: ProjectCursor;
}
interface PositionedRow {
    offset: number;
    end: number;
    row: MetricsJournalRow;
}
interface CycleOptions {
    signal?: AbortSignal;
    deadlineMs?: number;
}
interface WorkerResult {
    outcome?: string;
    retry?: string;
    code?: string;
    status?: string;
}

function readCursor(destinationId: string): CursorFile {
    try {
        return JSON.parse(Deno.readTextFileSync(join(exportDestinationDirectory(destinationId), "cursor.json")));
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return {};
        throw error;
    }
}
function readRows(path: string, offset: number, firstOnly = false, endOffset?: number): PositionedRow[] {
    let file;
    try {
        file = Deno.openSync(path, { read: true });
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return [];
        throw error;
    }
    let bytes;
    try {
        const size = Math.min(file.statSync().size, endOffset ?? Infinity);
        bytes = new Uint8Array(Math.max(0, firstOnly ? Math.min(16_384, size - offset) : size - offset));
        file.seekSync(offset, Deno.SeekMode.Start);
        let read = 0;
        while (read < bytes.length) {
            const n = file.readSync(bytes.subarray(read));
            if (n === null) break;
            read += n;
        }
        bytes = bytes.subarray(0, read);
    } finally {
        file.close();
    }
    const rows: PositionedRow[] = [];
    let start = 0;
    for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] !== 10) continue;
        try {
            rows.push({
                offset: offset + start,
                end: offset + i + 1,
                row: JSON.parse(new TextDecoder().decode(bytes.subarray(start, i))),
            });
        } catch { /* Invalid journal rows are never candidates. */ }
        start = i + 1;
        if (firstOnly) break;
    }
    return rows;
}
function scanProject(
    grant: MetricsExportDestinationGrant,
    project: MetricsExportProjectStart,
    previous: ProjectCursor | undefined,
    epoch: string,
): ProjectCursor {
    const cursor: ProjectCursor =
        previous && previous.grantId === grant.grantId && previous.startEpoch === project.historyEpoch &&
            previous.startOffset === project.offset && previous.historyEpoch === epoch && previous.excludedExecutions
            ? structuredClone(previous)
            : {
                grantId: grant.grantId,
                startEpoch: project.historyEpoch,
                startOffset: project.offset,
                historyEpoch: epoch,
                offset: epoch === project.historyEpoch ? project.offset : 0,
                pending: [],
            };
    // Only a recorded start before consent excludes an execution. Auxiliary
    // recorders without starts use the row offset, like rows without execution IDs.
    cursor.excludedExecutions ??= epoch === project.historyEpoch
        ? readRows(getWorkflowMetricsFilePath(project.projectRoot), 0, false, project.offset)
            .filter(({ row }) => row.v === 2 && row.historyEpoch === epoch && row.event === "execution_started")
            .flatMap(({ row }) => row.executionId ? [row.executionId] : [])
        : [];
    const excludedExecutions = new Set(cursor.excludedExecutions);
    for (const positioned of readRows(getWorkflowMetricsFilePath(project.projectRoot), cursor.offset)) {
        cursor.offset = positioned.end;
        const row = positioned.row;
        if (row.v !== 2 || row.historyEpoch !== epoch) continue;
        if (
            isExportableMetric(row) &&
            (!row.executionId || !excludedExecutions.has(row.executionId))
        ) {
            cursor.pending.push({ offset: positioned.offset, eventId: row.eventId });
        }
    }
    return cursor;
}
function rowAt(path: string, position: PendingPosition, epoch: string): MetricsJournalRow | null {
    const positioned = readRows(path, position.offset, true)[0];
    return positioned?.offset === position.offset && positioned.row.eventId === position.eventId &&
            positioned.row.historyEpoch === epoch
        ? positioned.row
        : null;
}
function code(value?: string): string | undefined {
    return value === undefined
        ? undefined
        : typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value)
        ? value
        : "unrecognized";
}
function callExporter(
    entryPath: string,
    method: "deliver" | "confirm",
    observation: MetricsExportObservation,
    context: MetricsExportContext,
    signal?: AbortSignal,
): Promise<WorkerResult> {
    return new Promise((resolve) => {
        const worker = new Worker(new URL("./metrics-exporter-worker.ts", import.meta.url).href, { type: "module" });
        let finished = false;
        const finish = (result: WorkerResult) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            worker.terminate();
            resolve(result);
        };
        const abort = () => finish({ outcome: "uncertain", code: "shutdown" });
        const timer = setTimeout(
            () => finish({ outcome: "uncertain", code: "deadline" }),
            Math.max(0, context.deadline - Date.now()),
        );
        worker.onerror = (event) => {
            event.preventDefault();
            finish({ outcome: "uncertain", code: "worker_exit" });
        };
        worker.onmessageerror = () => finish({ outcome: "uncertain", code: "malformed_result" });
        worker.onmessage = ({ data }) => {
            const result: WorkerResult = data;
            if (
                !result || typeof result !== "object" ||
                (method === "deliver" && !(result.outcome === "accepted" || result.outcome === "uncertain" ||
                    (result.outcome === "not_accepted" &&
                        ["retryable", "needs_correction", "permanent"].includes(result.retry ?? "")))) ||
                (method === "confirm" &&
                    !["present", "not_found_yet", "mismatch", "unsupported"].includes(result.status ?? ""))
            ) {
                finish({ outcome: "uncertain", code: "malformed_result" });
            } else {finish({
                    outcome: result.outcome,
                    retry: result.retry,
                    code: code(result.code),
                    status: result.status,
                });}
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
            abort();
            return;
        }
        const request: MetricsExporterRequest = { entryPath, method, observation, context };
        worker.postMessage(request);
    });
}
/** Inventory can use asynchronous package APIs. Cancel it without holding authorization locks. */
async function findApprovedExporter(
    grant: MetricsExportDestinationGrant,
    signal?: AbortSignal,
): Promise<InstalledMetricsExporter | undefined> {
    if (signal?.aborted) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = () => {};
    const stopped = new Promise<undefined>((resolve) => {
        cancel = () => resolve(undefined);
        timer = setTimeout(cancel, 1000);
        signal?.addEventListener("abort", cancel, { once: true });
    });
    try {
        return await Promise.race([
            resolveApprovedMetricsExporters().then(
                (exporters) => exporters.find((e) => grantMatchesExporter(grant, e)),
                () => undefined,
            ),
            stopped,
        ]);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
    }
}

function currentProject(
    grant: MetricsExportDestinationGrant,
    project: MetricsExportProjectStart,
): MetricsExportDestinationGrant | undefined {
    return readMetricsExportGrants().find((g) =>
        g.destinationId === grant.destinationId && g.grantId === grant.grantId &&
        g.projects.some((p) =>
            p.projectRoot === project.projectRoot && p.historyEpoch === project.historyEpoch &&
            p.offset === project.offset
        )
    );
}
function shouldSend(item: MetricsDeliveryItem | undefined, revision: string): boolean {
    return !item || (item.state === "pending" && (item.nextAttemptAt ?? 0) <= Date.now()) ||
        (item.state === "rejected" && item.retry === "needs_correction" && item.credentialsRevision !== revision);
}
function retainPending(item: MetricsDeliveryItem): boolean {
    return item.state === "pending" || (item.state === "rejected" && item.retry === "needs_correction");
}

export async function runMetricsExportCycle(options: CycleOptions = {}): Promise<void> {
    if (remotePersonalResourcesActive() || options.signal?.aborted) return;
    const grants = readMetricsExportGrants();
    if (!grants.length) return;
    const identity = await readMetricsExportHostIdentity();
    for (const grant of grants) {
        if (options.signal?.aborted) break;
        const directory = exportDestinationDirectory(grant.destinationId);
        const lock = tryExportLock(join(directory, ".send.lock"));
        if (!lock) continue;
        try {
            const ledger = readMetricsExportLedger(grant.destinationId);
            for (const [key, item] of ledger) {
                if (item.state !== "sending" && !item.confirming) continue;
                const lost: MetricsDeliveryItem = item.state === "sending"
                    ? {
                        ...item,
                        state: "unconfirmed",
                        code: "process_lost",
                        at: new Date().toISOString(),
                    }
                    : { ...item, confirming: false };
                appendMetricsExportLedger(grant.destinationId, lost);
                ledger.set(key, lost);
            }
            const cursors = readCursor(grant.destinationId);
            for (const project of grant.projects) {
                if (options.signal?.aborted || !currentProject(grant, project)) break;
                const path = getWorkflowMetricsFilePath(project.projectRoot);
                const projectRef = await metricsExportReference(identity, "project", project.projectRoot);
                const journalRef = await metricsExportReference(identity, "journal", path);
                const cursor = await withWorkflowMetricJournalLock(
                    path,
                    (epoch) => scanProject(grant, project, cursors[projectRef], epoch),
                    options.signal,
                );
                cursors[projectRef] = cursor;
                replaceExportFile(join(directory, "cursor.json"), JSON.stringify(cursors));
                for (const position of [...cursor.pending]) {
                    if (options.signal?.aborted) break;
                    const key = `${projectRef}:${cursor.historyEpoch}:${position.eventId}`;
                    const previous = ledger.get(key);
                    if (!shouldSend(previous, readMetricsExportCredentials(grant.destinationId).revision)) {
                        if (previous && !retainPending(previous)) {
                            cursor.pending = cursor.pending.filter((p) => p.eventId !== position.eventId);
                        }
                        continue;
                    }
                    const exporter = await findApprovedExporter(grant, options.signal);
                    if (!exporter || options.signal?.aborted) continue;
                    // Configuration edits use configuration -> journal ordering too. Revoke cannot
                    // commit between the final consent read and the durable intent.
                    const authorized = await withExportConfigurationLock(
                        () =>
                            withWorkflowMetricJournalLock(path, (epoch) => {
                                if (epoch !== cursor.historyEpoch || options.signal?.aborted) return null;
                                const fresh = currentProject(grant, project);
                                if (!metricsExporterStillApproved(exporter) || !fresh) return null;
                                const row = rowAt(path, position, epoch);
                                if (!row) return null;
                                const credentials = readMetricsExportCredentials(grant.destinationId);
                                const intent: MetricsDeliveryItem = {
                                    eventId: row.eventId,
                                    attemptId: crypto.randomUUID(),
                                    grantId: grant.grantId,
                                    projectRef,
                                    journalRef,
                                    historyEpoch: epoch,
                                    offset: position.offset,
                                    state: "sending",
                                    at: new Date().toISOString(),
                                    credentialsRevision: credentials.revision,
                                    attempts: (previous?.attempts ?? 0) + 1,
                                    confirmations: 0,
                                };
                                appendMetricsExportLedger(grant.destinationId, intent);
                                ledger.set(key, intent);
                                return { row, exporter, credentials, intent };
                            }, options.signal),
                        options.signal,
                    );
                    if (!authorized) continue;
                    const observation = await buildMetricsExportObservation(
                        authorized.row,
                        project.projectRoot,
                        identity,
                    );
                    if (!observation) throw new Error("Invalid export candidate");
                    const context: MetricsExportContext = {
                        endpoint: grant.endpoint,
                        externalProject: grant.externalProject,
                        credentials: authorized.credentials.credentials,
                        deadline: Date.now() + (options.deadlineMs ?? METRICS_EXPORT_DEADLINE_MS),
                    };
                    let result: WorkerResult;
                    try {
                        result = await callExporter(
                            authorized.exporter.entryPath,
                            "deliver",
                            observation,
                            context,
                            options.signal,
                        );
                    } catch {
                        result = { outcome: "uncertain", code: "worker_exit" };
                    }
                    const settlement: MetricsDeliveryItem = {
                        ...authorized.intent,
                        state: result.outcome === "accepted"
                            ? "accepted"
                            : result.outcome === "not_accepted"
                            ? result.retry === "retryable" ? "pending" : "rejected"
                            : "unconfirmed",
                        code: code(result.code),
                        at: new Date().toISOString(),
                    };
                    if (result.outcome === "not_accepted") {
                        settlement.retry = result.retry as MetricsDeliveryItem["retry"];
                    }
                    if (settlement.state === "pending") {
                        settlement.nextAttemptAt = Date.now() +
                            Math.min(3_600_000, 60_000 * 2 ** Math.min(settlement.attempts - 1, 6));
                    }
                    appendMetricsExportLedger(grant.destinationId, settlement);
                    ledger.set(key, settlement);
                    if (!retainPending(settlement)) {
                        cursor.pending = cursor.pending.filter((p) => p.eventId !== position.eventId);
                    }
                }
                replaceExportFile(join(directory, "cursor.json"), JSON.stringify(cursors));
                for (const [key, item] of ledger) {
                    if (options.signal?.aborted || !currentProject(grant, project)) break;
                    if (
                        item.grantId !== grant.grantId || item.projectRef !== projectRef ||
                        item.historyEpoch !== cursor.historyEpoch ||
                        (item.historyEpoch === project.historyEpoch && item.offset < project.offset) ||
                        !["accepted", "unconfirmed"].includes(item.state) || item.confirmations >= 3
                    ) continue;
                    const exporter = await findApprovedExporter(grant, options.signal);
                    if (!exporter || options.signal?.aborted) continue;
                    const candidate = rowAt(path, { offset: item.offset, eventId: item.eventId }, item.historyEpoch);
                    const observation = candidate
                        ? await buildMetricsExportObservation(candidate, project.projectRoot, identity)
                        : null;
                    if (!observation) continue;
                    const authorized = await withExportConfigurationLock(
                        () =>
                            withWorkflowMetricJournalLock(path, (epoch) => {
                                if (
                                    epoch !== item.historyEpoch || options.signal?.aborted ||
                                    !metricsExporterStillApproved(exporter)
                                ) return null;
                                const row = rowAt(path, { offset: item.offset, eventId: item.eventId }, epoch);
                                if (!row) return null;
                                if (!currentProject(grant, project) || options.signal?.aborted) return null;
                                // Count the check before I/O, so a crash cannot evade the three-check cap.
                                const intent: MetricsDeliveryItem = {
                                    ...item,
                                    confirming: true,
                                    confirmations: item.confirmations + 1,
                                };
                                appendMetricsExportLedger(grant.destinationId, intent);
                                ledger.set(key, intent);
                                return {
                                    exporter,
                                    observation,
                                    intent,
                                    credentials: readMetricsExportCredentials(grant.destinationId).credentials,
                                };
                            }, options.signal),
                        options.signal,
                    );
                    if (!authorized) continue;
                    let result: WorkerResult;
                    try {
                        result = await callExporter(authorized.exporter.entryPath, "confirm", authorized.observation, {
                            endpoint: grant.endpoint,
                            externalProject: grant.externalProject,
                            credentials: authorized.credentials,
                            deadline: Date.now() + (options.deadlineMs ?? METRICS_EXPORT_DEADLINE_MS),
                        }, options.signal);
                    } catch {
                        result = { status: "not_found_yet" };
                    }
                    const confirmation: MetricsDeliveryItem = {
                        ...authorized.intent,
                        confirming: false,
                        state: result.status === "present" ? "confirmed" : item.state,
                        confirmations: result.status === "unsupported" ? 3 : authorized.intent.confirmations,
                    };
                    appendMetricsExportLedger(grant.destinationId, confirmation);
                    ledger.set(key, confirmation);
                }
            }
        } catch {
            /* Local collection and workflows do not depend on export storage or transport. */
        } finally {
            lock.close();
        }
    }
}

export function startMetricsExportScheduler(options: CycleOptions = {}): () => Promise<void> {
    if (remotePersonalResourcesActive()) return () => Promise.resolve();
    const controller = new AbortController();
    let running: Promise<void> | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const cycle = () => {
        if (running || controller.signal.aborted) return;
        running = runMetricsExportCycle({ ...options, signal: controller.signal }).catch(() => {}).finally(() => {
            running = undefined;
        });
    };
    const abort = () => {
        clearInterval(timer);
        controller.abort();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    cycle();
    if (!controller.signal.aborted) timer = setInterval(cycle, METRICS_EXPORT_INTERVAL_MS);
    return async () => {
        clearInterval(timer);
        options.signal?.removeEventListener("abort", abort);
        controller.abort();
        if (running) {
            let timeout: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
                running,
                new Promise<void>((resolve) => {
                    timeout = setTimeout(resolve, 2000);
                }),
            ]);
            clearTimeout(timeout);
        }
    };
}

export async function readMetricsExportStatus() {
    const grants = readMetricsExportGrants();
    if (!grants.length) return [];
    const identity = await readMetricsExportHostIdentity();
    const exporters: InstalledMetricsExporter[] = await resolveApprovedMetricsExporters();
    const statuses = [];
    for (const grant of grants) {
        const counts = { pending: 0, accepted: 0, confirmed: 0, unconfirmed: 0, rejected: 0 };
        const ledger = readMetricsExportLedger(grant.destinationId);
        const cursors = readCursor(grant.destinationId);
        const currentItems: MetricsDeliveryItem[] = [];
        for (const project of grant.projects) {
            const path = getWorkflowMetricsFilePath(project.projectRoot);
            const epoch = resolveCollectionEpoch(path).historyEpoch;
            const projectRef = await metricsExportReference(identity, "project", project.projectRoot);
            const cursor = scanProject(grant, project, cursors[projectRef], epoch);
            const credential = readMetricsExportCredentials(grant.destinationId);
            const items = [...ledger.values()].filter((item) =>
                item.grantId === grant.grantId && item.historyEpoch === epoch && item.projectRef === projectRef &&
                (epoch !== project.historyEpoch || item.offset >= project.offset)
            );
            currentItems.push(...items);
            for (const item of items) {
                if (
                    item.state === "sending" ||
                    (item.state === "rejected" && item.retry === "needs_correction" &&
                        item.credentialsRevision !== credential.revision)
                ) counts.pending++;
                else counts[item.state]++;
            }
            counts.pending += cursor.pending.filter((p) => !items.some((item) => item.eventId === p.eventId)).length;
        }
        currentItems.sort((a, b) => a.at.localeCompare(b.at));
        statuses.push({
            destinationId: grant.destinationId,
            grantId: grant.grantId,
            endpoint: grant.endpoint,
            externalProject: grant.externalProject,
            projects: grant.projects.map((p) => p.projectRoot),
            credentials: {
                configured: Object.keys(readMetricsExportCredentials(grant.destinationId).credentials).length > 0,
            },
            exporterApproved: exporters.some((e) => grantMatchesExporter(grant, e)),
            counts,
            latestCodes: currentItems.slice(-10).map((item) => code(item.code)).filter(Boolean),
            lastAttemptAt: currentItems.map((item) => item.at).sort().at(-1) ?? null,
        });
    }
    return statuses;
}
