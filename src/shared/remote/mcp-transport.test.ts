import process from "node:process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient } from "@earendil-works/pi-mcp";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { serveHttp } from "../http-server.ts";
import { configureRemoteMcpConnection, LaptopMcpBridge, RemoteMcpTransport } from "./mcp-bridge.ts";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";

async function withWire(
    chunks: (string | Uint8Array)[],
    run: (transport: RemoteMcpTransport, sends: string[]) => Promise<void>,
) {
    await withProcessGlobalTestLock(async () => {
        const sends: string[] = [];
        const server = serveHttp({ hostname: "127.0.0.1", port: 0 }, async (request) => {
            if (request.url.endsWith("/open")) {
                let index = 0;
                let cancelled = false;
                return new Response(
                    new ReadableStream<Uint8Array>({
                        async pull(controller) {
                            await new Promise((resolve) => setTimeout(resolve, 2));
                            if (cancelled) return;
                            if (index === chunks.length) {
                                controller.close();
                                return;
                            }
                            const chunk = chunks[index++];
                            controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
                        },
                        cancel() {
                            cancelled = true;
                        },
                    }),
                );
            }
            if (request.url.endsWith("/send")) {
                sends.push(await request.text());
                return new Response(null, { status: 503 });
            }
            return new Response(null, { status: 204 });
        });
        assert(server.addr.transport === "tcp");
        const clear = configureRemoteMcpConnection({ port: server.addr.port, credential: "a".repeat(64) });
        try {
            await run(new RemoteMcpTransport("personal"), sends);
        } finally {
            await clear();
            await server.shutdown();
        }
    });
}

test("transport parses split NDJSON and rejects incomplete EOF without replay", async () => {
    await withWire(
        [
            "\n",
            '{"jsonrpc":"2.0",',
            '"id":1,"result":{"text":"hello',
            new Uint8Array([0xc3]),
            new Uint8Array([0xa9]),
            '"}}\n',
            '{"jsonrpc":',
        ],
        async (transport, sends) => {
            const messages: string[] = [];
            const closed = new Promise<void>((resolve) => transport.onClose(resolve));
            transport.onMessage((message) => messages.push(JSON.stringify(message)));
            await transport.start();
            await closed;
            assertEquals(messages, ['{"jsonrpc":"2.0","id":1,"result":{"text":"helloé"}}']);
            assertEquals(sends, []);
        },
    );
});

test("transport rejects oversized frames and malformed messages without partial output", async () => {
    for (const payload of ['{"invalid":true}\n', "x".repeat(16 * 1024 * 1024 + 1)]) {
        await withWire(["\n", payload], async (transport) => {
            const messages: string[] = [];
            let errors = 0;
            transport.onMessage((message) => messages.push(JSON.stringify(message)));
            transport.onError(() => errors++);
            const closed = new Promise<void>((resolve) => transport.onClose(resolve));
            await transport.start();
            await closed;
            assertEquals(messages, []);
            assertEquals(errors, 1);
        });
    }
});

test("lost send acknowledgement closes the transport and does not retry queued effects", async () => {
    await withWire(["\n", ...Array.from({ length: 100 }, () => "\n")], async (transport, sends) => {
        await transport.start();
        const a = transport.send({ jsonrpc: "2.0", id: 1, method: "tools/call" });
        const b = transport.send({ jsonrpc: "2.0", id: 2, method: "tools/call" });
        await Promise.all([assertRejects(() => a), assertRejects(() => b)]);
        assertEquals(sends.length, 1);
        assertEquals(JSON.parse(sends[0]).sequence, 0);
    });
});

test("remote pending sends are bounded even before the first network write", async () => {
    await withWire(["\n"], async (transport, sends) => {
        await transport.start();
        const message = {
            jsonrpc: "2.0" as const,
            method: "fixture/input",
            params: { text: "x".repeat(15 * 1024 * 1024) },
        };
        const pending = [0, 1, 2].map(() => transport.send(message));
        await Promise.all(pending.map((result) => assertRejects(() => result)));
        assertEquals(sends, []);
    });
});

test("an admitted real call with a lost acknowledgement is not replayed after reconnect", async () => {
    await withRuntimeCommandFixture("mcp-lost-ack-", async (f) => {
        const log = join(f.homeDir, "calls.log");
        await writeFile(
            join(f.homeDir, ".wld/mcp.json"),
            JSON.stringify({
                mcpServers: {
                    personal: {
                        command: process.execPath,
                        args: runtimeSourceArgs([
                            "run",
                            "-A",
                            fileURLToPath(new URL("../mcp/fixture-server.ts", import.meta.url)),
                        ]),
                        env: { RUNWIELD_MCP_FIXTURE_LOG: log },
                    },
                },
            }),
            { mode: 0o600 },
        );
        const bridge = new LaptopMcpBridge();
        const server = serveHttp(
            { hostname: "127.0.0.1", port: 0, onError: () => new Response(null, { status: 503 }) },
            async (request) => {
                const body = await request.clone().text();
                const response = await bridge.handle(request, () => true);
                if (request.url.endsWith("/send") && body.includes('"cooperative-slow"')) {
                    // The real process has admitted the effect before the network drops its acknowledgement.
                    for (let i = 0; i < 200; i++) {
                        if ((await readFile(log, "utf8")).includes('"marker":"cooperative-slow"')) break;
                        await new Promise((resolve) => setTimeout(resolve, 5));
                    }
                    return new Response(null, { status: 503 });
                }
                return response;
            },
        );
        assert(server.addr.transport === "tcp");
        const clear = configureRemoteMcpConnection({ port: server.addr.port, credential: "a".repeat(64) });
        const a = new McpClient({ name: "lost", version: "1" });
        const b = new McpClient({ name: "fresh", version: "1" });
        try {
            await a.connect(new RemoteMcpTransport("personal"));
            await assertRejects(() => a.callTool("fixture_echo", { marker: "cooperative-slow" }));
            await b.connect(new RemoteMcpTransport("personal"));
            await b.callTool("fixture_echo", { marker: "fresh" });
            const evidence = await readFile(log, "utf8");
            assertEquals(evidence.split('"marker":"cooperative-slow"').length - 1, 1);
            assertEquals(evidence.split('"marker":"fresh"').length - 1, 1);
        } finally {
            await a.close();
            await b.close();
            await clear();
            await bridge.close();
            await server.shutdown();
        }
    });
});
