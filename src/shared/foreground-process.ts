/**
 * @module shared/foreground-process
 *
 * Runs one RunWield-owned foreground command as an independently terminable
 * process tree.
 *
 * A validation or `!` command normally starts descendants of its own, so
 * killing only the wrapper shell leaves the real work running and can hold the
 * inherited output pipes open. This module makes the command process a
 * process-group leader on Unix-like systems (via `detached`) so cancellation
 * can signal the whole group, and uses `taskkill /T` on Windows. It also owns
 * the two termination triggers — a caller-supplied `AbortSignal` and an
 * optional timeout — so every caller gets the same race-safe behavior instead
 * of re-implementing listener and timer handling.
 *
 * This is RunWield-owned process machinery, not a dependency-injection seam.
 */

import { spawn } from "node:child_process";
import { env as inheritedEnv, kill, platform, versions } from "node:process";

interface NativeProcessStatus {
    code: number;
    success: boolean;
}
export interface NativeProcess {
    pid: number;
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    stdin: WritableStream<Uint8Array>;
    status: Promise<NativeProcessStatus>;
    kill(signal?: "SIGKILL" | "SIGTERM" | "SIGINT"): void;
}
export interface NativeSpawnOptions {
    args: string[];
    cwd: string;
    env?: Record<string, string>;
    stdin: "null" | "piped" | "inherit";
    stdout: "piped" | "null" | "inherit";
    stderr: "piped" | "null" | "inherit";
    detached?: boolean;
    signal?: AbortSignal;
    windowsRawArguments?: boolean;
}
interface BunInputSink {
    write(chunk: Uint8Array): number;
    flush(wait: true): Promise<number>;
    end(): number | Promise<number>;
}
interface BunProcess {
    pid: number;
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    stdin: BunInputSink;
    exited: Promise<number>;
    kill(signal?: "SIGKILL" | "SIGTERM" | "SIGINT"): void;
}
interface BunSpawnOptions {
    cmd: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdin: "ignore" | "pipe" | "inherit";
    stdout: "ignore" | "pipe" | "inherit";
    stderr: "ignore" | "pipe" | "inherit";
    detached: boolean;
    windowsVerbatimArguments?: boolean;
}
interface BunProcessRuntime {
    spawn(options: BunSpawnOptions): BunProcess;
}

export function spawnNativeProcess(command: string, options: NativeSpawnOptions): NativeProcess {
    if (!versions.bun) throw new Error("Foreground processes require Bun");
    options.signal?.throwIfAborted();
    const bun = Reflect.get(globalThis, "Bun") as BunProcessRuntime;
    const child = bun.spawn({
        cmd: [command, ...options.args],
        cwd: options.cwd,
        env: { ...inheritedEnv, ...options.env },
        stdin: options.stdin === "piped" ? "pipe" : options.stdin === "inherit" ? "inherit" : "ignore",
        stdout: options.stdout === "piped" ? "pipe" : options.stdout === "inherit" ? "inherit" : "ignore",
        stderr: options.stderr === "piped" ? "pipe" : options.stderr === "inherit" ? "inherit" : "ignore",
        detached: options.detached === true,
        windowsVerbatimArguments: options.windowsRawArguments,
    });
    const abort = () => {
        try {
            child.kill("SIGTERM");
        } catch {
            /* Exit raced with cancellation. */
        }
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const status = child.exited
        .then((code) => ({ code, success: code === 0 }))
        .finally(() => options.signal?.removeEventListener("abort", abort));
    // FileSink owns buffering; waiting for flush preserves web-stream
    // backpressure for interactive protocol writers and large stdin payloads.
    const stdin = new WritableStream<Uint8Array>({
        async write(chunk) {
            child.stdin.write(chunk);
            await child.stdin.flush(true);
        },
        async close() {
            await child.stdin.end();
        },
        async abort() {
            await child.stdin.end();
        },
    });
    return {
        pid: child.pid,
        stdout: child.stdout,
        stderr: child.stderr,
        stdin,
        status,
        kill: (signal) => child.kill(signal),
    };
}

/** Both runtimes report a missing executable synchronously during spawn. */
export function isMissingExecutableError(error: Error): boolean {
    return error.name === "NotFound" || ("code" in error && error.code === "ENOENT");
}

/** Inputs for one foreground direct command. */
export interface SpawnForegroundProcessOptions {
    /** Executable path or PATH-resolved command name. */
    command: string;
    /** Literal argument array. Arguments are never joined through a shell. */
    args?: string[];
    cwd: string;
    /** Extra environment merged over the inherited environment. */
    env?: Record<string, string>;
    /** Optional stdin text written to the child, then closed. */
    stdinText?: string;
    /** Interactive protocol input, owned and closed by the caller. Mutually exclusive with stdinText. */
    stdin?: "piped";
    /** User cancellation trigger; aborting terminates the whole process tree. */
    signal?: AbortSignal;
    /** Optional timeout in milliseconds; expiry terminates the whole process tree. */
    timeoutMs?: number;
}

/** Inputs for one foreground shell command. */
export interface SpawnForegroundShellOptions {
    /** Command line passed to `sh -c` (Unix-like) or `cmd /c` (Windows). */
    command: string;
    cwd: string;
    /** Extra environment merged over the inherited environment. */
    env?: Record<string, string>;
    /** User cancellation trigger; aborting terminates the whole process tree. */
    signal?: AbortSignal;
    /** Optional timeout in milliseconds; expiry terminates the whole process tree. */
    timeoutMs?: number;
}

/** Which trigger ended the command early. */
export type ForegroundTermination = "abort" | "timeout";

/** How one foreground process finished. */
export interface ForegroundProcessOutcome {
    /** The process' real exit code, or `null` when its process tree was force-terminated. */
    exitCode: number | null;
    /** The trigger that terminated the tree, or `null` when the command exited on its own. */
    terminatedBy: ForegroundTermination | null;
}

/** How one foreground shell command finished. */
export type ForegroundShellOutcome = ForegroundProcessOutcome;

/** A running (or already-settled) foreground process. */
export interface ForegroundProcess {
    /** OS pid of the spawned process, or `null` when a pre-aborted signal prevented the spawn. */
    readonly pid: number | null;
    readonly stdout: ReadableStream<Uint8Array>;
    readonly stderr: ReadableStream<Uint8Array>;
    readonly stdin?: WritableStream<Uint8Array>;
    /** Force-terminate the process tree without changing a naturally settled outcome. */
    kill(): void;
    /**
     * Settles once the process has exited and the signal/timeout listeners are
     * detached. Callers must also drain `stdout`/`stderr` before publishing
     * final output or releasing Session interaction ownership.
     */
    readonly done: Promise<ForegroundProcessOutcome>;
}

/** A running (or already-settled) foreground shell command. */
export type ForegroundShell = ForegroundProcess;

export { terminateOwnedLinuxGroup } from "./linux-process-group.ts";

function emptyClosedStream(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start: (controller) => controller.close(),
    });
}

/**
 * Terminate the spawned process' entire process tree.
 *
 * The Unix group signal is only ever sent to a pid this module spawned with
 * `detached`, so the negative pid names exactly that command's group — never
 * RunWield's own. On Windows `taskkill /T` is the tree guarantee, so the
 * direct-child kill waits until taskkill has had a chance to find descendants.
 */
function terminateProcessTree(child: NativeProcess): void {
    if (platform === "win32") {
        const finish = () => {
            try {
                child.kill();
            } catch {
                // The process may have exited while taskkill was running.
            }
        };
        try {
            const killer = spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
            killer.once("error", () => {});
            killer.once("close", finish);
        } catch {
            finish();
        }
        return;
    }
    if (platform === "darwin") {
        void stopAndKillMacProcessGroup(child);
    } else {
        killProcessGroup(child);
    }
}

function killProcessGroup(child: NativeProcess): void {
    try {
        kill(-child.pid, "SIGKILL");
    } catch {
        try {
            child.kill("SIGKILL");
        } catch {
            // The process may have exited between termination and the kill.
        }
    }
}

/** Stop forks before killing the group; Darwin can miss a child still being created during killpg. */
async function stopAndKillMacProcessGroup(child: NativeProcess): Promise<void> {
    const deadline = Date.now() + 1_000;
    try {
        while (Date.now() < deadline) {
            kill(-child.pid, "SIGSTOP");
            const output = await new Promise<string>((resolve, reject) => {
                const probe = spawn("/bin/ps", ["-axo", "pgid=,state="], {
                    cwd: "/",
                    stdio: ["ignore", "pipe", "ignore"],
                    timeout: 1_000,
                    killSignal: "SIGKILL",
                });
                let text = "";
                probe.stdout.setEncoding("utf8").on("data", (chunk: string) => {
                    text += chunk;
                });
                probe.once("error", reject);
                probe.once("close", (code) => (code === 0 ? resolve(text) : reject(new Error("Process probe failed"))));
            });
            const members = output
                .split("\n")
                .map((line) => line.trim().split(/\s+/))
                .filter(([group]) => Number(group) === child.pid);
            if (members.length && members.every(([, state]) => /^[TZ]/.test(state || ""))) break;
        }
    } catch {
        // A failed probe must not leave the owned command suspended.
    } finally {
        killProcessGroup(child);
    }
}

function spawnOwnedProcess(options: SpawnForegroundProcessOptions, windowsRawArguments = false): ForegroundProcess {
    const { command, args = [], cwd, env, stdinText, signal, timeoutMs } = options;
    if (options.stdin && stdinText !== undefined) throw new Error("Choose interactive stdin or stdinText, not both.");

    if (signal?.aborted) {
        return {
            pid: null,
            stdout: emptyClosedStream(),
            stderr: emptyClosedStream(),
            kill() {},
            done: Promise.resolve({ exitCode: null, terminatedBy: "abort" }),
        };
    }

    let child: NativeProcess | null = null;
    let terminatedBy: ForegroundTermination | null = null;
    let killSent = false;
    const terminate = (reason: ForegroundTermination): void => {
        if (!terminatedBy) terminatedBy = reason;
        if (!child || killSent) return;
        killSent = true;
        terminateProcessTree(child);
    };
    const onAbort = (): void => terminate("abort");
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeoutId = timeoutMs === undefined ? undefined : setTimeout(() => terminate("timeout"), timeoutMs);

    let spawned: NativeProcess;
    try {
        spawned = spawnNativeProcess(command, {
            args,
            cwd,
            env,
            windowsRawArguments,
            stdin: options.stdin || (stdinText === undefined ? "null" : "piped"),
            stdout: "piped",
            stderr: "piped",
            // Group leadership is what makes the whole tree terminable on
            // Unix-like systems; Windows uses taskkill /T instead.
            ...(platform === "win32" ? {} : { detached: true }),
        });
    } catch (error) {
        signal?.removeEventListener("abort", onAbort);
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        throw error;
    }
    child = spawned;
    if (stdinText !== undefined) {
        const writer = spawned.stdin.getWriter();
        const stdin = new TextEncoder().encode(stdinText);
        writer
            .write(stdin)
            .then(() => writer.close())
            .catch(() => undefined);
    }
    // Close the pre-spawn race: if the abort fired while `child` was still null,
    // `terminatedBy` is already set and this call sends the kill exactly once.
    if (signal?.aborted) terminate("abort");

    const done: Promise<ForegroundProcessOutcome> = (async () => {
        try {
            const status = await spawned.status;
            return {
                exitCode: terminatedBy ? null : status.code,
                terminatedBy,
            };
        } finally {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
            signal?.removeEventListener("abort", onAbort);
        }
    })();

    return {
        pid: spawned.pid,
        stdout: spawned.stdout,
        stderr: spawned.stderr,
        ...(options.stdin ? { stdin: spawned.stdin } : {}),
        kill: () => terminate("abort"),
        done,
    };
}

/**
 * Spawn a foreground direct command in its own terminable process tree.
 *
 * Arguments stay literal. This is the API for external CLIs whose command line
 * is assembled by RunWield and must not pass through shell parsing.
 */
export function spawnForegroundProcess(options: SpawnForegroundProcessOptions): ForegroundProcess {
    return spawnOwnedProcess(options);
}

/**
 * Spawn a foreground shell command in its own terminable process tree.
 *
 * Cancellation ordering is closed at both ends: the abort listener is attached
 * before spawn, and the post-spawn aborted-state check catches an abort that
 * fired while the child handle was not yet assigned. A pre-aborted signal
 * skips the spawn entirely. Termination is forceful on purpose — a command
 * that traps graceful signals must not keep the Session busy — and every
 * ordering settles exactly once with listeners and timers detached.
 */
export function spawnForegroundShell(options: SpawnForegroundShellOptions): ForegroundShell {
    const { command, cwd, env, signal, timeoutMs } = options;
    const isWindows = platform === "win32";
    return spawnOwnedProcess(
        {
            command: isWindows ? "cmd" : "sh",
            // cmd parses its own quoting; CRT escaping would turn quotes into literal backslashes.
            args: isWindows ? ["/d", "/s", "/c", `"${command}"`] : ["-c", command],
            cwd,
            env,
            signal,
            timeoutMs,
        },
        isWindows,
    );
}
