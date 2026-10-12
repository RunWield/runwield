import type { McpIntegration } from "../../../mcp/integration.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunWieldModel } from "../../../models/model-registry.ts";
import type { HostedSession } from "../../hosted-session.js";
import { emitHostedSessionRuntimeEvent, RuntimeEventTypes } from "../../session-runtime-events.js";
import type { ImageAttachment } from "../../types.js";
import { WorkflowStepCompleted } from "../../../workflow/workflow-tool-events.ts";
import {
    prepareClaudeCliCommand,
    type PreparedClaudeCliCommand,
    removeClaudeCliMcpConfigFile,
    removeClaudeCliPromptFile,
} from "./command.ts";
import {
    buildBackendStatusEntry,
    ClaudeCliBackendError,
    emitBackendStatus,
    sanitizeStderrForDisplay,
} from "./failure.ts";
import { type ClaudeCliProcessResult, DenoClaudeCliProcessPort } from "./process.ts";
import { type ClaudeCliUsage, parseClaudeCliStream } from "./stream-parser.ts";
import {
    CLAUDE_CLI_MCP_PROVENANCE,
    mcpAliasFor,
    type RunWieldMcpBridgeHandle,
    startRunWieldMcpBridge,
} from "./mcp-bridge.ts";
import { buildBridgedToolPromptAppendix } from "../../bridged-tools/prompt.ts";
import { readExternalCliConversation, serializeExternalCliConversation } from "../../external-cli-conversation.ts";
import { ExecutionMetricsRecorder } from "../../../workflow/execution-metrics.ts";

type SessionAppendMessage = Parameters<SessionManager["appendMessage"]>[0];

export interface ClaudeCliExecutionSessionOptions {
    cwd: string;
    agentName: string;
    agentDisplayName: string;
    finalSystemPrompt: string;
    model: RunWieldModel;
    sessionManager: SessionManager;
    hostedSession?: HostedSession;
    /** Eligible RunWield Tool Definitions exposed over MCP this turn. */
    bridgedTools?: ToolDefinition[];
    mcpIntegration?: McpIntegration;
    /** False for temporary turns that must not change the root model marker. */
    persistModelChange?: boolean;
}

export interface ClaudeCliRunOptions {
    userRequest: string;
    images?: { base64: string; mimeType: string }[];
    signal?: AbortSignal;
    requestId?: string;
    attemptId?: string;
    dispatchKind?: string;
    executionKind?: "root" | "isolated" | "delegated";
    mode?: "foreground" | "background";
    parentExecutionId?: string;
    parentToolCallId?: string;
    taskId?: string;
    sourceSurface?: string;
}

interface ClaudeCliQueueUpdateEvent {
    type: "queue_update";
    steering: string[];
    followUp: string[];
}

type ClaudeCliQueueListener = (event: ClaudeCliQueueUpdateEvent) => void;

class RuntimeDeltaBuffer {
    private buffered = "";
    private flushTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly emit: (delta: string) => void) {}

    push(delta: string): void {
        if (!delta) return;
        this.buffered += delta;
        if (this.flushTimer !== null) return;
        this.flushTimer = setTimeout(() => this.flush(), 16);
    }

    flush(): void {
        if (this.flushTimer !== null) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (!this.buffered) return;
        const delta = this.buffered;
        this.buffered = "";
        this.emit(delta);
    }
}

export class ClaudeCliExecutionSession {
    readonly kind = "claude-cli";
    readonly id: string;
    readonly model: RunWieldModel;
    readonly agentName: string;
    readonly agentDisplayName: string;
    readonly sessionManager: SessionManager;
    readonly finalSystemPrompt: string;
    private readonly cwd: string;
    private readonly hostedSession?: HostedSession;
    private readonly bridgedTools: ToolDefinition[];
    private readonly mcpIntegration?: McpIntegration;
    private readonly mcpToolNames: Set<string>;
    private readonly persistModelChange: boolean;
    private readonly messages: AgentMessage[] = [];
    private readonly steeringMessages: string[] = [];
    private readonly queueListeners = new Set<ClaudeCliQueueListener>();
    private turnAbortController: AbortController | null = null;
    isStreaming = false;

    constructor(options: ClaudeCliExecutionSessionOptions) {
        this.id = `claude-cli:${crypto.randomUUID()}`;
        this.cwd = options.cwd;
        this.agentName = options.agentName;
        this.agentDisplayName = options.agentDisplayName;
        this.finalSystemPrompt = options.finalSystemPrompt;
        this.model = options.model;
        this.sessionManager = options.sessionManager;
        this.hostedSession = options.hostedSession;
        this.bridgedTools = [...(options.bridgedTools || [])];
        this.mcpIntegration = options.mcpIntegration;
        this.mcpToolNames = new Set(options.mcpIntegration?.getTools().map((tool) => tool.name));
        this.persistModelChange = options.persistModelChange !== false;
        this.messages = this.readMessages();
    }

    getMessages(): AgentMessage[] {
        return [...this.messages];
    }

    dispose(): void {
        this.abort();
    }

    abort(): void {
        this.turnAbortController?.abort();
    }

    clearQueue(): void {
        if (this.steeringMessages.length === 0) return;
        this.steeringMessages.splice(0, this.steeringMessages.length);
        this.emitQueueUpdate();
    }

    steer(text: string, images?: ImageAttachment[]): Promise<void> {
        if (images && images.length > 0) {
            throw new Error("Claude CLI execution backend does not support image attachments in live steering");
        }
        this.steeringMessages.push(text);
        this.emitQueueUpdate();
        return Promise.resolve();
    }

    async followUp(text: string, images?: ImageAttachment[]): Promise<void> {
        await this.steer(text, images);
    }

    getSteeringMessages(): string[] {
        return [...this.steeringMessages];
    }

    consumeSteeringMessages(): string[] {
        const messages = this.getSteeringMessages();
        if (messages.length === 0) return messages;
        this.steeringMessages.splice(0, this.steeringMessages.length);
        this.emitQueueUpdate();
        return messages;
    }

    subscribe(listener: ClaudeCliQueueListener): () => void {
        this.queueListeners.add(listener);
        return () => this.queueListeners.delete(listener);
    }

    private emitQueueUpdate(): void {
        const event: ClaudeCliQueueUpdateEvent = {
            type: "queue_update",
            steering: this.getSteeringMessages(),
            followUp: [],
        };
        for (const listener of this.queueListeners) listener(event);
    }

    async runTurn(options: ClaudeCliRunOptions): Promise<AgentMessage[]> {
        const bridgedTools = this.mcpIntegration
            ? [
                ...this.bridgedTools.filter((tool) => !this.mcpToolNames.has(tool.name)),
                ...this.mcpIntegration.getTools(),
            ]
            : this.bridgedTools;

        if (options.images && options.images.length > 0) {
            throw new Error("Claude CLI execution backend does not support image attachments in this slice");
        }
        const conversation = readExternalCliConversation(this.sessionManager);
        const userMessage = makeUserMessage(options.userRequest);
        conversation.push({ role: "user", text: options.userRequest });
        const selector = this.model.id;
        let bridge: RunWieldMcpBridgeHandle | null = null;
        let command: PreparedClaudeCliCommand | null = null;
        let process: ClaudeCliProcessResult | null = null;
        let statusEmitted = false;
        this.turnAbortController = new AbortController();
        const combinedSignal = options.signal
            ? AbortSignal.any([options.signal, this.turnAbortController.signal])
            : this.turnAbortController.signal;
        this.isStreaming = true;

        const emitFailure = (
            kind: ConstructorParameters<typeof ClaudeCliBackendError>[0],
            exitCode: number | null,
            message?: string,
        ) => {
            if (options.signal?.reason instanceof WorkflowStepCompleted) return;
            // emitBackendStatus persists the sanitized runwield.backend_status transcript entry.
            if (statusEmitted) return;
            statusEmitted = true;
            emitBackendStatus(
                this.hostedSession,
                this.sessionManager,
                buildBackendStatusEntry(kind, {
                    exitCode,
                    ...(message ? { message } : {}),
                    requestId: options.requestId,
                    attemptId: options.attemptId,
                }),
            );
        };

        const recorder = new ExecutionMetricsRecorder({
            projectRoot: this.cwd,
            commandId: this.hostedSession?.activeCommandInvocationId || undefined,
            sessionId: this.sessionManager.getSessionId(),
            managedSessionId: this.hostedSession?.getManagedMetadata()?.runwieldSessionId,
            segmentId: options.executionKind === "root"
                ? this.hostedSession?.getManagedMetadata()?.currentSegmentId
                : undefined,
            agent: this.agentName,
            provider: this.model.provider,
            model: this.model.id,
            backend: "claude-cli",
            requestId: options.requestId,
            attemptId: options.attemptId,
            dispatchKind: options.dispatchKind,
            executionKind: options.executionKind || "root",
            mode: options.mode || "foreground",
            parentExecutionId: options.parentExecutionId,
            parentToolCallId: options.parentToolCallId,
            taskId: options.taskId,
            sourceSurface: options.sourceSurface || "cli",
        });
        await recorder.recordExecutionStart();
        await recorder.recordToolExposure(bridgedTools, "partial");
        const pendingObservations = new Set<Promise<void>>();
        const observe = (pending: Promise<void>) => {
            pendingObservations.add(pending);
            void pending.then(() => pendingObservations.delete(pending), () => pendingObservations.delete(pending));
        };
        observe(recorder.recordResponseLatency("turn_start"));
        let executionOutcome: import("../../../workflow/execution-metrics.ts").ExecutionOutcome = "succeeded";
        let failureKind: string | undefined;

        let flushRuntimeDeltas = () => {};
        const eligibleAliases = bridgedTools.map((tool) => mcpAliasFor(tool.name));
        const eligibleAliasesSet = new Set(eligibleAliases);
        const nativeCallIds = new Set<string>();
        let firstTextDeltaRecorded = false;
        let parsed: Awaited<ReturnType<typeof parseClaudeCliStream>> | null = null;
        try {
            if (bridgedTools.length > 0) {
                try {
                    bridge = await startRunWieldMcpBridge({
                        tools: bridgedTools,
                        cwd: this.cwd,
                        hostedSession: this.hostedSession,
                        sessionManager: this.sessionManager,
                        onMessage: (message) => {
                            this.messages.push(message);
                            if (message.role === "assistant") {
                                for (const part of message.content) {
                                    if (part.type === "toolCall") {
                                        this.hostedSession?.recordToolExecution(part.id, recorder.executionId);
                                    }
                                }
                            } else if (message.role === "toolResult") {
                                this.hostedSession?.forgetToolExecution(message.toolCallId);
                            }
                            observe(recorder.recordBridgeMessage(message));
                        },
                        signal: combinedSignal,
                        assistantBase: {
                            api: this.model.api,
                            provider: this.model.provider,
                            model: this.model.id,
                        },
                        provenance: CLAUDE_CLI_MCP_PROVENANCE,
                        onUnexpectedDisconnect: () => {
                            emitFailure("bridge_disconnected", null);
                        },
                        beforeRuntimeToolEvent: () => flushRuntimeDeltas(),
                        consumePendingSteering: () => this.consumeSteeringMessages(),
                        onTerminalAccepted: () => process?.kill(),
                    });
                } catch {
                    executionOutcome = "failed";
                    failureKind = "bridge_startup_failed";
                    emitFailure("bridge_startup_failed", null);
                    throw new ClaudeCliBackendError("bridge_startup_failed");
                }
            }
            command = await prepareClaudeCliCommand({
                selector,
                systemPrompt: this.finalSystemPrompt + buildBridgedToolPromptAppendix(bridgedTools, "Claude Code"),
                ...(bridge ? { mcpConfig: bridge.config } : {}),
                allowedToolNames: eligibleAliases.flatMap((alias) => [alias, `mcp__runwield__${alias}`]),
            });
            const stdinText = serializeExternalCliConversation(conversation);
            const processPort = new DenoClaudeCliProcessPort();
            try {
                process = processPort.run(command, stdinText, this.cwd, combinedSignal);
            } catch (error) {
                executionOutcome = "failed";
                if (error instanceof ClaudeCliBackendError) {
                    failureKind = error.kind;
                    emitFailure(error.kind, error.exitCode);
                }
                throw error;
            }

            this.sessionManager.appendMessage(userMessage);
            this.messages.push(userMessage as AgentMessage);
            this.sessionManager.appendCustomEntry("runwield.execution_backend", {
                version: 1,
                backend: "claude-cli",
                provider: this.model.provider,
                model: selector,
                outputFormat: "stream-json",
                ...(options.requestId ? { requestId: options.requestId } : {}),
                ...(options.attemptId ? { attemptId: options.attemptId } : {}),
            });

            const messageId = `claude-cli-assistant:${crypto.randomUUID()}`;
            const thinkingMessageId = `claude-cli-thinking:${crypto.randomUUID()}`;
            const textDeltas = new RuntimeDeltaBuffer((delta) => {
                emitHostedSessionRuntimeEvent(this.hostedSession, {
                    type: RuntimeEventTypes.ASSISTANT_TEXT_DELTA,
                    messageId,
                    delta,
                    agentName: this.agentDisplayName,
                    messageKind: "assistant",
                });
            });
            const thinkingDeltas = new RuntimeDeltaBuffer((delta) => {
                emitHostedSessionRuntimeEvent(this.hostedSession, {
                    type: RuntimeEventTypes.ASSISTANT_THINKING_DELTA,
                    messageId: thinkingMessageId,
                    delta,
                    agentName: this.agentDisplayName,
                });
            });
            flushRuntimeDeltas = () => {
                thinkingDeltas.flush();
                textDeltas.flush();
            };
            try {
                parsed = await parseClaudeCliStream(process.stdout, {
                    onDelta: (delta) => {
                        if (!firstTextDeltaRecorded && delta.text) {
                            firstTextDeltaRecorded = true;
                            observe(recorder.recordResponseLatency("first_text"));
                        }
                        textDeltas.push(delta.text);
                    },
                    onThinkingObserved: () => observe(recorder.recordResponseLatency("first_response")),
                    onThinkingDelta: (delta) => {
                        observe(recorder.recordResponseLatency("first_response"));
                        thinkingDeltas.push(delta.text);
                    },
                    onThinkingEnd: () => {
                        thinkingDeltas.flush();
                        emitHostedSessionRuntimeEvent(this.hostedSession, {
                            type: RuntimeEventTypes.ASSISTANT_THINKING_END,
                            messageId: thinkingMessageId,
                            agentName: this.agentDisplayName,
                        });
                    },
                    onUsage: (observation) => {
                        observe(recorder.recordModelUsage({
                            sourceId: observation.sourceId,
                            inputTokens: observation.usage.inputTokens,
                            outputTokens: observation.usage.outputTokens,
                            cacheReadTokens: observation.usage.cacheReadTokens,
                            cacheWriteTokens: observation.usage.cacheWriteTokens,
                            costUsd: observation.usage.costUsd,
                            costSource: observation.usage.costUsd === null ? "unavailable" : "reported",
                            inputCacheBasis: "unknown",
                            aggregationBasis: observation.aggregationBasis,
                            usageKind: observation.aggregationBasis === "alternative" ? "request" : "turn",
                            model: observation.model || this.model.id,
                        }));
                    },
                    onNativeToolStart: (call) => {
                        observe(recorder.recordResponseLatency("first_response"));
                        if (!isBridgedTool(call.toolName, eligibleAliasesSet)) {
                            nativeCallIds.add(call.callId);
                            observe(recorder.recordToolStart(call.callId, call.toolName, call.args));
                        }
                    },
                    onNativeToolResult: (res) => {
                        if (nativeCallIds.has(res.callId)) {
                            nativeCallIds.delete(res.callId);
                            observe(recorder.recordToolFinish(res.callId, "", {
                                isError: res.isError,
                                result: res.resultText,
                            }));
                        }
                    },
                    isTerminalAccepted: () => bridge?.acceptedTerminal === true,
                });
            } catch (error) {
                executionOutcome = combinedSignal.aborted ? "canceled" : "failed";
                process.kill();
                if (!combinedSignal.aborted && error instanceof Error && error.message.includes("terminal result")) {
                    try {
                        const status = await process.completed;
                        if (!status.success) {
                            const stderr = await process.stderrText;
                            const kind = isAuthFailure(stderr) ? "auth_failed" : "non_zero_exit";
                            failureKind = kind;
                            emitFailure(kind, status.code);
                            const excerpt = sanitizeStderrForDisplay(stderr);
                            const base = buildBackendStatusEntry(kind, { exitCode: status.code }).message;
                            throw new ClaudeCliBackendError(kind, {
                                exitCode: status.code,
                                message: excerpt ? `${base}\n${excerpt}` : base,
                            });
                        }
                    } catch (statusError) {
                        if (statusError instanceof ClaudeCliBackendError) throw statusError;
                    }
                }
                const kind = combinedSignal.aborted ? "canceled" : "malformed_stream";
                failureKind = kind;
                emitFailure(kind, null);
                throw error instanceof ClaudeCliBackendError ? error : new ClaudeCliBackendError(kind);
            }
            flushRuntimeDeltas();

            let status: Deno.CommandStatus;
            try {
                status = await process.completed;
            } catch {
                const kind = combinedSignal.aborted ? "canceled" : "non_zero_exit";
                executionOutcome = combinedSignal.aborted ? "canceled" : "failed";
                failureKind = kind;
                emitFailure(kind, null);
                throw new ClaudeCliBackendError(kind);
            }
            if (combinedSignal.aborted) {
                process.kill();
                executionOutcome = "canceled";
                failureKind = "canceled";
                emitFailure("canceled", status.code);
                throw new ClaudeCliBackendError("canceled", { exitCode: status.code });
            }
            if (parsed.metadata.isError || (!status.success && bridge?.acceptedTerminal !== true)) {
                const stderr = await process.stderrText;
                const excerpt = sanitizeStderrForDisplay(stderr);
                const claudeMessage = parsed.metadata.isError ? sanitizeStderrForDisplay(parsed.text) : "";
                const detail = claudeMessage || excerpt;
                const kind = isAuthFailure(detail) ? "auth_failed" : "non_zero_exit";
                executionOutcome = "failed";
                failureKind = kind;
                const base = buildBackendStatusEntry(kind, { exitCode: status.code }).message;
                const message = detail || base;
                emitFailure(kind, status.code, message);
                throw new ClaudeCliBackendError(kind, {
                    exitCode: status.code,
                    message,
                });
            }
            if (this.persistModelChange) this.sessionManager.appendModelChange(this.model.provider, this.model.id);
            const assistantMessage = makeAssistantMessage(parsed.text, this.model, parsed.metadata.usage);
            this.sessionManager.appendMessage(assistantMessage);
            this.sessionManager.appendCustomEntry("runwield.execution_backend", {
                version: 1,
                backend: "claude-cli",
                provider: this.model.provider,
                model: selector,
                outputFormat: "stream-json",
                ...(options.requestId ? { requestId: options.requestId } : {}),
                ...(options.attemptId ? { attemptId: options.attemptId } : {}),
                ...(parsed.metadata.externalSessionId ? { externalSessionId: parsed.metadata.externalSessionId } : {}),
            });
            this.messages.push(assistantMessage as AgentMessage);
            emitHostedSessionRuntimeEvent(this.hostedSession, {
                type: RuntimeEventTypes.USAGE,
                usage: toRuntimeUsage(parsed.metadata.usage),
            });
            return this.getMessages();
        } finally {
            flushRuntimeDeltas();
            this.isStreaming = false;
            this.turnAbortController = null;
            if (command) {
                await removeClaudeCliPromptFile(command);
                await removeClaudeCliMcpConfigFile(command);
            }
            if (bridge) await bridge.close();
            observe(recorder.recordResponseLatency("turn_finish"));
            await Promise.allSettled([...pendingObservations]);
            await recorder.settleExecution(executionOutcome, failureKind);
            this.hostedSession?.forgetExecutionToolCalls(recorder.executionId);
        }
    }

    private readMessages(): AgentMessage[] {
        return readExternalCliConversation(this.sessionManager).map((message) => {
            return message.role === "user"
                ? makeUserMessage(message.text) as AgentMessage
                : makeAssistantMessage(message.text, this.model, zeroUsage()) as AgentMessage;
        });
    }
}

function makeUserMessage(text: string): SessionAppendMessage {
    return {
        role: "user",
        timestamp: Date.now(),
        content: [{ type: "text", text }],
    };
}

function makeAssistantMessage(text: string, model: RunWieldModel, usage: ClaudeCliUsage): SessionAppendMessage {
    return {
        role: "assistant",
        timestamp: Date.now(),
        content: [{ type: "text", text }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: toPiUsage(usage),
        stopReason: "stop",
    };
}

function zeroUsage(): ClaudeCliUsage {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
    };
}

function toRuntimeUsage(usage: ClaudeCliUsage) {
    return {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        costUsd: usage.costUsd ?? 0,
    };
}

function toPiUsage(usage: ClaudeCliUsage) {
    const cacheRead = usage.cacheReadTokens ?? 0;
    const cacheWrite = usage.cacheWriteTokens ?? 0;
    return {
        input: usage.inputTokens ?? 0,
        output: usage.outputTokens ?? 0,
        cacheRead,
        cacheWrite,
        totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + cacheRead + cacheWrite,
        cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: usage.costUsd ?? 0,
        },
    };
}

function isAuthFailure(stderr: string): boolean {
    return /authenticate|not signed in|oauth|api key|login|expired/i.test(stderr);
}

function isBridgedTool(toolName: string, eligibleAliases: Set<string>): boolean {
    if (!toolName) return false;
    if (toolName.startsWith("mcp__runwield__")) return true;
    if (eligibleAliases.has(toolName)) return true;
    const stripped = toolName.replace(/^mcp__[^_]+__/, "");
    if (eligibleAliases.has(stripped)) return true;
    return false;
}
