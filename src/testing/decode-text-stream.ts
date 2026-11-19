/** Incrementally decode real subprocess bytes, including shared backing buffers. */
export function decodeTextStream(): TransformStream<Uint8Array, string> {
    const decoder = new TextDecoder();
    return new TransformStream<Uint8Array, string>({
        transform(bytes, controller) {
            controller.enqueue(decoder.decode(Uint8Array.from(bytes), { stream: true }));
        },
        flush(controller) {
            const tail = decoder.decode();
            if (tail) controller.enqueue(tail);
        },
    });
}
