/** Adapt the real Node stdin iterator to the runtime's Web byte stream. */
import process from "node:process";
export function stdinStream(): ReadableStream<Uint8Array> {
    const iterator = process.stdin.iterator();
    return new ReadableStream<Uint8Array>(
        {
            async pull(controller) {
                const item = await iterator.next();
                if (item.done) controller.close();
                else if (item.value instanceof Uint8Array) controller.enqueue(item.value);
                else controller.error(new Error("Expected binary stdin"));
            },
            async cancel() {
                await iterator.return?.();
            },
        },
        { highWaterMark: 0 },
    );
}
