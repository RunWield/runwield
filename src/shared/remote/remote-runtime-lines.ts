import { decodeTextStream } from "../../testing/decode-text-stream.ts";
/** Newline-delimited private process reports. */
export function processLines(stream: ReadableStream<Uint8Array>) {
    let pending = "";
    return stream
        .pipeThrough(decodeTextStream())
        .pipeThrough(
            new TransformStream<string, string>({
                transform(chunk, controller) {
                    pending += chunk;
                    let newline: number;
                    while ((newline = pending.indexOf("\n")) >= 0) {
                        controller.enqueue(pending.slice(0, newline));
                        pending = pending.slice(newline + 1);
                    }
                },
                flush(controller) {
                    if (pending) controller.enqueue(pending);
                },
            }),
        )
        .getReader();
}
