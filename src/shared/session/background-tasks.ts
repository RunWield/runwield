import { type FileHandle, open } from "node:fs/promises";
import { mkdir as fsMkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getHomeDir } from "../../constants.js";
import { spawnForegroundShell } from "../foreground-process.ts";
import { extractAssistantOutput } from "../workflow/workflow-results.js";
import type { DelegatedAgentSessionOptions } from "../../tools/delegate-agent.ts";
import type { HostedSession } from "./hosted-session.js";

export type BackgroundTaskKind = "shell" | "delegate";
export type BackgroundTaskState = "running" | "completed" | "failed" | "cancelled" | "timed_out";

export interface BackgroundTaskStatus {
    task_id: string;
    kind: BackgroundTaskKind;
    state: BackgroundTaskState;
    log_path: string;
    err_log_path: string;
    byte_count: number;
    line_count: number;
    exit_code?: number | null;
    error?: string;
    output?: string;
}

interface TaskRecord {
    status: BackgroundTaskStatus;
    controller: AbortController;
    finished: Promise<void>;
    out: StreamCount;
    err: StreamCount;
    preview: { out: Uint8Array[]; err: Uint8Array[] };
    previewBytes: number;
    logFailure?: string;
    suppressDelivery?: boolean;
}

interface StreamCount {
    bytes: number;
    lines: number;
    lastByte: number | null;
}

export const MAX_ACTIVE_BACKGROUND_TASKS = 5;
export const INLINE_BACKGROUND_OUTPUT_BYTES = 8192;

/** Generated input treats task output as data, not as an instruction from the user. */
export function formatBackgroundTaskCompletion(status: BackgroundTaskStatus): string {
    const outcome = [
        `Background task ${status.task_id} (${status.kind}) ${status.state}.`,
        ...(status.exit_code !== undefined ? [`Exit code: ${status.exit_code}.`] : []),
        ...(status.error ? [`Error: ${safeText(status.error)}`] : []),
    ];
    if (status.byte_count === 0) outcome.push("No output.");
    else if (status.output !== undefined) outcome.push(`Output (task data):\n${status.output}`);
    else {outcome.push(
            `Output logs: ${status.log_path} (stdout), ${status.err_log_path} (stderr); ` +
                `${status.byte_count} bytes, ${status.line_count} lines total.`,
        );}
    return outcome.join("\n");
}

function pathPart(value: string): string {
    // Never allow a Session or project identifier to escape the private log directory.
    if (/^[a-zA-Z0-9_-]+$/.test(value)) return value;
    return `id-${Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function errorText(error: Error | string): string {
    return error instanceof Error ? error.message : String(error);
}

/** Remove terminal control sequences from text presented to the model, never from the log. */
function safeText(text: string): string {
    // deno-lint-ignore no-control-regex
    const withoutAnsi = text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))?/g, "");
    // deno-lint-ignore no-control-regex
    return withoutAnsi.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

function countChunk(count: StreamCount, chunk: Uint8Array): void {
    count.bytes += chunk.byteLength;
    for (const byte of chunk) if (byte === 10) count.lines++;
    if (chunk.byteLength) count.lastByte = chunk[chunk.byteLength - 1];
}

function lineCount(count: StreamCount): number {
    return count.lines + (count.lastByte !== null && count.lastByte !== 10 ? 1 : 0);
}

async function writeChunk(file: FileHandle, chunk: Uint8Array, onWritten: (part: Uint8Array) => void): Promise<void> {
    let offset = 0;
    while (offset < chunk.byteLength) {
        const { bytesWritten: written } = await file.write(chunk.subarray(offset));
        if (written === 0) throw new Error("Task log write made no progress");
        const part = chunk.subarray(offset, offset + written);
        onWritten(part);
        offset += written;
    }
}

/** Process-local Session owner. Results remain until this registry is discarded. */
export class BackgroundTasks {
    private readonly records = new Map<string, TaskRecord>();
    private readonly pending = new Set<string>();
    private completionHandler: ((status: BackgroundTaskStatus) => void) | null = null;
    private suppressed = false;

    constructor(private readonly session: HostedSession) {}

    /** Notification is not an acknowledgement. The runtime must acknowledge after consumption. */
    setCompletionHandler(handler: ((status: BackgroundTaskStatus) => void) | null): void {
        this.completionHandler = handler;
        if (handler) {
            for (const id of this.pending) {
                try {
                    handler(this.status(id));
                } catch {
                    // Still pending; the runtime can retry without losing the result.
                }
            }
        }
    }

    pendingCompletions(): BackgroundTaskStatus[] {
        return [...this.pending].map((id) => this.status(id));
    }

    acknowledge(taskId: string): void {
        this.pending.delete(taskId);
    }

    get activeCount(): number {
        return this.runningTasks().length;
    }

    runningTasks(): BackgroundTaskStatus[] {
        return [...this.records.values()].filter((record) => record.status.state === "running")
            .map((record) => this.snapshot(record));
    }

    isPending(taskId: string): boolean {
        return this.pending.has(taskId);
    }

    canDeliver(taskId: string): boolean {
        const record = this.records.get(taskId);
        return Boolean(record && !this.suppressed && !record.suppressDelivery);
    }

    private reserve(kind: BackgroundTaskKind): TaskRecord {
        this.session.assertActive();
        if (this.suppressed) throw new Error("Background tasks are stopping for Task Completion or Session Stop.");
        if (this.activeCount >= MAX_ACTIVE_BACKGROUND_TASKS) {
            throw new Error(`Too many background tasks are running; maximum is ${MAX_ACTIVE_BACKGROUND_TASKS}.`);
        }
        const taskId = crypto.randomUUID();
        const managed = this.session.getManagedMetadata();
        const projectId = managed?.projectId ?? "local";
        const directory = join(
            getHomeDir(),
            ".wld",
            "sessions",
            pathPart(projectId),
            pathPart(managed?.runwieldSessionId ?? this.session.id),
        );
        const base = join(directory, taskId);
        const record: TaskRecord = {
            status: {
                task_id: taskId,
                kind,
                state: "running",
                log_path: `${base}.out.log`,
                err_log_path: `${base}.err.log`,
                byte_count: 0,
                line_count: 0,
            },
            controller: new AbortController(),
            finished: Promise.resolve(),
            out: { bytes: 0, lines: 0, lastByte: null },
            err: { bytes: 0, lines: 0, lastByte: null },
            preview: { out: [], err: [] },
            previewBytes: 0,
        };
        this.records.set(taskId, record); // reserve before any asynchronous setup or launch
        return record;
    }

    private snapshot(record: TaskRecord): BackgroundTaskStatus {
        const status = {
            ...record.status,
            byte_count: record.out.bytes + record.err.bytes,
            line_count: lineCount(record.out) + lineCount(record.err),
        };
        if (status.state !== "running") {
            if (status.byte_count === 0) status.output = "(No output.)";
            else if (status.byte_count <= INLINE_BACKGROUND_OUTPUT_BYTES) {
                const joined = new Uint8Array(record.previewBytes);
                let offset = 0;
                for (const chunk of [...record.preview.out, ...record.preview.err]) {
                    joined.set(chunk, offset);
                    offset += chunk.byteLength;
                }
                status.output = safeText(new TextDecoder().decode(joined));
            }
        }
        return status;
    }

    status(taskId: string): BackgroundTaskStatus {
        const record = this.records.get(taskId);
        if (!record) throw new Error(`Unknown background task: ${taskId}`);
        return this.snapshot(record);
    }

    private recordWritten(record: TaskRecord, count: StreamCount, part: Uint8Array): void {
        countChunk(count, part);
        if (record.previewBytes <= INLINE_BACKGROUND_OUTPUT_BYTES) {
            const copy = part.slice(0, INLINE_BACKGROUND_OUTPUT_BYTES + 1 - record.previewBytes);
            record.preview[count === record.out ? "out" : "err"].push(copy);
            record.previewBytes += copy.byteLength;
        }
    }

    private async drain(
        stream: ReadableStream<Uint8Array>,
        file: FileHandle,
        count: StreamCount,
        record: TaskRecord,
    ): Promise<void> {
        const reader = stream.getReader();
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                try {
                    await writeChunk(file, value, (part) => this.recordWritten(record, count, part));
                } catch (error) {
                    record.logFailure ??= `Task log write failed: ${
                        errorText(error instanceof Error ? error : String(error))
                    }`;
                    record.controller.abort();
                    // Continue draining to allow the process and its streams to settle.
                }
            }
        } finally {
            reader.releaseLock();
        }
    }

    private finish(record: TaskRecord, state: BackgroundTaskState, exitCode?: number | null, error?: string): void {
        record.status.state = record.logFailure ? "failed" : state;
        if (exitCode !== undefined) record.status.exit_code = exitCode;
        if (record.logFailure || error) record.status.error = record.logFailure ?? error;
        if (!this.suppressed && !record.suppressDelivery) this.pending.add(record.status.task_id);
        try {
            this.completionHandler?.(this.snapshot(record));
        } catch { /* pending result remains available */ }
    }

    startShell(options: { command: string; cwd: string; timeoutMs?: number }): BackgroundTaskStatus {
        if (!options.command?.trim()) throw new Error("A nonempty shell command is required.");
        if (
            options.timeoutMs !== undefined &&
            (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647)
        ) {
            throw new Error("Timeout must be a positive finite number.");
        }
        const record = this.reserve("shell");
        record.finished = this.runShell(record, options);
        return this.snapshot(record);
    }

    private async runShell(
        record: TaskRecord,
        options: { command: string; cwd: string; timeoutMs?: number },
    ): Promise<void> {
        let out: FileHandle | undefined;
        let err: FileHandle | undefined;
        let shell: ReturnType<typeof spawnForegroundShell> | undefined;
        let finalState: BackgroundTaskState = "failed";
        let finalExit: number | null | undefined;
        let finalError: string | undefined;
        try {
            await fsMkdir(dirname(record.status.log_path), { recursive: true, mode: 0o700 });
            out = await open(record.status.log_path, "wx", 0o600);
            err = await open(record.status.err_log_path, "wx", 0o600);
            if (record.controller.signal.aborted) {
                finalState = "cancelled";
                finalExit = null;
                return;
            }
            shell = spawnForegroundShell({
                command: options.command,
                cwd: options.cwd,
                env: { PWD: options.cwd },
                signal: record.controller.signal,
                timeoutMs: options.timeoutMs,
            });
            const [outcome, stdout, stderr] = await Promise.allSettled([
                shell.done,
                this.drain(shell.stdout, out, record.out, record),
                this.drain(shell.stderr, err, record.err, record),
            ]);
            if (outcome.status === "rejected") throw outcome.reason;
            if (stdout.status === "rejected") throw stdout.reason;
            if (stderr.status === "rejected") throw stderr.reason;
            const { exitCode, terminatedBy } = outcome.value;
            finalState = terminatedBy === "timeout"
                ? "timed_out"
                : terminatedBy === "abort"
                ? "cancelled"
                : exitCode === 0
                ? "completed"
                : "failed";
            finalExit = exitCode;
        } catch (error) {
            record.controller.abort();
            if (shell) await shell.done.catch(() => {});
            finalError = `Task failed: ${errorText(error instanceof Error ? error : String(error))}`;
        } finally {
            try {
                await out?.close();
            } catch (error) {
                record.logFailure ??= `Task log close failed: ${
                    errorText(error instanceof Error ? error : String(error))
                }`;
            }
            try {
                await err?.close();
            } catch (error) {
                record.logFailure ??= `Task log close failed: ${
                    errorText(error instanceof Error ? error : String(error))
                }`;
            }
            this.finish(record, finalState, finalExit, finalError);
        }
    }

    /** Execute the read-only child without registering it as a foreground sub-agent. */
    startDelegate(options: Omit<DelegatedAgentSessionOptions, "signal" | "background">): BackgroundTaskStatus {
        const record = this.reserve("delegate");
        let release: () => void;
        try {
            release = this.session.acquireDelegatedAgentLease("read");
        } catch (error) {
            this.records.delete(record.status.task_id);
            throw error;
        }
        record.finished = (async () => {
            let out: FileHandle | undefined;
            let err: FileHandle | undefined;
            let finalState: BackgroundTaskState = "failed";
            let finalError: string | undefined;
            try {
                await fsMkdir(dirname(record.status.log_path), { recursive: true, mode: 0o700 });
                out = await open(record.status.log_path, "wx", 0o600);
                err = await open(record.status.err_log_path, "wx", 0o600);
                if (record.controller.signal.aborted) {
                    finalState = "cancelled";
                    return;
                }
                const { runIsolatedAgentSession } = await import("./session.js");
                const messages = await runIsolatedAgentSession({
                    ...options,
                    background: true,
                    signal: record.controller.signal,
                    taskId: record.status.task_id,
                    parentToolCallId: options.parentToolCallId,
                });
                if (record.controller.signal.aborted) {
                    finalState = "cancelled";
                    return;
                }
                const failed = [...messages].reverse().find((message) => message.role === "assistant");
                if (failed?.role === "assistant" && failed.stopReason === "error") {
                    throw new Error(failed.errorMessage || "Model request failed");
                }
                const bytes = new TextEncoder().encode(extractAssistantOutput(messages) || "");
                try {
                    await writeChunk(out, bytes, (part) => this.recordWritten(record, record.out, part));
                } catch (error) {
                    record.logFailure = `Task log write failed: ${
                        errorText(error instanceof Error ? error : String(error))
                    }`;
                    throw error;
                }
                finalState = "completed";
            } catch (error) {
                finalState = record.controller.signal.aborted ? "cancelled" : "failed";
                finalError = finalState === "failed"
                    ? `Delegate failed: ${errorText(error instanceof Error ? error : String(error))}`
                    : undefined;

                record.controller.abort();
            } finally {
                try {
                    await out?.close();
                } catch (error) {
                    record.logFailure ??= `Task log close failed: ${
                        errorText(error instanceof Error ? error : String(error))
                    }`;
                }
                try {
                    await err?.close();
                } catch (error) {
                    record.logFailure ??= `Task log close failed: ${
                        errorText(error instanceof Error ? error : String(error))
                    }`;
                }
                release();
                this.finish(record, finalState, undefined, finalError);
            }
        })();
        return this.snapshot(record);
    }

    async cancel(taskId: string): Promise<BackgroundTaskStatus> {
        const record = this.records.get(taskId);
        if (!record) throw new Error(`Unknown background task: ${taskId}`);
        if (record.status.state === "running") record.controller.abort();
        await record.finished;
        return this.snapshot(record);
    }

    async wait(taskId: string): Promise<BackgroundTaskStatus> {
        const record = this.records.get(taskId);
        if (!record) throw new Error(`Unknown background task: ${taskId}`);
        await record.finished;
        return this.snapshot(record);
    }

    /** Called by the owning host at explicit Stop/shutdown, not at turn settlement. */
    async cancelAllAndSuppress(): Promise<void> {
        this.suppressed = true;
        this.pending.clear();
        for (const record of this.records.values()) record.suppressDelivery = true;
        await Promise.all(
            [...this.records.values()].filter((record) => record.status.state === "running").map((record) =>
                this.cancel(record.status.task_id)
            ),
        );
    }

    resumeDelivery(): void {
        this.suppressed = false;
    }
}
