import { test } from "node:test";
import { assertEquals } from "../../testing/assertions.ts";
import { captureProcessOutput, trimProcessOutputLines } from "./process-output.ts";

function outputStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });
}

test("combined capture bounds UTF-8 text while the sink receives every original byte", async () => {
    const bytes = new TextEncoder().encode("é".repeat(50));
    const saved: number[] = [];
    const capture = await captureProcessOutput(outputStream(bytes), outputStream(new Uint8Array()), {
        tailBytes: 11,
        sink(chunk) {
            saved.push(...chunk);
            return Promise.resolve();
        },
    });
    assertEquals(capture.text, "é".repeat(5));
    assertEquals(capture.totalBytes, 100);
    assertEquals(capture.truncated, true);
    assertEquals(saved, Array.from(bytes));
});

test("invalid UTF-8 replacement characters cannot exceed the delivered byte budget", async () => {
    const capture = await captureProcessOutput(
        outputStream(new Uint8Array(50).fill(255)),
        outputStream(new Uint8Array()),
        {
            tailBytes: 11,
        },
    );
    assertEquals(new TextEncoder().encode(capture.text).byteLength <= 11, true);
    assertEquals(capture.totalBytes, 50);
    assertEquals(capture.truncated, true);
});

test("line trimming keeps complete final lines and marks omitted lines as truncated", () => {
    const result = trimProcessOutputLines({ text: "first\nsecond\nlast\n", totalBytes: 18, truncated: false }, 2);
    assertEquals(result, { text: "second\nlast\n", totalBytes: 18, truncated: true });
    const partial = trimProcessOutputLines({ text: "partial\nwhole\n", totalBytes: 100, truncated: true }, 200);
    assertEquals(partial, { text: "whole\n", totalBytes: 100, truncated: true });
});
