import type { McpIntegration } from "../../../mcp/integration.ts";
import { calculateCost, validateToolCall, type Usage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getExternalCliPriceModel, type RunWieldModel } from "../../../models/model-registry.ts";
import type { HostedSession } from "../../hosted-session.ts";
import {
    emitHostedSessionRuntimeEvent,
    normalizeRuntimeToolResult,
    normalizeRuntimeUsage,
    RuntimeEventTypes,
} from "../../session-runtime-events.ts";
import { describeRuntimeTool } from "../../tool-event-title.ts";
import {
    cleanupAgyCustomAgent,
    materializeAgyCustomAgent,
    resolveAgyCustomAgentPaths,
    verifyAgyCustomAgentOwnership,
} from "./custom-agent.ts";
import type { AgyCustomAgentOwnership } from "./custom-agent.ts";
import { runAgyAcpTurn, type AgyAcpPermissionRequest, type AgyAcpTurnResult } from "./acp-transport.ts";
import { resolveInstalledWldExecutable } from "./mcp-setup.ts";
import {
    requestHostedSessionInteraction,
    RuntimeInteractionTypes,
    RuntimeInteractionOutcomes,
} from "../../session-runtime-interactions.ts";
import { type AgyCliEffort, concreteAgyModel, thinkingLevelToEffort } from "./model-options.ts";
import type { ForegroundTermination } from "../../../foreground-process.ts";

interface AgyCliProcessStatus {
    success: boolean;
    code: number | null;
    terminatedBy: ForegroundTermination | null;
}
import {
    AgyCliBackendError,
    type AgyCliBackendStatusKind,
    buildAgyBackendStatusEntry,
    emitAgyBackendStatus,
    isAgyAuthFailure,
    isAgyMcpUnavailable,
    isAgyPermissionDenied,
} from "./failure.ts";
import {
    AGY_CLI_MCP_PROVENANCE,
    mcpAliasFor,
    type RunWieldMcpBridgeHandle,
    type RunWieldMcpAuthorizationRequest,
    startRunWieldMcpBridge,
} from "../../bridged-tools/mcp-bridge.ts";
import { RUNWIELD_MCP_BRIDGE_TOKEN_ENV, RUNWIELD_MCP_BRIDGE_URL_ENV } from "../../bridged-tools/stdio-transport.ts";
import { AgyCliStreamError } from "./stream-parser.ts";
import type { AgyCliParseResult, AgyCliToolStep, AgyCliUsage } from "./stream-parser.ts";
import { readExternalCliConversation, serializeExternalCliConversation } from "../../external-cli-conversation.ts";
import { ExecutionMetricsRecorder } from "../../../workflow/execution-metrics.ts";

type SessionAppendMessage = Parameters<SessionManager["appendMessage"]>[0];

export interface AgyCliExecutionSessionOptions {
    cwd: string;
    agentName: string;
    agentDisplayName: string;
    finalSystemPrompt: string;
    model: RunWieldModel;
    sessionManager: SessionManager;
    hostedSession?: HostedSession;
    bridgedTools?: ToolDefinition[];
    mcpIntegration?: McpIntegration;
    thinkingLevel?: string;
    persistModelChange?: boolean;
    declaredTools?: string[];
}

export interface AgyCliRunOptions {
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
    userInitiated?: boolean;
}

interface ClassifiedFailure {
    kind: AgyCliBackendStatusKind;
    exitCode: number | null;
    message?: string;
}

export class AgyCliExecutionSession {
    readonly kind = "agy-cli";
    readonly id: string;
    readonly model: RunWieldModel;
    readonly agentName: string;
    readonly agentDisplayName: string;
    readonly sessionManager: SessionManager;
    readonly finalSystemPrompt: string;
    private readonly cwd: string;
    private readonly hostedSession?: HostedSession;
    private readonly ownership: AgyCustomAgentOwnership;
    private readonly bridgedTools: ToolDefinition[];
    private readonly mcpIntegration?: McpIntegration;
    private readonly mcpToolNames: Set<string>;
    private readonly thinkingLevel?: string;
    private readonly persistModelChange: boolean;
    private readonly nativeTools: Set<string>;
    private messages: AgentMessage[] = [];
    private turnAbortController: AbortController | null = null;
    private activeTurnDone: Promise<void> | null = null;
    private cleanupStatusEmitted = false;
    isStreaming = false;

    private constructor(options: AgyCliExecutionSessionOptions, ownership: AgyCustomAgentOwnership) {
        this.id = `agy-cli:${crypto.randomUUID()}`;
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
        this.thinkingLevel = options.thinkingLevel;
        this.persistModelChange = options.persistModelChange !== false;
        this.ownership = ownership;
        this.nativeTools = new Set(resolveAgyNativeTools(options.declaredTools));
        this.messages = this.readMessages();
    }

    static async create(options: AgyCliExecutionSessionOptions): Promise<AgyCliExecutionSession> {
        thinkingLevelToEffort(options.model.id, options.thinkingLevel);
        const selector = makeTemporaryAgentSelector(options.agentName);
        const nativeTools = resolveAgyNativeTools(options.declaredTools);
        const definition = formatAgyCustomAgentDefinition(
            selector,
            options.finalSystemPrompt,
            options.agentDisplayName,
            nativeTools,
        );
        const paths = resolveAgyCustomAgentPaths(selector);
        const pendingOwnership: AgyCustomAgentOwnership = {
            name: selector,
            definition,
            agentsRootPath: paths.agentsRootPath,
            agentDirectoryPath: paths.agentDirectoryPath,
            definitionPath: paths.definitionPath,
            createdAgentDirectory: true,
            createdDefinition: true,
        };
        let ownership: AgyCustomAgentOwnership | null = null;
        try {
            ownership = await materializeAgyCustomAgent(selector, definition);
            return new AgyCliExecutionSession(options, ownership);
        } catch (error) {
            const failure = classifySetupFailure(error instanceof Error ? error : String(error));
            emitAgyBackendStatus(
                options.hostedSession,
                options.sessionManager,
                buildAgyBackendStatusEntry(failure.kind, { exitCode: failure.exitCode, message: failure.message }),
            );
            await cleanupAgyCustomAgent(ownership || pendingOwnership).catch((cleanupError) => {
                emitAgyBackendStatus(
                    options.hostedSession,
                    options.sessionManager,
                    buildAgyBackendStatusEntry("cleanup_failed", {
                        message: getErrorText(cleanupError instanceof Error ? cleanupError : String(cleanupError)),
                    }),
                );
            });
            throw new AgyCliBackendError(failure.kind, { exitCode: failure.exitCode, message: failure.message });
        }
    }

    getMessages(): AgentMessage[] {
        return [...this.messages];
    }

    async dispose(): Promise<void> {
        this.abort();
        await this.activeTurnDone?.catch(() => undefined);
        try {
            await cleanupAgyCustomAgent(this.ownership);
        } catch (error) {
            this.emitCleanupWarning(error instanceof Error ? error : String(error));
        }
    }

    abort(): void {
        this.turnAbortController?.abort();
    }

    clearQueue(): void {}

    async runTurn(options: AgyCliRunOptions): Promise<AgentMessage[]> {
        const turn = this.runTurnInternal(options);
        const done = turn.then(
            () => undefined,
            () => undefined,
        );
        this.activeTurnDone = done;
        try {
            return await turn;
        } finally {
            if (this.activeTurnDone === done) this.activeTurnDone = null;
        }
    }

    private async runTurnInternal(options: AgyCliRunOptions): Promise<AgentMessage[]> {
        const bridgedTools = this.mcpIntegration
            ? [
                  ...this.bridgedTools.filter((tool) => !this.mcpToolNames.has(tool.name)),
                  ...this.mcpIntegration.getTools(),
              ]
            : this.bridgedTools;

        if (options.images && options.images.length > 0) {
            throw new Error("Agy CLI execution backend does not support image attachments in this slice");
        }
        const effort = thinkingLevelToEffort(this.model.id, this.thinkingLevel);
        const expectedBackendModel = concreteAgyModel(this.model.id, effort);
        const conversation = readExternalCliConversation(this.sessionManager);
        conversation.push({ role: "user", text: options.userRequest });
        const serializedConversation = serializeExternalCliConversation(conversation);
        if (serializedConversation.includes(this.finalSystemPrompt)) {
            throw new Error("Agy user text cannot contain the Agent Definition");
        }

        let statusEmitted = false;
        const emitFailure = (failure: ClassifiedFailure, afterAcceptedTerminal: boolean): void => {
            if (statusEmitted) return;
            statusEmitted = true;
            emitAgyBackendStatus(
                this.hostedSession,
                this.sessionManager,
                buildAgyBackendStatusEntry(failure.kind, {
                    exitCode: failure.exitCode,
                    ...(failure.message ? { message: failure.message } : {}),
                    requestId: options.requestId,
                    attemptId: options.attemptId,
                    afterAcceptedTerminal,
                }),
            );
        };

        const recorder = new ExecutionMetricsRecorder({
            projectRoot: this.cwd,
            hostedSession: this.hostedSession ?? undefined,
            commandId: this.hostedSession?.activeCommandInvocationId || undefined,
            sessionId: this.sessionManager.getSessionId(),
            managedSessionId: this.hostedSession?.getManagedMetadata()?.runwieldSessionId,
            segmentId:
                options.executionKind === "root"
                    ? this.hostedSession?.getManagedMetadata()?.currentSegmentId
                    : undefined,
            agent: this.ownership.name,
            provider: this.model.provider,
            model: this.model.id,
            backend: "agy-cli",
            requestId: options.requestId,
            attemptId: options.attemptId,
            dispatchKind: options.dispatchKind,
            executionKind: options.executionKind || "root",
            mode: options.mode || "foreground",
            parentExecutionId: options.parentExecutionId,
            parentToolCallId: options.parentToolCallId,
            taskId: options.taskId,
            sourceSurface: options.sourceSurface || "cli",
            userInitiated: options.userInitiated,
        });
        await recorder.recordExecutionStart();
        await recorder.recordToolExposure(bridgedTools, "partial");
        const pendingObservations = new Set<Promise<void>>();
        const observe = (pending: Promise<void>) => {
            pendingObservations.add(pending);
            void pending.then(
                () => pendingObservations.delete(pending),
                () => pendingObservations.delete(pending),
            );
        };
        observe(recorder.recordResponseLatency("turn_start"));
        let usageEndedAt: string | null = null;
        let executionOutcome: import("../../../workflow/execution-metrics.ts").ExecutionOutcome = "succeeded";
        let failureKind: string | undefined;

        let bridge: RunWieldMcpBridgeHandle | null = null;
        const terminalController = new AbortController();
        const bridgeServerName = `runwield_turn_${crypto.randomUUID().replaceAll("-", "")}`;
        let bridgeDisconnected = false;
        this.turnAbortController = new AbortController();
        const combinedSignal = options.signal
            ? AbortSignal.any([options.signal, this.turnAbortController.signal])
            : this.turnAbortController.signal;
        this.isStreaming = true;

        let firstTextDeltaRecorded = false;
        let parsed: AgyAcpTurnResult | null = null;
        let observedUsage: AgyCliUsage | null = null;
        let settleInterruptedTools: (() => void) | undefined;
        try {
            try {
                await this.verifyCustomAgentReady(combinedSignal);
            } catch (error) {
                const failure = classifySetupFailure(error instanceof Error ? error : String(error));
                executionOutcome = failure.kind === "canceled" || combinedSignal.aborted ? "canceled" : "failed";
                failureKind = failure.kind;
                emitFailure(failure, false);
                throw new AgyCliBackendError(failure.kind, { exitCode: failure.exitCode, message: failure.message });
            }

            if (bridgedTools.length > 0) {
                try {
                    bridge = await startRunWieldMcpBridge({
                        tools: bridgedTools,
                        authorizeCall: (request) => this.authorizeBridgeCall(request, bridgedTools, combinedSignal),
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
                        provenance: AGY_CLI_MCP_PROVENANCE,
                        onUnexpectedDisconnect: () => {
                            bridgeDisconnected = true;
                        },
                        onTerminalAccepted: () => terminalController.abort(),
                    });
                } catch (error) {
                    executionOutcome = "failed";
                    failureKind = "bridge_startup_failed";
                    const failure: ClassifiedFailure = {
                        kind: "bridge_startup_failed",
                        exitCode: null,
                        message: getErrorText(error instanceof Error ? error : String(error)),
                    };
                    emitFailure(failure, false);
                    throw new AgyCliBackendError(failure.kind, { message: failure.message });
                }
            }

            const messageId = `agy-cli-assistant:${crypto.randomUUID()}`;
            const nativeTools = new Map<
                number,
                { name: string; startedAt: number; parameters?: AgyCliToolStep["parameters"] }
            >();
            const completedTools = new Set<number>();
            const onTool = (step: AgyCliToolStep): void => {
                // The MCP bridge already records and emits its own calls.
                if (
                    step.name === "call_mcp_tool" ||
                    step.name.startsWith(`mcp_${bridgeServerName}_`) ||
                    completedTools.has(step.stepIndex)
                )
                    return;
                const toolCallId = `${messageId}:tool:${step.stepIndex}`;
                const previous = nativeTools.get(step.stepIndex);
                const parameters = step.parameters || previous?.parameters;
                const tool = describeRuntimeTool(step.name, parameters);
                if (!previous) {
                    nativeTools.set(step.stepIndex, { name: step.name, startedAt: Date.now(), parameters });
                    emitHostedSessionRuntimeEvent(this.hostedSession, {
                        type: RuntimeEventTypes.TOOL_START,
                        toolCallId,
                        ...tool,
                        ...(parameters ? { args: parameters } : {}),
                    });
                }
                if (step.state === "ACTIVE") return;
                const started = nativeTools.get(step.stepIndex);
                if (started?.name !== step.name) return;
                completedTools.add(step.stepIndex);
                // Commit only observed completions: replay must not show an unfinished
                // native tool as still running after its CLI process has exited.
                const call = {
                    role: "assistant",
                    timestamp: started.startedAt,
                    content: [
                        {
                            type: "toolCall",
                            id: toolCallId,
                            name: step.name,
                            arguments: parameters || {},
                        },
                    ],
                    api: this.model.api,
                    provider: this.model.provider,
                    model: this.model.id,
                    stopReason: "toolUse",
                } as SessionAppendMessage;
                this.sessionManager.appendMessage(call);
                this.messages.push(call as AgentMessage);
                const output = step.output || "";
                const isError = step.state === "ERROR";
                const result = {
                    role: "toolResult",
                    timestamp: Date.now(),
                    toolCallId,
                    toolName: step.name,
                    content: [{ type: "text", text: output }],
                    isError,
                } as SessionAppendMessage;
                this.sessionManager.appendMessage(result);
                this.messages.push(result as AgentMessage);
                emitHostedSessionRuntimeEvent(this.hostedSession, {
                    type: RuntimeEventTypes.TOOL_END,
                    toolCallId,
                    ...tool,
                    ...normalizeRuntimeToolResult(output),
                    isError,
                    durationMs: step.durationMs ?? Math.max(0, Date.now() - started.startedAt),
                });
            };
            settleInterruptedTools = () => {
                for (const [stepIndex, tool] of nativeTools) {
                    if (completedTools.has(stepIndex)) continue;
                    const warning =
                        "Antigravity stopped before confirming this tool's result. Its effects are unknown. Inspect the affected state before retrying; do not repeat the action blindly.";
                    onTool({
                        stepIndex,
                        name: tool.name,
                        parameters: tool.parameters,
                        state: "ERROR",
                        output: warning,
                    });
                    this.sessionManager.appendCustomEntry("runwield.interrupted_tool", {
                        backend: "agy-cli",
                        toolName: tool.name,
                        outcome: "unknown",
                        message: warning,
                        requestId: options.requestId,
                        attemptId: options.attemptId,
                    });
                }
            };
            let parseError: Error | null = null;
            try {
                parsed = await runAgyAcpTurn(
                    {
                        cwd: this.cwd,
                        agentName: this.ownership.name,
                        model: this.model.id,
                        effort,
                        userRequest: serializedConversation,
                        onReady: () => {
                            const userMessage = makeUserMessage(options.userRequest);
                            this.sessionManager.appendMessage(userMessage);
                            this.messages.push(userMessage as AgentMessage);
                            appendExecutionBackendEntry(this.sessionManager, this.model, {
                                requestId: options.requestId,
                                attemptId: options.attemptId,
                                thinkingLevel: this.thinkingLevel || "off",
                                effort,
                            });
                        },
                        signal: combinedSignal,
                        terminalSignal: terminalController.signal,
                        mcpServers: bridge
                            ? [
                                  {
                                      name: bridgeServerName,
                                      command: await resolveInstalledWldExecutable(),
                                      args: ["mcp", "agy-cli"],
                                      env: [
                                          { name: RUNWIELD_MCP_BRIDGE_URL_ENV, value: bridge.url },
                                          { name: RUNWIELD_MCP_BRIDGE_TOKEN_ENV, value: bridge.token },
                                      ],
                                  },
                              ]
                            : [],
                        authorizePermission: (request) =>
                            this.authorizePermission(request, bridgedTools, bridgeServerName, combinedSignal),
                    },
                    {
                        onTool,
                        onUsage: (usage) => {
                            observedUsage = usage;
                            usageEndedAt = new Date().toISOString();
                        },
                        onToolInfo: (observation) => {
                            observe(recorder.recordResponseLatency("first_response"));
                            if (
                                !observation.toolName?.startsWith("mcp__runwield__") &&
                                !observation.toolName?.startsWith(`mcp_${bridgeServerName}_`) &&
                                !bridgedTools.some(
                                    (tool) =>
                                        observation.toolName === tool.name ||
                                        observation.toolName === mcpAliasFor(tool.name),
                                )
                            ) {
                                observe(recorder.recordNativeToolInfo(observation));
                            }
                        },
                        onDelta: (delta) => {
                            observe(recorder.recordResponseLatency("first_response"));
                            if (!firstTextDeltaRecorded && delta.text) {
                                firstTextDeltaRecorded = true;
                                observe(recorder.recordResponseLatency("first_text"));
                            }
                            emitHostedSessionRuntimeEvent(this.hostedSession, {
                                type: RuntimeEventTypes.ASSISTANT_TEXT_DELTA,
                                messageId,
                                delta: delta.text,
                                agentName: this.agentDisplayName,
                                messageKind: "assistant",
                            });
                        },
                    },
                );
            } catch (error) {
                parseError = error instanceof Error ? error : new Error(String(error));
            }
            const status: AgyCliProcessStatus = {
                success: !parseError,
                code: parseError ? null : 0,
                terminatedBy: combinedSignal.aborted ? "abort" : null,
            };
            const stderrText = parseError?.message || "";
            const acceptedTerminal = bridge?.acceptedTerminal === true;
            const failure = classifyTurnFailure({
                parsed,
                parseError,
                status,
                stderrText,
                bridgeDisconnected,
                expectedAgent: this.ownership.name,
                expectedModel: expectedBackendModel,
                requestedModel: this.model.id,
                signalAborted: combinedSignal.aborted,
            });
            if (parsed && failure?.kind !== "selection_mismatch") {
                appendExecutionBackendEntry(this.sessionManager, this.model, {
                    requestId: options.requestId,
                    attemptId: options.attemptId,
                    externalConversationId: parsed.metadata.sessionId,
                    thinkingLevel: this.thinkingLevel || "off",
                    effort,
                    backendModel: parsed.metadata.model,
                    modelSelectionSource: parsed.modelSelectionSource,
                });
            }
            if (acceptedTerminal) return this.getMessages();
            if (failure) {
                executionOutcome = combinedSignal.aborted ? "canceled" : "failed";
                failureKind = failure.kind;
                emitFailure(failure, false);
                throw new AgyCliBackendError(failure.kind, {
                    exitCode: failure.exitCode,
                    message: failure.message,
                });
            }
            if (!parsed) {
                executionOutcome = "failed";
                failureKind = "empty_result";
                const fallback = { kind: "empty_result", exitCode: status.code } satisfies ClassifiedFailure;
                emitFailure(fallback, false);
                throw new AgyCliBackendError(fallback.kind, { exitCode: fallback.exitCode });
            }

            const softFailure = classifySoftResultStatus(parsed);
            if (this.persistModelChange) this.sessionManager.appendModelChange(this.model.provider, this.model.id);
            const assistantMessage = makeAssistantMessage(parsed.text, this.model, parsed.metadata.usage);
            this.sessionManager.appendMessage(assistantMessage);
            this.messages.push(assistantMessage as AgentMessage);
            emitHostedSessionRuntimeEvent(this.hostedSession, {
                type: RuntimeEventTypes.USAGE,
                usage: toRuntimeUsage(parsed.metadata.usage),
            });
            if (softFailure) emitFailure(softFailure, false);
            return this.getMessages();
        } finally {
            settleInterruptedTools?.();
            if (bridge) await bridge.close();
            this.isStreaming = false;
            this.turnAbortController = null;
            const usage = parsed?.metadata?.usage ?? observedUsage;
            if (usage) {
                const priceModel = getExternalCliPriceModel(this.model);
                // Pricing alone treats unreported buckets as 0. Persisted measurements stay null.
                const priceUsage: Usage = {
                    input: usage.inputTokens ?? 0,
                    output: usage.outputTokens ?? 0,
                    cacheRead: usage.cacheReadTokens ?? 0,
                    cacheWrite: usage.cacheWriteTokens ?? 0,
                    totalTokens:
                        (usage.inputTokens ?? 0) +
                        (usage.outputTokens ?? 0) +
                        (usage.cacheReadTokens ?? 0) +
                        (usage.cacheWriteTokens ?? 0),
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                };
                const costAmount = priceModel ? calculateCost(priceModel, priceUsage).total : null;
                await recorder.recordModelUsage({
                    startedAt: recorder.getObservedTurnStartedAt(),
                    endedAt: usageEndedAt,
                    reasoningTokens: usage.thinkingTokens,
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    cacheReadTokens: usage.cacheReadTokens,
                    cacheWriteTokens: usage.cacheWriteTokens,
                    costAmount,
                    costSource: costAmount === null ? "unavailable" : "calculated",
                    costAvailability: costAmount === null ? "unavailable" : "complete",
                    measurementAvailability: [
                        usage.inputTokens,
                        usage.outputTokens,
                        usage.cacheReadTokens,
                        usage.cacheWriteTokens,
                    ].some((value) => value !== null)
                        ? "partial"
                        : "unavailable",
                    inputCacheBasis: "excludes_cache",
                    model: this.model.id,
                    provider: this.model.provider,
                });
            }
            observe(recorder.recordResponseLatency("turn_finish"));
            await Promise.allSettled([...pendingObservations]);
            await recorder.settleExecution(executionOutcome, failureKind);
            this.hostedSession?.forgetExecutionToolCalls(recorder.executionId);
        }
    }

    private async authorizePermission(
        request: AgyAcpPermissionRequest,
        tools: ToolDefinition[],
        bridgeServerName: string,
        signal: AbortSignal,
    ): Promise<boolean> {
        if (signal.aborted) return false;
        const definition = tools.find((tool) => request.name === `mcp_${bridgeServerName}_${mcpAliasFor(tool.name)}`);
        // Vendor MCP permissions can omit all actual arguments. This only opens
        // the exact owned transport envelope; authorizeBridgeCall gates effects.
        if (definition) return true;
        if (request.name.startsWith("mcp_")) return false;
        // Do not ask for approval of an unspecified native effect. Unknown vendor
        // schemas fail closed until their action details can be shown accurately.
        const input = request.arguments;
        const nonempty = (key: string) => typeof input[key] === "string" && input[key].trim().length > 0;
        const fullWrite =
            this.nativeTools.has("write_to_file") &&
            ["write_file", "write_to_file"].includes(request.name) &&
            (nonempty("Path") || nonempty("TargetFile")) &&
            typeof input.Content === "string";
        const fullCommand =
            this.nativeTools.has("run_command") && request.name === "run_command" && nonempty("CommandLine");
        const fullRead =
            this.nativeTools.has("view_file") &&
            ["read_file", "view_file"].includes(request.name) &&
            (nonempty("Path") || nonempty("AbsolutePath"));
        const fullEdit =
            this.nativeTools.has("replace_file_content") &&
            request.name === "replace_file_content" &&
            nonempty("TargetFile") &&
            typeof input.TargetContent === "string" &&
            typeof input.ReplacementContent === "string";
        const fullMultiEdit =
            this.nativeTools.has("replace_file_content") &&
            request.name === "multi_replace_file_content" &&
            nonempty("TargetFile") &&
            Array.isArray(input.ReplacementChunks) &&
            input.ReplacementChunks.length > 0 &&
            input.ReplacementChunks.every(
                (chunk) =>
                    chunk !== null &&
                    typeof chunk === "object" &&
                    !Array.isArray(chunk) &&
                    typeof chunk.TargetContent === "string" &&
                    typeof chunk.ReplacementContent === "string",
            );
        if (!fullWrite && !fullCommand && !fullRead && !fullEdit && !fullMultiEdit) return false;
        return await this.askPermission(request, signal);
    }

    private async authorizeBridgeCall(
        request: RunWieldMcpAuthorizationRequest,
        tools: ToolDefinition[],
        signal: AbortSignal,
    ): Promise<boolean> {
        if (signal.aborted) return false;
        const definition = tools.find((tool) => tool.name === request.name);
        if (!definition) return false;
        const args = JSON.parse(JSON.stringify(request.arguments)) as typeof request.arguments;
        try {
            const submitted = JSON.stringify(args);
            const validated = validateToolCall(
                [{ name: definition.name, description: definition.description, parameters: definition.parameters }],
                { type: "toolCall", id: request.toolCallId, name: definition.name, arguments: args },
            );
            if (JSON.stringify(validated) !== submitted) return false;
        } catch {
            return false;
        }
        // These owned lifecycle handlers enforce workflow identity/state themselves.
        if (
            ["plan_written", "task_completed", "review_complete", "triage_report", "pair_checkpoint"].includes(
                definition.name,
            )
        )
            return true;
        return await this.askPermission(request, signal);
    }

    private async askPermission(request: RunWieldMcpAuthorizationRequest, signal: AbortSignal): Promise<boolean> {
        if (!this.hostedSession) return false;
        const response = await requestHostedSessionInteraction(
            this.hostedSession,
            {
                type: RuntimeInteractionTypes.APPROVAL,
                prompt: `Antigravity requests ${request.name}. Allow this action once?\n${JSON.stringify(request.arguments)}`,
                toolCallId: request.toolCallId,
                options: [
                    { value: "approve", label: "Allow once" },
                    { value: "deny", label: "Deny" },
                ],
            },
            signal,
            this.hostedSession.getManagedOperationCapability(),
        );
        return (
            response.outcome === RuntimeInteractionOutcomes.ACCEPTED ||
            (response.outcome === RuntimeInteractionOutcomes.SELECTED && response.value === "approve")
        );
    }

    private async verifyCustomAgentReady(signal: AbortSignal): Promise<void> {
        await verifyAgyCustomAgentOwnership(this.ownership);
        if (signal.aborted) throw new AgyCliBackendError("canceled");
    }

    private emitCleanupWarning(error: Error | string): void {
        if (this.cleanupStatusEmitted) return;
        this.cleanupStatusEmitted = true;
        emitAgyBackendStatus(
            this.hostedSession,
            this.sessionManager,
            buildAgyBackendStatusEntry("cleanup_failed", { message: getErrorText(error) }),
        );
    }

    private readMessages(): AgentMessage[] {
        return this.sessionManager.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
    }
}

function classifySetupFailure(error: Error | string): ClassifiedFailure {
    if (error instanceof AgyCliBackendError) {
        return {
            kind: error.kind,
            exitCode: error.exitCode,
            ...(error.kind === "custom_agent_invalid" ? {} : { message: error.message }),
        };
    }
    const message = getErrorText(error);
    if (isAgyAuthFailure(message)) return { kind: "auth_failed", exitCode: null, message };
    if (isAgyMcpUnavailable(message)) return { kind: "mcp_unavailable", exitCode: null, message };
    return { kind: "custom_agent_invalid", exitCode: null };
}

function classifyTurnFailure(options: {
    parsed: AgyCliParseResult | null;
    parseError: Error | null;
    status: AgyCliProcessStatus;
    stderrText: string;
    bridgeDisconnected: boolean;
    expectedAgent: string;
    expectedModel: string;
    requestedModel: string;
    signalAborted: boolean;
}): ClassifiedFailure | null {
    const {
        parsed,
        parseError,
        status,
        stderrText,
        bridgeDisconnected,
        expectedAgent,
        expectedModel,
        requestedModel,
        signalAborted,
    } = options;
    if (parseError instanceof AgyCliBackendError)
        return { kind: parseError.kind, exitCode: parseError.exitCode, message: parseError.message };
    if (status.terminatedBy === "abort" && signalAborted) return { kind: "canceled", exitCode: status.code };
    if (status.terminatedBy === "timeout") return { kind: "timeout", exitCode: status.code };
    const processDetail = stderrText || parsed?.metadata.errorText || parsed?.text || "";
    if ((parseError || !status.success) && isAgyAuthFailure(processDetail)) {
        return { kind: "auth_failed", exitCode: status.code, message: processDetail };
    }
    if ((parseError || !status.success) && isAgyPermissionDenied(processDetail)) {
        return { kind: "permission_denied", exitCode: status.code, message: processDetail };
    }
    if ((parseError || !status.success) && isAgyMcpUnavailable(processDetail)) {
        return { kind: "mcp_unavailable", exitCode: status.code, message: processDetail };
    }
    if (!status.success && status.terminatedBy !== "abort") {
        return { kind: "non_zero_exit", exitCode: status.code, message: processDetail };
    }
    if (parseError) {
        if (parseError instanceof AgyCliStreamError) {
            return { kind: parseError.kind, exitCode: status.code };
        }
        return { kind: "malformed_stream", exitCode: status.code, message: parseError.message };
    }
    if (!parsed) return { kind: "empty_result", exitCode: status.code };
    if (parsed.metadata.agent && parsed.metadata.agent !== expectedAgent) {
        return { kind: "selection_mismatch", exitCode: status.code };
    }
    // CLI versions report either the requested family or the resolved effort-specific model.
    if (parsed.metadata.model !== expectedModel && parsed.metadata.model !== requestedModel) {
        return {
            kind: "selection_mismatch",
            exitCode: status.code,
            message: `Antigravity CLI reported model ${
                parsed.metadata.model || "[missing]"
            } instead of ${expectedModel}.`,
        };
    }
    if (parsed.metadata.permissionDenied && !parsed.text) {
        return { kind: "permission_denied", exitCode: status.code, message: permissionFailureMessage(parsed) };
    }
    if (!isResultStatusSuccess(parsed.metadata.status)) {
        if (parsed.text && (parsed.metadata.permissionDenied || parsed.metadata.mcpUnavailable)) return null;
        if (parsed.metadata.authFailed) {
            return { kind: "auth_failed", exitCode: status.code, message: parsed.metadata.errorText };
        }
        if (parsed.metadata.permissionDenied) {
            return { kind: "permission_denied", exitCode: status.code, message: permissionFailureMessage(parsed) };
        }
        if (parsed.metadata.mcpUnavailable) {
            return { kind: "mcp_unavailable", exitCode: status.code, message: parsed.metadata.errorText };
        }
        return { kind: "non_zero_exit", exitCode: status.code, message: parsed.metadata.errorText || parsed.text };
    }
    if (bridgeDisconnected) return { kind: "bridge_disconnected", exitCode: status.code };
    return null;
}

function classifySoftResultStatus(parsed: AgyCliParseResult): ClassifiedFailure | null {
    if (!parsed.text) return null;
    if (parsed.metadata.permissionDenied) {
        return { kind: "permission_denied", exitCode: 0, message: permissionFailureMessage(parsed) };
    }
    if (parsed.metadata.mcpUnavailable) {
        return { kind: "mcp_unavailable", exitCode: 0, message: parsed.metadata.errorText || parsed.text };
    }
    return null;
}

function permissionFailureMessage(parsed: AgyCliParseResult): string {
    return [
        "Antigravity could not approve an action in noninteractive mode.",
        ...parsed.metadata.permissionDetails.map((detail) => `Blocked: ${detail}`),
        parsed.metadata.errorText,
        "Review the action in Antigravity's /permissions, then retry this turn.",
    ]
        .filter(Boolean)
        .join("\n");
}

function isResultStatusSuccess(status: string): boolean {
    return !status || status === "success" || status === "ok" || status === "completed";
}

function getErrorText(error: Error | string): string {
    return error instanceof Error ? error.message : String(error);
}

export function resolveAgyNativeTools(declaredTools?: string[]): string[] {
    if (!declaredTools) {
        return ["run_command", "write_to_file", "replace_file_content", "view_file"];
    }
    const declared = new Set(declaredTools);
    const nativeTools: string[] = [];
    if (declared.has("bash") || declared.has("run_command")) {
        nativeTools.push("run_command");
    }
    if (declared.has("write") || declared.has("write_docs") || declared.has("write_to_file")) {
        nativeTools.push("write_to_file");
    }
    if (
        declared.has("edit") ||
        declared.has("edit_docs") ||
        declared.has("multi_file_edit") ||
        declared.has("replace_file_content")
    ) {
        nativeTools.push("replace_file_content");
    }
    if (declared.has("read") || declared.has("view") || declared.has("view_file")) {
        nativeTools.push("view_file");
    }
    if (nativeTools.length === 0) {
        nativeTools.push("view_file");
    }
    return nativeTools;
}

function formatAgyCustomAgentDefinition(
    selector: string,
    systemPrompt: string,
    displayName: string,
    tools: string[] = ["run_command", "write_to_file", "replace_file_content", "view_file"],
): string {
    const lines = ["---", `name: ${selector}`, `description: Temporary RunWield ${displayName} execution agent`];
    if (tools.length > 0) {
        lines.push("tools:");
        for (const tool of tools) {
            lines.push(`  - ${tool}`);
        }
    }
    lines.push(
        "excludeDefaultComponents: true",
        "inheritMcp: false",
        "inheritCustomizations: false",
        "---",
        "",
        systemPrompt.trim(),
        "",
    );
    return lines.join("\n");
}

function makeTemporaryAgentSelector(agentName: string): string {
    const sanitized =
        agentName
            .toLowerCase()
            .replace(/[^a-z0-9._-]+/g, "-")
            .replace(/^-+|-+$/g, "") || "agent";
    return `runwield-${sanitized}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function makeUserMessage(text: string): SessionAppendMessage {
    return {
        role: "user",
        timestamp: Date.now(),
        content: [{ type: "text", text }],
    };
}

// Pi requires usage on assistant messages; CLI transcripts omit it when no measurement was reported.
function makeAssistantMessage(text: string, model: RunWieldModel, usage: AgyCliUsage): SessionAppendMessage {
    return {
        role: "assistant",
        timestamp: Date.now(),
        content: [{ type: "text", text }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        ...(Object.values(usage).some((value) => value !== null) ? { usage: toPiUsage(usage) } : {}),
        stopReason: "stop",
    } as SessionAppendMessage;
}

function toRuntimeUsage(usage: AgyCliUsage) {
    return normalizeRuntimeUsage({ ...usage, costUsd: null });
}

function toPiUsage(usage: AgyCliUsage): Usage {
    const normalized = toRuntimeUsage(usage);
    const tokens = [
        normalized.inputTokens,
        normalized.outputTokens,
        normalized.cacheReadTokens,
        normalized.cacheWriteTokens,
    ];
    // Pi requires numeric Usage fields. Persist the honest partial shape instead:
    // absent measurements and unreported cost components must not become measured zeros.
    // A total is available only when all token categories are known.
    return {
        ...(normalized.inputTokens !== null ? { input: normalized.inputTokens } : {}),
        ...(normalized.outputTokens !== null ? { output: normalized.outputTokens } : {}),
        ...(normalized.cacheReadTokens !== null ? { cacheRead: normalized.cacheReadTokens } : {}),
        ...(normalized.cacheWriteTokens !== null ? { cacheWrite: normalized.cacheWriteTokens } : {}),
        ...(tokens.every((value) => value !== null)
            ? { totalTokens: tokens.reduce<number>((total, value) => total + (value ?? 0), 0) }
            : {}),
        ...(normalized.costUsd !== null ? { cost: { total: normalized.costUsd } } : {}),
    } as Usage;
}

function appendExecutionBackendEntry(
    sessionManager: SessionManager,
    model: RunWieldModel,
    options: {
        requestId?: string;
        attemptId?: string;
        externalConversationId?: string;
        thinkingLevel?: string;
        effort?: AgyCliEffort;
        backendModel?: string;
        modelSelectionSource?: "config_options" | "models";
    },
): void {
    sessionManager.appendCustomEntry("runwield.execution_backend", {
        version: 1,
        backend: "agy-cli",
        provider: model.provider,
        model: model.id,
        outputFormat: "acp",
        ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.backendModel ? { backendModel: options.backendModel } : {}),
        ...(options.modelSelectionSource ? { modelSelectionSource: options.modelSelectionSource } : {}),
        ...(options.requestId ? { requestId: options.requestId } : {}),
        ...(options.attemptId ? { attemptId: options.attemptId } : {}),
        ...(options.externalConversationId ? { externalConversationId: options.externalConversationId } : {}),
    });
}
