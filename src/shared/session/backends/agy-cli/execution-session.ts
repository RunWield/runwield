import type { McpIntegration } from "../../../mcp/integration.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunWieldModel } from "../../../models/model-registry.ts";
import type { HostedSession } from "../../hosted-session.js";
import {
    emitHostedSessionRuntimeEvent,
    normalizeRuntimeToolResult,
    RuntimeEventTypes,
} from "../../session-runtime-events.js";
import { describeRuntimeTool } from "../../tool-event-title.js";
import {
    cleanupAgyCustomAgent,
    materializeAgyCustomAgent,
    resolveAgyCustomAgentPaths,
    verifyAgyCustomAgentOwnership,
} from "./custom-agent.ts";
import type { AgyCustomAgentOwnership } from "./custom-agent.ts";
import { prepareAgyCliAgentsCommand, prepareAgyCliStreamCommand } from "./command.ts";
import { concreteAgyModel, thinkingLevelToEffort } from "./model-options.ts";
import { DenoAgyCliProcessPort } from "./process.ts";
import type { AgyCliProcessResult, AgyCliProcessStatus } from "./process.ts";
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
    startRunWieldMcpBridge,
} from "../../bridged-tools/mcp-bridge.ts";
import { RUNWIELD_MCP_BRIDGE_TOKEN_ENV, RUNWIELD_MCP_BRIDGE_URL_ENV } from "../../bridged-tools/stdio-transport.ts";
import { AgyCliStreamError, parseAgyCliStream } from "./stream-parser.ts";
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
}

interface ClassifiedFailure {
    kind: AgyCliBackendStatusKind;
    exitCode: number | null;
    message?: string;
}

interface AgyParseOutcome {
    parsed: AgyCliParseResult | null;
    parseError: Error | null;
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
    private messages: AgentMessage[] = [];
    private activeProcess: AgyCliProcessResult | null = null;
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
        this.messages = this.readMessages();
    }

    static async create(options: AgyCliExecutionSessionOptions): Promise<AgyCliExecutionSession> {
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
            await verifyAgyCustomAgentListed(selector, options.cwd);
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
        this.activeProcess?.kill();
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
            commandId: this.hostedSession?.activeCommandInvocationId || undefined,
            sessionId: this.sessionManager.getSessionId(),
            managedSessionId: this.hostedSession?.getManagedMetadata()?.runwieldSessionId,
            segmentId: options.executionKind === "root"
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

        let bridge: RunWieldMcpBridgeHandle | null = null;
        let process: AgyCliProcessResult | null = null;
        let bridgeDisconnected = false;
        this.turnAbortController = new AbortController();
        const combinedSignal = options.signal
            ? AbortSignal.any([options.signal, this.turnAbortController.signal])
            : this.turnAbortController.signal;
        this.isStreaming = true;

        let firstTextDeltaRecorded = false;
        let parsed: AgyCliParseResult | null = null;
        let observedUsage: AgyCliUsage | null = null;
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
                        onTerminalAccepted: () => process?.kill(),
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

            const command = prepareAgyCliStreamCommand({
                cwd: this.cwd,
                agentName: this.ownership.name,
                model: this.model.id,
                userRequest: serializedConversation,
                effort,
                env: bridge
                    ? {
                        [RUNWIELD_MCP_BRIDGE_URL_ENV]: bridge.url,
                        [RUNWIELD_MCP_BRIDGE_TOKEN_ENV]: bridge.token,
                    }
                    : undefined,
            });
            const processPort = new DenoAgyCliProcessPort();
            try {
                process = processPort.run(command, this.cwd, combinedSignal);
                this.activeProcess = process;
                if (process.pid === null) {
                    executionOutcome = "canceled";
                    failureKind = "canceled";
                    const failure: ClassifiedFailure = { kind: "canceled", exitCode: null };
                    emitFailure(failure, false);
                    throw new AgyCliBackendError(failure.kind, { exitCode: failure.exitCode });
                }
            } catch (error) {
                const failure = classifySetupFailure(error instanceof Error ? error : String(error));
                executionOutcome = failure.kind === "canceled" || combinedSignal.aborted ? "canceled" : "failed";
                failureKind = failure.kind;
                emitFailure(failure, false);
                throw new AgyCliBackendError(failure.kind, { exitCode: failure.exitCode, message: failure.message });
            }

            const userMessage = makeUserMessage(options.userRequest);
            this.sessionManager.appendMessage(userMessage);
            this.messages.push(userMessage as AgentMessage);
            appendExecutionBackendEntry(this.sessionManager, this.model, {
                requestId: options.requestId,
                attemptId: options.attemptId,
                thinkingLevel: this.thinkingLevel || "off",
                effort,
            });

            const messageId = `agy-cli-assistant:${crypto.randomUUID()}`;
            const nativeTools = new Map<
                number,
                { name: string; startedAt: number; parameters?: AgyCliToolStep["parameters"] }
            >();
            const completedTools = new Set<number>();
            const onTool = (step: AgyCliToolStep): void => {
                // The MCP bridge already records and emits its own calls.
                if (step.name === "call_mcp_tool" || completedTools.has(step.stepIndex)) return;
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
                    content: [{
                        type: "toolCall",
                        id: toolCallId,
                        name: step.name,
                        arguments: parameters || {},
                    }],
                    api: this.model.api,
                    provider: this.model.provider,
                    model: this.model.id,
                    usage: toPiUsage(zeroUsage()),
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
            const parseOutcomePromise = parseAgyCliStream(process.stdout, {
                onTool,
                onUsage: (usage) => {
                    observedUsage = usage;
                },
                onToolInfo: (observation) => {
                    observe(recorder.recordResponseLatency("first_response"));
                    if (
                        !observation.toolName?.startsWith("mcp__runwield__") &&
                        !bridgedTools.some((tool) =>
                            observation.toolName === tool.name ||
                            observation.toolName === mcpAliasFor(tool.name)
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
            }).then(
                (parsed): AgyParseOutcome => ({ parsed, parseError: null }),
                (error): AgyParseOutcome => ({
                    parsed: null,
                    parseError: error instanceof Error ? error : new Error(String(error)),
                }),
            );
            const status = await waitForAgyProcessExit(process, parseOutcomePromise);
            process.kill();
            const [{ parsed: streamParsed, parseError }, stderrText] = await Promise.all([
                parseOutcomePromise,
                process.stderrText,
            ]);
            parsed = streamParsed;
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
                });
            }
            if (acceptedTerminal) return this.getMessages();
            if (failure) {
                process.kill();
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
            if (bridge) await bridge.close();
            this.activeProcess = null;
            this.isStreaming = false;
            this.turnAbortController = null;
            const usage = parsed?.metadata?.usage ?? observedUsage;
            if (usage) {
                await recorder.recordModelUsage({
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    cacheReadTokens: usage.cacheReadTokens,
                    cacheWriteTokens: usage.cacheWriteTokens,
                    costUsd: null,
                    costSource: "unavailable",
                    measurementAvailability: usage.inputTokens !== null &&
                            usage.outputTokens !== null
                        ? "partial"
                        : "unavailable",
                    inputCacheBasis: "unknown",
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

    private async verifyCustomAgentReady(signal: AbortSignal): Promise<void> {
        await verifyAgyCustomAgentOwnership(this.ownership);
        await verifyAgyCustomAgentListed(this.ownership.name, this.cwd, signal);
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
        return readExternalCliConversation(this.sessionManager).map((message) => {
            return message.role === "user"
                ? makeUserMessage(message.text) as AgentMessage
                : makeAssistantMessage(message.text, this.model, zeroUsage()) as AgentMessage;
        });
    }
}

async function waitForAgyProcessExit(
    process: AgyCliProcessResult,
    parseOutcomePromise: Promise<AgyParseOutcome>,
): Promise<AgyCliProcessStatus> {
    const first = await Promise.race([
        process.completed.then((status) => ({ kind: "status" as const, status })),
        parseOutcomePromise.then((outcome) => ({ kind: "parse" as const, outcome })),
    ]);
    if (first.kind === "status") return first.status;
    return await process.completed;
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

async function verifyAgyCustomAgentListed(agentName: string, cwd: string, signal?: AbortSignal): Promise<void> {
    const processPort = new DenoAgyCliProcessPort();
    const result = processPort.run(prepareAgyCliAgentsCommand(), cwd, signal);
    const stdoutTextPromise = new Response(result.stdout).text().catch(() => "");
    const [status, stderrText, stdoutText] = await Promise.all([
        result.completed,
        result.stderrText,
        stdoutTextPromise,
    ]);
    if (!status.success) {
        const detail = stderrText || `agy /agents exited with code ${status.code}`;
        if (signal?.aborted) {
            throw new AgyCliBackendError("canceled", { exitCode: status.code });
        }
        if (status.terminatedBy === "timeout") {
            throw new AgyCliBackendError("timeout", { exitCode: status.code });
        }
        if (isAgyAuthFailure(detail)) {
            throw new AgyCliBackendError("auth_failed", { exitCode: status.code, message: detail });
        }
        if (status.terminatedBy === "abort") {
            throw new AgyCliBackendError("canceled", { exitCode: status.code });
        }
        if (isAgyMcpUnavailable(detail)) {
            throw new AgyCliBackendError("mcp_unavailable", { exitCode: status.code, message: detail });
        }
        throw new AgyCliBackendError("custom_agent_invalid", { exitCode: status.code, message: detail });
    }
    let parsed: JsonValue;
    try {
        parsed = JSON.parse(stdoutText) as JsonValue;
    } catch {
        throw new AgyCliBackendError("custom_agent_invalid", { message: "agy /agents did not return JSON" });
    }
    if (!agentListContainsExactName(parsed, agentName)) {
        throw new AgyCliBackendError("custom_agent_invalid", {
            message: "agy /agents did not list the expected RunWield custom agent",
        });
    }
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
    ].filter(Boolean).join("\n");
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
        declared.has("edit") || declared.has("edit_docs") || declared.has("multi_file_edit") ||
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
    const lines = [
        "---",
        `name: ${selector}`,
        `description: Temporary RunWield ${displayName} execution agent`,
    ];
    if (tools.length > 0) {
        lines.push("tools:");
        for (const tool of tools) {
            lines.push(`  - ${tool}`);
        }
    }
    lines.push("---", "", systemPrompt.trim(), "");
    return lines.join("\n");
}

function makeTemporaryAgentSelector(agentName: string): string {
    const sanitized = agentName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
    return `runwield-${sanitized}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

type JsonScalar = string | number | boolean | null;
type JsonArray = JsonValue[];
interface JsonRecord {
    [key: string]: JsonValue;
}
type JsonValue = JsonScalar | JsonArray | JsonRecord;

function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readAgentList(value: JsonValue): JsonArray | null {
    if (Array.isArray(value)) return value;
    if (!isJsonRecord(value)) return null;
    if (Array.isArray(value.agents)) return value.agents;
    if (isJsonRecord(value.data) && Array.isArray(value.data.agents)) return value.data.agents;
    if (isJsonRecord(value.command) && isJsonRecord(value.command.data) && Array.isArray(value.command.data.agents)) {
        return value.command.data.agents;
    }
    return null;
}

function agentEntryMatchesName(value: JsonValue, expected: string): boolean {
    if (typeof value === "string") return value === expected;
    if (!isJsonRecord(value)) return false;
    return value.name === expected;
}

function agentListContainsExactName(value: JsonValue, expected: string): boolean {
    const agents = readAgentList(value);
    return Boolean(agents?.some((agent) => agentEntryMatchesName(agent, expected)));
}

function makeUserMessage(text: string): SessionAppendMessage {
    return {
        role: "user",
        timestamp: Date.now(),
        content: [{ type: "text", text }],
    };
}

function makeAssistantMessage(text: string, model: RunWieldModel, usage: AgyCliUsage): SessionAppendMessage {
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

function zeroUsage(): AgyCliUsage {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null };
}

function toPiUsage(usage: AgyCliUsage) {
    return {
        input: usage.inputTokens ?? 0,
        output: usage.outputTokens ?? 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}

function toRuntimeUsage(usage: AgyCliUsage) {
    return {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
    };
}

function appendExecutionBackendEntry(
    sessionManager: SessionManager,
    model: RunWieldModel,
    options: {
        requestId?: string;
        attemptId?: string;
        externalConversationId?: string;
        thinkingLevel?: string;
        effort?: "low" | "medium" | "high";
        backendModel?: string;
    },
): void {
    sessionManager.appendCustomEntry("runwield.execution_backend", {
        version: 1,
        backend: "agy-cli",
        provider: model.provider,
        model: model.id,
        outputFormat: "stream-json",
        ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.backendModel ? { backendModel: options.backendModel } : {}),
        ...(options.requestId ? { requestId: options.requestId } : {}),
        ...(options.attemptId ? { attemptId: options.attemptId } : {}),
        ...(options.externalConversationId ? { externalConversationId: options.externalConversationId } : {}),
    });
}
