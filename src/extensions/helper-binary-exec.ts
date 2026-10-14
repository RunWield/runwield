import { isMissingExecutableError, spawnForegroundProcess } from "../shared/foreground-process.ts";

export interface HelperBinaryExecResult {
    code: number;
    stdout: string;
    stderr: string;
}

export interface HelperBinaryExecOptions {
    cwd: string;
    signal?: AbortSignal;
}

export type HelperBinaryExec = (
    command: string,
    args: string[],
    options: HelperBinaryExecOptions,
) => Promise<HelperBinaryExecResult>;

export const denoHelperBinaryExec: HelperBinaryExec = async (command, args, options) => {
    try {
        options.signal?.throwIfAborted();
        const child = spawnForegroundProcess({ command, args, ...options });
        const [outcome, stdout, stderr] = await Promise.all([
            child.done,
            new Response(child.stdout).arrayBuffer(),
            new Response(child.stderr).arrayBuffer(),
        ]).catch((error: Error) => {
            child.kill();
            throw error;
        });
        options.signal?.throwIfAborted();
        if (outcome.exitCode === null) throw new Error(`Helper process terminated: ${command}`);
        const decoder = new TextDecoder();
        return {
            code: outcome.exitCode,
            stdout: decoder.decode(stdout),
            stderr: decoder.decode(stderr),
        };
    } catch (error) {
        if (error instanceof Error && isMissingExecutableError(error)) {
            return {
                code: 127,
                stdout: "",
                stderr: `${command}: command not found`,
            };
        }
        throw error;
    }
};
