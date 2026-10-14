import { getCwd } from "../../constants.js";
import type { JsonMap } from "./config.ts";

interface FixtureRequestMeta {
    progressToken?: string | number;
}

interface FixtureRequestParams {
    name?: string;
    arguments?: Record<string, string>;
    cursor?: string;
    _meta?: FixtureRequestMeta;
}

interface FixtureRequest {
    id?: string | number;
    method?: string;
    params?: FixtureRequestParams;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function getLogPath(): string {
    return Deno.env.get("RUNWIELD_MCP_FIXTURE_LOG") || "";
}

async function log(entry: Record<string, string | number | boolean | string[]>): Promise<void> {
    const logPath = getLogPath();
    if (!logPath) return;
    await Deno.writeTextFile(logPath, `${JSON.stringify(entry)}\n`, { append: true, create: true });
}

function logSync(entry: Record<string, string | number | boolean | string[]>): void {
    const logPath = getLogPath();
    if (!logPath) return;
    Deno.writeTextFileSync(logPath, `${JSON.stringify(entry)}\n`, { append: true, create: true });
}

function send(message: JsonMap): void {
    Deno.stdout.writeSync(encoder.encode(`${JSON.stringify(message)}\n`));
}

function fixtureShouldListError(): boolean {
    return Deno.env.get("RUNWIELD_MCP_FIXTURE_LIST_ERROR") === "1";
}

function fixtureShouldInitError(): boolean {
    const path = Deno.env.get("RUNWIELD_MCP_FIXTURE_INIT_ERROR_PATH");
    return Deno.env.get("RUNWIELD_MCP_FIXTURE_INIT_ERROR") === "1" ||
        (path !== undefined && Deno.readTextFileSync(path) === "1");
}

function fixtureHasResources(): boolean {
    return Deno.env.get("RUNWIELD_MCP_FIXTURE_RESOURCES") === "1";
}

function fixtureShouldPaginate(): boolean {
    return Deno.env.get("RUNWIELD_MCP_FIXTURE_PAGINATED") === "1";
}

function fixtureEnvironment(): JsonMap {
    return {
        inherited: Deno.env.get("RUNWIELD_MCP_UNCONFIGURED_SECRET") ?? null,
        configured: Deno.env.get("RUNWIELD_MCP_CONFIGURED_SECRET") ?? null,
    };
}

let changedTools: string | undefined;

// Tests can change the real server's inventory while it has no callable tools.
function watchToolChanges(): void {
    const toolsPath = Deno.env.get("RUNWIELD_MCP_FIXTURE_TOOLS_PATH");
    if (!toolsPath) return;
    let configuredTools = Deno.readTextFileSync(toolsPath);
    changedTools = configuredTools;
    setInterval(() => {
        const next = Deno.readTextFileSync(toolsPath);
        if (next === configuredTools) return;
        configuredTools = next;
        changedTools = next;
        send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }, 20);
}
watchToolChanges();

function fixtureTools(): JsonMap[] {
    const names = (changedTools ?? Deno.env.get("RUNWIELD_MCP_FIXTURE_TOOLS") ?? "fixture_echo")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
    return names.map((name) => ({
        name,
        description: `Fixture tool ${name}.`,
        inputSchema: {
            type: "object",
            properties: { marker: { type: "string" } },
            required: ["marker"],
        },
        annotations: { readOnlyHint: true },
    }));
}

async function runFixtureServer(): Promise<void> {
    let buffer = "";
    await log({ event: "started", pid: Deno.pid, cwd: getCwd() });
    function logShutdown(): void {
        logSync({ event: "shutdown", pid: Deno.pid });
    }
    addEventListener("unload", logShutdown);
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
        Deno.addSignalListener(signal, () => {
            logShutdown();
            Deno.exit(0);
        });
    }

    for await (const chunk of Deno.stdin.readable) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) {
                const message = JSON.parse(line) as FixtureRequest;
                if (message.method === "initialize") {
                    if (fixtureShouldInitError()) {
                        send({
                            jsonrpc: "2.0",
                            id: message.id ?? null,
                            error: { code: -32000, message: "permission denied TOKEN=abc --secret" },
                        });
                    } else {
                        send({
                            jsonrpc: "2.0",
                            id: message.id ?? null,
                            result: {
                                protocolVersion: "2025-06-18",
                                capabilities: {
                                    tools: { listChanged: true },
                                    ...(fixtureHasResources() ? { resources: {} } : {}),
                                },
                                serverInfo: { name: "runwield-fixture", version: "1.0.0" },
                            },
                        });
                    }
                } else if (message.method === "tools/list") {
                    if (fixtureShouldListError()) {
                        send({
                            jsonrpc: "2.0",
                            id: message.id ?? null,
                            error: { code: -32000, message: "raw secret TOKEN=abc --flag" },
                        });
                    } else {
                        const tools = fixtureTools();
                        const paginated = fixtureShouldPaginate();
                        const cursor = message.params?.cursor;
                        await log({ event: "list", cursor: cursor || "" });
                        send({
                            jsonrpc: "2.0",
                            id: message.id ?? null,
                            result: paginated
                                ? cursor
                                    ? { tools: tools.slice(1) }
                                    : { tools: tools.slice(0, 1), nextCursor: "second-page" }
                                : { tools },
                        });
                    }
                } else if (message.method === "resources/list") {
                    send({
                        jsonrpc: "2.0",
                        id: message.id ?? null,
                        result: {
                            resources: [
                                { uri: "fixture://document", name: "document", mimeType: "text/plain" },
                            ],
                        },
                    });
                } else if (message.method === "resources/templates/list") {
                    send({ jsonrpc: "2.0", id: message.id ?? null, result: { resourceTemplates: [] } });
                } else if (message.method === "resources/read") {
                    send({
                        jsonrpc: "2.0",
                        id: message.id ?? null,
                        result: {
                            contents: [
                                { uri: "fixture://document", mimeType: "text/plain", text: "fixture-resource" },
                            ],
                        },
                    });
                } else if (message.method === "tools/call") {
                    const marker = message.params?.arguments?.marker || "";
                    await log({ event: "call", pid: Deno.pid, marker });
                    if (marker === "change-tools") {
                        changedTools = "replacement";
                        send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
                    }
                    if (marker === "slow") await new Promise((resolve) => setTimeout(resolve, 5_000));
                    if (marker === "progress") {
                        const progressToken = message.params?._meta?.progressToken;
                        if (progressToken !== undefined) {
                            send({
                                jsonrpc: "2.0",
                                method: "notifications/progress",
                                params: { progressToken, progress: 1, total: 2, message: "Fixture halfway done." },
                            });
                        }
                        send({
                            jsonrpc: "2.0",
                            id: message.id ?? null,
                            result: { content: [{ type: "text", text: "fixture-result:progress" }] },
                        });
                    } else if (marker === "structured") {
                        send({
                            jsonrpc: "2.0",
                            id: message.id ?? null,
                            result: { content: [], structuredContent: { marker, count: 2 } },
                        });
                    } else if (marker === "error") {
                        send({
                            jsonrpc: "2.0",
                            id: message.id ?? null,
                            result: { content: [{ type: "text", text: "fixture-error" }], isError: true },
                        });
                    } else if (marker === "environment") {
                        send({
                            jsonrpc: "2.0",
                            id: message.id ?? null,
                            result: {
                                content: [{
                                    type: "text",
                                    text: JSON.stringify(fixtureEnvironment()),
                                }],
                            },
                        });
                    } else if (marker === "image-resource") {
                        send({
                            jsonrpc: "2.0",
                            id: message.id ?? null,
                            result: {
                                content: [{
                                    type: "resource",
                                    resource: { uri: "fixture://image", mimeType: "image/png", blob: "aW1hZ2U=" },
                                }],
                            },
                        });
                    } else if (marker === "resource") {
                        send({
                            jsonrpc: "2.0",
                            id: message.id ?? null,
                            result: {
                                content: [{
                                    type: "resource",
                                    resource: {
                                        uri: `file:///${"u".repeat(20_000)}`,
                                        mimeType: "text/plain",
                                        text: "r".repeat(20_000),
                                    },
                                }],
                                isError: false,
                            },
                        });
                    } else if (marker === "resource-link") {
                        send({
                            jsonrpc: "2.0",
                            id: message.id ?? null,
                            result: {
                                content: [{
                                    type: "resource_link",
                                    name: "resource-link",
                                    title: "t".repeat(20_000),
                                    uri: `file:///${"u".repeat(20_000)}`,
                                }],
                                isError: false,
                            },
                        });
                    } else {
                        send({
                            jsonrpc: "2.0",
                            id: message.id ?? null,
                            result: { content: [{ type: "text", text: `fixture-result:${marker}` }], isError: false },
                        });
                    }
                }
            }
            newline = buffer.indexOf("\n");
        }
    }
}
await runFixtureServer();
