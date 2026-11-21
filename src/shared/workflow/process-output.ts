/**
 * @module shared/workflow/process-output
 * Capture the tail of a child process's output without buffering all of it.
 *
 * Nothing here is validation-specific — it is the stream handling that local
 * validation commands need and that `Deno.Command.output()` cannot provide.
 */

/** The retained tail of one process stream, plus what was dropped to keep it. */
export interface CapturedProcessStream {
    text: string;
    totalBytes: number;
    truncated: boolean;
}

/** Default tail budget per stream. Large enough that most runs are not truncated at all. */
export const PROCESS_STREAM_OUTPUT_LIMIT_BYTES = 1024 * 1024;

function concatBytes(left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
    const combined = new Uint8Array(left.byteLength + right.byteLength);
    combined.set(left, 0);
    combined.set(right, left.byteLength);
    return combined;
}

/**
 * Read a process stream without using `Deno.Command.output()`, whose internal
 * buffer can throw before a large-but-successful validation command finishes.
 *
 * The tail is kept rather than the head because build and test failures are
 * reported last.
 */
export async function captureProcessStreamTail(
    stream: ReadableStream<Uint8Array>,
    limitBytes: number,
): Promise<CapturedProcessStream> {
    const reader = stream.getReader();
    let retained: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    let totalBytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (value.byteLength >= limitBytes) {
                retained = value.slice(value.byteLength - limitBytes);
                continue;
            }
            retained = concatBytes(retained, value);
            if (retained.byteLength > limitBytes) {
                retained = retained.slice(retained.byteLength - limitBytes);
            }
        }
    } finally {
        reader.releaseLock();
    }
    return {
        text: new TextDecoder().decode(retained),
        totalBytes,
        truncated: totalBytes > retained.byteLength,
    };
}

/**
 * Join both streams into what the agent reads, and say so when output was dropped.
 *
 * Silent truncation is the failure mode worth avoiding: an agent that cannot see
 * the note will treat a truncated log as the whole story.
 */
export function formatCapturedProcessOutput(
    stdout: CapturedProcessStream,
    stderr: CapturedProcessStream,
    limitBytes: number = PROCESS_STREAM_OUTPUT_LIMIT_BYTES,
): string {
    const output = `${stdout.text}\n${stderr.text}`;
    if (!stdout.truncated && !stderr.truncated) return output;
    const notices: string[] = [];
    if (stdout.truncated) {
        notices.push(`[RunWield] stdout truncated; showing last ${limitBytes} of ${stdout.totalBytes} bytes.`);
    }
    if (stderr.truncated) {
        notices.push(`[RunWield] stderr truncated; showing last ${limitBytes} of ${stderr.totalBytes} bytes.`);
    }
    return `${output}\n${notices.join("\n")}\n`;
}

export interface ProcessOutputCaptureOptions {
    tailBytes: number;
    sink?: (chunk: Uint8Array) => Promise<void>;
}

/** Read both pipes concurrently, retaining and saving chunks in observed arrival order. */
export async function captureProcessOutput(
    stdout: ReadableStream<Uint8Array>,
    stderr: ReadableStream<Uint8Array>,
    { tailBytes, sink }: ProcessOutputCaptureOptions,
): Promise<CapturedProcessStream> {
    let retained: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    let totalBytes = 0;
    async function capture(stream: ReadableStream<Uint8Array>): Promise<void> {
        const reader = stream.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) return;
                totalBytes += value.byteLength;
                retained =
                    value.byteLength >= tailBytes
                        ? value.slice(-tailBytes)
                        : concatBytes(retained, value).slice(-tailBytes);
                // Await the sink to bound pending writes as well as the retained tail.
                await sink?.(value);
            }
        } finally {
            reader.releaseLock();
        }
    }
    const results = await Promise.allSettled([capture(stdout), capture(stderr)]);
    for (const result of results) {
        if (result.status === "rejected") throw result.reason;
    }
    // A byte boundary can split a UTF-8 character. Drop its continuation bytes.
    let start = 0;
    while (start < retained.length && (retained[start] & 0xc0) === 0x80) start++;
    let text = new TextDecoder().decode(retained.subarray(start));
    // Replacement characters for invalid UTF-8 can use more bytes than the input.
    const encoded = new TextEncoder().encode(text);
    if (encoded.byteLength > tailBytes) {
        start = encoded.byteLength - tailBytes;
        while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) start++;
        text = new TextDecoder().decode(encoded.subarray(start));
    }
    return { text, totalBytes, truncated: totalBytes > retained.byteLength || encoded.byteLength > tailBytes };
}

/** Drop a partial first line after byte truncation, then keep at most maxLines lines. */
export function trimProcessOutputLines(capture: CapturedProcessStream, maxLines: number): CapturedProcessStream {
    let text = capture.text;
    if (capture.truncated && text.includes("\n")) text = text.slice(text.indexOf("\n") + 1);
    const lines = text.split("\n");
    const lineCount = lines.length - (text.endsWith("\n") ? 1 : 0);
    if (lineCount > maxLines) text = lines.slice(lineCount - maxLines).join("\n");
    return { ...capture, text, truncated: capture.truncated || text !== capture.text };
}
