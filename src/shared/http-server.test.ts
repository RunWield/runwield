import { equal, match, ok } from "node:assert/strict";
import { versions } from "node:process";
import { test } from "node:test";
import { serveHttp } from "./http-server.ts";

const options = { hostname: "127.0.0.1", port: 0, onListen() {} };

test("native HTTP server preserves request method/body/headers and response status/headers", async () => {
    const server = serveHttp(options, async (request) =>
        new Response(`${request.method}:${await request.text()}`, {
            status: 201,
            headers: { "x-request-marker": request.headers.get("x-marker") || "missing" },
        }));
    try {
        ok(server.addr.port > 0);
        const response = await fetch(`http://127.0.0.1:${server.addr.port}/fixture`, {
            method: "POST",
            body: "payload π",
            headers: { "x-marker": "literal value" },
        });
        equal(response.status, 201);
        equal(response.headers.get("x-request-marker"), "literal value");
        equal(await response.text(), "POST:payload π");
    } finally {
        await server.shutdown();
        await server.finished;
    }
});

test("native HTTP server uses its explicit error response and remains available", async () => {
    const server = serveHttp(
        { ...options, onError: () => new Response("fixture error", { status: 503 }) },
        (request) => {
            if (new URL(request.url).pathname === "/throw") throw new Error("fixture");
            return new Response("alive");
        },
    );
    try {
        const failed = await fetch(`http://127.0.0.1:${server.addr.port}/throw`);
        equal(failed.status, 503);
        equal(await failed.text(), "fixture error");
        equal(await (await fetch(`http://127.0.0.1:${server.addr.port}/`)).text(), "alive");
    } finally {
        await server.shutdown();
    }
});

test("native HTTP server streams an event before closing the response", async () => {
    let finish!: () => void;
    const server = serveHttp(options, () =>
        new Response(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode("data: ready\n\n"));
                    finish = () => controller.close();
                },
            }),
            { headers: { "content-type": "text/event-stream" } },
        ));
    try {
        const response = await fetch(`http://127.0.0.1:${server.addr.port}/`, { signal: AbortSignal.timeout(5_000) });
        const reader = response.body!.getReader();
        const first = await reader.read();
        equal(first.done, false);
        match(new TextDecoder().decode(first.value), /data: ready/);
        finish();
        equal((await reader.read()).done, true);
        reader.releaseLock();
    } finally {
        await server.shutdown();
    }
});

test("native HTTP compression preserves content and negotiates gzip", async () => {
    const text = "response π ".repeat(1024);
    const server = serveHttp({ ...options, automaticCompression: true }, () =>
        new Response(text, {
            headers: { "content-type": "text/plain", "vary": "Origin" },
        }));
    try {
        for (const [encoding, expected] of [["gzip", "gzip"], ["gzip;q=0", null]] as const) {
            const response = await fetch(`http://127.0.0.1:${server.addr.port}/`, {
                headers: { "accept-encoding": encoding },
            });
            equal(response.headers.get("content-encoding"), expected);
            equal(await response.text(), text);
            if (expected) match(response.headers.get("vary") || "", /accept-encoding/i);
        }
    } finally {
        await server.shutdown();
    }
});

test("native HTTP shutdown waits for an in-flight response and is repeatable", async () => {
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const server = serveHttp(options, async () => {
        entered();
        await gate;
        return new Response("finished request");
    });
    const request = fetch(`http://127.0.0.1:${server.addr.port}/`);
    await ready;
    let stopped = false;
    const stopping = server.shutdown().then(() => {
        stopped = true;
    });
    try {
        await new Promise((resolve) => setTimeout(resolve, 30));
        equal(stopped, false);
        release();
        equal(await (await request).text(), "finished request");
        await stopping;
        await server.finished;
        await server.shutdown();
    } finally {
        release();
        await stopping;
    }
});

// Deno retains its native lifecycle: abort after shutdown begins does not
// escalate an already-graceful close. Bun explicitly supports this escalation.
for (const gracefulFirst of versions.bun ? [false, true] : [false]) {
    test(`native HTTP abort closes an open stream (graceful shutdown first: ${gracefulFirst})`, async () => {
        const controller = new AbortController();
        const server = serveHttp({ ...options, signal: controller.signal }, () =>
            new Response(
                new ReadableStream<Uint8Array>({
                    start(stream) {
                        stream.enqueue(new TextEncoder().encode("data: ready\n\n"));
                    },
                }),
                { headers: { "content-type": "text/event-stream" } },
            ));
        const response = await fetch(`http://127.0.0.1:${server.addr.port}/`, { signal: AbortSignal.timeout(5_000) });
        const reader = response.body!.getReader();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            equal((await reader.read()).done, false);
            const ending = reader.read().then((result) => equal(result.done, true), () => {});
            if (gracefulFirst) void server.shutdown();
            controller.abort();
            await Promise.race([
                Promise.all([server.finished, ending]),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error("Abort left the stream open")), 1_000);
                }),
            ]);
        } finally {
            clearTimeout(timer);
            await reader.cancel().catch(() => {});
            controller.abort();
            await server.finished;
        }
    });
}

test("native HTTP default error response never exposes exception details", async () => {
    const server = serveHttp(options, () => {
        throw new Error("private-probe-message");
    });
    try {
        const response = await fetch(`http://127.0.0.1:${server.addr.port}/`);
        equal(response.status, 500);
        equal(await response.text(), "Internal Server Error");
    } finally {
        await server.shutdown();
    }
});
