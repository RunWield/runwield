import { mkdtemp as fsMkdtemp, readFile as fsReadFile, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertRejects, assertStringIncludes } from "../../../../testing/assertions.ts";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types";
import { createMultiFileEditTool } from "../../../../tools/multi_file_edit.ts";
import { HostedSession } from "../../hosted-session.js";
import { RuntimeEventTypes } from "../../session-runtime-events.js";
import { CLAUDE_CLI_MCP_PROVENANCE, mcpAliasFor, startRunWieldMcpBridge } from "./mcp-bridge.ts";

interface RecordedCall {
    name: string;
    args: Record<string, unknown>;
}

function makeTestTools() {
    const calls: RecordedCall[] = [];
    const planTool = defineTool({
        name: "plan_written",
        label: "Plan Written",
        description: "Declare a plan.",
        parameters: Type.Object({
            planName: Type.String({ description: "Plan filename without extension." }),
        }),
        execute(_toolCallId, params, _signal, onUpdate) {
            calls.push({ name: "plan_written", args: { ...params } });
            onUpdate?.({
                content: [{ type: "text", text: `plan pending for ${params.planName}` }],
                details: { planName: params.planName, reviewUrl: "http://127.0.0.1/review" },
            });
            return Promise.resolve({
                content: [{ type: "text", text: `plan feedback for ${params.planName}` }],
                details: { outcome: "feedback", feedback: "revise" },
                terminate: false,
            });
        },
    });

    let taskInvocations = 0;
    let releaseAccepted: (() => void) | undefined;
    const acceptedGate = new Promise<void>((resolve) => {
        releaseAccepted = resolve;
    });
    const taskTool = defineTool({
        name: "task_completed",
        label: "Task Completed",
        description: "Declare completion.",
        parameters: Type.Object({
            message: Type.String({ description: "Completion report." }),
        }),
        async execute(_toolCallId, params) {
            calls.push({ name: "task_completed", args: { ...params } });
            taskInvocations += 1;
            await acceptedGate;
            return {
                content: [],
                details: { outcome: "task_completed", message: params.message },
                terminate: true,
            };
        },
    });

    const reviewTool = defineTool({
        name: "review_complete",
        label: "Review Complete",
        description: "Declare review verdict.",
        parameters: Type.Object({
            approved: Type.Boolean({ description: "Whether approved." }),
        }),
        execute(_toolCallId, params) {
            calls.push({ name: "review_complete", args: { ...params } });
            return Promise.resolve({
                content: [{ type: "text", text: "review approved" }],
                details: { outcome: "approved", approved: true, feedback: "", findings: [], advisories: [] },
                terminate: true,
            });
        },
    });

    return {
        calls,
        taskInvocations: () => taskInvocations,
        releaseAccepted: () => releaseAccepted?.(),
        acceptedGate,
        tools: [planTool, taskTool, reviewTool],
    };
}

interface BridgeTestContext {
    manager: SessionManager;
    bridge: Awaited<ReturnType<typeof startRunWieldMcpBridge>>;
    client: Client;
    transport: StreamableHTTPClientTransport;
    mirrored: unknown[];
    runtimeEvents: Array<Record<string, unknown>>;
}

async function withBridge(
    tools: ToolDefinition[],
    callback: (context: BridgeTestContext) => Promise<void>,
): Promise<void> {
    await withBridgeWithSignal(tools, undefined, callback);
}

async function withBridgeWithSignal(
    tools: ToolDefinition[],
    signal: AbortSignal | undefined,
    callback: (context: BridgeTestContext) => Promise<void>,
): Promise<void> {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-mcp-bridge-"));
    const manager = SessionManager.inMemory(cwd);
    const mirrored: unknown[] = [];
    const runtimeEvents: Array<Record<string, unknown>> = [];
    const hostedSession = new HostedSession({
        id: crypto.randomUUID(),
        cwd,
        eventSink: (event: Record<string, unknown>) => runtimeEvents.push(event),
    });
    const bridge = await startRunWieldMcpBridge({
        tools,
        cwd,
        hostedSession,
        sessionManager: manager,
        onMessage: (message) => {
            mirrored.push(message);
        },
        signal,
        assistantBase: { api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet" },
        provenance: CLAUDE_CLI_MCP_PROVENANCE,
    });
    const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
        requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
    });
    const client = new Client({ name: "runwield-bridge-test", version: "1.0.0" });
    try {
        await client.connect(transport);
        await callback({ manager, bridge, client, transport, mirrored, runtimeEvents });
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
    return context.manager.getBranch()
        .filter((entry) => entry.type === "message")
        .map((entry) => (entry as { message?: unknown }).message);
}

test("workflow MCP bridge lists only the eligible prefixed aliases with preserved schemas", async () => {
    await withBridge(makeTestTools().tools, async (context) => {
        const listed = await context.client.listTools();
        const names = listed.tools.map((tool) => tool.name);
        assertEquals(names, ["runwield_plan_written", "runwield_task_completed", "runwield_review_complete"]);
        const taskTool = listed.tools.find((tool) => tool.name === "runwield_task_completed");
        assertEquals(taskTool?.inputSchema.type, "object");
        assertEquals(
            (taskTool?.inputSchema.properties as Record<string, unknown> | undefined)?.message !== undefined,
            true,
        );
        assertEquals(taskTool?.inputSchema.required, ["message"]);
    });
});

test("workflow MCP bridge rejects requests without the Bearer token before protocol dispatch", async () => {
    await withBridge(makeTestTools().tools, async (context) => {
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
    const tools = makeTestTools();
    await withBridge(tools.tools, async (context) => {
        const rejected = await context.client.callTool({
            name: "runwield_task_completed",
            arguments: {},
        });
        assertEquals(rejected.isError, true);
        assertStringIncludes(resultText(rejected as never), "rejected");

        const messages = recordedMessages(context);
        const toolCalls = messages.filter((msg) =>
            (msg as { role?: string }).role === "assistant" &&
            (msg as { content?: Array<{ type?: string }> }).content?.some((block) => block.type === "toolCall")
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
        assertEquals(tools.taskInvocations(), 0);
    });
});

test("workflow MCP bridge emits live Runtime tool events for delegated plan_written updates", async () => {
    await withBridge(makeTestTools().tools, async (context) => {
        const result = await context.client.callTool({
            name: "runwield_plan_written",
            arguments: { planName: "runtime-boundary" },
        });
        assertEquals(result.isError, false);

        const toolEvents = context.runtimeEvents.filter((event) =>
            event.type === RuntimeEventTypes.TOOL_START ||
            event.type === RuntimeEventTypes.TOOL_UPDATE ||
            event.type === RuntimeEventTypes.TOOL_END
        );
        assertEquals(toolEvents.map((event) => event.type), [
            RuntimeEventTypes.TOOL_START,
            RuntimeEventTypes.TOOL_UPDATE,
            RuntimeEventTypes.TOOL_END,
        ]);
        assertEquals(toolEvents[0].toolName, "plan_written");
        assertEquals(toolEvents[0].title, "plan_written docs/plans/runtime-boundary.md");
        assertEquals(toolEvents[1].output, "plan pending for runtime-boundary");
        assertEquals(
            (toolEvents[1].details as Record<string, unknown> | null)?.reviewUrl,
            "http://127.0.0.1/review",
        );
        assertEquals(toolEvents[2].output, "plan feedback for runtime-boundary");
    });
});

test("workflow MCP bridge accepts a delegated result, stamps provenance, and atomically closes the gate", async () => {
    const tools = makeTestTools();
    tools.releaseAccepted();
    await withBridge(tools.tools, async (context) => {
        const accepted = await context.client.callTool({
            name: "runwield_task_completed",
            arguments: { message: "all done" },
        });
        assertEquals(accepted.isError, false);
        assertEquals(tools.taskInvocations(), 1);

        const messages = recordedMessages(context);
        const results = messages.filter((msg) =>
            (msg as { role?: string }).role === "toolResult" &&
            (msg as { toolName?: string }).toolName === "task_completed"
        );
        assertEquals(results.length, 1);
        const details = (results[0] as { details?: Record<string, unknown> }).details;
        assertEquals(details?.outcome, "task_completed");
        assertEquals(details?.message, "all done");
        assertEquals(details?.provenance, CLAUDE_CLI_MCP_PROVENANCE);
        const assistantMsg = messages.find((msg) =>
            (msg as { role?: string }).role === "assistant" &&
            (msg as { content?: Array<{ type?: string; name?: string }> }).content?.some(
                (block) => block.type === "toolCall" && block.name === "task_completed",
            )
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
        assertEquals(tools.taskInvocations(), 1);
    });
});

test("workflow MCP bridge serializes concurrent calls so only the first terminal result wins", async () => {
    const tools = makeTestTools();
    await withBridge(tools.tools, async (context) => {
        const first = context.client.callTool({
            name: "runwield_task_completed",
            arguments: { message: "first" },
        });
        const second = context.client.callTool({
            name: "runwield_task_completed",
            arguments: { message: "second" },
        });
        tools.releaseAccepted();
        const [firstResult, secondResult] = await Promise.all([first, second]);
        assertEquals(firstResult.isError, false);
        assertEquals(secondResult.isError, true);
        // Serialization + gate: exactly one invocation reached the tool.
        assertEquals(tools.taskInvocations(), 1);
        const results = recordedMessages(context).filter((msg) =>
            (msg as { role?: string }).role === "toolResult" &&
            (msg as { toolName?: string }).toolName === "task_completed"
        );
        assertEquals(results.length, 2);
    });
});

test("workflow MCP bridge rejects an unknown tool and closes the listener deterministically", async () => {
    await withBridge(makeTestTools().tools, async (context) => {
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

test("mcpAliasFor keeps lifecycle aliases and leaves capability names unchanged", () => {
    assertEquals(mcpAliasFor("task_completed"), "runwield_task_completed");
    assertEquals(mcpAliasFor("review_diff"), "review_diff");
});

test("RunWield MCP bridge lists capability aliases and exposes timeout config", async () => {
    const capability = defineTool({
        name: "memory_recall",
        label: "Memory Recall",
        description: "Recall memory.",
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
        assertEquals(listed.tools.map((tool) => tool.name), ["memory_recall"]);
        assertEquals(context.bridge.advertisedToolNames, ["memory_recall"]);
        const config = JSON.parse(context.bridge.config) as { mcpServers: { runwield: { timeout: number } } };
        assertEquals(config.mcpServers.runwield.timeout, 24 * 60 * 60 * 1000);
        const result = await context.client.callTool({ name: "memory_recall", arguments: { query: "plans" } });
        assertStringIncludes(resultText(result as { content: Array<{ type: string; text?: string }> }), "hit plans");
    });
});

test("RunWield MCP bridge rejects duplicate aliases", async () => {
    const toolA = defineTool({
        name: "memory_recall",
        label: "Memory Recall A",
        description: "A.",
        parameters: Type.Object({}),
        execute() {
            return Promise.resolve({ content: [], details: {} });
        },
    });
    const toolB = defineTool({
        name: "memory_recall",
        label: "Memory Recall B",
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
    const checkpoint = defineTool({
        name: "pair_checkpoint",
        label: "Pair Checkpoint",
        description: "Report a checkpoint.",
        parameters: Type.Object({ action: Type.Literal("report"), summary: Type.String() }),
        execute() {
            return Promise.resolve({
                content: [{ type: "text" as const, text: "Checkpoint ready." }],
                details: { outcome: "reported" },
                terminate: true,
            });
        },
    });
    await withBridge([checkpoint], async (context) => {
        const listed = await context.client.listTools();
        assertEquals(listed.tools.map((tool) => tool.name), ["pair_checkpoint"]);
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
    });
});

test("RunWield MCP bridge lets capabilities run after a terminal lifecycle result", async () => {
    const lifecycle = defineTool({
        name: "task_completed",
        label: "Task Completed",
        description: "Done.",
        parameters: Type.Object({ message: Type.String() }),
        execute() {
            return Promise.resolve({ content: [], details: { outcome: "task_completed" }, terminate: true });
        },
    });
    const capability = defineTool({
        name: "memory_recall",
        label: "Memory Recall",
        description: "Recall memory.",
        parameters: Type.Object({ query: Type.String() }),
        execute(_toolCallId, params) {
            return Promise.resolve({
                content: [{ type: "text" as const, text: `hit ${params.query}` }],
                details: params,
            });
        },
    });
    await withBridge([lifecycle, capability], async (context) => {
        await context.client.callTool({ name: "runwield_task_completed", arguments: { message: "done" } });
        const rejected = await context.client.callTool({
            name: "runwield_task_completed",
            arguments: { message: "again" },
        });
        const capabilityResult = await context.client.callTool({
            name: "memory_recall",
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
    });
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
        name: "memory_recall",
        label: "Memory Recall",
        description: "Recall memory.",
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
        const pending = context.client.callTool(
            { name: "memory_recall", arguments: { query: "plans" } },
            undefined,
            { signal: controller.signal, timeout: 5_000 },
        ).catch((error) => error);
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
        name: "memory_recall",
        label: "Memory Recall",
        description: "Recall memory.",
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
        const pending = context.client.callTool({ name: "memory_recall", arguments: { query: "plans" } });
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
    await withBridge(makeTestTools().tools, async (context) => {
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
