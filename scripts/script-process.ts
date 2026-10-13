/** Literal process execution for development and packaging commands. */
import { type ChildProcess, spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import process from "node:process";
import { constants } from "node:os";

export interface ScriptProcessOptions {
    args?: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    clearEnv?: boolean;
    stdin?: "null" | "inherit";
    stdout?: "null" | "inherit" | "piped";
    stderr?: "null" | "inherit" | "piped";
    signal?: AbortSignal;
    input?: string;
}
export interface ScriptProcessOutput {
    code: number;
    success: boolean;
    stdout: Uint8Array;
    stderr: Uint8Array;
}
function stdio(value: "null" | "inherit" | "piped") {
    return value === "null" ? "ignore" : value === "piped" ? "pipe" : "inherit";
}
function environment(options: ScriptProcessOptions) {
    return options.clearEnv ? (options.env ?? {}) : { ...process.env, ...options.env };
}
function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
    return code ?? (signal && constants.signals[signal] ? 128 + constants.signals[signal] : 1);
}
export function captureScriptProcess(
    command: string,
    options: ScriptProcessOptions = {},
): Promise<ScriptProcessOutput> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, options.args ?? [], {
            cwd: options.cwd,
            env: environment(options),
            stdio: [
                options.input !== undefined ? "pipe" : stdio(options.stdin ?? "null"),
                stdio(options.stdout ?? "piped"),
                stdio(options.stderr ?? "piped"),
            ],
            signal: options.signal,
        });
        let failure: Error | undefined;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const forceAbortedExit = () => {
            killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
        };
        options.signal?.addEventListener("abort", forceAbortedExit, { once: true });
        if (options.signal?.aborted) forceAbortedExit();
        if (options.input !== undefined) {
            child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
                if (error.code !== "EPIPE") {
                    failure = error;
                    child.kill();
                }
            });
            child.stdin?.end(options.input);
        }
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout?.on("data", (value: Buffer) => stdout.push(value));
        child.stderr?.on("data", (value: Buffer) => stderr.push(value));
        child.on("error", (error) => {
            failure = error;
        });
        child.on("close", (code, signal) => {
            clearTimeout(killTimer);
            options.signal?.removeEventListener("abort", forceAbortedExit);
            if (failure) reject(failure);
            else {
                resolve({
                    code: exitCode(code, signal),
                    success: code === 0,
                    stdout: Buffer.concat(stdout),
                    stderr: Buffer.concat(stderr),
                });
            }
        });
    });
}
interface ScriptExit {
    code: number;
    success: boolean;
}
export function waitForScriptExit(child: ChildProcess): Promise<ScriptExit> {
    return new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, signal) => resolve({ code: exitCode(code, signal), success: code === 0 }));
    });
}
