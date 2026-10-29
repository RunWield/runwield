import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
    coreResult,
    field,
    map,
    text,
    toolObservation,
    type HostObservation,
    type Json,
    type JsonMap,
} from "./evidence.ts";

/** Fixed categories only: native errors may contain credential-bearing provider text. */
export class HostAuthenticationError extends Error {
    constructor(readonly reason: "missing" | "rejected") {
        super(`Codex host authentication ${reason}`);
    }
}
function nativeFailure(value: Json | undefined, fallback: string): Error {
    const info = field(value, "codexErrorInfo") ?? field(value, "data", "codexErrorInfo");
    const statuses = [
        "httpConnectionFailed",
        "responseStreamConnectionFailed",
        "responseStreamDisconnected",
        "responseTooManyFailedAttempts",
    ];
    const message = text(field(value, "message"))?.slice(0, 2048) ?? "";
    const unauthorized =
        info === "unauthorized" ||
        field(value, "code") === 401 ||
        statuses.some((key) => field(info, key, "httpStatusCode") === 401) ||
        /\b(authentication required|not logged in|invalid api key|expired (?:access |refresh )?token|token (?:has )?expired|401 unauthorized)\b/i.test(
            message,
        );
    return unauthorized ? new HostAuthenticationError("rejected") : new Error(fallback);
}

export interface HostOptions {
    executable: string;
    cwd: string;
    root: string;
    env: NodeJS.ProcessEnv;
    run: string;
    args: string[];
}
interface PendingRequest {
    resolve: (result: JsonMap) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}
interface PendingState extends PendingRequest {
    matches: (result: JsonMap) => boolean;
}
interface SpawnObservation {
    threadId: string;
    freshContext: boolean;
}
/** External subprocess only: never reads a transcript or imports Core lifecycle writers. */
export class CodexHost {
    private child: ChildProcessWithoutNullStreams;
    private requests = new Map<number, PendingRequest>();
    private states: JsonMap[] = [];
    private wait: PendingState | null = null;
    private sequence = 0;
    private failure: Error | null = null;
    private closed: Promise<void>;
    private stopped = false;
    private threadId = "";
    private exitCode: number | null = null;
    private spawns = new Map<string, SpawnObservation>();
    private observedWorkers = new Set<string>();
    private completedTurns = new Set<string>();
    private turnWait: PendingRequest | null = null;
    readonly observations: HostObservation[] = [];
    constructor(readonly options: HostOptions) {
        this.child = spawn(options.executable, options.args, {
            cwd: options.cwd,
            env: options.env,
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.record({ run: options.run, kind: "start" });
        const decoder = new StringDecoder("utf8");
        let buffer = "";
        this.child.stdout.on("data", (bytes: Buffer) => {
            buffer += decoder.write(bytes);
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                if (!line.trim()) continue;
                try {
                    const value = map(JSON.parse(line));
                    if (!value) throw new Error("Not a transport message");
                    this.observe(value);
                } catch {
                    this.fail(new Error("Codex emitted malformed protocol output"));
                }
            }
        });
        // Drain diagnostics without saving credentials, prompts, or arbitrary subprocess output.
        this.child.stderr.resume();
        this.child.stdin.on("error", () => this.fail(new Error("Codex input closed")));
        this.child.on("error", () => this.fail(new Error("Codex executable unavailable")));
        this.closed = new Promise((resolve) =>
            this.child.on("close", (code) => {
                this.stopped = true;
                this.exitCode = code;
                buffer += decoder.end();
                if (buffer.trim()) this.fail(new Error("Codex emitted truncated protocol output"));
                this.record({ run: options.run, kind: "exit", exitCode: code });
                this.fail(new Error("Codex process ended before the expected checkpoint"));
                resolve();
            }),
        );
    }
    private record(row: HostObservation): void {
        this.observations.push(row);
        appendFileSync(join(this.options.root, "host-evidence.jsonl"), JSON.stringify(row) + "\n", { mode: 0o600 });
    }
    private fail(error: Error): void {
        this.failure ??= error;
        for (const request of this.requests.values()) {
            clearTimeout(request.timer);
            request.reject(error);
        }
        this.requests.clear();
        if (this.wait) {
            clearTimeout(this.wait.timer);
            this.wait.reject(error);
            this.wait = null;
        }
        if (this.turnWait) {
            clearTimeout(this.turnWait.timer);
            this.turnWait.reject(error);
            this.turnWait = null;
        }
    }
    private observe(row: JsonMap): void {
        if (typeof row.id === "number" && (row.result !== undefined || row.error !== undefined)) {
            const pending = this.requests.get(row.id);
            if (pending) {
                this.requests.delete(row.id);
                clearTimeout(pending.timer);
                const result = map(row.result);
                if (result) pending.resolve(result);
                else pending.reject(nativeFailure(row.error, "Codex rejected the protocol request"));
            }
            return;
        }
        if (row.type === "thread.started") this.threadId = text(row.thread_id) ?? "";
        const eventThread = text(field(row, "params", "threadId")) ?? this.threadId;
        if (row.type === "turn.completed" || row.method === "turn/completed") {
            if (row.method === "turn/completed" && field(row, "params", "turn", "status") !== "completed") {
                if (eventThread === this.threadId)
                    this.fail(nativeFailure(field(row, "params", "turn", "error"), "Codex model turn failed"));
                return;
            }
            this.record({ run: this.options.run, kind: "turn", threadId: eventThread });
            this.completedTurns.add(eventThread);
            if (eventThread === this.threadId && this.turnWait) {
                clearTimeout(this.turnWait.timer);
                this.turnWait.resolve({});
                this.turnWait = null;
            }
        }
        if (
            row.type === "turn.failed" ||
            row.type === "error" ||
            (row.method === "error" && eventThread === this.threadId && field(row, "params", "willRetry") !== true)
        )
            this.fail(nativeFailure(row.error ?? field(row, "params", "error"), "Codex model turn failed"));
        const nativeItem = map(field(row, "params", "item"));
        if (
            row.method === "rawResponseItem/completed" &&
            nativeItem?.type === "function_call" &&
            nativeItem.name === "spawn_agent"
        ) {
            try {
                const args = typeof nativeItem.arguments === "string" ? map(JSON.parse(nativeItem.arguments)) : null;
                const callId = text(nativeItem.call_id);
                if (callId)
                    this.spawns.set(callId, { threadId: eventThread, freshContext: args?.fork_turns === "none" });
            } catch {
                this.fail(new Error("Unreadable native spawn arguments"));
            }
        }
        if (row.method === "item/started" && nativeItem?.type === "subAgentActivity") {
            const child = text(nativeItem.agentThreadId),
                callId = text(nativeItem.id);
            const spawn = callId ? this.spawns.get(callId) : null;
            if (child && spawn?.threadId === eventThread && !this.observedWorkers.has(child)) {
                this.observedWorkers.add(child);
                this.record({
                    run: this.options.run,
                    kind: "worker",
                    threadId: spawn.threadId,
                    toolId: callId!,
                    workerIds: [child],
                    freshContext: spawn.freshContext,
                });
                // Ephemeral child events already share this native stream. Resuming would require a saved rollout.
            }
        }
        const item =
            row.type === "item.completed"
                ? map(row.item)
                : row.method === "item/completed"
                  ? map(field(row, "params", "item"))
                  : null;
        if (!item) return;
        const threadId = eventThread;
        const observation = toolObservation(this.options.run, threadId, item);
        if (observation) {
            this.record(observation);
            const result = map(item.result);
            const state = result && coreResult(result);
            if (state) {
                this.states.push(state);
                this.checkWait();
            }
        }
        if (["collab_tool_call", "collabAgentToolCall"].includes(String(item.type))) {
            const ids = item.receiverThreadIds ?? item.receiver_thread_ids;
            if (Array.isArray(ids) && ids.every((id) => typeof id === "string"))
                this.record({
                    run: this.options.run,
                    kind: "worker",
                    threadId,
                    workerIds: ids as string[],
                    ...(text(item.tool) ? { workerOperation: String(item.tool) } : {}),
                    ...(text(item.status) ? { workerStatus: String(item.status) } : {}),
                });
        }
    }
    request(method: string, params: JsonMap, timeoutMs = 60_000): Promise<JsonMap> {
        if (this.failure) return Promise.reject(this.failure);
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.requests.delete(id);
                reject(new Error(`Codex ${method} timed out`));
            }, timeoutMs);
            this.requests.set(id, { resolve, reject, timer });
            this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
        });
    }
    async initializeTransport(): Promise<void> {
        await this.request("initialize", {
            clientInfo: { name: "runwield-acceptance", version: "1" },
            capabilities: { experimentalApi: true },
        });
        this.child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    }
    async requireAuthentication(): Promise<void> {
        // No proactive refresh or login. Account details remain in memory and are never evidence.
        const account = await this.request("account/read", { refreshToken: false });
        if (account.requiresOpenaiAuth === true && !map(account.account)) throw new HostAuthenticationError("missing");
        if (typeof account.requiresOpenaiAuth !== "boolean")
            throw new Error("Codex did not report authentication requirements");
    }
    async startThread(options: JsonMap = {}): Promise<void> {
        const response = await this.request("thread/start", {
            cwd: this.options.cwd,
            ephemeral: true,
            sandbox: "read-only",
            approvalPolicy: "never",
            ...options,
        });
        this.threadId = text(field(response, "thread", "id")) ?? "";
        if (!this.threadId) throw new Error("Codex did not identify the ephemeral thread");
    }
    async initialize(): Promise<void> {
        await this.initializeTransport();
        await this.startThread();
    }
    async startTurn(prompt: string): Promise<void> {
        this.completedTurns.delete(this.threadId);
        await this.request("turn/start", { threadId: this.threadId, input: [{ type: "text", text: prompt }] });
    }
    async finishTurn(timeoutMs: number): Promise<void> {
        if (this.completedTurns.has(this.threadId)) return;
        if (this.failure) throw this.failure;
        await new Promise<JsonMap>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.turnWait = null;
                reject(new Error("Codex turn timed out"));
            }, timeoutMs);
            this.turnWait = { resolve, reject, timer };
        });
    }
    async inventory(): Promise<JsonMap> {
        const deadline = Date.now() + 30_000;
        while (true) {
            const result = await this.request("mcpServerStatus/list", { threadId: this.threadId });
            const rows = Array.isArray(result.data) ? result.data : [];
            if (!rows.some((row) => field(row, "name") === "runwield" && field(row, "runtimeStatus") === "starting"))
                return result;
            if (Date.now() >= deadline) throw new Error("RunWield MCP startup did not complete");
            await delay(100);
        }
    }
    async call(operation: string, args: JsonMap, timeoutMs = 60_000): Promise<JsonMap> {
        const response = await this.request(
            "mcpServer/tool/call",
            { threadId: this.threadId, server: "runwield", tool: operation, arguments: args },
            timeoutMs,
        );
        const result = coreResult(response);
        if (!result) throw new Error("Core did not return structured workflow state");
        return result;
    }
    waitForCore(matches: PendingState["matches"], timeoutMs: number): Promise<JsonMap> {
        if (this.wait) throw new Error("Only one Core checkpoint may be awaited");
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.wait = null;
                reject(new Error("Codex did not reach the required Core checkpoint"));
            }, timeoutMs);
            this.wait = { matches, resolve, reject, timer };
            this.checkWait();
            if (this.failure && this.wait) {
                clearTimeout(timer);
                this.wait = null;
                reject(this.failure);
            }
        });
    }
    private checkWait(): void {
        if (!this.wait) return;
        const index = this.states.findIndex(this.wait.matches);
        if (index < 0) return;
        const state = this.states[index];
        this.states.splice(0, index + 1);
        const pending = this.wait;
        this.wait = null;
        clearTimeout(pending.timer);
        pending.resolve(state);
    }
    endInput(): void {
        this.child.stdin.end();
    }
    async finish(timeoutMs: number): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                this.closed,
                new Promise<void>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error("Codex did not finish the turn")), timeoutMs);
                }),
            ]);
            if (this.exitCode !== 0 || !this.observations.some((row) => row.kind === "turn"))
                throw new Error("Codex turn did not complete successfully");
        } finally {
            clearTimeout(timer);
        }
    }
    async stop(): Promise<void> {
        if (this.stopped) return;
        // Model loss of the host connection. Killing the process group would also kill Core
        // before its transport/signal cleanup can cancel the separately grouped CI process.
        this.child.stdin.end();
        const terminate = setTimeout(() => {
            if (!this.stopped) this.child.kill("SIGTERM");
        }, 15_000);
        const kill = setTimeout(() => {
            if (!this.stopped) this.child.kill("SIGKILL");
        }, 30_000);
        try {
            await this.closed;
        } finally {
            clearTimeout(terminate);
            clearTimeout(kill);
        }
    }
}
