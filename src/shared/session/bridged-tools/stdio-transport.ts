import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp";
import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types";
import { RUNWIELD_MCP_TOOL_TIMEOUT_MS } from "./tool-timeout.ts";

export const RUNWIELD_MCP_BRIDGE_URL_ENV = "RUNWIELD_MCP_BRIDGE_URL" as const;
export const RUNWIELD_MCP_BRIDGE_TOKEN_ENV = "RUNWIELD_MCP_BRIDGE_TOKEN" as const;

interface BridgeEnv {
    url: URL;
    token: string;
}

function readBridgeEnv(): BridgeEnv {
    const urlText = process.env[RUNWIELD_MCP_BRIDGE_URL_ENV] || "";
    const token = process.env[RUNWIELD_MCP_BRIDGE_TOKEN_ENV] || "";
    if (!urlText || !token) {
        throw new Error("RunWield MCP bridge is not available for this process.");
    }
    let url: URL;
    try {
        url = new URL(urlText);
    } catch {
        throw new Error("RunWield MCP bridge URL is invalid.");
    }
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
        throw new Error("RunWield MCP bridge URL must use plain HTTP on 127.0.0.1.");
    }
    if (!/^\d+$/.test(url.port)) {
        throw new Error("RunWield MCP bridge URL must include a loopback port.");
    }
    return { url, token };
}

export async function runRunWieldMcpStdioTransport(): Promise<void> {
    const bridge = readBridgeEnv();
    const clientTransport = new StreamableHTTPClientTransport(bridge.url, {
        requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
    });
    const client = new Client({ name: "runwield-agy-cli-stdio", version: "1.0.0" });
    const server = new Server({ name: "runwield", version: "1.0.0" }, { capabilities: { tools: {} } });
    const stdio = new StdioServerTransport();
    let closed = false;
    let onStdinEnd: (() => void) | undefined;

    async function close(): Promise<void> {
        if (closed) return;
        closed = true;
        try {
            await stdio.close();
        } catch {
            // The host may already have closed stdio.
        }
        try {
            await server.close();
        } catch {
            // The server can already be closed after stdio EOF.
        }
        try {
            await client.close();
        } catch {
            // Best effort after upstream failure.
        }
        try {
            await clientTransport.close();
        } catch {
            // Best effort after upstream failure.
        }
    }

    server.setRequestHandler(ListToolsRequestSchema, (request, extra) => {
        return client.listTools(request.params, { signal: extra.signal });
    });
    server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
        return client.callTool(request.params, undefined, {
            signal: extra.signal,
            timeout: RUNWIELD_MCP_TOOL_TIMEOUT_MS,
        });
    });
    stdio.onclose = () => {
        close();
    };
    stdio.onerror = () => {
        close();
    };

    try {
        await client.connect(clientTransport);
        await server.connect(stdio);
        await new Promise<void>((resolve) => {
            const closeAndResolve = () => {
                close().finally(resolve);
            };
            stdio.onclose = closeAndResolve;
            stdio.onerror = closeAndResolve;
            client.onclose = closeAndResolve;
            client.onerror = closeAndResolve;
            // The SDK stdio transport does not close itself when the host ends stdin.
            // Close the HTTP/SSE side too, so a disconnected host cannot leave an orphan CLI.
            onStdinEnd = closeAndResolve;
            process.stdin.once("end", onStdinEnd);
            if (process.stdin.readableEnded) closeAndResolve();
        });
    } finally {
        if (onStdinEnd) process.stdin.removeListener("end", onStdinEnd);
        await close();
    }
}
