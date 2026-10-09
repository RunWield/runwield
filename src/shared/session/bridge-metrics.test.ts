import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { ExecutionMetricsRecorder } from "../workflow/execution-metrics.ts";
import { CLAUDE_CLI_MCP_PROVENANCE, startRunWieldMcpBridge } from "./bridged-tools/mcp-bridge.ts";

test("authenticated bridge records admitted results and known-tool rejections in its execution", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const recorder = new ExecutionMetricsRecorder({ projectRoot, backend: "claude-cli" });
        const tool = defineTool({
            name: "read_fixture",
            label: "Read Fixture",
            description: "Read fixture data",
            parameters: Type.Object({ value: Type.String() }),
            execute: () =>
                Promise.resolve({ content: [{ type: "text" as const, text: "SECRET-RESULT" }], details: {} }),
        });
        const bridge = await startRunWieldMcpBridge({
            tools: [tool],
            cwd: projectRoot,
            sessionManager: SessionManager.inMemory(projectRoot),
            onMessage: (message) => {
                void recorder.recordBridgeMessage(message);
            },
            assistantBase: { api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet" },
            provenance: CLAUDE_CLI_MCP_PROVENANCE,
        });
        const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
            requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
        });
        const client = new Client({ name: "metrics-test", version: "1.0.0" });
        try {
            await client.connect(transport);
            assertEquals(
                (await client.callTool({ name: "read_fixture", arguments: { value: "SECRET-ARG" } })).isError,
                false,
            );
            assertEquals((await client.callTool({ name: "read_fixture", arguments: {} })).isError, true);
            await recorder.settleExecution();
            // Recorder sequence, rather than asynchronous disk append order, defines execution order.
            const records = (await readMetrics()).filter((row) => row.recorderId === recorder.recorderId)
                .sort((a, b) => Number(a.seq) - Number(b.seq));
            assertEquals(records.filter((row) => row.event === "tool_call_started").length, 2);
            assertEquals(records.filter((row) => row.event === "tool_call_finished").map((row) => row.outcome), [
                "success",
                "rejected",
            ]);
            assertEquals(records.find((row) => row.event === "execution_finished")?.callCount, 2);
            assertEquals(
                records.find((row) => row.event === "tool_call_finished" && row.outcome === "success")?.resultBytes,
                new TextEncoder().encode("SECRET-RESULT").byteLength,
            );
            assertEquals(JSON.stringify(records).includes("SECRET-"), false);
        } finally {
            await client.close();
            await bridge.close();
        }
    });
});
