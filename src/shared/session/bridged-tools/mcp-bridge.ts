import { serveHttp } from "../../http-server.ts";
/**
 * @module shared/session/bridged-tools/mcp-bridge
 *
 * Per-turn loopback MCP adapter that exposes the RunWield Bridged Tools
 * eligible for the current external CLI Agent.
 *
 * External CLI backends own their internal read/shell tool loop and RunWield deliberately
 * does not ingest that internal transcript, so lifecycle truth must not come
 * from final prose, sentinel text, or model chatter. This module starts an
 * authenticated loopback MCP server for a supplied set of existing Tool
 * Definitions (the same definitions Pi uses), hides HTTP transport,
 * authorization, JSON-RPC dispatch, tool-result conversion, call
 * serialization, and temporary-file cleanup, and returns host-specific connection data plus a deterministic close operation.
 *
 * Only an accepted delegated result with `terminate: true` may become the
 * turn's terminal workflow signal; after that result the adapter rejects
 * later lifecycle calls without invoking RunWield machinery again. The
 * adapter never examines assistant text.
 */

import {
    type ExtensionToolContext,
    type ExtensionUIContext,
    type SessionManager,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Api, ImageContent, ProviderId, TextContent } from "@earendil-works/pi-ai";
import { validateToolCall } from "@earendil-works/pi-ai";
import { Server } from "@modelcontextprotocol/sdk/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types";
import { RUNWIELD_MCP_TOOL_TIMEOUT_MS } from "./tool-timeout.ts";
import {
    emitHostedSessionRuntimeEvent,
    normalizeRuntimeToolResult,
    RuntimeEventTypes,
} from "../session-runtime-events.js";
import type { HostedSession } from "../hosted-session.js";
import { describeRuntimeTool } from "../tool-event-title.js";

/** Concrete JSON shapes crossing the MCP boundary. */
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
interface JsonObject {
    [key: string]: JsonValue;
}

/** Tool content blocks the bridge forwards to MCP. */
type ToolContentBlock = TextContent | ImageContent;

type ToolContent = ToolContentBlock[];

/** Provenance stamped on every bridge-recorded tool result; not user-settable. */
export const CLAUDE_CLI_MCP_PROVENANCE = "claude-cli-mcp" as const;
export const AGY_CLI_MCP_PROVENANCE = "agy-cli-mcp" as const;

export type BridgedToolProvenance = typeof CLAUDE_CLI_MCP_PROVENANCE | typeof AGY_CLI_MCP_PROVENANCE;

/** External prefixed alias each supported internal tool is exposed under. */
export const WORKFLOW_MCP_ALIASES = {
    plan_written: "runwield_plan_written",
    task_completed: "runwield_task_completed",
    review_complete: "runwield_review_complete",
    triage_report: "runwield_triage_report",
} as const;

export type WorkflowInternalToolName = keyof typeof WORKFLOW_MCP_ALIASES;

/**
 * @param {string} internalName
 * @returns {string | undefined}
 */
export function workflowMcpAliasFor(internalName: string): string | undefined {
    return WORKFLOW_MCP_ALIASES[internalName as WorkflowInternalToolName];
}

export function mcpAliasFor(internalName: string): string {
    return workflowMcpAliasFor(internalName) ?? internalName;
}

function isLifecycleTool(internalName: string): boolean {
    return internalName === "pair_checkpoint" || workflowMcpAliasFor(internalName) !== undefined;
}

/** Model fields the recorded assistant toolCall message carries from the current model. */
export interface RunWieldMcpBridgeAssistantBase {
    api: Api;
    provider: ProviderId;
    model: string;
}

/** Message shapes this bridge records (assistant toolCall + toolResult). */
type BridgeRecordedMessage = Parameters<SessionManager["appendMessage"]>[0];

export interface RunWieldMcpBridgeOptions {
    /** Eligible existing Tool Definitions exposed to this external CLI turn. */
    tools: ToolDefinition[];
    /** Abort signal for the current external CLI turn. */
    signal?: AbortSignal;
    sessionManager: SessionManager;
    cwd: string;
    /** Hosted Session that receives live Runtime events for TUI tool blocks. */
    hostedSession?: HostedSession;
    /** Mirror of recorded messages into the execution-session message list. */
    onMessage?: (message: BridgeRecordedMessage) => void;
    /** Model fields stamped onto the canonical assistant toolCall messages. */
    assistantBase: RunWieldMcpBridgeAssistantBase;
    /** Flush pending assistant display deltas before tool runtime events are emitted. */
    beforeRuntimeToolEvent?: () => void;
    /** Trusted provenance value stamped onto all bridge-recorded results. */
    provenance: BridgedToolProvenance;
    /** Optional host-specific notice when the listener ends before close(). */
    onUnexpectedDisconnect?: () => void;
    /** Consume live user steering before a lifecycle call is accepted. */
    consumePendingSteering?: () => string[];
    /** Stop the external backend immediately after a terminating lifecycle result. */
    onTerminalAccepted?: (internalName: string) => void;
}

export interface RunWieldMcpBridgeHandle {
    /** Loopback URL of the temporary server (in-process only; never logged). */
    readonly url: string;
    /** Random Bearer token required on every request (in-process only; never logged). */
    readonly token: string;
    /** JSON content for Claude's owner-only `--mcp-config` file. */
    readonly config: string;
    readonly closed: boolean;
    readonly acceptedTerminal: boolean;
    readonly advertisedToolNames: string[];
    /** Stop the listener, close active streams, and release all resources. Idempotent. */
    close(): Promise<void>;
}

interface BridgeToolEntry {
    alias: string;
    internalName: string;
    definition: ToolDefinition;
    kind: "lifecycle" | "capability";
}

interface McpToolInputSchema {
    type: "object";
    properties?: JsonObject;
    required?: string[];
}

interface DelegatedToolResult {
    content: ToolContent;
    structuredContent?: JsonObject;
    details?: JsonObject | null;
    isError?: boolean;
    terminate?: boolean;
}

type McpToolResult = {
    content: ToolContent;
    structuredContent?: JsonObject;
    isError?: boolean;
};

const ZERO_USAGE = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

function generateBearerToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Minimal extension context: the bridged tools capture HostedSession state at factory time. */
function createToolContext(cwd: string, signal?: AbortSignal): ExtensionToolContext {
    return {
        tools: [],
        executeTool: () => Promise.reject(new Error("Nested tools are not available through the CLI bridge.")),
        ui: {} as ExtensionUIContext,
        mode: "print",
        hasUI: false,
        cwd,
        sessionManager: undefined as never,
        modelRegistry: undefined as never,
        model: undefined,
        scopedModels: [],
        isIdle: () => true,
        isProjectTrusted: () => true,
        signal,
        abort: () => {},
        hasPendingMessages: () => false,
        shutdown: () => {},
        getContextUsage: () => undefined,
        compact: () => {},
        getSystemPrompt: () => "",
    };
}

function stampDetails(details: JsonObject | null | undefined, provenance: BridgedToolProvenance): JsonObject {
    const stamped: JsonObject = {};
    if (details !== null && typeof details === "object") {
        Object.assign(stamped, details);
    }
    stamped.provenance = provenance;
    return stamped;
}

function rejectionText(reason: string): string {
    return `runwield lifecycle call rejected: ${reason}`;
}

function formatPendingSteeringRejection(messages: string[]): string {
    const formatted = messages.map((message) => `- ${message}`).join("\n");
    return `user steering is pending. Read this user message before calling the lifecycle tool again:\n${formatted}`;
}

function mergeAbortSignals(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
    const signals = [first, second].filter((signal): signal is AbortSignal => Boolean(signal));
    if (signals.length === 0) return undefined;
    if (signals.length === 1) return signals[0];
    return AbortSignal.any(signals);
}

/**
 * Start a per-turn authenticated loopback MCP server advertising only the
 * supplied eligible RunWield tool aliases, and return the Claude config content
 * plus a close operation.
 *
 * The caller writes the returned `config` to an owner-only temporary file and
 * passes it to a compatible external CLI; `close()` must run in the
 * `finally` of the turn, after the prompt file and config file are removed.
 */
export async function startRunWieldMcpBridge(
    options: RunWieldMcpBridgeOptions,
): Promise<RunWieldMcpBridgeHandle> {
    if (!options.tools || options.tools.length === 0) {
        throw new Error("startRunWieldMcpBridge: at least one eligible Tool Definition is required");
    }
    const entries: BridgeToolEntry[] = options.tools.map((definition) => {
        const internalName = definition.name;
        const alias = mcpAliasFor(internalName);
        if (!alias.trim()) {
            throw new Error(`startRunWieldMcpBridge: "${internalName}" resolved to an empty MCP alias`);
        }
        const kind = isLifecycleTool(internalName) ? "lifecycle" as const : "capability" as const;
        return { alias, internalName, definition, kind };
    });
    const byAlias = new Map<string, BridgeToolEntry>();
    for (const entry of entries) {
        if (byAlias.has(entry.alias)) {
            throw new Error(`startRunWieldMcpBridge: duplicate MCP alias "${entry.alias}"`);
        }
        byAlias.set(entry.alias, entry);
    }

    const token = generateBearerToken();
    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
    });
    const mcpServer = new Server(
        { name: "runwield", version: "1.0.0" },
        { capabilities: { tools: {} } },
    );

    let terminal = false;
    let callQueue: Promise<void> = Promise.resolve();
    const toolStartedAt = new Map<string, number>();
    const toolArgs = new Map<string, JsonObject>();

    function appendMessage(message: BridgeRecordedMessage): void {
        options.sessionManager.appendMessage(message);
        options.onMessage?.(message);
    }

    function emitToolStart(internalName: string, callId: string, args: JsonObject): void {
        options.beforeRuntimeToolEvent?.();
        toolStartedAt.set(callId, Date.now());
        emitHostedSessionRuntimeEvent(options.hostedSession, {
            type: RuntimeEventTypes.TOOL_START,
            toolCallId: callId,
            ...describeRuntimeTool(internalName, args),
            args,
        });
    }

    function emitToolUpdate(
        internalName: string,
        callId: string,
        result: Pick<DelegatedToolResult, "content" | "details">,
    ): void {
        options.beforeRuntimeToolEvent?.();
        const toolResult = normalizeRuntimeToolResult(result);
        emitHostedSessionRuntimeEvent(options.hostedSession, {
            type: RuntimeEventTypes.TOOL_UPDATE,
            toolCallId: callId,
            ...describeRuntimeTool(internalName, toolArgs.get(callId)),
            ...toolResult,
        });
    }

    function emitToolEnd(internalName: string, callId: string, result: DelegatedToolResult): void {
        options.beforeRuntimeToolEvent?.();
        const toolResult = normalizeRuntimeToolResult(result);
        const startedAt = toolStartedAt.get(callId);
        const args = toolArgs.get(callId);
        toolStartedAt.delete(callId);
        toolArgs.delete(callId);
        emitHostedSessionRuntimeEvent(options.hostedSession, {
            type: RuntimeEventTypes.TOOL_END,
            toolCallId: callId,
            ...describeRuntimeTool(internalName, args),
            ...toolResult,
            isError: result.isError === true,
            durationMs: startedAt === undefined ? null : Math.max(0, Date.now() - startedAt),
        });
    }

    function recordToolCall(internalName: string, callId: string, args: JsonObject): void {
        appendMessage({
            role: "assistant",
            timestamp: Date.now(),
            content: [{ type: "toolCall", id: callId, name: internalName, arguments: args }],
            api: options.assistantBase.api,
            provider: options.assistantBase.provider,
            model: options.assistantBase.model,
            usage: { ...ZERO_USAGE },
            stopReason: "toolUse",
        });
        toolArgs.set(callId, args);
        emitToolStart(internalName, callId, args);
    }

    function recordToolResult(
        internalName: string,
        callId: string,
        result: DelegatedToolResult,
    ): void {
        appendMessage({
            role: "toolResult",
            toolCallId: callId,
            toolName: internalName,
            content: result.content,
            details: stampDetails(result.details, options.provenance),
            isError: result.isError === true,
            timestamp: Date.now(),
        });
        emitToolEnd(internalName, callId, result);
    }

    function rejectedResult(
        reason: string,
        entry: BridgeToolEntry,
        callId: string,
        args: JsonObject,
    ): McpToolResult {
        const text = rejectionText(reason);
        // No `outcome` key: plan outcome readers treat any truthy outcome as a
        // decision, so a rejection must stay invisible to them.
        const result: DelegatedToolResult = {
            content: [{ type: "text", text }],
            details: { reason },
            isError: true,
        };
        recordToolCall(entry.internalName, callId, args);
        recordToolResult(entry.internalName, callId, result);
        return { content: result.content, isError: true };
    }

    async function executeCall(
        alias: string,
        args: JsonObject | undefined,
        requestSignal?: AbortSignal,
    ): Promise<McpToolResult> {
        // Cancellation can arrive while this call is waiting behind another tool.
        // Check before validation, steering consumption, recording, or execution.
        const callSignal = mergeAbortSignals(options.signal, requestSignal);
        callSignal?.throwIfAborted();
        const callId = crypto.randomUUID();
        const entry = byAlias.get(alias);
        if (!entry) {
            throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${alias}`);
        }
        if (entry.kind === "lifecycle" && terminal) {
            return rejectedResult(
                "an accepted terminal lifecycle call already closed the gate for this turn",
                entry,
                callId,
                args ?? {},
            );
        }
        const pendingSteering = entry.kind === "lifecycle" ? options.consumePendingSteering?.() || [] : [];
        if (pendingSteering.length > 0) {
            return rejectedResult(formatPendingSteeringRejection(pendingSteering), entry, callId, args ?? {});
        }

        let params: JsonObject;
        try {
            params = validateToolCall(
                [{
                    name: alias,
                    description: entry.definition.description,
                    parameters: entry.definition.parameters,
                }],
                { type: "toolCall", id: callId, name: alias, arguments: args ?? {} },
            ) as JsonObject;
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return rejectedResult(`invalid arguments for ${alias}: ${reason}`, entry, callId, args ?? {});
        }

        recordToolCall(entry.internalName, callId, args ?? {});

        let result: DelegatedToolResult;
        try {
            const executed = await entry.definition.execute(
                callId,
                params,
                callSignal,
                (update) => emitToolUpdate(entry.internalName, callId, update as DelegatedToolResult),
                createToolContext(options.cwd, callSignal),
            );
            result = {
                content: executed.content,
                structuredContent: executed.structuredContent as JsonObject | undefined,
                details: executed.details as JsonObject | null | undefined,
                terminate: executed.terminate === true,
                isError: (executed as { isError?: boolean }).isError === true,
            };
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const isAborted = callSignal?.aborted === true;
            result = {
                content: [{ type: "text", text: `runwield ${entry.kind} call failed: ${reason}` }],
                details: { reason: isAborted ? "aborted" : "execution_error" },
                isError: true,
            };
        }

        if (entry.kind === "lifecycle" && result.terminate === true) {
            terminal = true;
            try {
                options.onTerminalAccepted?.(entry.internalName);
            } catch {
                // The accepted result remains authoritative if the process already exited.
            }
        }
        recordToolResult(entry.internalName, callId, result);
        return {
            content: result.content,
            ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
            isError: result.isError === true,
        };
    }

    mcpServer.setRequestHandler(ListToolsRequestSchema, () => {
        return {
            tools: entries.map((entry) => ({
                name: entry.alias,
                description: entry.definition.description,
                inputSchema: entry.definition.parameters as McpToolInputSchema,
                ...(entry.definition.outputSchema
                    ? { outputSchema: entry.definition.outputSchema as McpToolInputSchema }
                    : {}),
            })),
        };
    });

    mcpServer.setRequestHandler(CallToolRequestSchema, (request, extra) => {
        const name = request.params.name;
        const args = request.params.arguments as JsonObject | undefined;
        const run = callQueue.then(() => executeCall(name, args, extra.signal));
        callQueue = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    });

    await mcpServer.connect(transport);
    let url = "";
    const serveServer = serveHttp(
        {
            hostname: "127.0.0.1",
            port: 0,
            onListen: () => {},
        },
        (request) => {
            const origin = request.headers.get("origin");
            if (origin !== null && origin !== url) {
                return new Response(JSON.stringify({ error: "Forbidden Origin" }), {
                    status: 403,
                    headers: { "content-type": "application/json" },
                });
            }
            const auth = request.headers.get("authorization");
            if (auth !== `Bearer ${token}`) {
                return new Response(JSON.stringify({ error: "Unauthorized" }), {
                    status: 401,
                    headers: { "content-type": "application/json" },
                });
            }
            return transport.handleRequest(request);
        },
    );
    url = `http://127.0.0.1:${serveServer.addr.port}`;
    const config = buildMcpConfigJson(url, token);

    let closed = false;
    serveServer.finished.then(
        () => {
            if (!closed) options.onUnexpectedDisconnect?.();
        },
        () => {
            if (!closed) options.onUnexpectedDisconnect?.();
        },
    );
    async function close(): Promise<void> {
        if (closed) return;
        closed = true;
        try {
            await transport.close();
        } catch {
            // SSE streams may already be gone; the listener shutdown follows.
        }
        try {
            await mcpServer.close();
        } catch {
            // Protocol close is a no-op once no session remains.
        }
        try {
            await serveServer.shutdown();
        } catch {
            // Listener teardown is best-effort.
        }
    }

    return {
        url,
        token,
        config,
        advertisedToolNames: entries.map((entry) => entry.internalName),
        get closed() {
            return closed;
        },
        get acceptedTerminal() {
            return terminal;
        },
        close,
    };
}

function buildMcpConfigJson(url: string, token: string): string {
    return JSON.stringify({
        mcpServers: {
            runwield: {
                type: "http",
                url,
                headers: { Authorization: `Bearer ${token}` },
                timeout: RUNWIELD_MCP_TOOL_TIMEOUT_MS,
            },
        },
    });
}
