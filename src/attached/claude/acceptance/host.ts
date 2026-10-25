import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { jsonMap, type JsonMap } from "./evidence.ts";
import { readHostTraffic } from "./traffic.ts";

export interface HostOptions {
    claude: string;
    cwd: string;
    root: string;
    runId: string;
    phase: string;
    env: NodeJS.ProcessEnv;
}
interface CoreWait {
    matches: (body: JsonMap) => boolean;
    resolve: (body: JsonMap) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}
export class HostTurnEnded extends Error {}

/** A real external host process. Pausing freezes transient checkpoints before the next model turn. */
export class ClaudeHost {
    private child: ChildProcessWithoutNullStreams;
    private results: JsonMap[] = [];
    private tools = new Set<string>();
    private pendingTasks = new Map<string, string | undefined>();
    private cursor = 0;
    private waiting: CoreWait | null = null;
    private turn: JsonMap | null = null;
    private turnWait: CoreWait | null = null;
    private paused = false;
    private failure: Error | null = null;
    private exited = false;
    private exitPhase: string;
    private closed: Promise<void>;

    constructor(readonly options: HostOptions) {
        if (!/^[a-z0-9-]+$/.test(options.runId)) throw new Error("Invalid host run ID");
        this.exitPhase = options.phase;
        const log = join(options.root, "logs/claude", `${options.runId}.jsonl`);
        writeFileSync(log, "", { flag: "wx", mode: 0o600 });
        this.child = spawn(
            options.claude,
            [
                "-p",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--forward-subagent-text",
                "--dangerously-skip-permissions",
                "--setting-sources",
                "project,local",
            ],
            { cwd: options.cwd, env: options.env, detached: true, stdio: ["pipe", "pipe", "pipe"] },
        );
        const pid = this.child.pid;
        if (pid) this.audit({ event: "start", phase: options.phase, runId: options.runId, pid });
        const decoder = new StringDecoder("utf8");
        let buffered = "";
        this.child.stdout.on("data", (bytes: Buffer) => {
            appendFileSync(log, bytes);
            buffered += decoder.write(bytes);
            let newline: number;
            while ((newline = buffered.indexOf("\n")) >= 0) {
                const line = buffered.slice(0, newline);
                buffered = buffered.slice(newline + 1);
                if (!line.trim()) continue;
                try {
                    const row = jsonMap(JSON.parse(line));
                    if (!row) throw new Error("Not a host event");
                    this.observe(row);
                } catch {
                    this.fail(new Error("Malformed Claude stream event"));
                }
            }
        });
        this.child.stderr.on("data", (bytes: Buffer) =>
            appendFileSync(join(options.root, "logs", `${options.runId}.stderr.log`), bytes),
        );
        this.child.stdin.on("error", () => this.fail(new Error("Claude input closed")));
        this.child.on("error", () => this.fail(new Error("Claude process could not start")));
        this.closed = new Promise((resolve) =>
            this.child.on("close", (code, signal) => {
                this.exited = true;
                buffered += decoder.end();
                if (buffered.trim()) this.fail(new Error("Truncated Claude stream event"));
                this.audit({
                    event: "exit",
                    phase: this.exitPhase,
                    runId: options.runId,
                    pid: pid ?? null,
                    exitCode: code,
                    signal,
                });
                this.fail(new Error("Claude process exited before the expected checkpoint"));
                resolve();
            }),
        );
    }

    private audit(row: JsonMap): void {
        appendFileSync(join(this.options.root, "logs/processes.jsonl"), JSON.stringify(row) + "\n");
    }
    private fail(error: Error): void {
        this.failure ??= error;
        for (const wait of [this.waiting, this.turnWait]) {
            if (wait) {
                clearTimeout(wait.timer);
                wait.reject(error);
            }
        }
        this.waiting = this.turnWait = null;
    }
    private observeTasks(row: JsonMap): void {
        if (row.type !== "system") return;
        if (row.subtype === "task_notification") {
            if (
                (row.status === "completed" || row.status === "failed" || row.status === "stopped") &&
                typeof row.task_id === "string" &&
                (row.run_id === undefined || (typeof row.run_id === "string" && row.run_id.trim())) &&
                this.pendingTasks.has(row.task_id) &&
                (row.run_id === undefined ||
                    this.pendingTasks.get(row.task_id) === undefined ||
                    this.pendingTasks.get(row.task_id) === row.run_id)
            ) {
                this.pendingTasks.delete(row.task_id);
                // A task notification resumes the parent; its earlier result is no longer an idle turn.
                this.turn = null;
            }
            return;
        }
        if (row.subtype !== "task_started" && row.subtype !== "background_tasks_changed") return;
        if (row.subtype === "task_started" && row.is_backgrounded === false) return;
        const tasks = row.subtype === "task_started" ? [row] : row.tasks;
        if (!Array.isArray(tasks)) return this.fail(new Error("Unreadable Claude task list"));
        const pending =
            row.subtype === "background_tasks_changed"
                ? new Map<string, string | undefined>()
                : new Map(this.pendingTasks);
        for (const value of tasks) {
            const task = jsonMap(value);
            if (task?.ambient === true) continue;
            if (
                typeof task?.task_id !== "string" ||
                !task.task_id.trim() ||
                (task.run_id !== undefined && (typeof task.run_id !== "string" || !task.run_id.trim()))
            )
                return this.fail(new Error("Unreadable Claude task identity"));
            pending.set(task.task_id, task.run_id);
        }
        // background_tasks_changed is the complete live set, including an explicit empty set.
        const changed =
            pending.size !== this.pendingTasks.size ||
            [...pending].some(([id, run]) => !this.pendingTasks.has(id) || this.pendingTasks.get(id) !== run);
        this.pendingTasks = pending;
        if (changed) this.turn = null;
    }
    private observe(row: JsonMap): void {
        this.observeTasks(row);
        if (row.type === "assistant" && row.parent_tool_use_id == null) this.turn = null;
        const traffic = readHostTraffic(row, this.options.runId);
        for (const tool of traffic.tools) this.tools.add(tool.toolId);
        for (const result of traffic.results) {
            const body = jsonMap(result.body);
            if (!body || !this.tools.has(result.toolId)) continue;
            this.results.push(body);
            this.checkCore();
        }
        if (row.type === "result" && row.parent_tool_use_id == null) {
            this.turn = row;
            if (row.subtype !== "success" || row.is_error !== false)
                return this.fail(new Error("Claude turn did not succeed"));
            if (this.pendingTasks.size) return;
            if (this.turnWait) {
                const wait = this.turnWait;
                this.turnWait = null;
                clearTimeout(wait.timer);
                wait.resolve(row);
            }
            if (this.waiting) {
                const wait = this.waiting;
                this.waiting = null;
                clearTimeout(wait.timer);
                wait.reject(new HostTurnEnded("Claude turn ended before the expected checkpoint"));
            }
        }
    }
    private signal(signal: NodeJS.Signals): void {
        if (!this.exited && this.child.pid) {
            // Keep the MCP review listener alive while the model is paused at a checkpoint.
            const pid = signal === "SIGSTOP" || signal === "SIGCONT" ? this.child.pid : -this.child.pid;
            try {
                process.kill(pid, signal);
            } catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
            }
        }
    }
    private checkCore(): void {
        const wait = this.waiting;
        if (!wait) return;
        const index = this.results.findIndex((body, index) => index >= this.cursor && wait.matches(body));
        if (index < 0) return;
        this.signal("SIGSTOP");
        this.paused = true;
        this.cursor = index + 1;
        this.waiting = null;
        clearTimeout(wait.timer);
        wait.resolve(this.results[index]);
    }
    get readyForInput(): boolean {
        if (this.failure || this.exited) throw this.failure ?? new Error("Claude is not running");
        return this.turn !== null && !this.pendingTasks.size;
    }
    send(text: string): void {
        if (this.failure || this.exited) throw this.failure ?? new Error("Claude is not running");
        this.turn = null;
        this.child.stdin.write(
            JSON.stringify({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null }) + "\n",
        );
    }
    resume(): void {
        if (this.paused) {
            this.signal("SIGCONT");
            this.paused = false;
        }
    }
    waitForCore(matches: (body: JsonMap) => boolean, timeoutMs = 600_000): Promise<JsonMap> {
        if (this.waiting) return Promise.reject(new Error("A host checkpoint wait is already active"));
        if (this.failure) return Promise.reject(this.failure);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiting = null;
                reject(new Error("Claude checkpoint timed out"));
            }, timeoutMs);
            this.waiting = { matches, resolve, reject, timer };
            this.checkCore();
            if (this.waiting && this.turn && !this.pendingTasks.size) {
                clearTimeout(timer);
                this.waiting = null;
                reject(new HostTurnEnded("Claude turn ended before the expected checkpoint"));
            }
            if (this.waiting) this.resume();
        });
    }
    finishTurn(timeoutMs = 600_000): Promise<void> {
        if (this.failure) return Promise.reject(this.failure);
        if (this.turn && !this.pendingTasks.size) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.turnWait = null;
                reject(new Error("Claude turn timed out"));
            }, timeoutMs);
            this.turnWait = { matches: () => true, resolve: () => resolve(), reject, timer };
        });
    }
    async stop(phase: string, signal: "SIGKILL" | "SIGTERM" = "SIGTERM"): Promise<void> {
        if (this.exited) return;
        this.exitPhase = phase;
        if (signal === "SIGTERM") this.resume();
        this.signal(signal);
        let timer: ReturnType<typeof setTimeout>;
        await Promise.race([
            this.closed,
            new Promise<void>((resolve) => {
                timer = setTimeout(() => {
                    this.signal("SIGKILL");
                    resolve();
                }, 5000);
            }),
        ]);
        clearTimeout(timer!);
        await this.closed;
    }
}
