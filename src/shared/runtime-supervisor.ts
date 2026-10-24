/** Keep native runtime failure outside the process that owns terminal recovery. */
import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:os";
import process from "node:process";
import { resourceExhaustionMessage } from "./resource-exhaustion.ts";

interface RuntimeExit {
    code: number | null;
    signal: NodeJS.Signals | null;
}

/** Run exactly once. Never replay a command whose external effects may be uncertain. */
export async function superviseRuntime(command: string, args: string[]): Promise<number> {
    // Capture before the child can enter raw mode. The supervisor keeps its own
    // descriptor budget and can restore the terminal after a native abort.
    const terminal =
        process.stdin.isTTY && process.platform !== "win32"
            ? spawnSync("stty", ["-g"], { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" })
            : null;
    let diagnostics = "";
    let launchError: Error | undefined;
    const child = spawn(command, args, {
        stdio: ["inherit", "inherit", "pipe"],
        env: { ...process.env, WLD_RUNTIME_SUPERVISOR_PID: String(process.pid) },
    });
    child.once("error", (error) => {
        launchError = error;
    });
    // Bun leaves the pipe absent when spawn itself fails (for example EMFILE).
    child.stderr?.on("data", (chunk: Buffer) => {
        // A bounded tail handles diagnostic fragments split across pipe reads.
        diagnostics = (diagnostics + chunk.toString("utf8")).slice(-16_384);
    });
    child.stderr?.pipe(process.stderr, { end: false });
    const signals: NodeJS.Signals[] =
        process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
    const forward = (signal: NodeJS.Signals) => {
        try {
            child.kill(signal);
        } catch {
            // The runtime may already have exited.
        }
    };
    for (const signal of signals) process.on(signal, forward);
    try {
        const result = await new Promise<RuntimeExit>((resolve) => {
            let drainTimer: ReturnType<typeof setTimeout> | undefined;
            let resumeDrain: (() => void) | undefined;
            const complete = (code: number | null, signal: NodeJS.Signals | null) => {
                if (drainTimer) clearTimeout(drainTimer);
                if (resumeDrain) process.stderr.off("drain", resumeDrain);
                child.stderr?.destroy();
                resolve({ code, signal });
            };
            child.once("close", complete);
            child.once("exit", (code, signal) => {
                // Descendants can keep stderr open after the runtime exits. Allow
                // final diagnostics to drain, but do not wait for that shared EOF.
                const scheduleDrain = () => {
                    drainTimer = setTimeout(() => {
                        // A blocked destination is not an idle input pipe.
                        if (process.stderr.writableNeedDrain) process.stderr.once("drain", scheduleDrain);
                        else complete(code, signal);
                    }, 250);
                };
                resumeDrain = scheduleDrain;
                scheduleDrain();
            });
        });
        const failed = result.code !== 0 || result.signal !== null || launchError !== undefined;
        if (failed) {
            const restored =
                terminal?.status === 0 &&
                spawnSync("stty", [terminal.stdout.trim()], { stdio: ["inherit", "ignore", "ignore"] }).status === 0;
            if (!restored && process.stdin.isTTY) {
                try {
                    process.stdin.setRawMode(false);
                } catch {
                    /* No terminal access. */
                }
            }
            if (process.stdout.isTTY) {
                // Leave alternate-screen, bracketed-paste, and hidden-cursor modes.
                process.stdout.write("\x1b[?2004l\x1b[?1049l\x1b[?25h\x1b[0m");
            }
            // Earlier recovered errors (or quoted log text) do not describe the
            // final failure. Inspect only the last runtime/fatal-error diagnostic.
            let failureStart = -1;
            for (const match of diagnostics.matchAll(
                /\[RunWield\] (?:Fatal error|Remote entry failed):|(?:^|\n)(?:error:|fatal error:|panic(?:\([^\n]*\))?:|thread ['"].*panicked)/gi,
            )) {
                failureStart = match.index;
            }
            const resource = resourceExhaustionMessage(
                launchError ?? (failureStart < 0 ? "" : diagnostics.slice(failureStart)),
            );
            const unexpectedSignal = result.signal && !signals.some((signal) => signal === result.signal);
            const runtimePanic = /Bun has crashed|panic(?:\([^\n]*\))?:|Segmentation fault|fatal error:/i.test(
                diagnostics,
            );
            if (resource || unexpectedSignal || runtimePanic || launchError) {
                console.error(
                    `\n[RunWield] ${
                        resource ??
                        (launchError
                            ? `Could not start the runtime: ${launchError.message}`
                            : `RunWield runtime stopped unexpectedly (${result.signal ?? `exit ${result.code}`}).`)
                    }`,
                );
                console.error("The command was not replayed. Check any interrupted tool's result before retrying.");
                console.error("To reopen your last saved Session, run: wld --continue");
            }
        }
        // The CLI may use process.exit(), so flush the supervisor's output queue.
        await new Promise<void>((resolve) => process.stderr.write("", () => resolve()));
        if (process.stdout.isTTY) await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
        if (result.signal) return 128 + (constants.signals[result.signal] ?? 1);
        return result.code !== null && result.code >= 0 ? result.code : 1;
    } finally {
        for (const signal of signals) process.off(signal, forward);
    }
}
