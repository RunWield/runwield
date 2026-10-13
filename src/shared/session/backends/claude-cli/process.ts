import { isMissingExecutableError, spawnForegroundProcess } from "../../../foreground-process.ts";
import type { PreparedClaudeCliCommand } from "./command.ts";
import { ClaudeCliBackendError } from "./failure.ts";

export interface ClaudeCliProcessStatus {
    success: boolean;
    code: number;
    signal: null;
}

export interface ClaudeCliProcessResult {
    success: boolean;
    code: number;
    stdout: ReadableStream<Uint8Array>;
    stderrText: Promise<string>;
    completed: Promise<ClaudeCliProcessStatus>;
    kill(): void;
}

export class DenoClaudeCliProcessPort {
    run(
        command: PreparedClaudeCliCommand,
        stdinText: string,
        cwd: string,
        signal?: AbortSignal,
    ): ClaudeCliProcessResult {
        let process: ReturnType<typeof spawnForegroundProcess>;
        try {
            process = spawnForegroundProcess({
                command: command.command,
                args: command.args,
                cwd,
                env: command.env,
                stdinText,
                signal,
            });
        } catch (error) {
            if (error instanceof Error && isMissingExecutableError(error)) {
                throw new ClaudeCliBackendError("missing_executable");
            }
            throw error;
        }
        return {
            success: true,
            code: 0,
            stdout: process.stdout,
            stderrText: new Response(process.stderr).text(),
            completed: process.done.then((outcome) => ({
                success: outcome.terminatedBy === null && outcome.exitCode === 0,
                code: outcome.exitCode ?? 1,
                signal: null,
            })),
            kill() {
                process.kill();
            },
        };
    }
}
