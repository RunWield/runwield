/**
 * @module @runwield/acp/server
 * Bind a Session Runtime to an ACP connection.
 */

import type {
    AgentApp,
    AgentConnection,
    AgentRequestMethod,
    ClientCapabilities,
    ClientNotificationMethod,
    InitializeRequest,
    InitializeResponse,
    PromptRequest,
    PromptResponse,
    SessionNotification,
    Stream,
} from "@agentclientprotocol/sdk/unstable";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk/unstable";
import { methods as nesMethods } from "@agentclientprotocol/sdk/experimental/nes";
import { isAbsolute } from "node:path";
import type { JsonRecord, JsonValue } from "@runwield/parsing/jsonc";
import type { UserPromptResult } from "@runwield/session-runtime";
import { SessionTurnInProgressError } from "@runwield/session-runtime/errors";
import type { ImageAttachment, SessionRuntimeEvent } from "@runwield/session-runtime/events";
import { RuntimeEventTypes } from "@runwield/session-runtime/events";
import type { RuntimeInteractionRequest, RuntimeInteractionResponse } from "@runwield/session-runtime/interactions";
import { RuntimeInteractionOutcomes } from "@runwield/session-runtime/interactions";
import type { AcpInteractionContext, AcpReviewServices } from "./interaction-mapper.ts";
import { createAcpInteractionAdapter } from "./interaction-mapper.ts";
import type { AcpPromptRecord } from "./session-map.ts";
import { AcpSessionMap, normalizeAcpSessionIdForLoad } from "./session-map.ts";
import {
    type AcpCommandCatalog,
    type AcpContextUsage,
    buildAcpCommandCatalog,
    mapRuntimeContextToAcpUpdate,
    mapRuntimeEventToAcpSessionNotification,
} from "./event-mapper.ts";
import { formatChatQuestion, parseChatReply } from "./chat-interaction.ts";
import { buildAcpModelOptions, type AcpModelSelection } from "./model-options.ts";
import { convertAcpPrompt, type AcpPromptBlock } from "./prompt-codec.ts";
import { ACP_STEERING_METHOD, decodeAcpSteeringRequest, type AcpSteeringResponse } from "./steering-codec.ts";
import type { AcpServerCommandHost, AcpServerModelHost, AcpServerOptions, AcpServerRuntime } from "./server-host.ts";

interface AcpBuiltinCommand {
    name: string;
    args: string[];
}

type ReleasePrompt = (requestId: string, release: () => void) => void;

type AcpCatalogRuntime = Pick<
    AcpServerRuntime,
    "getSessionSnapshot" | "listSessionPromptTemplates" | "listSessionSkills"
>;
type AcpLiveRuntime = AcpCatalogRuntime &
    Pick<
        AcpServerRuntime,
        | "answerInteraction"
        | "cancelSession"
        | "setInteractionAdapter"
        | "subscribeSessionEvents"
        | "queueNextTurnMessage"
    >;

interface AcpLiveOperationOptions {
    runtime: AcpLiveRuntime;
    sessionMap: AcpSessionMap;
    acpSessionId: string;
    runtimeSessionId: string;
    clientCapabilities: ClientCapabilities | null;
    releasePromptAfterResponse?: ReleasePrompt;
    commandCatalog?: AcpCommandCatalog;
    models?: AcpServerModelHost;
    review?: AcpReviewServices;
}

interface AcpPromptContext extends AcpNotificationContext {
    requestId?: string | number | null;
}

interface AcpBuiltinCommandOptions extends AcpLiveOperationOptions {
    commands: AcpServerCommandHost;
    context: AcpPromptContext;
    commandName: string;
    args: string[];
    requestId?: string;
    onOperation(operation: ReturnType<typeof createLiveOperation>): void;
}

interface AcpPendingQuestion {
    interaction: RuntimeInteractionRequest;
    delivered: boolean;
    queued: boolean;
}

type AcpTurnResult = Pick<UserPromptResult, "ok" | "error">;

interface AcpCommandMessageMetadata {
    command: string;
    level: string;
}

type PendingNotification = (context: AcpNotificationContext) => void | Promise<void>;

const ACP_AUTH_REQUIRED = -32000;
const ACP_NOT_IMPLEMENTED = -32004;
const ACP_INVALID_PARAMS = -32602;
const ACP_NOT_FOUND = -32001;
const ACP_INVALID_STATE = -32002;
const ACP_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

type AcpThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

function isAcpThinkingLevel(value: string): value is AcpThinkingLevel {
    return ACP_THINKING_LEVELS.has(value);
}

function isRecord<Value>(value: Value): value is Value & JsonRecord {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function supportsTerminalAuth(clientCapabilities: ClientCapabilities | null | undefined) {
    if (!isRecord(clientCapabilities)) return false;
    const capabilities = clientCapabilities;
    const auth = capabilities.auth;
    if (isRecord(auth) && auth.terminal === true) return true;
    const meta = capabilities._meta;
    return isRecord(meta) && meta["terminal-auth"] === true;
}

function throwAuthenticationRequired(cwd: string): never {
    throw new RequestError(
        ACP_AUTH_REQUIRED,
        "RunWield login and default model setup are required before starting ACP.",
        {
            cwd,
        },
    );
}

function isAuthenticationSetupFailure(message: string) {
    return (
        /^Unknown .*model:/.test(message) ||
        /^Invalid .*model:/.test(message) ||
        /^No configured model found/.test(message) ||
        /^No API key configured for /.test(message) ||
        /^No configured auth for provider /.test(message) ||
        message.includes("missing_auth")
    );
}

type AcpStream = Stream;

type AcpNotificationContext = AcpInteractionContext;

interface AcpServerContext extends AcpServerOptions {
    sessionMap: AcpSessionMap;
    releasePromptAfterResponse: ReleasePrompt;
    operations: Map<string, ReturnType<typeof createLiveOperation>>;
    trackSessionChange<Result>(start: () => Promise<Result>): Promise<Result>;
}

/**
 * Build the stable initialize response for the ACP MVP.
 *
 * The response always carries the version RunWield speaks. ACP negotiation puts the
 * decision on the Client: it reads the Agent's version and either accepts it or
 * disconnects. Echoing a requested version RunWield does not implement would tell the
 * Client the wrong thing.
 */
function createInitializeResponse(
    request: InitializeRequest | undefined,
    options: Pick<AcpServerOptions, "agentInfo" | "models" | "runtime" | "terminalAuth">,
): InitializeResponse {
    const { agentInfo, models, runtime, terminalAuth } = options;
    const supportsDelete = runtime.canArchiveSavedSessions();
    const authMethods = terminalAuth && supportsTerminalAuth(request?.clientCapabilities) ? [terminalAuth] : [];
    return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
            loadSession: true,
            promptCapabilities: {
                image: true,
                _meta: { runwield: { contentTypes: ["text", "image", "resource_link"] } },
            },
            sessionCapabilities: {
                close: {},
                ...(supportsDelete ? { delete: {} } : {}),
                _meta: {
                    runwield: {
                        implementedMethods: [
                            "session/new",
                            "session/load",
                            "session/prompt",
                            ACP_STEERING_METHOD,
                            "session/cancel",
                            "session/close",
                            ...(supportsDelete ? ["session/delete"] : []),
                            ...(models ? ["session/set_config_option"] : []),
                        ],
                        updateNotifications: ["session/update"],
                    },
                },
            },
        },
        authMethods,
        agentInfo,
        _meta: { steering: { supported: true } },
    };
}

function throwUnimplemented(method: string): never {
    throw new RequestError(ACP_NOT_IMPLEMENTED, `RunWield ACP method is not implemented yet: ${method}`, {
        method,
        phase: "session-runtime-acp-mvp",
    });
}

function throwInvalidParams(message: string, data: Record<string, JsonValue | undefined> = {}): never {
    throw new RequestError(ACP_INVALID_PARAMS, message, data);
}

function throwUnknownSession(sessionId: string): never {
    throw new RequestError(ACP_NOT_FOUND, `Unknown ACP session: ${sessionId}`, { sessionId });
}

function throwProjectRuntimeRefusal(
    error: Error,
    cwd: string,
    describe: AcpServerOptions["describeProjectRefusal"],
): void {
    const refusal = describe?.(error);
    if (!refusal) return;
    throw new RequestError(ACP_INVALID_STATE, error.message, { cwd, ...refusal });
}

function notifyClient(context: AcpNotificationContext, method: ClientNotificationMethod, params: SessionNotification) {
    const maybeContextNotify = context.notify;
    if (typeof maybeContextNotify === "function") {
        return maybeContextNotify.call(context, method, params);
    }
    const clientContext = context.client;
    if (clientContext && typeof clientContext.notify === "function") {
        return clientContext.notify(method, params);
    }
    return Promise.resolve();
}

function registerUnimplementedRequest(app: AgentApp, method: AgentRequestMethod) {
    app.onRequest(method, () => throwUnimplemented(method));
}

type McpServerDefinition = NonNullable<Parameters<AcpServerRuntime["createSession"]>[0]["mcpServers"]>[number];

function isJsonArray(value: JsonValue | undefined): value is JsonValue[] {
    return Array.isArray(value);
}

function validateAcpMcpEnv(value: JsonValue | undefined): Record<string, string> {
    if (!isJsonArray(value)) {
        throwInvalidParams("ACP stdio MCP server env must be an array", { field: "mcpServers.env" });
    }
    const env: Record<string, string> = {};
    for (const entry of value) {
        if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.value !== "string") {
            throwInvalidParams("ACP stdio MCP server env entries require string name and value", {
                field: "mcpServers.env",
            });
        }
        env[entry.name] = entry.value;
    }
    return env;
}

function validateAcpMcpServers(value: JsonValue | undefined): McpServerDefinition[] {
    if (!isJsonArray(value)) throwInvalidParams("ACP mcpServers must be an array", { field: "mcpServers" });
    const servers: McpServerDefinition[] = [];
    for (const server of value) {
        if (!isRecord(server)) throwInvalidParams("ACP MCP server must be an object", { field: "mcpServers" });
        if (server.type === "http" || server.type === "sse" || server.type === "acp") {
            throwInvalidParams(`RunWield supports only stdio MCP servers, not ${server.type}`, {
                field: "mcpServers.type",
                transport: server.type,
            });
        }
        if (server.type !== undefined && server.type !== "stdio") {
            throwInvalidParams("Unsupported ACP MCP server transport", { field: "mcpServers.type" });
        }
        if (typeof server.name !== "string" || !server.name.trim()) {
            throwInvalidParams("ACP stdio MCP server requires a name", { field: "mcpServers.name" });
        }
        if (typeof server.command !== "string" || !isAbsolute(server.command)) {
            throwInvalidParams("ACP stdio MCP server requires an absolute command path", {
                field: "mcpServers.command",
            });
        }
        if (!isJsonArray(server.args) || !server.args.every((arg) => typeof arg === "string")) {
            throwInvalidParams("ACP stdio MCP server args must be an array of strings", { field: "mcpServers.args" });
        }
        servers.push({
            name: server.name,
            command: server.command,
            args: server.args,
            env: validateAcpMcpEnv(server.env),
            source: "request",
        });
    }
    return servers;
}

function isOpenAbSenderContext(text: string) {
    const match = /^<sender_context>\s*([\s\S]*)\s*<\/sender_context>$/.exec(text.trim());
    if (!match) return false;
    try {
        const envelope: JsonValue = JSON.parse(match[1]);
        return isRecord(envelope) && envelope.schema === "openab.sender.v1";
    } catch {
        return false;
    }
}

function extractAcpBuiltinCommand(blocks: readonly AcpPromptBlock[] | JsonValue): AcpBuiltinCommand | null {
    if (!Array.isArray(blocks) || blocks.length === 0) {
        throwInvalidParams("session/prompt requires at least one prompt content block");
    }
    const commandTexts: string[] = [];
    const content: readonly (AcpPromptBlock | JsonValue)[] = blocks;
    for (const block of content) {
        if (!block || typeof block !== "object") throwInvalidParams("Invalid prompt content block");
        if (Array.isArray(block) || block.type !== "text") continue;
        const text = String(block.text || "").trim();
        if (text.startsWith("/")) commandTexts.push(text);
    }
    if (commandTexts.length === 0) return null;
    if (commandTexts.length > 1) throwInvalidParams("ACP prompts can include only one slash command.");
    const text = commandTexts[0];
    if (/\r?\n/.test(text)) throwInvalidParams("ACP slash command prompts must contain only the command line.");
    const [name = "", ...args] = text.slice(1).trim().split(/\s+/).filter(Boolean);
    if (!name) throwInvalidParams("Slash command name is required.");
    return { name, args };
}

async function buildAcpAvailableCommands(
    runtime: AcpCatalogRuntime,
    runtimeSessionId: string,
    catalog?: AcpCommandCatalog,
) {
    const snapshot = runtime.getSessionSnapshot(runtimeSessionId);
    const cwd = snapshot?.cwd;
    if (!cwd) return buildAcpCommandCatalog(catalog);
    const [templates, skills] = await Promise.all([
        runtime.listSessionPromptTemplates(runtimeSessionId),
        runtime.listSessionSkills(runtimeSessionId),
    ]);
    return buildAcpCommandCatalog(catalog, templates, skills);
}

async function notifyAcpCommandCatalog(
    context: AcpNotificationContext,
    runtime: AcpCatalogRuntime,
    runtimeSessionId: string,
    acpSessionId: string,
    catalog?: AcpCommandCatalog,
) {
    await notifyClient(context, methods.client.session.update, {
        sessionId: acpSessionId,
        update: {
            sessionUpdate: "available_commands_update",
            availableCommands: await buildAcpAvailableCommands(runtime, runtimeSessionId, catalog),
        },
    });
}

async function notifyAcpModelOptions(
    context: AcpNotificationContext,
    acpSessionId: string,
    selection: AcpModelSelection,
    models?: AcpServerModelHost,
) {
    if (!models) return;
    await notifyClient(context, methods.client.session.update, {
        sessionId: acpSessionId,
        update: {
            sessionUpdate: "config_option_update",
            configOptions: await buildAcpModelOptions(selection, () => models.list()),
        },
    });
}

async function notifyAcpContextUsage(
    context: AcpNotificationContext,
    runtime: Pick<AcpServerRuntime, "getSessionSnapshot">,
    sessionMap: AcpSessionMap,
    runtimeSessionId: string,
    acpSessionId: string,
) {
    const contextUsage = runtime.getSessionSnapshot(runtimeSessionId)?.contextUsage || null;
    const update = mapRuntimeContextToAcpUpdate(contextUsage, sessionMap.getRecord(acpSessionId)?.usageCostUsd || 0);
    if (update) await notifyClient(context, methods.client.session.update, { sessionId: acpSessionId, update });
}

async function dispatchAcpBuiltinCommand(options: AcpBuiltinCommandOptions): Promise<PromptResponse> {
    const operation = createLiveOperation(options);
    options.onOperation(operation);
    operation.start(options.context, `command-${crypto.randomUUID()}`);
    const execution = Promise.resolve().then(() =>
        options.commands.execute({
            commandName: options.commandName,
            args: options.args,
            requestId: options.requestId,
            get runtimeSessionId() {
                return operation.runtimeSessionId;
            },
            get cancelled() {
                return operation.cancelled;
            },
            sendMessage: (text, isError = false) =>
                operation.sendMessage(text, { command: options.commandName, level: isError ? "error" : "info" }),
            replaceRuntimeSession: operation.replaceRuntimeSession,
        }),
    );
    const settlement = execution.then(
        () => operation.settle({ ok: true }),
        (error) => operation.settle(null, error),
    );
    return await operation.waitForRequest(options.context, settlement, "", []);
}

function validateNewSessionParams<Value>(params: Value) {
    const request: JsonRecord = isRecord(params) ? params : {};
    const cwd = request.cwd;
    if (typeof cwd !== "string" || !isAbsolute(cwd)) {
        throwInvalidParams("session/new requires an absolute cwd", { cwd });
    }
    const runwieldMcpServers = validateAcpMcpServers(request.mcpServers);
    const extraDirectories = request.additionalDirectories;
    if (
        (isJsonArray(extraDirectories) && extraDirectories.length > 0) ||
        (isRecord(extraDirectories) && Object.keys(extraDirectories).length > 0)
    ) {
        throwInvalidParams("RunWield ACP MVP does not support additionalDirectories yet", {
            field: "additionalDirectories",
        });
    }
    return { cwd, runwieldMcpServers };
}

function validateLoadSessionParams<Value>(params: Value) {
    const request: JsonRecord = isRecord(params) ? params : {};
    const validated = validateNewSessionParams(request);
    const sessionId = request.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
        throwInvalidParams("session/load requires sessionId", { sessionId });
    }
    const metadata = request._meta;
    const runwield = isRecord(metadata) ? metadata.runwield : undefined;
    const sessionPath = isRecord(runwield) ? runwield.sessionPath : undefined;
    if (sessionPath !== undefined && typeof sessionPath !== "string") {
        throwInvalidParams("session/load _meta.runwield.sessionPath must be a string", { field: "sessionPath" });
    }
    return { ...validated, sessionId, sessionPath };
}

function validateCloseSessionParams<Value>(params: Value) {
    const sessionId = isRecord(params) ? params.sessionId : undefined;
    if (typeof sessionId !== "string" || !sessionId) {
        throwInvalidParams("session/close requires sessionId", { sessionId });
    }
    return { sessionId };
}

type AcpSessionCloser = Pick<AcpServerRuntime, "closeSessionWhenIdle">;

async function closeMappedSession(runtime: AcpSessionCloser, sessionMap: AcpSessionMap, acpSessionId: string) {
    const record = sessionMap.getRecord(acpSessionId);
    if (!record) return { ok: false, closed: false, error: "not_found" };
    const runtimeSessionId = sessionMap.getRuntimeSessionId(acpSessionId);
    sessionMap.markCancelled(acpSessionId);
    if (runtimeSessionId) await runtime.closeSessionWhenIdle(runtimeSessionId);
    sessionMap.deleteRecord(acpSessionId);
    return { ok: true, closed: Boolean(runtimeSessionId), record };
}

function requireUnmappedSession(runtime: AcpServerRuntime, sessionMap: AcpSessionMap, sessionId: string) {
    const persistedSessionId = normalizeAcpSessionIdForLoad(sessionId);
    const isMapped = sessionMap.listRecords().some((record) => {
        if (
            normalizeAcpSessionIdForLoad(record.acpSessionId) === persistedSessionId ||
            record.persistedSessionId === persistedSessionId
        ) {
            return true;
        }
        const snapshot = runtime.getSessionSnapshot(record.runtimeSessionId);
        return (
            snapshot?.sessionManagerId === persistedSessionId ||
            snapshot?.managed?.runwieldSessionId === persistedSessionId
        );
    });
    if (isMapped) throw new RequestError(ACP_INVALID_STATE, `ACP session already exists: ${sessionId}`);
}

async function adoptOpenedSession<Result>(
    runtime: AcpServerRuntime,
    sessionMap: AcpSessionMap,
    runtimeSessionId: string,
    adopt: () => Result,
): Promise<Result> {
    const existing = sessionMap.getAcpSessionIdForRuntimeSession(runtimeSessionId);
    if (existing) throw new RequestError(ACP_INVALID_STATE, `ACP session already exists: ${existing}`);
    try {
        return adopt();
    } catch (error) {
        await runtime.closeSessionWhenIdle(runtimeSessionId);
        throw error;
    }
}

/**
 * Map one Runtime event for an ACP Session, folding usage cost into the Session total.
 *
 * The Runtime reports the cost of a single assistant message; ACP wants the cumulative
 * Session cost. Every mapping site goes through here so live, replayed, and setup events
 * all add to the same total.
 */
function mapEventWithSessionCost(
    sessionMap: AcpSessionMap,
    acpSessionId: string,
    event: SessionRuntimeEvent,
    contextUsage: AcpContextUsage | null,
    commandCatalog?: AcpCommandCatalog,
) {
    const sessionCostUsd =
        event.type === RuntimeEventTypes.USAGE
            ? sessionMap.addUsageCost(acpSessionId, event.usage?.costUsd)
            : sessionMap.getRecord(acpSessionId)?.usageCostUsd || 0;
    return mapRuntimeEventToAcpSessionNotification(acpSessionId, event, sessionCostUsd, contextUsage, commandCatalog);
}

function releasePromptsAfterResponses(stream: AcpStream, promptReleases: Map<string, () => void>): AcpStream {
    const writer = stream.writable.getWriter();
    return {
        readable: stream.readable,
        writable: new WritableStream({
            async write(message) {
                const responseId =
                    "id" in message && ("result" in message || "error" in message) ? String(message.id) : null;
                try {
                    await writer.write(message);
                } finally {
                    if (responseId) {
                        const release = promptReleases.get(responseId);
                        if (release) {
                            promptReleases.delete(responseId);
                            release();
                        }
                    }
                }
            },
            close() {
                return writer.close();
            },
            abort(reason) {
                return writer.abort(reason);
            },
        }),
    };
}

async function replaySetupEvents(
    context: AcpNotificationContext,
    runtime: AcpServerRuntime,
    sessionMap: AcpSessionMap,
    runtimeSessionId: string,
    acpSessionId: string,
    commandCatalog?: AcpCommandCatalog,
) {
    const pendingNotifications: Array<void | Promise<void>> = [];
    const unsubscribe = runtime.subscribeSessionEvents(runtimeSessionId, (event) => {
        const contextUsage = runtime.getSessionSnapshot(runtimeSessionId)?.contextUsage || null;
        const notification = mapEventWithSessionCost(sessionMap, acpSessionId, event, contextUsage, commandCatalog);
        if (!notification) return;
        const pending = notifyClient(context, methods.client.session.update, notification);
        pendingNotifications.push(pending);
        return pending;
    });
    try {
        await runtime.replaySession(runtimeSessionId);
        await Promise.allSettled(pendingNotifications);
    } finally {
        unsubscribe();
    }
}

/**
 * One live Runtime turn may serve several ACP prompt requests. Only the request's
 * response owns activePrompt; the operation owns its adapter and event subscription.
 */
function createLiveOperation(options: AcpLiveOperationOptions) {
    const {
        runtime,
        sessionMap,
        acpSessionId,
        clientCapabilities,
        releasePromptAfterResponse,
        commandCatalog,
        models,
        review,
    } = options;
    let runtimeSessionId = options.runtimeSessionId;
    let attached: AcpNotificationContext | null = null;
    let initialContext: AcpNotificationContext | null = null;
    let prompt: AcpPromptRecord | null = null;
    let unsubscribe: () => void = () => {};
    const undelivered: PendingNotification[] = [];
    let tail: Promise<void> = Promise.resolve();
    let wake: PromiseWithResolvers<void> = Promise.withResolvers();
    let question: AcpPendingQuestion | null = null;
    let settled = false;
    let cancelled = false;
    let result: AcpTurnResult | null = null;
    let failure: Error | null = null;
    const started: PromiseWithResolvers<void> = Promise.withResolvers();
    let completed: PromiseWithResolvers<void> = Promise.withResolvers();
    let generatedTurnActive = false;
    let stopped = false;

    function signalWake() {
        wake.resolve();
        wake = Promise.withResolvers();
    }

    function queue(send: PendingNotification) {
        if (stopped) return;
        if (!attached) {
            undelivered.push(send);
            return;
        }
        const context = attached;
        tail = tail.then(() => send(context));
        tail.catch(() => runtime.cancelSession(runtimeSessionId));
        return tail;
    }
    function deliverQuestion() {
        if (!question || question.queued || !attached) return;
        const current = question;
        current.queued = true;
        void queue((context) =>
            notifyClient(context, methods.client.session.update, {
                sessionId: acpSessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: formatChatQuestion(current.interaction) },
                },
            }),
        )?.then(
            () => {
                current.delivered = true;
                signalWake();
            },
            () => {},
        );
    }
    function installAdapter(context: AcpNotificationContext) {
        runtime.setInteractionAdapter(
            runtimeSessionId,
            createAcpInteractionAdapter({
                context,
                acpSessionId,
                clientCapabilities,
                review,
                presentChatQuestion: (interaction, signal) => {
                    if (cancelled || signal?.aborted) {
                        return Promise.resolve({
                            outcome: RuntimeInteractionOutcomes.CANCELED,
                            message: "Interaction canceled.",
                        });
                    }
                    const answered: PromiseWithResolvers<RuntimeInteractionResponse> = Promise.withResolvers();
                    const current = { interaction, delivered: false, queued: false };
                    question = current;
                    const abort = () => {
                        if (question === current) question = null;
                        answered.resolve({
                            outcome: RuntimeInteractionOutcomes.CANCELED,
                            message: "Interaction canceled.",
                        });
                    };
                    if (signal?.aborted) abort();
                    else signal?.addEventListener("abort", abort, { once: true });
                    deliverQuestion();
                    return answered.promise.finally(() => signal?.removeEventListener("abort", abort));
                },
            }),
        );
    }
    // Answers are sent to the broker's existing callback, not to the adapter's
    // presentation Promise. Its abort listener dismisses the losing surface.
    function replaceRuntimeSession(nextId: string) {
        if (nextId === runtimeSessionId) return;
        sessionMap.replaceRuntimeSession(acpSessionId, {
            sessionId: nextId,
            cwd: runtime.getSessionSnapshot(nextId)?.cwd,
        });
        unsubscribe();
        runtime.setInteractionAdapter(runtimeSessionId, null);
        runtimeSessionId = nextId;
        const context = attached || initialContext;
        if (context) installAdapter(context);
        subscribe();
    }
    function subscribe() {
        unsubscribe = runtime.subscribeSessionEvents(runtimeSessionId, (event) => {
            if (stopped) return;
            if (event.type === RuntimeEventTypes.SESSION_REPLACED) {
                replaceRuntimeSession(event.newSessionId);
                return;
            }
            if (event.type === RuntimeEventTypes.COMMAND_CATALOG_CHANGED) {
                queue((context) =>
                    notifyAcpCommandCatalog(context, runtime, runtimeSessionId, acpSessionId, commandCatalog),
                );
                return;
            }
            if (event.type === RuntimeEventTypes.USER_MESSAGE && event.origin === "background_task_result") {
                generatedTurnActive = true;
                settled = false;
                completed = Promise.withResolvers();
            }
            if (event.type === RuntimeEventTypes.BUSY_CHANGED && !event.busy && generatedTurnActive) {
                generatedTurnActive = false;
                settled = true;
                completed.resolve();
                signalWake();
            }
            const snapshot = runtime.getSessionSnapshot(runtimeSessionId);
            const notification = mapEventWithSessionCost(
                sessionMap,
                acpSessionId,
                event,
                snapshot?.contextUsage || null,
                commandCatalog,
            );
            if (
                event.type === RuntimeEventTypes.MODEL_CHANGED ||
                event.type === RuntimeEventTypes.AGENT_CHANGED ||
                event.type === RuntimeEventTypes.THINKING_LEVEL_CHANGED
            ) {
                // The managed session may return to its dormant snapshot while the catalog loads.
                const selection: AcpModelSelection = {
                    activeModel:
                        event.type === RuntimeEventTypes.MODEL_CHANGED
                            ? { model: event.model, provider: event.provider }
                            : snapshot?.activeModel,
                    thinkingLevel:
                        event.type === RuntimeEventTypes.THINKING_LEVEL_CHANGED
                            ? event.thinkingLevel
                            : snapshot?.thinkingLevel,
                };
                queue(async (context) => {
                    await notifyAcpModelOptions(context, acpSessionId, selection, models);
                    await notifyAcpContextUsage(context, runtime, sessionMap, runtimeSessionId, acpSessionId);
                });
            }
            if (notification) queue((context) => notifyClient(context, methods.client.session.update, notification));
        });
    }
    async function flush(context: AcpNotificationContext) {
        if (undelivered.length) {
            const updates = undelivered.splice(0);
            for (const update of updates) {
                tail = tail.then(() => update(context));
                tail.catch(() => runtime.cancelSession(runtimeSessionId));
            }
        }
        try {
            // New notifications can be queued while an earlier write is pending.
            let pending;
            do {
                pending = tail;
                await pending;
            } while (pending !== tail);
        } catch (error) {
            // A failed write cancels the operation. Do not leave a rejected
            // delivery chain that poisons every later request on this connection.
            tail = Promise.resolve();
            throw error;
        }
    }
    async function finishCancellation(
        context: AcpNotificationContext,
        settlement: Promise<void>,
    ): Promise<PromptResponse> {
        await settlement;
        await flush(context);
        return { stopReason: "cancelled" };
    }
    async function waitForQuestionOrSettlement(
        context: AcpNotificationContext,
        settlement: Promise<void>,
        answeredQuestion: typeof question = null,
    ) {
        while (true) {
            const nextWake = wake.promise;
            await flush(context);
            if (cancelled || prompt?.cancelled || settled || (question !== answeredQuestion && question?.delivered)) {
                return;
            }
            await Promise.race([nextWake, settlement]);
        }
    }
    function attachRequest(context: AcpPromptContext) {
        attached = context;
        wake = Promise.withResolvers();
        prompt = sessionMap.beginPrompt(
            acpSessionId,
            crypto.randomUUID(),
            context.requestId === undefined ? undefined : String(context.requestId),
        );
        if (!prompt) throwUnknownSession(acpSessionId);
        // The old request has already flushed its response before this can run.
        // The caller replays detached events before presenting a new question.
    }
    function finishRequest() {
        const current = prompt;
        if (!current) return;
        const release = () => {
            sessionMap.endPrompt(acpSessionId, current);
            if (prompt === current) {
                prompt = null;
                attached = initialContext;
                if (attached) void flush(attached).catch(() => runtime.cancelSession(runtimeSessionId));
            }
        };
        // Hold updates until the SDK has written the prompt response.
        attached = null;
        if (current.requestId !== undefined && releasePromptAfterResponse) {
            releasePromptAfterResponse(current.requestId, release);
        } else release();
    }
    async function waitForRequest(
        context: AcpPromptContext,
        operationSettlement: Promise<void>,
        text: string,
        images: ImageAttachment[],
    ): Promise<PromptResponse> {
        // onTurnStarted can run after the Runtime's asynchronous setup.
        if (!prompt) await Promise.race([operationSettlement, started.promise]);
        try {
            if (prompt) await waitForQuestionOrSettlement(context, operationSettlement);
            else await flush(context);
            if (cancelled || prompt?.cancelled) {
                return await finishCancellation(context, operationSettlement);
            }
            if (question?.delivered && !settled) return { stopReason: "end_turn" };
            if (failure) throw failure;
            if (!result?.ok) {
                if (result?.error === "managed_operation_in_progress" && !prompt) {
                    const queued = runtime.queueNextTurnMessage(runtimeSessionId, text, images, {
                        deliverWhenAvailable: true,
                    });
                    if (queued.ok) {
                        return {
                            stopReason: "end_turn",
                            _meta: { runwield: { queued: queued.queued, queuedMessageId: queued.message?.id || "" } },
                        };
                    }
                }
                throw new RequestError(ACP_INVALID_STATE, result?.error || "ACP prompt was rejected", {
                    sessionId: acpSessionId,
                });
            }
            return { stopReason: "end_turn" };
        } catch (error) {
            if (cancelled || prompt?.cancelled) {
                return await finishCancellation(context, operationSettlement);
            }
            if (error instanceof SessionTurnInProgressError) {
                throw new RequestError(ACP_INVALID_STATE, `ACP session already has an active prompt: ${acpSessionId}`);
            }
            throw error;
        } finally {
            finishRequest();
        }
    }
    return {
        replaceRuntimeSession,
        get runtimeSessionId() {
            return runtimeSessionId;
        },
        sendMessage(text: string, metadata: AcpCommandMessageMetadata) {
            queue((context) =>
                notifyClient(context, methods.client.session.update, {
                    sessionId: acpSessionId,
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text },
                        _meta: { runwield: metadata },
                    },
                }),
            );
        },
        get question() {
            return question;
        },
        get settled() {
            return settled;
        },
        get cancelled() {
            return cancelled;
        },
        async replay(context: AcpPromptContext) {
            attachRequest(context);
            try {
                await flush(context);
            } finally {
                finishRequest();
            }
        },
        start(context: AcpPromptContext, turnId: string) {
            attached = context;
            initialContext = context;
            prompt = sessionMap.beginPrompt(
                acpSessionId,
                turnId,
                context.requestId === undefined ? undefined : String(context.requestId),
            );
            if (!prompt) throwUnknownSession(acpSessionId);
            installAdapter(context);
            subscribe();
            started.resolve();
        },
        stop() {
            stopped = true;
            unsubscribe();
            runtime.setInteractionAdapter(runtimeSessionId, null);
        },
        settle(value: AcpTurnResult | null, error?: Error | null) {
            settled = true;
            result = value;
            failure = error instanceof Error ? error : error ? new Error(String(error)) : null;
            question = null;
            signalWake();
            completed.resolve();
        },
        cancel() {
            cancelled = true;
        },
        async attach(
            context: AcpPromptContext,
            expectedInteractionId: string | undefined,
            reply: RuntimeInteractionResponse | null | undefined,
            feedback?: string,
        ): Promise<PromptResponse> {
            attachRequest(context);
            try {
                await flush(context);
                if (cancelled || prompt?.cancelled) {
                    return await finishCancellation(context, completed.promise);
                }
                let answeredQuestion = null;
                if (question && !question.delivered) {
                    deliverQuestion();
                } else if (reply && question?.interaction.id !== expectedInteractionId) {
                    // Another surface won; never apply the old reply to its successor.
                } else if (!reply && question) {
                    queue((context) =>
                        notifyClient(context, methods.client.session.update, {
                            sessionId: acpSessionId,
                            update: {
                                sessionUpdate: "agent_message_chunk",
                                content: { type: "text", text: feedback || "An answer is required." },
                            },
                        }),
                    );
                    await flush(context);
                    if (cancelled || prompt?.cancelled) {
                        return await finishCancellation(context, completed.promise);
                    }
                } else if (question && reply) {
                    const current = question;
                    if (runtime.answerInteraction(runtimeSessionId, expectedInteractionId || "", reply, "acp")) {
                        answeredQuestion = current;
                    } else {
                        queue((context) =>
                            notifyClient(context, methods.client.session.update, {
                                sessionId: acpSessionId,
                                update: {
                                    sessionUpdate: "agent_message_chunk",
                                    content: { type: "text", text: "This question was answered elsewhere." },
                                },
                            }),
                        );
                        await flush(context);
                        if (cancelled || prompt?.cancelled) {
                            return await finishCancellation(context, completed.promise);
                        }
                    }
                }
                await waitForQuestionOrSettlement(context, completed.promise, answeredQuestion);
                if (cancelled || prompt?.cancelled) {
                    return await finishCancellation(context, completed.promise);
                }
                if (question?.delivered && !settled) return { stopReason: "end_turn" };
                if (failure) throw failure;
                if (settled && !result?.ok) {
                    throw new RequestError(ACP_INVALID_STATE, result?.error || "ACP prompt failed");
                }
                return { stopReason: "end_turn" };
            } catch (error) {
                if (cancelled || prompt?.cancelled) {
                    return await finishCancellation(context, completed.promise);
                }
                throw error;
            } finally {
                finishRequest();
            }
        },
        waitForRequest,
    };
}

/**
 * Create the RunWield ACP agent app.
 */
function modelOptions(selection: AcpModelSelection | null, models: AcpServerModelHost | undefined) {
    return models ? buildAcpModelOptions(selection, () => models.list()) : Promise.resolve([]);
}

function createRunWieldAcpServer(server: AcpServerContext): AgentApp {
    const app = agent({ name: "RunWield ACP MVP" });
    const {
        runtime,
        sessionMap,
        releasePromptAfterResponse,
        commandCatalog,
        commands,
        models,
        review,
        describeProjectRefusal,
        trackSessionChange,
    } = server;
    const operations = server.operations;
    let clientCapabilities: ClientCapabilities | null = null;
    let previousLoad = Promise.resolve();

    app.onRequest(methods.agent.initialize, (context) => {
        clientCapabilities = context.params?.clientCapabilities || null;
        return createInitializeResponse(context.params, server);
    });

    // The SDK's default parser silently drops malformed MCP definitions. Validate
    // the original request so a client never receives a Session missing its tools.
    app.onRequest(methods.agent.session.new, validateNewSessionParams, async (context) => {
        const request = context.params;
        if (models && !models.isReady(request.cwd)) throwAuthenticationRequired(request.cwd);
        const { record, runtimeSessionId, cwd, persistedSessionId } = await trackSessionChange(async () => {
            let runtimeSessionId: string;
            try {
                const created = await runtime.createSession({
                    cwd: request.cwd,
                    selectDefaultAgent: true,
                    mcpServers: request.runwieldMcpServers,
                });
                runtimeSessionId = created.sessionId;
            } catch (error) {
                if (error instanceof Error) throwProjectRuntimeRefusal(error, request.cwd, describeProjectRefusal);
                throw error;
            }
            return await adoptOpenedSession(runtime, sessionMap, runtimeSessionId, () => {
                const snapshot = runtime.getSessionSnapshot(runtimeSessionId);
                if (!snapshot) throwUnknownSession(runtimeSessionId);
                const persistedSessionId = snapshot.sessionManagerId || runtimeSessionId;
                const record = sessionMap.createRecord(
                    { sessionId: runtimeSessionId, cwd: snapshot.cwd },
                    { persistedSessionId },
                );
                return { record, runtimeSessionId, cwd: snapshot.cwd, persistedSessionId };
            });
        });
        context.signal.throwIfAborted();
        await replaySetupEvents(context, runtime, sessionMap, runtimeSessionId, record.acpSessionId, commandCatalog);
        const configOptions = await modelOptions(runtime.getSessionSnapshot(runtimeSessionId), models);
        queueMicrotask(() => {
            notifyAcpCommandCatalog(context, runtime, runtimeSessionId, record.acpSessionId, commandCatalog).catch(
                () => {},
            );
        });
        return {
            sessionId: record.acpSessionId,
            configOptions,
            _meta: {
                runwield: {
                    runtimeSessionId,
                    persistedSessionId,
                    cwd,
                },
            },
        };
    });

    app.onRequest(methods.agent.session.load, validateLoadSessionParams, async (context) => {
        const request = context.params;
        const persistedSessionId = normalizeAcpSessionIdForLoad(request.sessionId);
        requireUnmappedSession(runtime, sessionMap, request.sessionId);
        try {
            const loaded = trackSessionChange(() =>
                previousLoad.then(async () => {
                    context.signal.throwIfAborted();
                    requireUnmappedSession(runtime, sessionMap, request.sessionId);
                    const result = await runtime.resumeSession({
                        cwd: request.cwd,
                        sessionId: persistedSessionId,
                        sessionPath: request.sessionPath,
                        mcpServers: request.runwieldMcpServers,
                    });
                    return await adoptOpenedSession(runtime, sessionMap, result.sessionId, () => {
                        const snapshot = runtime.getSessionSnapshot(result.sessionId);
                        const stablePersistedSessionId =
                            snapshot?.managed?.runwieldSessionId || result.sessionManagerId;
                        // Resume can resolve a transcript alias to a Session mapped by another request while we waited.
                        requireUnmappedSession(runtime, sessionMap, request.sessionId);
                        if (stablePersistedSessionId !== persistedSessionId) {
                            requireUnmappedSession(runtime, sessionMap, stablePersistedSessionId);
                        }
                        const record = sessionMap.createRecord(
                            { sessionId: result.sessionId, cwd: result.cwd },
                            {
                                acpSessionId: request.sessionId,
                                loaded: true,
                                persistedSessionId: stablePersistedSessionId,
                                sessionPath: result.sessionPath,
                            },
                        );
                        return { result, record, stablePersistedSessionId };
                    });
                }),
            );
            // Serialize the runtime open and mapping. Replay and response writes can proceed separately.
            previousLoad = loaded.then(
                () => {},
                () => {},
            );
            const { result, record, stablePersistedSessionId } = await loaded;
            context.signal.throwIfAborted();
            const notifications = result.replayEvents
                .map((event) =>
                    mapEventWithSessionCost(
                        sessionMap,
                        record.acpSessionId,
                        event,
                        runtime.getSessionSnapshot(result.sessionId)?.contextUsage || null,
                        commandCatalog,
                    ),
                )
                .filter(Boolean)
                .map((notification) => notifyClient(context, methods.client.session.update, notification!));
            await Promise.allSettled(notifications);
            const configOptions = await modelOptions(runtime.getSessionSnapshot(result.sessionId), models);
            queueMicrotask(() => {
                notifyAcpCommandCatalog(context, runtime, result.sessionId, record.acpSessionId, commandCatalog).catch(
                    () => {},
                );
            });
            return {
                configOptions,
                _meta: {
                    runwield: {
                        runtimeSessionId: result.sessionId,
                        persistedSessionId: stablePersistedSessionId,
                        sessionPath: result.sessionPath,
                        cwd: result.cwd,
                        replayedUpdates: notifications.length,
                    },
                },
            };
        } catch (error) {
            if (error instanceof Error) throwProjectRuntimeRefusal(error, request.cwd, describeProjectRefusal);
            const message = error instanceof Error ? error.message : String(error || "session/load failed");
            if (message.includes("already exists") || message.includes("already has live HostedSession")) {
                throw new RequestError(ACP_INVALID_STATE, message, { sessionId: request.sessionId });
            }
            if (isAuthenticationSetupFailure(message)) throwAuthenticationRequired(request.cwd);
            throw new RequestError(ACP_NOT_FOUND, `Unable to load ACP session: ${request.sessionId}`, {
                sessionId: request.sessionId,
                cwd: request.cwd,
            });
        }
    });

    app.onRequest(methods.agent.session.setConfigOption, async (context) => {
        const { sessionId, configId, value } = context.params;
        if (typeof sessionId !== "string" || !sessionId) {
            throwInvalidParams("session/set_config_option requires sessionId");
        }
        const runtimeSessionId = sessionMap.getRuntimeSessionId(sessionId);
        if (!runtimeSessionId) throwUnknownSession(sessionId);
        if (typeof configId !== "string" || typeof value !== "string") {
            throwInvalidParams("Expected a select config option with a string value");
        }
        const exposedOptions = await modelOptions(runtime.getSessionSnapshot(runtimeSessionId), models);
        const option = exposedOptions.find((candidate) => candidate.id === configId);
        if (!option || option.type !== "select") {
            throwInvalidParams(`Config option is not available: ${configId}=${value}`, { configId, value });
        }
        const optionValues = option.options
            .flatMap((entry) => ("options" in entry ? entry.options : [entry]))
            .map((entry) => entry.value);
        if (!optionValues.includes(value)) {
            throwInvalidParams(`Config option is not available: ${configId}=${value}`, { configId, value });
        }
        if (
            sessionMap.getRecord(sessionId)?.activePrompt ||
            (operations.has(sessionId) && !operations.get(sessionId)?.settled)
        ) {
            throw new RequestError(
                ACP_INVALID_STATE,
                "Wait for the active turn to finish before changing configuration",
                {
                    sessionId,
                },
            );
        }
        if (configId === "model") {
            const selectableModels = await models?.list();
            const selected = selectableModels?.find((model) => `${model.provider}/${model.id}` === value);
            if (!models || !selected) throwInvalidParams(`Model is not available: ${value}`, { configId, value });
            const result = await models.select(runtimeSessionId, selected.id, selected.provider);
            if (!result.ok) {
                throw new RequestError(ACP_INVALID_STATE, result.error || "Model switch failed", {
                    sessionId,
                    configId,
                    value,
                });
            }
        } else if (configId === "thought_level") {
            if (!isAcpThinkingLevel(value)) {
                throwInvalidParams(`Reasoning level is not available: ${value}`, { configId, value });
            }
            const result = await runtime.setSessionThinkingLevel(runtimeSessionId, value);
            if (!result?.ok) {
                throw new RequestError(ACP_INVALID_STATE, result?.error || "Reasoning level switch failed", {
                    sessionId,
                    configId,
                    value,
                });
            }
        }
        const configOptions = await modelOptions(runtime.getSessionSnapshot(runtimeSessionId), models);
        await notifyClient(context, methods.client.session.update, {
            sessionId,
            update: { sessionUpdate: "config_option_update", configOptions },
        });
        await notifyAcpContextUsage(context, runtime, sessionMap, runtimeSessionId, sessionId);
        return { configOptions };
    });

    app.onRequest(ACP_STEERING_METHOD, decodeAcpSteeringRequest, async (context): Promise<AcpSteeringResponse> => {
        const request = context.params;
        const runtimeSessionId = sessionMap.getRuntimeSessionId(request.sessionId);
        if (!runtimeSessionId) throwUnknownSession(request.sessionId);
        const { text, images } = convertAcpPrompt(request.prompt);
        if (operations.get(request.sessionId)?.question) {
            return { outcome: "promptRequired", reason: "questionPending" };
        }
        if (extractAcpBuiltinCommand(request.prompt)) {
            throw new RequestError(ACP_INVALID_STATE, "Slash commands cannot steer a running turn.");
        }
        const result = await runtime.steerSession(runtimeSessionId, text, images);
        if (result.ok && result.queued) return { outcome: "injected" };
        if (result.ok && result.reason === "not_streaming") {
            return { outcome: "promptRequired", reason: "noRunningTurn" };
        }
        throw new RequestError(ACP_INVALID_STATE, result.error || result.reason || "ACP steering was not accepted", {
            sessionId: request.sessionId,
        });
    });

    app.onRequest(methods.agent.session.prompt, async (context) => {
        const request = (context.params || {}) as PromptRequest;
        const acpSessionId = request.sessionId;
        if (!acpSessionId || typeof acpSessionId !== "string") {
            throwInvalidParams("session/prompt requires sessionId");
        }
        const runtimeSessionId = sessionMap.getRuntimeSessionId(acpSessionId);
        if (!runtimeSessionId) throwUnknownSession(acpSessionId);
        // A pending question owns its reply, even when that text looks like a malformed command.
        const requestedCommand =
            commands && !operations.get(acpSessionId)?.question ? extractAcpBuiltinCommand(request.prompt) : null;
        if (commands && requestedCommand?.name === "plan-review" && requestedCommand.args.length === 0) {
            const snapshot = runtime.getSessionSnapshot(runtimeSessionId);
            if (snapshot?.livePlanReview) {
                const result = await commands.reopenPlanReview(runtimeSessionId);
                await notifyClient(context, methods.client.session.update, {
                    sessionId: acpSessionId,
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        content: {
                            type: "text",
                            text: result.url ? `${result.message} ${result.url}` : result.message,
                        },
                        _meta: { runwield: { command: "plan-review", ...(result.url && { reviewUrl: result.url }) } },
                    },
                });
                return { stopReason: "end_turn" };
            }
            if (
                sessionMap.getRecord(acpSessionId)?.activePrompt ||
                (operations.has(acpSessionId) && !operations.get(acpSessionId)?.settled)
            ) {
                await commands.recordBusyPlanReview?.(runtimeSessionId);
                await notifyClient(context, methods.client.session.update, {
                    sessionId: acpSessionId,
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: "This Session is busy with other work." },
                        _meta: { runwield: { command: "plan-review" } },
                    },
                });
                return { stopReason: "end_turn" };
            }
        }
        if (sessionMap.getRecord(acpSessionId)?.activePrompt) {
            throw new RequestError(ACP_INVALID_STATE, `ACP session already has an active prompt: ${acpSessionId}`, {
                sessionId: acpSessionId,
            });
        }
        const operation = operations.get(acpSessionId);
        if (operation) {
            const pending = operation.question;
            if (pending && !pending.delivered) {
                return await operation.attach(context, pending.interaction.id, undefined);
            }
            if (!operation.settled) {
                if (operation.cancelled || !pending) {
                    throw new RequestError(ACP_INVALID_STATE, "Wait for the operation to settle", {
                        sessionId: acpSessionId,
                    });
                }
                // Do not turn an attachment or a blank required answer into a tool answer.
                const blocks = request.prompt;
                const textOnly = Array.isArray(blocks) && blocks.every((block) => block?.type === "text");
                const reply = textOnly
                    ? parseChatReply(
                          pending.interaction,
                          blocks
                              .filter((block) => !isOpenAbSenderContext(block.text || ""))
                              .map((block) => block.text || "")
                              .join("\n"),
                      )
                    : null;
                return await operation.attach(
                    context,
                    pending.interaction.id,
                    reply,
                    pending.interaction._meta?.source === "user_interview"
                        ? textOnly
                            ? "An answer is required. Reply with text."
                            : "This interview needs a text answer. Attachments were not submitted; reply with text."
                        : `The reply did not match. Reply with text.\n\n${formatChatQuestion(pending.interaction)}`,
                );
            }
            await operation.replay(context);
            // Keep the old Session subscription until the new turn installs its own.
            // A task can finish while this prompt is acquiring the writer lock.
        }
        const builtinCommand = commands ? extractAcpBuiltinCommand(request.prompt) : null;
        if (commands && builtinCommand) {
            const isBuiltInName = Boolean(commandCatalog?.isReserved(builtinCommand.name));
            const [templates, skills] = isBuiltInName
                ? [[], []]
                : await Promise.all([
                      runtime.listSessionPromptTemplates(runtimeSessionId),
                      runtime.listSessionSkills(runtimeSessionId),
                  ]);
            const isResourceName =
                templates.some((template) => template.name === builtinCommand.name) ||
                skills.some((skill) => `skill:${skill.name}` === builtinCommand.name);
            if (!isResourceName) {
                return await dispatchAcpBuiltinCommand({
                    context,
                    runtime,
                    sessionMap,
                    acpSessionId,
                    runtimeSessionId,
                    clientCapabilities,
                    onOperation: (next) => {
                        operation?.stop();
                        operations.set(acpSessionId, next);
                    },
                    commands,
                    commandCatalog,
                    models,
                    review,
                    commandName: builtinCommand.name,
                    args: builtinCommand.args,
                    requestId: context.requestId === undefined ? undefined : String(context.requestId),
                    releasePromptAfterResponse,
                });
            }
        }
        const { text: promptText, images: promptImages } = convertAcpPrompt(request.prompt);
        const initialSnapshot = runtime.getSessionSnapshot(runtimeSessionId);
        if (initialSnapshot?.managed?.syncState?.status === "active_elsewhere") {
            const queued = runtime.queueNextTurnMessage(runtimeSessionId, promptText, promptImages, {
                deliverWhenAvailable: true,
            });
            if (!queued.ok) {
                throw new RequestError(ACP_INVALID_STATE, queued.error || "ACP prompt could not be queued", {
                    sessionId: acpSessionId,
                });
            }
            return {
                stopReason: "end_turn" satisfies PromptResponse["stopReason"],
                _meta: { runwield: { queued: queued.queued, queuedMessageId: queued.message?.id || "" } },
            };
        }

        const interview = createLiveOperation({
            runtime,
            sessionMap,
            acpSessionId,
            runtimeSessionId,
            clientCapabilities,
            releasePromptAfterResponse,
            commandCatalog,
            models,
            review,
        });
        const runtimePrompt = runtime.promptUserTurn(runtimeSessionId, {
            initialRequest: promptText,
            initialImages: promptImages,
            onTurnStarted: ({ turnId }) => {
                operation?.stop();
                interview.start(context, turnId);
                operations.set(acpSessionId, interview);
                // Notifications and interactions can continue after this prompt settles.
                return () => {};
            },
        });
        // The operation stays alive after a question's response. The request does not.
        const settled = Promise.resolve(runtimePrompt).then(
            (result) => interview.settle(result),
            (error) => interview.settle(null, error),
        );
        // Keep the subscription until the next prompt or session close.
        return await interview.waitForRequest(context, settled, promptText, promptImages);
    });

    app.onRequest(methods.agent.session.delete, (requestContext) =>
        trackSessionChange(async () => {
            const sessionId = requestContext.params?.sessionId;
            if (typeof sessionId !== "string" || !sessionId) {
                throwInvalidParams("session/delete requires sessionId");
            }
            if (!runtime.canArchiveSavedSessions()) throwUnimplemented(methods.agent.session.delete);
            const record = sessionMap.getRecord(sessionId);
            const snapshot = record ? runtime.getSessionSnapshot(record.runtimeSessionId) : null;
            const persistedId =
                snapshot?.managed?.runwieldSessionId ||
                record?.persistedSessionId ||
                normalizeAcpSessionIdForLoad(sessionId);
            if (record) {
                sessionMap.markCancelled(sessionId);
                operations.get(sessionId)?.cancel();
                await runtime.closeSessionWhenIdle(record.runtimeSessionId);
            }
            await runtime.archiveSavedSession(persistedId);
            operations.get(sessionId)?.stop();
            operations.delete(sessionId);
            sessionMap.deleteRecord(sessionId);
            return {};
        }),
    );

    app.onRequest(methods.agent.session.close, (context) =>
        trackSessionChange(async () => {
            const request = validateCloseSessionParams(context.params);
            const record = sessionMap.getRecord(request.sessionId);
            if (!record) throwUnknownSession(request.sessionId);
            operations.get(request.sessionId)?.cancel();
            operations.get(request.sessionId)?.stop();
            const result = await closeMappedSession(runtime, sessionMap, request.sessionId);
            operations.delete(request.sessionId);
            if (!result.ok) throwUnknownSession(request.sessionId);
            return { _meta: { runwield: { sessionId: request.sessionId, closed: result.closed } } };
        }),
    );

    app.onNotification(methods.agent.session.cancel, (context) => {
        const sessionId = context.params?.sessionId;
        if (!sessionId || typeof sessionId !== "string") return;
        const runtimeSessionId = sessionMap.getRuntimeSessionId(sessionId);
        if (!runtimeSessionId) return;
        sessionMap.markCancelled(sessionId);
        operations.get(sessionId)?.cancel();
        runtime.cancelSession(runtimeSessionId);
    });

    registerUnimplementedRequest(app, methods.agent.authenticate);
    registerUnimplementedRequest(app, methods.agent.logout);
    registerUnimplementedRequest(app, methods.agent.providers.list);
    registerUnimplementedRequest(app, methods.agent.providers.set);
    registerUnimplementedRequest(app, methods.agent.providers.disable);
    registerUnimplementedRequest(app, methods.agent.session.list);
    registerUnimplementedRequest(app, methods.agent.session.fork);
    registerUnimplementedRequest(app, methods.agent.session.resume);
    registerUnimplementedRequest(app, methods.agent.session.setMode);
    // NES has a separate SDK entrypoint. Keep its existing unsupported-method response.
    for (const method of [nesMethods.agent.nes.start, nesMethods.agent.nes.suggest, nesMethods.agent.nes.close]) {
        app.onRequest(
            method,
            () => ({}),
            () => throwUnimplemented(method),
        );
    }

    return app;
}

/**
 * Connect the supplied byte streams to the ACP server using the caller's Runtime.
 * Closing the connection settles and closes the Sessions opened by this binding.
 * The caller remains responsible for the Runtime's lifetime.
 */
export function connectAcpServer(options: AcpServerOptions): AgentConnection {
    const promptReleases = new Map<string, () => void>();
    const sessionMap = new AcpSessionMap();
    const operations = new Map<string, ReturnType<typeof createLiveOperation>>();
    const pendingSessionChanges = new Set<Promise<void>>();
    const app = createRunWieldAcpServer({
        ...options,
        sessionMap,
        operations,
        trackSessionChange(start) {
            const change = start();
            const settled = change.then(
                () => {},
                () => {},
            );
            pendingSessionChanges.add(settled);
            void settled.then(() => pendingSessionChanges.delete(settled));
            return change;
        },
        releasePromptAfterResponse: (requestId, release) => {
            if (!connection.signal.aborted) promptReleases.set(requestId, release);
        },
    });
    const { transport, runtime } = options;
    const stream = releasePromptsAfterResponses(ndJsonStream(transport.writable, transport.readable), promptReleases);
    const connection = app.connect(stream);
    const closeMappedSessions = async () => {
        const failures: Error[] = [];
        for (const operation of operations.values()) {
            operation.cancel();
            try {
                operation.stop();
            } catch (error) {
                failures.push(error instanceof Error ? error : new Error(String(error)));
            }
        }
        operations.clear();
        promptReleases.clear();
        // Opening and archival can outlive the wire request. Keep the caller's
        // runtime available and include sessions that were mapped during shutdown.
        await Promise.all(pendingSessionChanges);
        for (const record of sessionMap.listRecords()) {
            try {
                await closeMappedSession(runtime, sessionMap, record.acpSessionId);
            } catch (error) {
                failures.push(error instanceof Error ? error : new Error(String(error)));
            }
        }
        if (failures.length) throw new AggregateError(failures, "ACP Session cleanup failed");
    };
    return {
        signal: connection.signal,
        client: connection.client,
        close: (error) => connection.close(error),
        closed: connection.closed.then(closeMappedSessions, closeMappedSessions),
    };
}
