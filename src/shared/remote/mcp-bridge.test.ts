import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { McpClient } from "@earendil-works/pi-mcp";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import type { McpServerDefinition } from "../mcp/config.ts";
import { startMcpIntegration } from "../mcp/integration.ts";
import { startRemoteControlService } from "./control.ts";
import { configureRemoteMcpConnection, LaptopMcpBridge, RemoteMcpTransport } from "./mcp-bridge.ts";

const fixtureServer = fileURLToPath(new URL("../mcp/fixture-server.ts", import.meta.url));
const identity = { buildId: "a".repeat(64), protocol: 1 };

async function withBridge(run: (f: BridgeFixture) => Promise<void>, env: Record<string, string> = {}) {
    await withRuntimeCommandFixture("mcp-relay-", async (local) => {
        const log = join(local.homeDir, "mcp.log");
        const definition = {
            command: process.execPath,
            args: runtimeSourceArgs(["run", "-A", fixtureServer]),
            env: { RUNWIELD_MCP_FIXTURE_LOG: log, ...env },
        };
        await writeFile(
            join(local.homeDir, ".wld", "mcp.json"),
            JSON.stringify({ mcpServers: { personal: definition } }),
            { mode: 0o600 },
        );
        const service = startRemoteControlService(identity);
        const connection = { port: service.port, credential: service.credential };
        const clear = configureRemoteMcpConnection(connection);
        const request = (path: string, body = "{}", authorized = true) =>
            fetch(`http://127.0.0.1:${service.port}${path}`, {
                method: "POST",
                headers: { Authorization: authorized ? `Bearer ${service.credential}` : "Bearer wrong" },
                body,
            });
        try {
            await run({
                ...local,
                log,
                definition,
                service,
                request,
                ready: async () => {
                    assertEquals((await request("/handshake", JSON.stringify(identity))).ok, true);
                    assertEquals((await request("/readiness")).ok, true);
                },
            });
        } finally {
            await clear();
            await service.close();
        }
    });
}
type LocalFixture = Parameters<Parameters<typeof withRuntimeCommandFixture>[1]>[0];
interface BridgeFixture extends LocalFixture {
    log: string;
    definition: { command: string; args: string[]; env: Record<string, string> };
    service: ReturnType<typeof startRemoteControlService>;
    request(path: string, body?: string, authorized?: boolean): Promise<Response>;
    ready(): Promise<void>;
}
const personal: McpServerDefinition = {
    name: "personal",
    command: "",
    args: [],
    env: {},
    source: "global",
    location: "laptop",
};
function call(
    tool: ToolDefinition,
    marker: string,
    signal?: AbortSignal,
    update?: Parameters<ToolDefinition["execute"]>[3],
) {
    return tool.execute(
        crypto.randomUUID(),
        { marker },
        signal,
        update,
        {} as Parameters<ToolDefinition["execute"]>[4],
    );
}
async function waitForLog(path: string, marker: string): Promise<string> {
    for (let i = 0; i < 200; i++) {
        const log = await readFile(path, "utf8").catch(() => "");
        if (log.includes(marker)) return log;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Missing fixture event: ${marker}`);
}

interface OutputDetails {
    fullOutputPath?: string;
}

test("one Pi extension preserves native personal results, shared resources, roots and progress", async () => {
    await withBridge(
        async (f) => {
            await f.ready();
            const { integration } = await startMcpIntegration({
                cwd: f.projectRoot,
                servers: [personal, { ...f.definition, name: "project", source: "project", location: "remote" }],
            });
            try {
                const tools = integration.getTools();
                const tool = tools.find((tool) => tool.name === "mcp__personal__fixture_echo");
                assert(tool, JSON.stringify(tools.map((tool) => tool.name)));
                assert(tools.some((tool) => tool.name === "mcp__personal__second"));
                assertEquals(tool.annotations, { readOnlyHint: true });
                assertStringIncludes(JSON.stringify(tool.parameters), '"marker":{"type":"string"}');
                assertStringIncludes(JSON.stringify(await call(tool, "structured")), '"count":2');
                assertStringIncludes(JSON.stringify(await call(tool, "error")), "fixture-error");
                assertStringIncludes(JSON.stringify(await call(tool, "image-resource")), '"type":"image"');
                assertStringIncludes(JSON.stringify(await call(tool, "roots")), pathToFileURL(f.projectRoot).href);
                const progress: string[] = [];
                await call(tool, "progress", undefined, (update) => progress.push(JSON.stringify(update)));
                assertStringIncludes(progress.join("\n"), "halfway");
                const output = await call(tool, "resource-link");
                const details = output.details as OutputDetails;
                assert(details.fullOutputPath);
                assertStringIncludes(await readFile(details.fullOutputPath, "utf8"), "t".repeat(20_000));
                // Pi owns a single set of resource tools, with both servers selectable.
                const resourceList = tools.find((tool) => tool.name === "list_mcp_resources");
                assert(resourceList, tools.map((tool) => tool.name).join(","));
                for (const server of ["personal", "project"]) {
                    const result = await resourceList.execute(
                        "list",
                        { server },
                        undefined,
                        undefined,
                        {} as Parameters<ToolDefinition["execute"]>[4],
                    );
                    assertStringIncludes(JSON.stringify(result), "fixture://document");
                }
            } finally {
                await integration.close();
            }
        },
        {
            RUNWIELD_MCP_FIXTURE_RESOURCES: "1",
            RUNWIELD_MCP_FIXTURE_PAGINATED: "1",
            RUNWIELD_MCP_FIXTURE_TOOLS: "fixture_echo,second",
        },
    );
});

test("native cancellation reaches the laptop while a cooperative call is running", async () => {
    await withBridge(async (f) => {
        await f.ready();
        const { integration } = await startMcpIntegration({
            cwd: f.projectRoot,
            servers: [personal],
        });
        try {
            const abort = new AbortController();
            const pending = call(integration.getTools()[0], "cooperative-slow", abort.signal);
            const rejected = assertRejects(() => pending);
            await waitForLog(f.log, '"event":"call"');
            abort.abort();
            await rejected;
            await waitForLog(f.log, '"event":"cancelled"');
            await new Promise((resolve) => setTimeout(resolve, 600));
            assertEquals((await readFile(f.log, "utf8")).includes("delayed-effect"), false);
            const before = new AbortController();
            before.abort();
            await assertRejects(() => call(integration.getTools()[0], "never-dispatched", before.signal));
            assertEquals((await readFile(f.log, "utf8")).includes("never-dispatched"), false);
        } finally {
            await integration.close();
        }
    });
});

test("laptop transports keep Session lifetimes separate and close owned PIDs on revocation", async () => {
    await withBridge(async (f) => {
        await f.ready();
        const a = new McpClient({ name: "a", version: "1" });
        const b = new McpClient({ name: "b", version: "1" });
        await a.connect(new RemoteMcpTransport("personal"));
        await b.connect(new RemoteMcpTransport("personal"));
        await a.close();
        await a.close();
        const log = await waitForLog(f.log, '"event":"shutdown"');
        assertEquals(log.split('"event":"started"').length - 1, 2);
        assertEquals(log.split('"event":"shutdown"').length - 1, 1);
        assertStringIncludes(JSON.stringify(await b.callTool("fixture_echo", { marker: "survivor" })), "survivor");
        const pending = b.callTool("fixture_echo", { marker: "cooperative-slow" });
        const rejected = assertRejects(() => pending);
        await waitForLog(f.log, '"marker":"cooperative-slow"');
        f.service.requestShutdown();
        await rejected;
        await f.service.close();
        const final = await readFile(f.log, "utf8");
        assertEquals(final.split('"event":"shutdown"').length - 1, 2);
        assertEquals(final.includes("delayed-effect"), false);
        await b.close();
    });
});

test("admission rejects unready, unauthenticated, executable-bearing, stale and repeated transports", async () => {
    await withBridge(async (f) => {
        const id = crypto.randomUUID();
        const route = `/mcp/transport/${id}`;
        const open = JSON.stringify({ name: "personal" });
        assertEquals((await f.request(`${route}/open`, open, false)).status, 401);
        assertEquals((await f.request(`${route}/open`, open)).status, 403);
        await f.ready();
        assertEquals((await f.request(`/mcp/transport/${"-".repeat(36)}/open`, open)).status, 404);
        assertEquals((await f.request(`${route}/open`, "{")).status, 400);
        assertEquals(
            (await f.request(`${route}/open`, JSON.stringify({ name: "personal", command: "BAD" }))).status,
            400,
        );
        assertEquals((await f.request(`${route}/close`)).status, 204);
        assertEquals((await f.request(`${route}/open`, open)).status, 409);
        assertEquals((await f.request(`${route}/close`)).status, 204);
        const fresh = `/mcp/transport/${crypto.randomUUID()}`;
        const response = await f.request(`${fresh}/open`, open);
        assertEquals(response.status, 200);
        assertEquals((await f.request(`${fresh}/open`, open)).status, 409);
        const send = (sequence: number) =>
            JSON.stringify({
                sequence,
                message: {
                    jsonrpc: "2.0",
                    id: 1,
                    method: "tools/call",
                    params: { name: "fixture_echo", arguments: { marker: "once" } },
                },
            });
        assertEquals((await f.request(`${fresh}/send`, send(0))).status, 204);
        await waitForLog(f.log, '"marker":"once"');
        assertEquals((await f.request(`${fresh}/send`, send(0))).status, 409);
        assertEquals((await f.request(`${fresh}/send`, send(2))).status, 409);
        await response?.body?.cancel().catch(() => {});
        assertEquals((await readFile(f.log, "utf8")).split('"marker":"once"').length - 1, 1);
        assertEquals((await f.request(`/mcp/transport/${crypto.randomUUID()}/open`, '{"name":"absent"}')).status, 503);
        f.service.requestShutdown();
        assertEquals((await f.request(`/mcp/transport/${crypto.randomUUID()}/open`, open)).status, 403);
    });
});

test("fresh reconnect rereads personal config, failed startup and errors expose no executable details", async () => {
    await withBridge(async (f) => {
        await f.ready();
        await writeFile(
            join(f.homeDir, ".wld", "mcp.json"),
            JSON.stringify({
                mcpServers: {
                    personal: { command: "missing-secret-TOKEN", args: ["secret-arg"], env: { SECRET: "secret-env" } },
                },
            }),
        );
        const client = new McpClient({ name: "failure", version: "1" });
        const error = await assertRejects(() => client.connect(new RemoteMcpTransport("personal")));
        assertEquals(String(error).includes("secret"), false);
        await writeFile(
            join(f.homeDir, ".wld", "mcp.json"),
            JSON.stringify({ mcpServers: { personal: f.definition } }),
        );
        const recovered = new McpClient({ name: "recovered", version: "1" });
        await recovered.connect(new RemoteMcpTransport("personal"));
        assertStringIncludes(
            JSON.stringify(await recovered.callTool("fixture_echo", { marker: "recovered" })),
            "recovered",
        );
        await recovered.close();
        await writeFile(join(f.homeDir, ".wld", "mcp.json"), '{"mcpServers":{"personal":{"enabled":false}}}');
        const removed = new McpClient({ name: "removed", version: "1" });
        await assertRejects(() => removed.connect(new RemoteMcpTransport("personal")));
        assertEquals((await readFile(f.log, "utf8")).split('"event":"started"').length - 1, 1);
    });
});

test("Pi reconnect recovers a failed personal inventory without a model request", async () => {
    await withBridge(async (f) => {
        await f.ready();
        await writeFile(
            join(f.homeDir, ".wld", "mcp.json"),
            JSON.stringify({ mcpServers: { personal: { command: "missing-secret" } } }),
        );
        const { integration } = await startMcpIntegration({
            cwd: f.projectRoot,
            servers: [personal],
        });
        try {
            assertEquals(integration.getTools(), []);
            assert(integration.bindRoot(), "Failed inventory must retain authorized root binding");
            await writeFile(
                join(f.homeDir, ".wld", "mcp.json"),
                JSON.stringify({ mcpServers: { personal: f.definition } }),
            );
            const notices = await integration.runCommand("reconnect personal");
            assertStringIncludes(JSON.stringify(notices), "personal: laptop");
            assertStringIncludes(
                JSON.stringify(await call(integration.getTools()[0], "after-reconnect")),
                "after-reconnect",
            );
        } finally {
            await integration.close();
        }
    });
});

test("live personal tool additions and withdrawal update the existing Pi inventory", async () => {
    await withBridge(async (f) => {
        await f.ready();
        const toolsPath = join(f.homeDir, "tools.txt");
        await writeFile(toolsPath, "");
        await writeFile(
            join(f.homeDir, ".wld", "mcp.json"),
            JSON.stringify({
                mcpServers: {
                    personal: {
                        ...f.definition,
                        env: { ...f.definition.env, RUNWIELD_MCP_FIXTURE_TOOLS_PATH: toolsPath },
                    },
                },
            }),
        );
        const { integration } = await startMcpIntegration({
            cwd: f.projectRoot,
            servers: [personal],
        });
        try {
            assertEquals(integration.getTools(), []);
            assert(integration.bindRoot());
            await writeFile(toolsPath, "appeared");
            for (let i = 0; i < 100 && !integration.getTools().length; i++)
                await new Promise((resolve) => setTimeout(resolve, 10));
            assertEquals(
                integration.getTools().map((tool) => tool.name),
                ["mcp__personal__appeared"],
            );
            assertStringIncludes(JSON.stringify(await call(integration.getTools()[0], "updated")), "updated");
            await writeFile(toolsPath, "");
            for (let i = 0; i < 100 && integration.getTools().length; i++)
                await new Promise((resolve) => setTimeout(resolve, 10));
            assertEquals(integration.getTools(), []);
        } finally {
            await integration.close();
        }
    });
});

test("close during asynchronous admission cannot spawn a late personal process", async () => {
    await withBridge(async (f) => {
        await f.ready();
        const path = `/mcp/transport/${crypto.randomUUID()}`;
        const open = f.request(`${path}/open`, '{"name":"personal"}').catch(() => null);
        const close = f.request(`${path}/close`);
        const response = await open;
        assertEquals((await close).status, 204);
        await response?.body?.cancel().catch(() => {});
        await f.service.close();
        const log = await readFile(f.log, "utf8").catch(() => "");
        assertEquals(log.split('"event":"started"').length, log.split('"event":"shutdown"').length);
    });
});

test("relay accepts large native messages below 16 MiB and rejects oversized request bodies", async () => {
    await withBridge(async (f) => {
        await f.ready();
        const client = new McpClient({ name: "large", version: "1" });
        await client.connect(new RemoteMcpTransport("personal"));
        try {
            const marker = "x".repeat(15 * 1024 * 1024);
            const output = await client.callTool("fixture_echo", { marker });
            assert(output.content?.[0].type === "text");
            assertEquals(output.content[0].text.length, marker.length + "fixture-result:".length);
            assertEquals(
                (
                    await f.request(
                        `/mcp/transport/${crypto.randomUUID()}/open`,
                        '"' + "x".repeat(17 * 1024 * 1024) + '"',
                    )
                ).status,
                400,
            );
        } finally {
            await client.close();
        }
    });
});

test("a send sequence gap on a live transport closes it without executing the effect", async () => {
    await withBridge(async (f) => {
        await f.ready();
        const path = `/mcp/transport/${crypto.randomUUID()}`;
        const response = await f.request(`${path}/open`, '{"name":"personal"}');
        assertEquals(
            (
                await f.request(
                    `${path}/send`,
                    JSON.stringify({
                        sequence: 1,
                        message: {
                            jsonrpc: "2.0",
                            id: 1,
                            method: "tools/call",
                            params: { name: "fixture_echo", arguments: { marker: "gap" } },
                        },
                    }),
                )
            ).status,
            409,
        );
        await response.body?.cancel().catch(() => {});
        await f.service.close();
        assertEquals((await readFile(f.log, "utf8").catch(() => "")).includes('"event":"call"'), false);
    });
});

test("an unread output stream overflows its bound and stops the laptop process", async () => {
    await withBridge(async (f) => {
        await f.ready();
        const path = `/mcp/transport/${crypto.randomUUID()}`;
        const response = await f.request(`${path}/open`, '{"name":"personal"}');
        await f.request(
            `${path}/send`,
            JSON.stringify({
                sequence: 0,
                message: {
                    jsonrpc: "2.0",
                    id: 1,
                    method: "tools/call",
                    params: { name: "fixture_echo", arguments: { marker: "flood" } },
                },
            }),
        );
        await waitForLog(f.log, '"event":"shutdown"');
        assertEquals(
            (
                await f.request(
                    `${path}/send`,
                    JSON.stringify({ sequence: 1, message: { jsonrpc: "2.0", id: 2, method: "tools/list" } }),
                )
            ).status,
            409,
        );
        await response.body?.cancel().catch(() => {});
    });
});

test("blocked laptop stdin cannot accumulate unbounded admitted sends", async () => {
    await withBridge(
        async (f) => {
            const bridge = new LaptopMcpBridge();
            const path = `http://127.0.0.1/mcp/transport/${crypto.randomUUID()}`;
            const request = (action: string, body: string) =>
                bridge.handle(new Request(`${path}/${action}`, { method: "POST", body }), () => true);
            try {
                const response = await request("open", '{"name":"personal"}');
                await waitForLog(f.log, '"event":"started"');
                const message = {
                    jsonrpc: "2.0",
                    method: "fixture/input",
                    params: { text: "x".repeat(15 * 1024 * 1024) },
                };
                const sends: Promise<Response>[] = [];
                for (const sequence of [0, 1, 2]) {
                    sends.push(request("send", JSON.stringify({ sequence, message })));
                    // Drain immediate body-read microtasks before admitting the next message, without awaiting blocked stdin.
                    await new Promise<void>((resolve) => setImmediate(resolve));
                }
                assertEquals(await Promise.all(sends.map(async (send) => (await send).status)), [503, 503, 503]);
                await waitForLog(f.log, '"event":"shutdown"');
                await response.body?.cancel().catch(() => {});
            } finally {
                await bridge.close();
            }
        },
        { RUNWIELD_MCP_FIXTURE_BLOCK_STDIN: "1" },
    );
});

test("closing a connecting protocol lifetime awaits the already-started process without dispatch", async () => {
    await withBridge(
        async (f) => {
            await f.ready();
            const transport = new RemoteMcpTransport("personal");
            const client = new McpClient({ name: "startup-abort", version: "1" });
            const connecting = client.connect(transport);
            const rejected = assertRejects(() => connecting);
            await waitForLog(f.log, '"event":"started"');
            await transport.close();
            await rejected;
            const log = await waitForLog(f.log, '"event":"shutdown"');
            assertEquals(log.includes('"event":"call"'), false);
            const started: { pid: number } = JSON.parse(log.split("\n")[0]);
            let alive = false;
            try {
                process.kill(started.pid, 0);
                alive = true;
            } catch {
                /* Owned process has exited. */
            }
            assertEquals(alive, false);
        },
        { RUNWIELD_MCP_FIXTURE_BLOCK_STDIN: "1" },
    );
});

test("Pi owns normalized-name collisions across personal and project origins", async () => {
    await withBridge(async (f) => {
        await f.ready();
        await writeFile(
            join(f.homeDir, ".wld/mcp.json"),
            JSON.stringify({ mcpServers: { "same-name": f.definition } }),
        );
        const { integration } = await startMcpIntegration({
            cwd: f.projectRoot,
            servers: [
                { ...personal, name: "same-name" },
                { ...f.definition, name: "same_name", source: "project", location: "remote" },
            ],
        });
        try {
            const tools = integration.getTools();
            assertEquals(tools.length, 2);
            assertEquals(new Set(tools.map((tool) => tool.name)).size, 2);
            for (const tool of tools)
                assertStringIncludes(JSON.stringify(await call(tool, "collision")), "fixture-result:collision");
        } finally {
            await integration.close();
        }
    });
});

test("health expiry revokes active calls and final close awaits every laptop PID", async () => {
    await withBridge(
        async (f) => {
            await f.ready();
            const client = new McpClient({ name: "health", version: "1" });
            await client.connect(new RemoteMcpTransport("personal"));
            const pending = client.callTool("fixture_echo", { marker: "cooperative-slow" });
            const rejected = assertRejects(() => pending);
            await waitForLog(f.log, '"event":"call"');
            const deadline = Date.now() + 20000;
            while (!f.service.status().shutdown && Date.now() < deadline)
                await new Promise((resolve) => setTimeout(resolve, 20));
            assertEquals(f.service.status().shutdown, true);
            await rejected;
            await Promise.all([f.service.close(), f.service.close()]);
            const log = await readFile(f.log, "utf8");
            assertEquals(log.includes('"event":"shutdown"'), true);
            assertEquals(log.includes("delayed-effect"), false);
            await client.close();
        },
        { RUNWIELD_MCP_FIXTURE_DELAY_MS: "30000" },
    );
});
