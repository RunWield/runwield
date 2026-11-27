/** Capture literal subprocess output without a shell or a fixed output-size ceiling. */
import { spawnForegroundProcess } from "./foreground-process.ts";

export interface CapturedProcessOptions {
    cwd: string;
    args: string[];
    env?: Record<string, string>;
    stdinText?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
}
export interface CapturedProcessOutput {
    code: number;
    success: boolean;
    stdout: Uint8Array;
    stderr: Uint8Array;
}

export async function captureForegroundProcess(
    command: string,
    options: CapturedProcessOptions,
): Promise<CapturedProcessOutput> {
    options.signal?.throwIfAborted();
    const child = spawnForegroundProcess({ command, ...options });
    try {
        const [result, stdout, stderr] = await Promise.all([
            child.done,
            new Response(child.stdout).arrayBuffer(),
            new Response(child.stderr).arrayBuffer(),
        ]);
        options.signal?.throwIfAborted();
        if (result.exitCode === null) throw new Error(`Command was terminated before producing a result: ${command}`);
        return {
            code: result.exitCode,
            success: result.exitCode === 0,
            stdout: new Uint8Array(stdout),
            stderr: new Uint8Array(stderr),
        };
    } catch (error) {
        child.kill();
        throw error;
    }
}
