/**
 * @module acp/server
 * RunWield ACP stdio server.
 */

import type {
    AgentApp,
    AgentConnection,
    AgentRequestMethod,
    ClientCapabilities,
    ClientNotificationMethod,
    CloseSessionRequest,
    InitializeRequest,
    InitializeResponse,
    LoadSessionRequest,
    NewSessionRequest,
    PromptRequest,
    PromptResponse,
    SessionNotification,
    Stream,
} from "@agentclientprotocol/sdk";
import type { SessionRuntime } from "../shared/session/session-runtime.ts";
import type { AcpInteractionContext } from "./interaction-mapper.ts";
import type { FileSessionStore } from "../shared/session/file-session-store-types.ts";
import type { ImageAttachment } from "../shared/session/image-attachments.ts";
import type { SelectOption } from "../ui/tui/api.ts";
import type { McpServerDefinition } from "../shared/mcp/config.ts";
import type {
    RuntimeInteractionRequest,
    RuntimeInteractionResponse,
} from "../shared/session/session-runtime-interactions.ts";
import type { SlashCommandOutcome } from "../shared/workflow/command-metrics.ts";
import type { SessionRuntimeEvent } from "../shared/session/session-runtime-events.ts";
import type { AcpPromptRecord } from "./session-map.ts";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import { isAbsolute } from "node:path";
import { VERSION } from "../shared/version.js";
import { openFileSessionStore } from "../shared/session/file-session-store.ts";
import {
    readLiveSessionConnection,
    waitForSessionActivationSettlement,
} from "../shared/session/live-session-connection.ts";
import { getSelectedDefaultModelAvailability } from "../shared/session/model-readiness.ts";
import { createSessionRuntime, SessionTurnInProgressError } from "../shared/session/session-runtime.ts";
import { RuntimeEventTypes } from "../shared/session/session-runtime-events.ts";
import { AcpSessionMap, normalizeAcpSessionIdForLoad } from "./session-map.ts";
import {
    type AcpContextUsage,
    mapRuntimeContextToAcpUpdate,
    mapRuntimeEventToAcpSessionNotification,
} from "./event-mapper.ts";
import { createAcpInteractionAdapter } from "./interaction-mapper.ts";
import { formatChatQuestion, parseChatReply } from "./chat-interaction.ts";
import { buildAcpModelOptions } from "./model-options.ts";
import { getCommandDefinition, getSlashCommandDefinition, getSlashCommandDefinitions } from "../cmd/registry.ts";
import { ProjectRuntimeEntryRefusedError } from "../shared/project-runtime-layout.ts";
import { RuntimeInteractionOutcomes, RuntimeInteractionTypes } from "../shared/session/session-runtime-interactions.ts";
import {
    applyUserModelSelection,
    listUserModelOptions,
    parseUserModelSelection,
} from "../shared/session/user-selection.ts";
import { SlashCommandMetricsTracker } from "../shared/workflow/command-metrics.ts";

type AcpWireRecord = Record<string, unknown>;

interface AcpBuiltinCommand {
    name: string;
    args: string[];
}

interface AcpCommandUiOptions {
    runtime: SessionRuntime;
    runtimeSessionId: string;
    sendMessage(text: string, isError?: boolean): void;
    onCanceled?: () => void;
}

type AcpTextOptions = Pick<RuntimeInteractionRequest, "defaultValue" | "placeholder" | "allowEmpty">;

type ReleasePrompt = (requestId: string, release: () => void) => void;

interface AcpLiveOperationOptions {
    runtime: SessionRuntime;
    sessionMap: AcpSessionMap;
    acpSessionId: string;
    runtimeSessionId: string;
    clientCapabilities: ClientCapabilities | null;
    releasePromptAfterResponse?: ReleasePrompt;
}

interface AcpPromptContext extends AcpNotificationContext {
    requestId?: string | number | null;
}

interface AcpBuiltinCommandOptions extends AcpLiveOperationOptions {
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

type AcpTurnResult = Pick<Awaited<ReturnType<SessionRuntime["promptUserTurn"]>>, "ok" | "error">;

interface AcpCommandMessageMetadata {
    command: string;
    level: string;
}

interface AcpLoadMetadata {
    runwield?: AcpLoadPathMetadata;
}

interface AcpLoadPathMetadata {
    sessionPath?: unknown;
}

type AcpLoadRequest = LoadSessionRequest & { _meta?: AcpLoadMetadata };

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

function isRecord(value: unknown): value is AcpWireRecord {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function supportsTerminalAuth(clientCapabilities: unknown) {
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

interface RunWieldAcpServerOptions {
    diagnostic?: (message: string) => void | Promise<void>;
}

interface AcpServerContext {
    runtime: SessionRuntime;
    sessionStore: FileSessionStore;
    sessionMap: AcpSessionMap;
    releasePromptAfterResponse?: ReleasePrompt;
    operations: Map<string, ReturnType<typeof createLiveOperation>>;
}

/**
 * Build the stable initialize response for the ACP MVP.
 *
 * The response always carries the version RunWield speaks. ACP negotiation puts the
 * decision on the Client: it reads the Agent's version and either accepts it or
 * disconnects. Echoing a requested version RunWield does not implement would tell the
 * Client the wrong thing.
 */
export function createInitializeResponse(request: InitializeRequest | undefined): InitializeResponse {
    const authMethods = supportsTerminalAuth(request?.clientCapabilities)
        ? [
              {
                  id: "runwield-terminal-login",
                  name: "RunWield Login",
                  description: "Open a terminal to configure RunWield credentials and choose a default model.",
                  type: "terminal",
                  args: ["login"],
              },
          ]
        : [];
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
                delete: {},
                _meta: {
                    runwield: {
                        implementedMethods: [
                            "session/new",
                            "session/load",
                            "session/prompt",
                            "_session/steering",
                            "session/cancel",
                            "session/close",
                            "session/delete",
                            "session/set_config_option",
                        ],
                        updateNotifications: ["session/update"],
                    },
                },
            },
        },
        authMethods,
        agentInfo: { name: "RunWield", version: VERSION },
        _meta: { steering: { supported: true } },
    };
}

function throwUnimplemented(method: string): never {
    throw new RequestError(ACP_NOT_IMPLEMENTED, `RunWield ACP method is not implemented yet: ${method}`, {
        method,
        phase: "session-runtime-acp-mvp",
    });
}

function throwInvalidParams(message: string, data: Record<string, unknown> = {}): never {
    throw new RequestError(ACP_INVALID_PARAMS, message, data);
}

function throwUnknownSession(sessionId: string): never {
    throw new RequestError(ACP_NOT_FOUND, `Unknown ACP session: ${sessionId}`, { sessionId });
}

function throwProjectRuntimeRefusal(error: unknown, cwd: string): never | void {
    if (!(error instanceof ProjectRuntimeEntryRefusedError)) return;
    throw new RequestError(ACP_INVALID_STATE, error.message, {
        cwd,
        reason: error.reason,
        paths: error.paths,
        ...(error.securityAction ? { securityAction: error.securityAction } : {}),
    });
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

function isNonEmptyArray(value: unknown) {
    return Array.isArray(value) && value.length > 0;
}

function isPlainRecord(value: unknown): value is AcpWireRecord {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validateAcpMcpEnv(value: unknown): Record<string, string> {
    if (!Array.isArray(value)) {
        throwInvalidParams("ACP stdio MCP server env must be an array", { field: "mcpServers.env" });
    }
    const env: Record<string, string> = {};
    for (const entry of value) {
        if (!isPlainRecord(entry) || typeof entry.name !== "string" || typeof entry.value !== "string") {
            throwInvalidParams("ACP stdio MCP server env entries require string name and value", {
                field: "mcpServers.env",
            });
        }
        env[entry.name] = entry.value;
    }
    return env;
}

function validateAcpMcpServers(value: unknown): McpServerDefinition[] {
    if (!Array.isArray(value)) throwInvalidParams("ACP mcpServers must be an array", { field: "mcpServers" });
    const servers: McpServerDefinition[] = [];
    for (const server of value) {
        if (!isPlainRecord(server)) throwInvalidParams("ACP MCP server must be an object", { field: "mcpServers" });
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
        if (!Array.isArray(server.args) || server.args.some((arg: unknown) => typeof arg !== "string")) {
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

interface AcpPromptBlock {
    type?: string;
    text?: string | null;
    data?: string | null;
    mimeType?: string | null;
    title?: string | null;
    name?: string | null;
    uri?: string | null;
}

interface ConvertedAcpPrompt {
    text: string;
    images: ImageAttachment[];
}

export function convertAcpPrompt(blocks: AcpPromptBlock[]): ConvertedAcpPrompt {
    if (!Array.isArray(blocks) || blocks.length === 0) {
        throwInvalidParams("session/prompt requires at least one prompt content block");
    }
    const parts: string[] = [];
    const images: ImageAttachment[] = [];
    for (const block of blocks) {
        if (!block || typeof block !== "object") throwInvalidParams("Invalid prompt content block");
        if (block.type === "text") {
            if (typeof block.text !== "string") throwInvalidParams("ACP text prompt content requires text");
            parts.push(block.text);
            continue;
        }
        if (block.type === "image") {
            if (typeof block.data !== "string" || !block.data) {
                throwInvalidParams("ACP image prompt content requires base64 data", { contentType: block.type });
            }
            if (typeof block.mimeType !== "string" || !block.mimeType) {
                throwInvalidParams("ACP image prompt content requires a MIME type", { contentType: block.type });
            }
            images.push({ base64: block.data, mimeType: block.mimeType });
            continue;
        }
        if (block.type === "resource_link") {
            if (typeof block.name !== "string" || typeof block.uri !== "string") {
                throwInvalidParams("ACP resource links require name and uri");
            }
            const label = block.title || block.name || block.uri;
            parts.push(`[Resource: ${label} <${block.uri}>]`);
            continue;
        }
        throwInvalidParams(`Unsupported prompt content block type for RunWield ACP MVP: ${block.type}`, {
            contentType: block.type,
        });
    }
    return { text: parts.join("\n").trim(), images };
}

interface AcpSteeringOptions {
    idleBehavior?: string;
}

interface AcpSteeringMetadata {
    steering?: AcpSteeringOptions;
}

interface AcpSteeringRequest {
    sessionId: string;
    prompt: AcpPromptBlock[];
    _meta?: AcpSteeringMetadata;
}

function validateSteeringParams(params: unknown): AcpSteeringRequest {
    const request = params as AcpSteeringRequest | null;
    if (typeof request?.sessionId !== "string" || !request.sessionId.trim()) {
        throwInvalidParams("_session/steering requires sessionId");
    }
    if (!Array.isArray(request.prompt) || request.prompt.length === 0) {
        throwInvalidParams("_session/steering requires at least one prompt content block");
    }
    if (request._meta !== undefined && !isRecord(request._meta)) {
        throwInvalidParams("_session/steering _meta must be an object");
    }
    if (request._meta?.steering !== undefined && !isRecord(request._meta.steering)) {
        throwInvalidParams("_session/steering _meta.steering must be an object");
    }
    const idleBehavior = request._meta?.steering?.idleBehavior;
    if (idleBehavior !== undefined && idleBehavior !== "promptRequired") {
        throwInvalidParams("_session/steering idleBehavior must be promptRequired");
    }
    return request;
}

function isOpenAbSenderContext(text: string) {
    const match = /^<sender_context>\s*([\s\S]*)\s*<\/sender_context>$/.exec(text.trim());
    if (!match) return false;
    try {
        return JSON.parse(match[1])?.schema === "openab.sender.v1";
    } catch {
        return false;
    }
}

function extractAcpBuiltinCommand(blocks: unknown): AcpBuiltinCommand | null {
    if (!Array.isArray(blocks) || blocks.length === 0) {
        throwInvalidParams("session/prompt requires at least one prompt content block");
    }
    const commandTexts: string[] = [];
    for (const block of blocks) {
        if (!block || typeof block !== "object") throwInvalidParams("Invalid prompt content block");
        if (block.type !== "text") continue;
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

async function buildAcpAvailableCommands(runtime: SessionRuntime, runtimeSessionId: string) {
    const snapshot = runtime.getSessionSnapshot(runtimeSessionId);
    const cwd = snapshot?.cwd;
    const builtins = getSlashCommandDefinitions("acp").map((command) => ({
        name: command.name,
        description: command.description,
        ...(command.usage?.[0] ? { input: { hint: command.usage[0].replace(/^.*?\s+/, "") } } : {}),
    }));
    if (!cwd) return builtins;
    const [templates, skills] = await Promise.all([
        runtime.listSessionPromptTemplates(runtimeSessionId),
        runtime.listSessionSkills(runtimeSessionId),
    ]);
    return [
        ...builtins,
        ...templates
            .filter((template) => !getCommandDefinition(template.name))
            .map((template) => ({
                name: template.name,
                description: template.description || "Prompt template",
                ...(template.argumentHint ? { input: { hint: template.argumentHint } } : {}),
            })),
        ...skills.map((skill) => ({
            name: `skill:${skill.name}`,
            description: skill.description || "Skill",
        })),
    ];
}

async function notifyAcpCommandCatalog(
    context: AcpNotificationContext,
    runtime: SessionRuntime,
    runtimeSessionId: string,
    acpSessionId: string,
) {
    await notifyClient(context, methods.client.session.update, {
        sessionId: acpSessionId,
        update: {
            sessionUpdate: "available_commands_update",
            availableCommands: await buildAcpAvailableCommands(runtime, runtimeSessionId),
        },
    });
}

async function notifyAcpModelOptions(
    context: AcpNotificationContext,
    runtime: SessionRuntime,
    runtimeSessionId: string,
    acpSessionId: string,
) {
    await notifyClient(context, methods.client.session.update, {
        sessionId: acpSessionId,
        update: {
            sessionUpdate: "config_option_update",
            configOptions: await buildAcpModelOptions(runtime, runtimeSessionId),
        },
    });
}

async function notifyAcpContextUsage(
    context: AcpNotificationContext,
    runtime: SessionRuntime,
    sessionMap: AcpSessionMap,
    runtimeSessionId: string,
    acpSessionId: string,
) {
    const contextUsage = runtime.getSessionSnapshot(runtimeSessionId)?.contextUsage || null;
    const update = mapRuntimeContextToAcpUpdate(contextUsage, sessionMap.getRecord(acpSessionId)?.usageCostUsd || 0);
    if (update) await notifyClient(context, methods.client.session.update, { sessionId: acpSessionId, update });
}

type AcpCommandSelectOption = SelectOption;

function createAcpCommandUiAPI(options: AcpCommandUiOptions) {
    const requestSelection = async (
        type: RuntimeInteractionRequest["type"],
        title: string,
        choices: AcpCommandSelectOption[],
        requestOptions: AcpTextOptions = {},
    ) => {
        const response = await options.runtime.requestInteraction(options.runtimeSessionId, {
            type,
            prompt: title,
            options: choices,
            defaultValue: requestOptions.defaultValue,
            placeholder: requestOptions.placeholder,
            allowEmpty: requestOptions.allowEmpty,
        });
        if (
            response.outcome === RuntimeInteractionOutcomes.CANCELED ||
            response.outcome === RuntimeInteractionOutcomes.UNSUPPORTED ||
            response.outcome === RuntimeInteractionOutcomes.BLOCKED
        ) {
            if (response.outcome === RuntimeInteractionOutcomes.CANCELED) options.onCanceled?.();
            if (response.message) options.sendMessage(response.message, true);
            return null;
        }
        if (response.outcome === RuntimeInteractionOutcomes.SELECTED && response.value === "cancel")
            options.onCanceled?.();
        return String(response.value || "");
    };
    const appendAgentText = (text: string) => options.sendMessage(text);
    const promptSelect = (title: string, choices: AcpCommandSelectOption[]) =>
        requestSelection(RuntimeInteractionTypes.SELECT, title, choices);
    const promptText = (title: string, textOptions: AcpTextOptions = {}) =>
        requestSelection(RuntimeInteractionTypes.TEXT, title, [], {
            defaultValue: textOptions.defaultValue,
            placeholder: textOptions.placeholder,
            allowEmpty: textOptions.allowEmpty,
        });
    return {
        appendSystemMessage: options.sendMessage,
        appendAgentMessageStart: () => ({ appendText: appendAgentText }),
        requestRender: () => {},
        abortActivePrompt: () => {},
        promptSelect,
        promptText,
        showModelSelector: async (initialSearchInput = "") => {
            const available = await listUserModelOptions();
            const choices = available.map((model) => ({
                value: `${model.provider}/${model.id}`,
                label: model.name ? `${model.name} (${model.provider}/${model.id})` : `${model.provider}/${model.id}`,
            }));
            const selected = await requestSelection(RuntimeInteractionTypes.SELECT, "Select model", choices, {
                defaultValue: initialSearchInput,
            });
            if (!selected) return { selected: false };
            const parsed = parseUserModelSelection(selected);
            const result = await applyUserModelSelection(
                options.runtime,
                options.runtimeSessionId,
                parsed.model,
                parsed.provider,
            );
            if (!result.ok) {
                options.sendMessage(
                    `Could not switch model to ${parsed.provider}/${parsed.model}: ${result.error}. The active model did not change.`,
                    true,
                );
                return { selected: false };
            }
            return { selected: true };
        },
    };
}

async function dispatchAcpBuiltinCommand(options: AcpBuiltinCommandOptions): Promise<PromptResponse> {
    let runtimeSessionId = options.runtimeSessionId;
    const definition = getSlashCommandDefinition(options.commandName, "acp");
    const operation = createLiveOperation(options);
    options.onOperation(operation);
    operation.start(options.context, `command-${crypto.randomUUID()}`);
    let menuCanceled = false;
    const sendMessage = (text: string, isError: boolean = false) =>
        operation.sendMessage(text, { command: options.commandName, level: isError ? "error" : "info" });
    const execution = (async () => {
        if (!definition) {
            const root = options.runtime.getSessionSnapshot?.(runtimeSessionId)?.cwd;
            if (root) {
                const rejected = new SlashCommandMetricsTracker({
                    command: "unknown",
                    kind: "builtin",
                    surface: "acp",
                    projectRoot: root,
                    sessionId: runtimeSessionId,
                    requestId: options.requestId,
                });
                await rejected.recordStart();
                await rejected.recordFinish({ outcome: "rejected", errorReason: "unknown_command" });
            }
            const reserved = getCommandDefinition(options.commandName);
            sendMessage(
                reserved
                    ? `Command /${options.commandName} is not available in ACP.`
                    : `Unknown command: /${options.commandName}`,
            );
            return;
        }
        if (["help", "--help", "-h"].includes(options.args[0] || "")) {
            const root = options.runtime.getSessionSnapshot?.(runtimeSessionId)?.cwd;
            const helpTracker = root
                ? new SlashCommandMetricsTracker({
                      command: definition.name,
                      kind: "builtin",
                      surface: "acp",
                      projectRoot: root,
                      sessionId: runtimeSessionId,
                      requestId: options.requestId,
                  })
                : null;
            await helpTracker?.recordStart();
            await helpTracker?.recordDispatched();
            const { formatCommandHelp } = await import("../cmd/help/index.ts");
            sendMessage(formatCommandHelp(definition.name) || `No help is available for /${definition.name}.`);
            await helpTracker?.recordFinish({ outcome: "succeeded" });
            return;
        }
        const commandUiAPI = createAcpCommandUiAPI({
            runtime: options.runtime,
            get runtimeSessionId() {
                return operation.runtimeSessionId;
            },
            sendMessage,
            onCanceled: () => {
                menuCanceled = true;
            },
        });
        const commandEditor = {
            disableSubmit: false,
            setText: () => {},
            setAutocompleteProvider: () => {},
            handleInput: () => {},
        };
        const commandTui = { requestRender: () => {}, setFocus: () => {} };
        const snapshot = options.runtime.getSessionSnapshot?.(runtimeSessionId);
        const tracker = snapshot?.cwd
            ? new SlashCommandMetricsTracker({
                  command: definition.name,
                  alias: options.commandName !== definition.name ? options.commandName : undefined,
                  kind: "builtin",
                  surface: "acp",
                  projectRoot: snapshot.cwd,
                  sessionId: runtimeSessionId,
                  requestId: options.requestId,
              })
            : null;
        const picker = (definition.name === "agent" || definition.name === "model") && options.args.length === 0;
        await tracker?.recordStart(picker ? "opened" : "start");
        if (!picker) await tracker?.recordDispatched();
        if (picker) {
            const select = commandUiAPI.promptSelect;
            commandUiAPI.promptSelect = async (...args) => {
                const selected = await select(...args);
                if (selected) await tracker?.recordDispatched();
                return selected;
            };
        }
        let outcome: SlashCommandOutcome = "succeeded";
        let errorReason = null;
        try {
            const result = await definition.execute(options.args, {
                uiAPI: commandUiAPI,
                editor: commandEditor,
                tui: commandTui,
                sessionRuntime: options.runtime,
                sessionId: runtimeSessionId,
                slashSurface: "acp",
                commandInvocationId: tracker?.invocationId,
                replaceRuntimeSession: (nextSessionId) => {
                    operation.replaceRuntimeSession(nextSessionId);
                    runtimeSessionId = nextSessionId;
                },
            });
            if (result === "failed" || result === "canceled" || result === "rejected") outcome = result;
        } catch (execError) {
            outcome = operation.cancelled ? "canceled" : "failed";
            errorReason = "failed";
            throw execError;
        } finally {
            if ((operation.cancelled || menuCanceled) && outcome !== "failed") outcome = "canceled";
            await tracker?.recordFinish({
                outcome: outcome,
                errorReason,
            });
        }
    })();
    const settlement = execution.then(
        () => operation.settle({ ok: true }),
        (error) => operation.settle(null, error),
    );
    return await operation.waitForRequest(options.context, settlement, "", []);
}

export function validateNewSessionParams(params: unknown) {
    const request = (params || {}) as NewSessionRequest;
    if (!request.cwd || typeof request.cwd !== "string" || !isAbsolute(request.cwd)) {
        throwInvalidParams("session/new requires an absolute cwd", { cwd: request.cwd });
    }
    const mcpServers = validateAcpMcpServers(request.mcpServers);
    if (
        isNonEmptyArray(request.additionalDirectories) ||
        (request.additionalDirectories &&
            typeof request.additionalDirectories === "object" &&
            Object.keys(request.additionalDirectories).length > 0)
    ) {
        throwInvalidParams("RunWield ACP MVP does not support additionalDirectories yet", {
            field: "additionalDirectories",
        });
    }
    return { ...request, mcpServers: request.mcpServers, runwieldMcpServers: mcpServers };
}

function validateLoadSessionParams(params: unknown) {
    const request = (params || {}) as AcpLoadRequest;
    const validated = validateNewSessionParams(request);
    if (!request.sessionId || typeof request.sessionId !== "string") {
        throwInvalidParams("session/load requires sessionId", { sessionId: request.sessionId });
    }
    const sessionPath = request._meta?.runwield?.sessionPath;
    if (sessionPath !== undefined && typeof sessionPath !== "string") {
        throwInvalidParams("session/load _meta.runwield.sessionPath must be a string", { field: "sessionPath" });
    }
    return { ...request, runwieldMcpServers: validated.runwieldMcpServers, sessionPath };
}

function validateCloseSessionParams(params: unknown) {
    const request = (params || {}) as CloseSessionRequest;
    if (!request.sessionId || typeof request.sessionId !== "string") {
        throwInvalidParams("session/close requires sessionId", { sessionId: request.sessionId });
    }
    return request;
}

async function closeMappedSession(runtime: SessionRuntime, sessionMap: AcpSessionMap, acpSessionId: string) {
    const record = sessionMap.getRecord(acpSessionId);
    if (!record) return { ok: false, closed: false, error: "not_found" };
    const runtimeSessionId = sessionMap.getRuntimeSessionId(acpSessionId);
    sessionMap.markCancelled(acpSessionId);
    if (runtimeSessionId) {
        if (runtime.closeSessionWhenIdle) {
            await runtime.closeSessionWhenIdle(runtimeSessionId);
        } else {
            try {
                runtime.cancelSession(runtimeSessionId);
            } catch {
                // Close should still dispose mapping if cancellation fails.
            }
            await runtime.closeSession(runtimeSessionId);
        }
    }
    sessionMap.deleteRecord(acpSessionId);
    return { ok: true, closed: Boolean(runtimeSessionId), record };
}

async function closeAllMappedSessions(runtime: SessionRuntime, sessionMap: AcpSessionMap) {
    for (const record of sessionMap.listRecords()) await closeMappedSession(runtime, sessionMap, record.acpSessionId);
    if (runtime.closeAllSessionsWhenIdle) await runtime.closeAllSessionsWhenIdle();
    else runtime.closeAllSessions?.();
}

/**
 * Map one Runtime event for an ACP Session, folding usage cost into the Session total.
 *
 * The Runtime reports the cost of a single assistant message; ACP wants the cumulative
 * Session cost. Every mapping site goes through here so live, replayed, and setup events
 * all add to the same total.
 */
export function mapEventWithSessionCost(
    sessionMap: AcpSessionMap,
    acpSessionId: string,
    event: SessionRuntimeEvent,
    contextUsage: AcpContextUsage | null = null,
) {
    const sessionCostUsd =
        event.type === RuntimeEventTypes.USAGE
            ? sessionMap.addUsageCost(acpSessionId, event.usage?.costUsd)
            : sessionMap.getRecord(acpSessionId)?.usageCostUsd || 0;
    return mapRuntimeEventToAcpSessionNotification(acpSessionId, event, sessionCostUsd, contextUsage);
}

function releasePromptsAfterResponses(stream: AcpStream, promptReleases: Map<string, () => void>): AcpStream {
    const writer = stream.writable.getWriter();
    return {
        readable: stream.readable,
        writable: new WritableStream({
            async write(message) {
                const responseId =
                    isRecord(message) && "id" in message && ("result" in message || "error" in message)
                        ? String(message.id)
                        : null;
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
    runtime: SessionRuntime,
    sessionMap: AcpSessionMap,
    runtimeSessionId: string,
    acpSessionId: string,
) {
    const pendingNotifications: Array<void | Promise<void>> = [];
    const unsubscribe = runtime.subscribeSessionEvents(runtimeSessionId, (event) => {
        const contextUsage = runtime.getSessionSnapshot(runtimeSessionId)?.contextUsage || null;
        const notification = mapEventWithSessionCost(sessionMap, acpSessionId, event, contextUsage);
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
    const { runtime, sessionMap, acpSessionId, clientCapabilities, releasePromptAfterResponse } = options;
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
                queue((context) => notifyAcpCommandCatalog(context, runtime, runtimeSessionId, acpSessionId));
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
            const usage = runtime.getSessionSnapshot(runtimeSessionId)?.contextUsage || null;
            const notification = mapEventWithSessionCost(sessionMap, acpSessionId, event, usage);
            if (
                event.type === RuntimeEventTypes.MODEL_CHANGED ||
                event.type === RuntimeEventTypes.AGENT_CHANGED ||
                event.type === RuntimeEventTypes.THINKING_LEVEL_CHANGED
            ) {
                queue(async (context) => {
                    await notifyAcpModelOptions(context, runtime, runtimeSessionId, acpSessionId);
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
                    if (runtime.answerInteraction(runtimeSessionId, expectedInteractionId || "", reply)) {
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
function createRunWieldAcpServer(context: AcpServerContext): AgentApp {
    const app = agent({ name: "RunWield ACP MVP" });
    const { runtime, sessionMap, releasePromptAfterResponse } = context;
    const operations = context.operations;
    let clientCapabilities: ClientCapabilities | null = null;

    app.onRequest(methods.agent.initialize, (context) => {
        clientCapabilities = context.params?.clientCapabilities || null;
        return createInitializeResponse(context.params);
    });

    // The SDK's default parser silently drops malformed MCP definitions. Validate
    // the original request so a client never receives a Session missing its tools.
    app.onRequest(methods.agent.session.new, validateNewSessionParams, async (context) => {
        const request = context.params;
        const readiness = getSelectedDefaultModelAvailability(request.cwd);
        if (!readiness.available) throwAuthenticationRequired(request.cwd);
        let runtimeSessionId;
        try {
            runtimeSessionId = await runtime.createPromptReadySession({
                cwd: request.cwd,
                mcpServers: request.runwieldMcpServers,
            });
        } catch (error) {
            throwProjectRuntimeRefusal(error, request.cwd);
            throw error;
        }
        const snapshot = runtime.getSessionSnapshot(runtimeSessionId);
        if (!snapshot) throwUnknownSession(runtimeSessionId);
        const persistedSessionId = snapshot.sessionManagerId || runtimeSessionId;
        const record = sessionMap.createRecord(
            { sessionId: runtimeSessionId, cwd: snapshot.cwd },
            { persistedSessionId },
        );
        await replaySetupEvents(context, runtime, sessionMap, runtimeSessionId, record.acpSessionId);
        const configOptions = await buildAcpModelOptions(runtime, runtimeSessionId);
        queueMicrotask(() => {
            notifyAcpCommandCatalog(context, runtime, runtimeSessionId, record.acpSessionId).catch(() => {});
        });
        return {
            sessionId: record.acpSessionId,
            configOptions,
            _meta: {
                runwield: {
                    runtimeSessionId,
                    persistedSessionId,
                    cwd: snapshot.cwd,
                },
            },
        };
    });

    app.onRequest(methods.agent.session.load, validateLoadSessionParams, async (context) => {
        const request = context.params;
        const persistedSessionId = normalizeAcpSessionIdForLoad(request.sessionId);
        if (
            sessionMap
                .listRecords()
                .some(
                    (record) =>
                        record.acpSessionId === request.sessionId || record.persistedSessionId === persistedSessionId,
                )
        ) {
            throw new RequestError(ACP_INVALID_STATE, `ACP session already exists: ${request.sessionId}`);
        }
        try {
            const result = await runtime.loadSession({
                cwd: request.cwd,
                sessionId: persistedSessionId,
                sessionPath: request.sessionPath,
                mcpServers: request.runwieldMcpServers,
            });
            const snapshot = runtime.getSessionSnapshot(result.sessionId);
            const stablePersistedSessionId = snapshot?.managed?.runwieldSessionId || result.sessionManagerId;
            const record = sessionMap.createRecord(
                { sessionId: result.sessionId, cwd: result.cwd },
                {
                    acpSessionId: request.sessionId,
                    loaded: true,
                    persistedSessionId: stablePersistedSessionId,
                    sessionPath: result.sessionPath,
                },
            );
            const notifications = result.replayEvents
                .map((event) =>
                    mapEventWithSessionCost(
                        sessionMap,
                        record.acpSessionId,
                        event,
                        runtime.getSessionSnapshot(result.sessionId)?.contextUsage || null,
                    ),
                )
                .filter(Boolean)
                .map((notification) => notifyClient(context, methods.client.session.update, notification!));
            await Promise.allSettled(notifications);
            const configOptions = await buildAcpModelOptions(runtime, result.sessionId);
            queueMicrotask(() => {
                notifyAcpCommandCatalog(context, runtime, result.sessionId, record.acpSessionId).catch(() => {});
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
            throwProjectRuntimeRefusal(error, request.cwd);
            const message = error instanceof Error ? error.message : String(error || "session/load failed");
            if (message.includes("already exists")) {
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
        const exposedOptions = await buildAcpModelOptions(runtime, runtimeSessionId);
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
            const models = await listUserModelOptions();
            const selected = models.find((model) => `${model.provider}/${model.id}` === value);
            if (!selected) throwInvalidParams(`Model is not available: ${value}`, { configId, value });
            const result = await applyUserModelSelection(runtime, runtimeSessionId, selected.id, selected.provider);
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
        const configOptions = await buildAcpModelOptions(runtime, runtimeSessionId);
        await notifyClient(context, methods.client.session.update, {
            sessionId,
            update: { sessionUpdate: "config_option_update", configOptions },
        });
        await notifyAcpContextUsage(context, runtime, sessionMap, runtimeSessionId, sessionId);
        return { configOptions };
    });

    app.onRequest("_session/steering", validateSteeringParams, async (context) => {
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
        const requestedCommand = operations.get(acpSessionId)?.question
            ? null
            : extractAcpBuiltinCommand(request.prompt);
        if (requestedCommand?.name === "plan-review" && requestedCommand.args.length === 0) {
            const snapshot = runtime.getSessionSnapshot(runtimeSessionId);
            const planReviewTracker = snapshot?.cwd
                ? new SlashCommandMetricsTracker({
                      command: "plan-review",
                      kind: "builtin",
                      surface: "acp",
                      projectRoot: snapshot.cwd,
                      sessionId: runtimeSessionId,
                  })
                : null;
            if (snapshot?.livePlanReview) {
                await planReviewTracker?.recordStart();
                await planReviewTracker?.recordDispatched();
                let result;
                try {
                    result = await runtime.reopenPlanReview(runtimeSessionId);
                    await planReviewTracker?.recordFinish({ outcome: result.url ? "succeeded" : "failed" });
                } catch (error) {
                    await planReviewTracker?.recordFinish({ outcome: "failed", errorReason: "failed" });
                    throw error;
                }
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
                await planReviewTracker?.recordStart();
                await planReviewTracker?.recordFinish({ outcome: "rejected", errorReason: "unavailable" });
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
        const builtinCommand = extractAcpBuiltinCommand(request.prompt);
        if (builtinCommand) {
            const isBuiltInName = Boolean(getCommandDefinition(builtinCommand.name));
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

    app.onRequest(methods.agent.session.delete, async (requestContext) => {
        const sessionId = requestContext.params?.sessionId;
        if (typeof sessionId !== "string" || !sessionId) {
            throwInvalidParams("session/delete requires sessionId");
        }
        const { sessionStore } = context;
        const record = sessionMap.getRecord(sessionId);
        const snapshot = record ? runtime.getSessionSnapshot(record.runtimeSessionId) : null;
        const persistedId =
            snapshot?.managed?.runwieldSessionId ||
            record?.persistedSessionId ||
            normalizeAcpSessionIdForLoad(sessionId);
        const session =
            sessionStore.getSessionById(persistedId) || sessionStore.findSessionByLocator({ piSessionId: persistedId });
        if (record) {
            sessionMap.markCancelled(sessionId);
            operations.get(sessionId)?.cancel();
            if (runtime.closeSessionWhenIdle) {
                await runtime.closeSessionWhenIdle(record.runtimeSessionId);
            } else {
                await runtime.cancelSession(record.runtimeSessionId);
                if (session) await waitForSessionActivationSettlement(sessionStore, session.runwieldSessionId);
                await runtime.closeSession(record.runtimeSessionId);
            }
        }
        if (session) {
            const activation = sessionStore.inspectSessionActivation(session.runwieldSessionId).activation;
            if (activation?.state === "active" && activation.operationId) {
                const result = await readLiveSessionConnection(session.runwieldSessionId, activation.operationId, {
                    action: "cancel",
                });
                if (!result.ok) throw new Error(result.error || "The Session could not be stopped.");
            }
            await waitForSessionActivationSettlement(sessionStore, session.runwieldSessionId);
            sessionStore.archiveSession(session.runwieldSessionId, session.projectId);
        }
        operations.get(sessionId)?.stop();
        operations.delete(sessionId);
        sessionMap.deleteRecord(sessionId);
        return {};
    });

    app.onRequest(methods.agent.session.close, async (context) => {
        const request = validateCloseSessionParams(context.params);
        const record = sessionMap.getRecord(request.sessionId);
        if (!record) throwUnknownSession(request.sessionId);
        operations.get(request.sessionId)?.cancel();
        operations.get(request.sessionId)?.stop();
        const result = await closeMappedSession(runtime, sessionMap, request.sessionId);
        operations.delete(request.sessionId);
        if (!result.ok) throwUnknownSession(request.sessionId);
        return { _meta: { runwield: { sessionId: request.sessionId, closed: result.closed } } };
    });

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
    registerUnimplementedRequest(app, methods.agent.nes.start);
    registerUnimplementedRequest(app, methods.agent.nes.suggest);
    registerUnimplementedRequest(app, methods.agent.nes.close);

    return app;
}

/**
 * Start the RunWield ACP server on newline-delimited JSON streams.
 */
export function startRunWieldAcpServer(
    input: ReadableStream<Uint8Array>,
    output: WritableStream<Uint8Array>,
    options: RunWieldAcpServerOptions = {},
): AgentConnection {
    const promptReleases: Map<string, () => void> = new Map();
    const stream = releasePromptsAfterResponses(ndJsonStream(output, input), promptReleases);
    const sessionStore = openFileSessionStore();
    const runtime = createSessionRuntime({ sessionStore, ownerProcessKind: "acp" });
    const sessionMap = new AcpSessionMap();
    const operations: Map<string, ReturnType<typeof createLiveOperation>> = new Map();
    const connection = createRunWieldAcpServer({
        runtime,
        sessionStore,
        sessionMap,
        operations,
        releasePromptAfterResponse: (requestId, release) => {
            promptReleases.set(requestId, release);
        },
    }).connect(stream);
    const closeMachinery = async () => {
        try {
            for (const operation of operations.values()) {
                operation.cancel();
                operation.stop();
            }
            operations.clear();
            await closeAllMappedSessions(runtime, sessionMap);
        } finally {
            sessionStore.close();
        }
    };
    const closed = connection.closed.then(closeMachinery, closeMachinery);
    const diagnostics = options.diagnostic;
    if (diagnostics) diagnostics("RunWield ACP stdio server started");
    return {
        signal: connection.signal,
        client: connection.client,
        close: (error) => connection.close(error),
        closed,
    };
}
