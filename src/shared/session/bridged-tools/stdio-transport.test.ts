import { assertEquals } from "../../../testing/assertions.ts";
import { fileURLToPath } from "node:url";
import { spawnForegroundProcess } from "../../foreground-process.ts";
import { runtimeSourceArgs } from "../../../testing/runtime-source-args.ts";
import process from "node:process";
import { mkdtemp as fsMkdtemp, rm as fsRm, stat as fsStat, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Type } from "typebox";
import { defineTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";
import { getCwd } from "../../../constants.js";
import { AGY_CLI_MCP_PROVENANCE, startRunWieldMcpBridge } from "./mcp-bridge.ts";
import { RUNWIELD_MCP_BRIDGE_TOKEN_ENV, RUNWIELD_MCP_BRIDGE_URL_ENV } from "./stdio-transport.ts";

test("Agy stdio review calls survive sixty elapsed seconds and preserve structured output", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-stdio-long-review-"));
    const advancePath = `${cwd}/advance`;
    const advancedPath = `${cwd}/advanced`;
    const started = Promise.withResolvers<void>();
    const decision = Promise.withResolvers<void>();
    let cancelled = false;
    const outputSchema = Type.Object({ approved: Type.Boolean() });
    const tool = defineTool({
        name: "fixture_review",
        label: "Fixture Review",
        description: "Wait for an external review service.",
        parameters: Type.Object({}),
        outputSchema,
        async execute(_id, _params, signal) {
            signal?.addEventListener("abort", () => (cancelled = true), { once: true });
            started.resolve();
            await decision.promise;
            return {
                content: [{ type: "text", text: "approved" }],
                details: {},
                structuredContent: { approved: true },
            };
        },
    });
    const bridge = await startRunWieldMcpBridge({
        tools: [tool],
        cwd,
        sessionManager: SessionManager.inMemory(cwd),
        assistantBase: { api: "agy-cli", provider: "agy-cli", model: "fixture-model" },
        provenance: AGY_CLI_MCP_PROVENANCE,
    });
    const fixture = fileURLToPath(new URL("./testing/stdio-clock-fixture.ts", import.meta.url));
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["run", ...[], fixture, advancePath, advancedPath],
        env: { [RUNWIELD_MCP_BRIDGE_URL_ENV]: bridge.url, [RUNWIELD_MCP_BRIDGE_TOKEN_ENV]: bridge.token },
        stderr: "pipe",
    });
    const client = new Client({ name: "runwield-stdio-long-review-test", version: "1.0.0" });
    try {
        await client.connect(transport);
        assertEquals((await client.listTools()).tools[0].outputSchema, JSON.parse(JSON.stringify(outputSchema)));
        const pending = client.callTool({ name: "fixture_review", arguments: {} });
        // Attach the rejection handler immediately so a regressed timeout is a test failure.
        const settled = pending.then(
            (result) => ({ result }),
            (error: Error) => ({ error }),
        );
        await started.promise;
        await fsWriteFile(advancePath, "advance");
        const deadline = Date.now() + 5_000;
        let advanced = false;
        while (!advanced && Date.now() < deadline) {
            advanced = await fsStat(advancedPath).then(
                () => true,
                () => false,
            );
            if (!advanced) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assertEquals(advanced, true);
        decision.resolve();
        const outcome = await settled;
        if ("error" in outcome) throw outcome.error;
        assertEquals(outcome.result.structuredContent, { approved: true });
        assertEquals(cancelled, false);
    } finally {
        decision.resolve();
        await client.close();
        await transport.close();
        await bridge.close();
        await fsRm(cwd, { recursive: true });
    }
});

test("stdio EOF releases the upstream bridge and exits without a host termination signal", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-stdio-eof-"));
    const bridge = await startRunWieldMcpBridge({
        tools: [
            defineTool({
                name: "fixture_echo",
                label: "Echo",
                description: "External fixture",
                parameters: Type.Object({}),
                execute: () => Promise.resolve({ content: [{ type: "text", text: "echo" }], details: {} }),
            }),
        ],
        cwd,
        sessionManager: SessionManager.inMemory(cwd),
        assistantBase: { api: "agy-cli", provider: "agy-cli", model: "fixture-model" },
        provenance: AGY_CLI_MCP_PROVENANCE,
    });
    const child = spawnForegroundProcess({
        command: process.execPath,
        args: runtimeSourceArgs([
            "run",
            "-A",
            "--unstable-no-legacy-abort",
            `${getCwd()}/src/cli.ts`,
            "mcp",
            "agy-cli",
        ]),
        cwd: getCwd(),
        stdin: "piped",
        timeoutMs: 10_000,
        env: { [RUNWIELD_MCP_BRIDGE_URL_ENV]: bridge.url, [RUNWIELD_MCP_BRIDGE_TOKEN_ENV]: bridge.token },
    });
    const writer = child.stdin!.getWriter();
    const reader = child.stdout.getReader();
    const stderr = new Response(child.stderr).text();
    try {
        await writer.write(
            new TextEncoder().encode(
                JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "initialize",
                    params: {
                        protocolVersion: "2024-11-05",
                        capabilities: {},
                        clientInfo: { name: "eof-regression", version: "1" },
                    },
                }) + "\n",
            ),
        );
        let response = "";
        while (!response.includes("\n")) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error(`Bridge exited before initialization: ${await stderr}`);
            response += new TextDecoder().decode(chunk.value);
        }
        assertEquals(JSON.parse(response.split("\n")[0]).id, 1);
        await writer.close();
        while (!(await reader.read()).done) {
            /* Drain until natural exit. */
        }
        assertEquals(await child.done, { exitCode: 0, terminatedBy: null }, await stderr);
    } finally {
        child.kill();
        reader.releaseLock();
        writer.releaseLock();
        await child.done;
        await bridge.close();
        await fsRm(cwd, { recursive: true });
    }
});
