import { test } from "node:test";
import { connect } from "node:net";
import { assertEquals, assertRejects } from "../testing/assertions.ts";
import { listenSocket, readStreamInto } from "./socket-listener.ts";

test("socket reads deliver a single byte promptly and preserve pipelined protocol bytes", async () => {
    const listener = await listenSocket({ host: "127.0.0.1", port: 0 });
    const peer = connect({ host: "127.0.0.1", port: listener.port });
    const connection = await listener.accept();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
        peer.write(new Uint8Array([0x61]));
        const buffer = new Uint8Array(4096);
        const count = await Promise.race([
            readStreamInto(connection, buffer),
            new Promise<never>((_, reject) => {
                deadline = setTimeout(() => reject(new Error("Single-byte transport input stalled")), 2_000);
            }),
        ]);
        assertEquals(count, 1);
        assertEquals(buffer[0], 0x61);
        peer.end(new Uint8Array([0x62, 10, 0, 255, 17]));
        const header = new Uint8Array(1);
        assertEquals(await readStreamInto(connection, header), 1);
        assertEquals(header[0], 0x62);
        assertEquals(await readStreamInto(connection, header), 1);
        assertEquals(header[0], 10);
        const payload: number[] = [];
        let received: number | null;
        while ((received = await readStreamInto(connection, buffer)) !== null) {
            payload.push(...buffer.subarray(0, received));
        }
        assertEquals(payload, [0, 255, 17]);
    } finally {
        if (deadline !== undefined) clearTimeout(deadline);
        peer.destroy();
        connection.destroy();
        listener.close();
    }
});

test("closing a socket listener rejects pending and future accepts", async () => {
    const listener = await listenSocket({ host: "127.0.0.1", port: 0 });
    const pending = listener.accept();
    const rejected = assertRejects(() => pending, Error, "closed");
    listener.close();
    await rejected;
    await assertRejects(() => listener.accept(), Error, "closed");
});
