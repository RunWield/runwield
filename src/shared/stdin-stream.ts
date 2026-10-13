import process from "node:process";

/** A cancellable process input stream. */
export function readableStdin(): ReadableStream<Uint8Array> {
    const input = process.stdin[Symbol.asyncIterator]();
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            const next = await input.next();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
        },
        async cancel() {
            // Release an in-flight next() before return() can settle.
            process.stdin.destroy();
            await input.return?.();
        },
    });
}
