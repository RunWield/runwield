/** Paused socket acceptance and bounded reads for private transport headers. */
import { createServer, type ListenOptions, type Socket } from "node:net";
import type { Readable } from "node:stream";

export interface SocketListener {
    readonly port: number;
    accept(): Promise<Socket>;
    close(): void;
}
interface WaitingAccept {
    resolve(socket: Socket): void;
    reject(error: Error): void;
}

/** Connections remain paused until their owner authenticates and consumes them. */
export async function listenSocket(options: ListenOptions): Promise<SocketListener> {
    const queued: Socket[] = [];
    const waiting: WaitingAccept[] = [];
    let closed = false;
    let failure: Error | undefined;
    const server = createServer({ allowHalfOpen: true }, (socket) => {
        // A disconnected unauthenticated peer must not crash the listener.
        socket.on("error", () => {});
        if (closed) return void socket.destroy();
        const pending = waiting.shift();
        if (pending) pending.resolve(socket);
        else queued.push(socket);
    });
    server.on("error", (error) => {
        failure = error;
        for (const pending of waiting.splice(0)) pending.reject(error);
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options, () => {
            server.removeListener("error", reject);
            resolve();
        });
    });
    const address = server.address();
    return {
        port: address && typeof address !== "string" ? address.port : 0,
        accept() {
            if (closed || failure) return Promise.reject(failure ?? new Error("Socket listener closed"));
            const socket = queued.shift();
            return socket
                ? Promise.resolve(socket)
                : new Promise((resolve, reject) => waiting.push({ resolve, reject }));
        },
        close() {
            if (closed) return;
            closed = true;
            server.close();
            for (const socket of queued.splice(0)) socket.destroy();
            for (const pending of waiting.splice(0)) pending.reject(new Error("Socket listener closed"));
        },
    };
}

/** Consume only the requested bytes, leaving pipelined protocol/terminal bytes queued. */
export async function readStreamInto(input: Readable, buffer: Uint8Array): Promise<number | null> {
    if (buffer.length === 0) return 0;
    while (true) {
        const length = Math.max(1, Math.min(buffer.length, input.readableLength));
        const bytes = input.read(length) as Uint8Array | null;
        if (bytes !== null) {
            buffer.set(bytes);
            return bytes.length;
        }
        if (input.readableEnded || input.destroyed) return null;
        await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                input.removeListener("readable", ready);
                input.removeListener("end", ready);
                input.removeListener("close", ready);
                input.removeListener("error", failed);
            };
            const ready = () => {
                cleanup();
                resolve();
            };
            const failed = (error: Error) => {
                cleanup();
                reject(error);
            };
            input.once("readable", ready);
            input.once("end", ready);
            input.once("close", ready);
            input.once("error", failed);
        });
    }
}
