import { spawnForegroundProcess } from "../../../foreground-process.ts";
import type { ForegroundProcess, ForegroundTermination } from "../../../foreground-process.ts";
import type { PreparedAgyCliCommand } from "./command.ts";
import { AgyCliBackendError } from "./failure.ts";

export interface AgyCliProcessStatus {
    success: boolean;
    code: number | null;
    terminatedBy: ForegroundTermination | null;
}

export interface AgyCliProcessResult {
    pid: number | null;
    stdout: ReadableStream<Uint8Array>;
    stderrText: Promise<string>;
    completed: Promise<AgyCliProcessStatus>;
    kill(): void;
}

export class DenoAgyCliProcessPort {
    run(command: PreparedAgyCliCommand, cwd: string, signal?: AbortSignal): AgyCliProcessResult {
        const localAbort = new AbortController();
        const combinedSignal = signal ? AbortSignal.any([signal, localAbort.signal]) : localAbort.signal;
        let process: ReturnType<typeof spawnForegroundProcess>;
        try {
            process = spawnForegroundProcess({
                command: command.command,
                args: command.args,
                cwd,
                env: command.env,
                signal: combinedSignal,
                timeoutMs: command.timeoutMs,
            });
        } catch (error) {
            if (error instanceof Deno.errors.NotFound) throw new AgyCliBackendError("missing_executable");
            throw error;
        }
        return {
            pid: process.pid,
            stdout: process.stdout,
            stderrText: readAgyDiagnostics(process),
            completed: process.done.then((outcome) => ({
                success: outcome.terminatedBy === null && outcome.exitCode === 0,
                code: outcome.exitCode,
                terminatedBy: outcome.terminatedBy,
            })),
            kill() {
                localAbort.abort();
                process.kill();
            },
        };
    }
}

async function readAgyDiagnostics(process: ForegroundProcess): Promise<string> {
    const chunks: string[] = [];
    const decoder = new TextDecoder();
    let tail = "";
    for await (const bytes of process.stderr) {
        const chunk = decoder.decode(bytes, { stream: true });
        chunks.push(chunk);
        const diagnostic = tail + chunk;
        // Headless Agy waits for an OAuth code even with stdin closed. That
        // login belongs in an interactive terminal, outside the RunWield turn.
        if (/(?:^|\n)\s*Authentication required\b/i.test(diagnostic)) process.kill();
        tail = diagnostic.slice(-128);
    }
    chunks.push(decoder.decode());
    return chunks.join("");
}
