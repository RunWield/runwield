import { Buffer } from "node:buffer";
import type { NativeProcess } from "../shared/foreground-process.ts";
import type { CapturedProcessOutput } from "../shared/captured-process.ts";

/** Drain both pipes while awaiting the actual child exit. */
export async function collectProcessOutput(child: NativeProcess): Promise<CapturedProcessOutput> {
    const [status, stdout, stderr] = await Promise.all([
        child.status,
        readRemaining(child.stdout),
        readRemaining(child.stderr),
    ]);
    return { ...status, stdout: new Uint8Array(stdout), stderr: new Uint8Array(stderr) };
}

async function readRemaining(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) return Buffer.concat(chunks);
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
}
