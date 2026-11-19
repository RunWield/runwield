import { prepareRequestDispatch } from "../../request-dispatch.ts";
import { createTaskCompletedTool } from "../../../../tools/task-completed.ts";
import { createPairCheckpointTool } from "../../../../tools/pair-checkpoint.ts";
import { listPendingWorkflowToolEvents } from "../../../workflow/workflow-tool-events.ts";
import { mkdtemp as fsMkdtemp, readFile as fsReadFile, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertRejects, assertStringIncludes } from "../../../../testing/assertions.ts";
import { Type } from "typebox";
import { defineTool, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types";
import { createMultiFileEditTool } from "../../../../tools/multi_file_edit.ts";
import { HostedSession } from "../../hosted-session.ts";

import { CLAUDE_CLI_MCP_PROVENANCE, startRunWieldMcpBridge } from "./mcp-bridge.ts";

type BridgeTools = ToolDefinition[] | ((session: HostedSession) => ToolDefinition[]);
const completionTools = (session: HostedSession) => [
    createTaskCompletedTool({ hostedSession: session, agentName: "engineer" }),
];

interface BridgeTestContext {
    hostedSession: HostedSession;
    manager: SessionManager;
    bridge: Awaited<ReturnType<typeof startRunWieldMcpBridge>>;
    client: Client;
    transport: StreamableHTTPClientTransport;
    mirrored: unknown[];
    runtimeEvents: Array<Record<string, unknown>>;
}

async function withBridge(tools: BridgeTools, callback: (context: BridgeTestContext) => Promise<void>): Promise<void> {
    await withBridgeWithSignal(tools, undefined, callback);
}

async function withBridgeWithSignal(
    tools: BridgeTools,
    signal: AbortSignal | undefined,
    callback: (context: BridgeTestContext) => Promise<void>,
    readPendingSteering?: () => string[],
): Promise<void> {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-mcp-bridge-"));
    const manager = SessionManager.inMemory(cwd);
    const mirrored: unknown[] = [];
    const runtimeEvents: Array<Record<string, unknown>> = [];
    const hostedSession = new HostedSession({
        id: crypto.randomUUID(),
        cwd,
        sessionManager: manager,
        eventSink: (event: Record<string, unknown>) => runtimeEvents.push(event),
    });
    const bridge = await startRunWieldMcpBridge({
        tools: typeof tools === "function" ? tools(hostedSession) : tools,
        cwd,
        hostedSession,
        sessionManager: manager,
        onMessage: (message) => {
            mirrored.push(message);
        },
        signal,
        readPendingSteering,
        assistantBase: { api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet" },
        provenance: CLAUDE_CLI_MCP_PROVENANCE,
    });
    const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
        requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
    });
    const client = new Client({ name: "runwield-bridge-test", version: "1.0.0" });
    try {
        await client.connect(transport);
        await callback({ manager, bridge, client, transport, mirrored, runtimeEvents, hostedSession });
    } finally {
        try {
            await client.close();
        } catch {
            // best effort
        }
        try {
            await transport.close();
        } catch {
            // best effort
        }
        await bridge.close();
        await fsRm(cwd, { recursive: true }).catch(() => undefined);
    }
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
    return result.content.map((block) => (block.type === "text" ? block.text || "" : "")).join(" ");
}

function recordedMessages(context: BridgeTestContext): unknown[] {
    return context.manager
        .getBranch()
        .filter((entry) => entry.type === "message")
        .map((entry) => (entry as { message?: unknown }).message);
}

test("workflow MCP bridge rejects requests without the Bearer token before protocol dispatch", async () => {
    await withBridge(completionTools, async (context) => {
        const noAuth = await fetch(context.bridge.url, { method: "POST", body: "{}" });
        assertEquals(noAuth.status, 401);
        const wrongAuth = await fetch(context.bridge.url, {
            method: "POST",
            headers: { Authorization: "Bearer wrong" },
            body: "{}",
        });
        assertEquals(wrongAuth.status, 401);
        assertEquals(context.bridge.token.length >= 32, true);
    });
});

test("workflow MCP bridge records canonical messages, provenance, and a rejected call without advancement", async () => {
    await withBridge(completionTools, async (context) => {
        const rejected = await context.client.callTool({
            name: "runwield_task_completed",
            arguments: {},
        });
        assertEquals(rejected.isError, true);
        assertStringIncludes(resultText(rejected as never), "rejected");

        const messages = recordedMessages(context);
        const toolCalls = messages.filter(
            (msg) =>
                (msg as { role?: string }).role === "assistant" &&
                (msg as { content?: Array<{ type?: string }> }).content?.some((block) => block.type === "toolCall"),
        );
        const toolResults = messages.filter((msg) => (msg as { role?: string }).role === "toolResult");
        assertEquals(toolCalls.length, 1);
        assertEquals(toolResults.length, 1);
        const callBlock = (toolCalls[0] as { content: Array<{ name?: string; arguments?: unknown }> }).content[0];
        assertEquals(callBlock.name, "task_completed");
        const result = toolResults[0] as { toolName?: string; isError?: boolean; details?: Record<string, unknown> };
        assertEquals(result.toolName, "task_completed");
        assertEquals(result.isError, true);
        assertEquals("outcome" in (result.details || {}), false);
        assertEquals(result.details?.provenance, CLAUDE_CLI_MCP_PROVENANCE);
        assertEquals(listPendingWorkflowToolEvents(context.hostedSession).length, 0);
    });
});

test("workflow MCP bridge accepts a delegated result, stamps provenance, and atomically closes the gate", async () => {
    await withBridge(completionTools, async (context) => {
        const accepted = await context.client.callTool({
            name: "runwield_task_completed",
            arguments: { message: "all done" },
        });
        assertEquals(accepted.isError, false);
        assertEquals(listPendingWorkflowToolEvents(context.hostedSession).length, 1);

        const messages = recordedMessages(context);
        const results = messages.filter(
            (msg) =>
                (msg as { role?: string }).role === "toolResult" &&
                (msg as { toolName?: string }).toolName === "task_completed",
        );
        assertEquals(results.length, 1);
        const details = (results[0] as { details?: Record<string, unknown> }).details;
        assertEquals(details?.outcome, "task_completed");
        assertEquals(details?.message, "all done");
        assertEquals(details?.provenance, CLAUDE_CLI_MCP_PROVENANCE);
        const assistantMsg = messages.find(
            (msg) =>
                (msg as { role?: string }).role === "assistant" &&
                (msg as { content?: Array<{ type?: string; name?: string }> }).content?.some(
                    (block) => block.type === "toolCall" && block.name === "task_completed",
                ),
        );
        assertEquals(assistantMsg !== undefined, true);
        assertEquals(context.mirrored.length, 2);

        // Gate is closed: later calls are rejected without invoking the tool again.
        const after = await context.client.callTool({
            name: "runwield_task_completed",
            arguments: { message: "second attempt" },
        });
        assertEquals(after.isError, true);
        assertStringIncludes(resultText(after as never), "gate");
        assertEquals(listPendingWorkflowToolEvents(context.hostedSession).length, 1);
    });
});

test("workflow MCP bridge serializes concurrent calls so only the first terminal result wins", async () => {
    await withBridge(completionTools, async (context) => {
        const first = context.client.callTool({
            name: "runwield_task_completed",
            arguments: { message: "first" },
        });
        const second = context.client.callTool({
            name: "runwield_task_completed",
            arguments: { message: "second" },
        });
        const [firstResult, secondResult] = await Promise.all([first, second]);
        assertEquals(firstResult.isError, false);
        assertEquals(secondResult.isError, true);
        // Serialization + gate: exactly one invocation reached the tool.
        assertEquals(listPendingWorkflowToolEvents(context.hostedSession).length, 1);
        const results = recordedMessages(context).filter(
            (msg) =>
                (msg as { role?: string }).role === "toolResult" &&
                (msg as { toolName?: string }).toolName === "task_completed",
        );
        assertEquals(results.length, 2);
    });
});

test("workflow MCP bridge rejects an unknown tool and closes the listener deterministically", async () => {
    await withBridge(completionTools, async (context) => {
        const error = await assertRejects(
            () =>
                context.client.callTool({
                    name: "runwield_bash",
                    arguments: {},
                }),
            McpError,
            "Unknown tool",
        );
        if (!("code" in error)) throw error;
        assertEquals(error.code, ErrorCode.InvalidParams);
        assertEquals(recordedMessages(context), []);

        const url = context.bridge.url;
        await context.client.close();
        await context.transport.close();
        await context.bridge.close();
        assertEquals(context.bridge.closed, true);
        await context.bridge.close(); // idempotent
        await assertRejects(() => fetch(url), TypeError);
    });
});

test("RunWield MCP bridge lists capability aliases and exposes timeout config", async () => {
    const capability = defineTool({
        name: "fixture_echo",
        label: "Fixture Echo",
        description: "External echo service.",
        parameters: Type.Object({ query: Type.String() }),
        execute(_toolCallId, params) {
            return Promise.resolve({
                content: [{ type: "text" as const, text: `hit ${params.query}` }],
                details: params,
            });
        },
    });
    await withBridge([capability], async (context) => {
        const listed = await context.client.listTools();
        assertEquals(
            listed.tools.map((tool) => tool.name),
            ["fixture_echo"],
        );
        assertEquals(context.bridge.advertisedToolNames, ["fixture_echo"]);
        const config = JSON.parse(context.bridge.config) as { mcpServers: { runwield: { timeout: number } } };
        assertEquals(config.mcpServers.runwield.timeout, 24 * 60 * 60 * 1000);
        const result = await context.client.callTool({ name: "fixture_echo", arguments: { query: "plans" } });
        assertStringIncludes(resultText(result as { content: Array<{ type: string; text?: string }> }), "hit plans");
    });
});

test("RunWield MCP bridge rejects duplicate aliases", async () => {
    const toolA = defineTool({
        name: "fixture_echo",
        label: "Fixture Echo A",
        description: "A.",
        parameters: Type.Object({}),
        execute() {
            return Promise.resolve({ content: [], details: {} });
        },
    });
    const toolB = defineTool({
        name: "fixture_echo",
        label: "Fixture Echo B",
        description: "B.",
        parameters: Type.Object({}),
        execute() {
            return Promise.resolve({ content: [], details: {} });
        },
    });
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await assertRejects(
            () =>
                startRunWieldMcpBridge({
                    tools: [toolA, toolB],
                    cwd,
                    sessionManager: SessionManager.inMemory(cwd),
                    assistantBase: { api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet" },
                    provenance: CLAUDE_CLI_MCP_PROVENANCE,
                }),
            Error,
            "duplicate MCP alias",
        );
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => undefined);
    }
});

test("RunWield MCP bridge treats Pair reports as terminal lifecycle calls without changing their name", async () => {
    await withBridge(
        (session) => {
            session.setActiveExecutionWorkflow({
                planName: "pair-bridge",
                triageMeta: {},
                executionAgent: "engineer",
                collaborationStyle: "pair",
            });
            session.beginTurn("pair-turn");
            prepareRequestDispatch(session.getRootSessionManager() as SessionManager, {
                userRequest: "Report progress.",
                dispatchKind: "interactive",
                backend: "claude-cli",
            });
            return [createPairCheckpointTool({ hostedSession: session })];
        },
        async (context) => {
            const listed = await context.client.listTools();
            assertEquals(
                listed.tools.map((tool) => tool.name),
                ["pair_checkpoint"],
            );
            await context.client.callTool({
                name: "pair_checkpoint",
                arguments: { action: "report", summary: "Ready." },
            });
            assertEquals(context.bridge.acceptedTerminal, true);
            const repeated = await context.client.callTool({
                name: "pair_checkpoint",
                arguments: { action: "report", summary: "Again." },
            });
            assertStringIncludes(
                resultText(repeated as { content: Array<{ type: string; text?: string }> }),
                "terminal lifecycle call already closed the gate",
            );
        },
    );
});

test("RunWield MCP bridge lets capabilities run after a terminal lifecycle result", async () => {
    const capability = defineTool({
        name: "fixture_echo",
        label: "Fixture Echo",
        description: "External echo service.",
        parameters: Type.Object({ query: Type.String() }),
        execute(_toolCallId, params) {
            return Promise.resolve({
                content: [{ type: "text" as const, text: `hit ${params.query}` }],
                details: params,
            });
        },
    });
    await withBridge(
        (session) => [...completionTools(session), capability],
        async (context) => {
            await context.client.callTool({ name: "runwield_task_completed", arguments: { message: "done" } });
            const rejected = await context.client.callTool({
                name: "runwield_task_completed",
                arguments: { message: "again" },
            });
            const capabilityResult = await context.client.callTool({
                name: "fixture_echo",
                arguments: { query: "plans" },
            });
            assertStringIncludes(
                resultText(rejected as { content: Array<{ type: string; text?: string }> }),
                "runwield lifecycle call rejected",
            );
            assertStringIncludes(
                resultText(capabilityResult as { content: Array<{ type: string; text?: string }> }),
                "hit plans",
            );
        },
    );
});

test("RunWield MCP bridge passes MCP request cancellation to a running bridged tool", async () => {
    let started: (() => void) | null = null;
    let observedAbort: (() => void) | null = null;
    const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
    });
    const abortedPromise = new Promise<void>((resolve) => {
        observedAbort = resolve;
    });
    const capability = defineTool({
        name: "fixture_echo",
        label: "Fixture Echo",
        description: "External echo service.",
        parameters: Type.Object({ query: Type.String() }),
        async execute(_toolCallId, _params, signal, _onUpdate, context) {
            const activeSignal = signal || context.signal;
            activeSignal?.addEventListener("abort", () => observedAbort?.(), { once: true });
            started?.();
            await abortedPromise;
            return { content: [{ type: "text" as const, text: "aborted" }], details: {} };
        },
    });
    await withBridge([capability], async (context) => {
        const controller = new AbortController();
        const pending = context.client
            .callTool({ name: "fixture_echo", arguments: { query: "plans" } }, undefined, {
                signal: controller.signal,
                timeout: 5_000,
            })
            .catch((error) => error);
        await startedPromise;
        controller.abort();
        await abortedPromise;
        await pending;
    });
});

test("RunWield MCP bridge passes abort signal to a running bridged tool", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    let observedSignal: AbortSignal | null = null;
    let release: (() => void) | null = null;
    const wait = new Promise<void>((resolve) => {
        release = resolve;
    });
    const capability = defineTool({
        name: "fixture_echo",
        label: "Fixture Echo",
        description: "External echo service.",
        parameters: Type.Object({ query: Type.String() }),
        async execute(_toolCallId, _params, signal, _onUpdate, context) {
            observedSignal = signal || context.signal || null;
            started.resolve();
            await wait;
            return {
                content: [{ type: "text" as const, text: observedSignal?.aborted ? "aborted" : "active" }],
                details: {},
            };
        },
    });
    await withBridgeWithSignal([capability], controller.signal, async (context) => {
        const pending = context.client.callTool({ name: "fixture_echo", arguments: { query: "plans" } });
        await started.promise;
        controller.abort();
        release?.();
        const result = await pending;
        assertStringIncludes(resultText(result as { content: Array<{ type: string; text?: string }> }), "aborted");
    });
});

test("RunWield MCP bridge preserves structured results and output schemas", async () => {
    const schema = Type.Object({ count: Type.Number() });
    const tool = defineTool({
        name: "structured",
        label: "Structured",
        description: "Return structured output.",
        parameters: Type.Object({}),
        outputSchema: schema,
        execute() {
            return Promise.resolve({
                content: [{ type: "text", text: "count: 2" }],
                details: {},
                structuredContent: { count: 2 },
            });
        },
    });
    await withBridge([tool], async (context) => {
        assertEquals((await context.client.listTools()).tools[0].outputSchema, JSON.parse(JSON.stringify(schema)));
        const result = await context.client.callTool({ name: "structured", arguments: {} });
        assertEquals(result.structuredContent, { count: 2 });
    });
});

test("RunWield MCP bridge rejects foreign and opaque Origins on every HTTP method", async () => {
    await withBridge(completionTools, async (context) => {
        const headers = {
            Authorization: `Bearer ${context.bridge.token}`,
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
            "Mcp-Session-Id": context.transport.sessionId || "",
        };
        for (const method of ["POST", "GET", "DELETE"]) {
            for (const origin of ["https://untrusted.example", "null", "http://127.0.0.1:1"]) {
                const response = await fetch(context.bridge.url, {
                    method,
                    headers: { ...headers, Origin: origin },
                    ...(method === "POST" ? { body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" }) } : {}),
                });
                assertEquals(response.status, 403);
                await response.body?.cancel();
            }
        }
        const allowed = await fetch(context.bridge.url, {
            method: "POST",
            headers: { ...headers, Origin: context.bridge.url },
            body: JSON.stringify({ jsonrpc: "2.0", id: 100, method: "ping" }),
        });
        assertEquals(allowed.status, 200);
        await allowed.body?.cancel();
        await context.client.ping(); // CLI requests without Origin remain valid.
    });
});

test("RunWield MCP bridge never starts a file edit cancelled while queued", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-cancelled-edit-"));
    const path = `${cwd}/file.txt`;
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = defineTool({
        name: "wait",
        label: "Wait",
        description: "Hold the serialized tool queue.",
        parameters: Type.Object({}),
        async execute() {
            started.resolve();
            await release.promise;
            return { content: [], details: {} };
        },
    });
    try {
        await fsWriteFile(path, "original");
        await withBridge([blocker, createMultiFileEditTool(cwd)], async (context) => {
            const first = context.client.callTool({ name: "wait", arguments: {} });
            await started.promise;
            const headers = {
                Authorization: `Bearer ${context.bridge.token}`,
                Accept: "application/json, text/event-stream",
                "Content-Type": "application/json",
                "Mcp-Session-Id": context.transport.sessionId || "",
            };
            const queued = await fetch(context.bridge.url, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 99,
                    method: "tools/call",
                    params: {
                        name: "multi_file_edit",
                        arguments: { edits: [{ path, oldText: "original", newText: "changed" }] },
                    },
                }),
            });
            try {
                const cancelled = await fetch(context.bridge.url, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        jsonrpc: "2.0",
                        method: "notifications/cancelled",
                        params: { requestId: 99 },
                    }),
                });
                assertEquals(cancelled.status, 202);
                await cancelled.body?.cancel();
                release.resolve();
                await first;
                await context.client.callTool({ name: "wait", arguments: {} }); // Drain the queue.
                assertEquals(await fsReadFile(path, "utf8"), "original");
                assertEquals(recordedMessages(context).length, 4); // Only the two accepted wait calls.
            } finally {
                release.resolve();
                await queued.body?.cancel();
                await first;
            }
        });
    } finally {
        release.resolve();
        await fsRm(cwd, { recursive: true });
    }
});

type BudgetJson = string | number | boolean | null | BudgetJson[] | BudgetArgs;
interface BudgetArgs {
    [key: string]: BudgetJson;
}

function nestedBudgetArgs(depth: number): BudgetArgs {
    let value: BudgetArgs = {};
    for (let index = 0; index < depth; index++) value = { child: value };
    return value;
}

const argumentRejections: Array<{ name: string; args: BudgetArgs; reason: string }> = [
    { name: "ASCII bytes", args: { text: "x".repeat(262_144) }, reason: "arguments too large" },
    { name: "UTF-8 bytes", args: { text: "é".repeat(131_067) }, reason: "arguments too large" },
    { name: "scalar elements", args: { edits: Array.from({ length: 4_096 }, () => 0) }, reason: "element limit" },
    {
        name: "empty object elements",
        args: { edits: Array.from({ length: 4_096 }, () => ({})) },
        reason: "element limit",
    },
    { name: "empty array elements", args: { edits: Array.from({ length: 4_096 }, () => []) }, reason: "element limit" },
    {
        name: "object members",
        args: Object.fromEntries(Array.from({ length: 4_097 }, (_, index) => [`key${index}`, {}])),
        reason: "element limit",
    },
    { name: "nesting depth", args: nestedBudgetArgs(17), reason: "nesting depth limit" },
];

for (const scenario of argumentRejections) {
    test(`RunWield MCP bridge rejects excess ${scenario.name} without execution or payload recording and remains usable`, async () => {
        let executions = 0;
        const tool = defineTool({
            name: "budget_echo",
            label: "Budget Echo",
            description: "Accept JSON arguments.",
            parameters: Type.Object({}, { additionalProperties: true }),
            execute() {
                executions++;
                return Promise.resolve({ content: [{ type: "text" as const, text: "accepted" }], details: {} });
            },
        });
        await withBridge([tool], async (context) => {
            const eventsBefore = context.runtimeEvents.length;
            await assertRejects(
                () => context.client.callTool({ name: "budget_echo", arguments: scenario.args }),
                McpError,
                scenario.reason,
            );
            assertEquals(executions, 0);
            assertEquals(recordedMessages(context), []);
            assertEquals(context.mirrored, []);
            assertEquals(context.runtimeEvents.length, eventsBefore);
            const valid = await context.client.callTool({ name: "budget_echo", arguments: { text: "small" } });
            assertEquals(valid.isError, false);
            assertEquals(executions, 1);
        });
    });
}

const argumentBoundaries: Array<{ name: string; args: BudgetArgs }> = [
    { name: "ASCII byte limit", args: { text: "x".repeat(262_144 - 11) } },
    { name: "UTF-8 byte limit", args: { text: "é".repeat(131_066) + "x" } },
    { name: "container element limit", args: { edits: Array.from({ length: 4_095 }, () => ({})) } },
    {
        name: "object member limit",
        args: Object.fromEntries(Array.from({ length: 4_096 }, (_, index) => [`key${index}`, {}])),
    },
    { name: "nesting depth limit", args: nestedBudgetArgs(16) },
];
for (const scenario of argumentBoundaries) {
    test(`RunWield MCP bridge executes arguments at the ${scenario.name}`, async () => {
        let executions = 0;
        const tool = defineTool({
            name: "budget_echo",
            label: "Budget Echo",
            description: "Accept JSON arguments.",
            parameters: Type.Object({}, { additionalProperties: true }),
            execute() {
                executions++;
                return Promise.resolve({ content: [{ type: "text" as const, text: "accepted" }], details: {} });
            },
        });
        await withBridge([tool], async (context) => {
            const result = await context.client.callTool({ name: "budget_echo", arguments: scenario.args });
            assertEquals(result.isError, false);
            assertEquals(executions, 1);
            assertEquals(recordedMessages(context).length, 2);
        });
    });
}

test("RunWield MCP bridge checks argument budgets before the terminal gate can record them", async () => {
    await withBridge(completionTools, async (context) => {
        await context.client.callTool({ name: "runwield_task_completed", arguments: { message: "done" } });
        const eventsBefore = context.runtimeEvents.length;
        await assertRejects(
            () =>
                context.client.callTool({
                    name: "runwield_task_completed",
                    arguments: { message: "x".repeat(262_144) },
                }),
            McpError,
            "arguments too large",
        );
        assertEquals(recordedMessages(context).length, 2);
        assertEquals(context.mirrored.length, 2);
        assertEquals(context.runtimeEvents.length, eventsBefore);
        assertEquals(listPendingWorkflowToolEvents(context.hostedSession).length, 1);
    });
});

for (const streamed of [false, true]) {
    test(`RunWield MCP bridge rejects oversized ${streamed ? "streamed" : "Content-Length"} HTTP bodies before recording and remains usable`, async () => {
        await withBridge(completionTools, async (context) => {
            const bytes = new TextEncoder().encode("x".repeat(1_048_577));
            const body = streamed
                ? new ReadableStream<Uint8Array>({
                      start(controller) {
                          controller.enqueue(bytes.subarray(0, 524_288));
                          controller.enqueue(bytes.subarray(524_288));
                          controller.close();
                      },
                  })
                : bytes;
            const response = await fetch(context.bridge.url, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${context.bridge.token}`,
                    "Content-Type": "application/json",
                },
                body,
            });
            assertEquals(response.status, 413);
            await response.body?.cancel();
            assertEquals(recordedMessages(context), []);
            assertEquals(context.mirrored, []);
            assertEquals(listPendingWorkflowToolEvents(context.hostedSession).length, 0);
            await context.client.ping();
        });
    });
}

test("RunWield MCP bridge accepts HTTP bodies at the request byte limit", async () => {
    await withBridge(completionTools, async (context) => {
        const ping = JSON.stringify({ jsonrpc: "2.0", id: 900, method: "ping" });
        const response = await fetch(context.bridge.url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${context.bridge.token}`,
                Accept: "application/json, text/event-stream",
                "Content-Type": "application/json",
                "Mcp-Session-Id": context.transport.sessionId || "",
            },
            body: ping.padEnd(1_048_576, " "),
        });
        assertEquals(response.status, 200);
        assertStringIncludes(await response.text(), '"result":{}');
        await context.client.ping();
    });
});

test("RunWield MCP bridge preserves authenticated bodyless GET and DELETE dispatch", async () => {
    await withBridge(completionTools, async (context) => {
        const headers = {
            Authorization: `Bearer ${context.bridge.token}`,
            Accept: "text/event-stream",
            "Mcp-Session-Id": context.transport.sessionId || "",
        };
        const response = await fetch(context.bridge.url, { method: "GET", headers });
        // The SDK rejects a duplicate SSE stream if the client already opened one.
        assertEquals([200, 409].includes(response.status), true);
        await response.body?.cancel();
        await context.client.ping();
        const deleted = await fetch(context.bridge.url, { method: "DELETE", headers });
        assertEquals(deleted.status, 200);
        await deleted.body?.cancel();
    });
});

test("RunWield MCP bridge checks argument budgets before pending steering can record them", async () => {
    let steering = ["Read the new user request first."];
    await withBridgeWithSignal(
        completionTools,
        undefined,
        async (context) => {
            const eventsBefore = context.runtimeEvents.length;
            await assertRejects(
                () =>
                    context.client.callTool({
                        name: "runwield_task_completed",
                        arguments: { message: "x".repeat(262_144) },
                    }),
                McpError,
                "arguments too large",
            );
            assertEquals(recordedMessages(context), []);
            assertEquals(context.mirrored, []);
            assertEquals(context.runtimeEvents.length, eventsBefore);
            assertEquals(listPendingWorkflowToolEvents(context.hostedSession).length, 0);
            const pending = await context.client.callTool({
                name: "runwield_task_completed",
                arguments: { message: "done" },
            });
            assertEquals(pending.isError, true);
            assertStringIncludes(resultText(pending as never), "user steering is pending");
            assertEquals(listPendingWorkflowToolEvents(context.hostedSession).length, 0);
            steering = [];
            const valid = await context.client.callTool({
                name: "runwield_task_completed",
                arguments: { message: "done" },
            });
            assertEquals(valid.isError, false);
            assertEquals(listPendingWorkflowToolEvents(context.hostedSession).length, 1);
        },
        () => steering,
    );
});
