import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { isExternalCliProvider } from "../models/model-registry.ts";
import {
    type Api,
    type AssistantMessage,
    type AssistantMessageEvent,
    type AssistantMessageEventStream,
    type Context,
    createAssistantMessageEventStream,
    createProvider,
    InMemoryCredentialStore,
    type Model,
    type ModelsApiStreamOptions,
    type ModelsSimpleStreamOptions,
    type ProviderStreams,
} from "@earendil-works/pi-ai";

/** Only display and planning fields cross the connection; endpoint and auth data never do. */
export type RemoteModel =
    & Pick<
        Model<Api>,
        "id" | "name" | "api" | "provider" | "reasoning" | "input" | "cost" | "contextWindow" | "maxTokens"
    >
    & Pick<Model<Api>, "thinkingLevelMap" | "inputLimits" | "promptCache">;
export interface RemoteProvider {
    id: string;
    name: string;
    available: boolean;
    oauth: boolean;
    subscription: boolean;
}
export interface RemoteCatalog {
    providers: RemoteProvider[];
    models: RemoteModel[];
    available: Array<{ provider: string; id: string }>;
}
export interface RemoteModelConnection {
    port: number;
    credential: string;
    /** Only the bounded no-extension Pi loader may opt into dropping its no-op hooks. */
    callbackPolicy?: "no-extensions";
}

type StreamOptions = ModelsSimpleStreamOptions | ModelsApiStreamOptions<Api>;
interface StreamRequest {
    id: string;
    provider: string;
    model: string;
    simple: boolean;
    context: Context;
    options: StreamOptions;
}
const optionKeys = new Set([
    "temperature",
    "maxTokens",
    "timeoutMs",
    "maxRetries",
    "maxRetryDelayMs",
    "transport",
    "cacheRetention",
    "sessionId",
    "websocketConnectTimeoutMs",
    "metadata",
    "samplingParams",
    "reasoning",
    "thinkingBudgets",
    "toolChoice",
    "reasoningEffort",
    "reasoningSummary",
    "serviceTier",
    "thinking",
    "interleavedThinking",
    "thinkingDisplay",
]);
const eventTypes = new Set([
    "start",
    "text_start",
    "text_delta",
    "text_end",
    "thinking_start",
    "thinking_delta",
    "thinking_end",
    "toolcall_start",
    "toolcall_delta",
    "toolcall_end",
    "done",
    "error",
]);
const encoder = new TextEncoder();

function safeModel(model: Model<Api>): RemoteModel {
    const {
        id,
        name,
        api,
        provider,
        reasoning,
        input,
        cost,
        contextWindow,
        maxTokens,
        thinkingLevelMap,
        inputLimits,
        promptCache,
    } = model;
    return {
        id,
        name,
        api,
        provider,
        reasoning,
        input,
        cost,
        contextWindow,
        maxTokens,
        thinkingLevelMap,
        inputLimits,
        promptCache,
    };
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
function serializable(value: JsonValue): boolean {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(serializable);
    if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
    return Object.values(value).every(serializable);
}

/** Do not forward credentials, environment, fetch implementations, headers or arbitrary callback hooks. */
function safeOptions(
    options: StreamOptions = {},
    callbackPolicy?: "no-extensions",
): ModelsSimpleStreamOptions & ModelsApiStreamOptions<Api> {
    for (const key of Object.keys(options)) {
        if (key === "signal" || key === "model") continue; // Identity travels separately in the stream request.
        // Only this bounded loader disables extensions. Pi passes its Agent-loop callbacks
        // through to providers; these already execute in that remote Agent, not in the laptop stream.
        if (
            callbackPolicy === "no-extensions" && new Set([
                "onPayload",
                "onResponse",
                "onProviderStreamEvent",
                "transformHeaders",
                "toolExecution",
                "beforeToolCall",
                "afterToolCall",
                "finishTurn",
                "prepareRequest",
                "prepareNextTurn",
                "convertToLlm",
                "transformContext",
                "getApiKey",
                "getSteeringMessages",
                "getFollowUpMessages",
            ]).has(key)
        ) continue;
        if (
            callbackPolicy === "no-extensions" && key === "headers" &&
            Object.keys(Reflect.get(options, key) ?? {}).length === 0
        ) continue;
        if (!optionKeys.has(key) && Reflect.get(options, key) !== undefined) {
            throw new Error(`Unsupported remote model option: ${key}`);
        }
    }
    const result: Record<string, string | number | boolean | Record<string, string | number | boolean> | undefined> =
        {};
    for (const key of optionKeys) {
        const value = Reflect.get(options, key);
        if (value !== undefined) {
            if (!serializable(value)) {
                throw new Error(`Unsupported remote model option: ${key}`);
            }
            const encoded = JSON.stringify(value);
            if (encoded === undefined) {
                throw new Error(`Unsupported remote model option: ${key}`);
            }
            Reflect.set(result, key, JSON.parse(encoded));
        }
    }
    return result as ModelsSimpleStreamOptions & ModelsApiStreamOptions<Api>;
}

function safeProviderDiagnostic(message: string | undefined): string {
    // Only fixed diagnostics cross the bridge. Raw provider errors can contain
    // URLs, headers or credentials, but Pi still needs its retry categories.
    const text = message ?? "";
    if (/unexpected eof|stream ended before|socket hang up|connection lost|network error|fetch failed/i.test(text)) {
        return "Network error: Unexpected EOF";
    }
    if (/\b429\b|rate.?limit|too many requests/i.test(text)) return "HTTP 429: rate limit";
    if (/\b50[0234]\b|\b52[04]\b|overloaded|service unavailable|timeout|timed out/i.test(text)) {
        return "HTTP 503: service unavailable";
    }
    if (/context.length.exceeded|context.length|context overflow/i.test(text)) return "context_length_exceeded";
    if (
        /\btemperature\b/i.test(text) &&
        /unsupported|not supported|not allowed|not accepted|invalid temperature/i.test(text)
    ) {
        return "temperature is not supported";
    }
    if (/\b401\b|\b403\b|unauthori[sz]ed|invalid.api.key/i.test(text)) return "HTTP 401: unauthorized";
    return "Laptop model request failed";
}

function safeMessage(message: AssistantMessage): AssistantMessage {
    const {
        role,
        api,
        provider,
        model,
        responseModel,
        responseId,
        providerThinkingLevel,
        usage,
        stopReason,
        errorMessage,
        rawStopReason,
        endTurn,
        timestamp,
    } = message;
    const content = message.content.map((part) => {
        if (part.type === "text") return { type: part.type, text: part.text, textSignature: part.textSignature };
        if (part.type === "thinking") {
            return {
                type: part.type,
                thinking: part.thinking,
                thinkingSignature: part.thinkingSignature,
                redacted: part.redacted,
            };
        }
        return {
            type: part.type,
            id: part.id,
            name: part.name,
            arguments: part.arguments,
            thoughtSignature: part.thoughtSignature,
            namespace: part.namespace,
        };
    });
    return {
        role,
        content,
        api,
        provider,
        model,
        responseModel,
        responseId,
        providerThinkingLevel,
        // Preserve upstream absence. Pi's type requires usage, but a remote completion can omit it.
        usage: usage && {
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
            cacheWrite1h: usage.cacheWrite1h,
            reasoning: usage.reasoning,
            totalTokens: usage.totalTokens,
            cost: usage.cost && {
                input: usage.cost.input,
                output: usage.cost.output,
                cacheRead: usage.cost.cacheRead,
                cacheWrite: usage.cost.cacheWrite,
                total: usage.cost.total,
            },
        },
        stopReason,
        // Provider errors can contain request URLs or headers. Do not export their raw text.
        errorMessage: stopReason === "aborted"
            ? "Model request cancelled"
            : stopReason === "error"
            ? safeProviderDiagnostic(errorMessage)
            : errorMessage,
        rawStopReason: stopReason === "error" || stopReason === "aborted" ? undefined : rawStopReason,
        endTurn,
        timestamp,
    };
}

function safeEvent(event: AssistantMessageEvent): AssistantMessageEvent {
    switch (event.type) {
        case "start":
        case "text_start":
        case "thinking_start":
        case "toolcall_start":
            return {
                type: event.type,
                ...(event.type !== "start" ? { contentIndex: event.contentIndex } : {}),
                partial: safeMessage(event.partial),
            } as AssistantMessageEvent;
        case "text_delta":
        case "thinking_delta":
        case "toolcall_delta":
            return {
                type: event.type,
                contentIndex: event.contentIndex,
                delta: event.delta,
                partial: safeMessage(event.partial),
            };
        case "text_end":
        case "thinking_end":
            return {
                type: event.type,
                contentIndex: event.contentIndex,
                content: event.content,
                partial: safeMessage(event.partial),
            };
        case "toolcall_end":
            return {
                type: event.type,
                contentIndex: event.contentIndex,
                toolCall: {
                    type: event.toolCall.type,
                    id: event.toolCall.id,
                    name: event.toolCall.name,
                    arguments: event.toolCall.arguments,
                    thoughtSignature: event.toolCall.thoughtSignature,
                    namespace: event.toolCall.namespace,
                },
                partial: safeMessage(event.partial),
            };
        case "done":
            return { type: "done", reason: event.reason, message: safeMessage(event.message) };
        case "error":
            return { type: "error", reason: event.reason, error: safeMessage(event.error) };
    }
}

function failure(model: Model<Api>, reason: string, stopReason: "error" | "aborted" = "error"): AssistantMessage {
    return {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason,
        errorMessage: reason,
        timestamp: Date.now(),
    };
}

/** A bridge lives for one authenticated control connection. */
export class LocalModelBridge {
    private readonly active = new Map<string, AbortController>();
    private readonly completed = new Set<string>();
    private closed = false;
    constructor(private readonly runtime: ModelRuntime) {}

    async catalog(): Promise<RemoteCatalog> {
        if (this.closed) throw new Error("Model bridge closed");
        const available = await this.runtime.getAvailable();
        return {
            providers: this.runtime.getProviders().filter((provider) => !isExternalCliProvider(provider.id)).map((
                provider,
            ) => ({
                id: provider.id,
                name: provider.name,
                available: this.runtime.hasConfiguredAuth(provider.id),
                oauth: this.runtime.isUsingOAuth(provider.id),
                subscription: this.runtime.isUsingSubscription(provider.id),
            })),
            models: this.runtime.getModels().filter((model) => !isExternalCliProvider(model.provider)).map(safeModel),
            available: available.filter(({ provider }) => !isExternalCliProvider(provider)).map(({ provider, id }) => ({
                provider,
                id,
            })),
        };
    }

    cancel(id: string): void {
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return;
        this.completed.add(id); // Also reject a start that arrives after its cancellation.
        this.active.get(id)?.abort();
    }
    close(): void {
        this.closed = true;
        for (const controller of this.active.values()) controller.abort();
        this.active.clear();
    }

    stream(request: StreamRequest): Response {
        if (
            this.closed || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.id) || this.completed.has(request.id) ||
            this.active.has(request.id)
        ) {
            return new Response(null, { status: 409 });
        }
        if (isExternalCliProvider(request.provider)) return new Response(null, { status: 404 });
        const model = this.runtime.getModel(request.provider, request.model);
        if (!model || !this.runtime.hasConfiguredAuth(request.provider)) return new Response(null, { status: 404 });
        this.completed.add(request.id); // A retry must not issue a second paid request.
        const abort = new AbortController();
        this.active.set(request.id, abort);
        const body = new ReadableStream<Uint8Array>({
            start: (controller) => {
                let terminal = false;
                let ended = false;
                const send = (event: AssistantMessageEvent) => {
                    if (ended || terminal) return;
                    controller.enqueue(encoder.encode(JSON.stringify(safeEvent(event)) + "\n"));
                    if (event.type === "done" || event.type === "error") terminal = true;
                };
                const finish = () => {
                    if (ended) return;
                    ended = true;
                    this.active.delete(request.id);
                    try {
                        controller.close();
                    } catch { /* disconnected */ }
                };
                abort.signal.addEventListener("abort", () => {
                    try {
                        send({
                            type: "error",
                            reason: "aborted",
                            error: failure(model, "Model request cancelled", "aborted"),
                        });
                    } catch { /* disconnected */ }
                    finish();
                }, { once: true });
                void (async () => {
                    try {
                        const options: ModelsSimpleStreamOptions & ModelsApiStreamOptions<Api> = {
                            ...safeOptions(request.options),
                            signal: abort.signal,
                        };
                        const source = request.simple
                            ? this.runtime.streamSimple(model, request.context, options)
                            : this.runtime.stream(model, request.context, options);
                        for await (const event of source) {
                            if (!eventTypes.has(event.type)) throw new Error("Unsupported model event");
                            send(event);
                        }
                        if (!terminal && !ended) {
                            send({
                                type: "error",
                                reason: "error",
                                error: failure(model, "Model stream ended without a result"),
                            });
                        }
                    } catch (error) {
                        if (!ended) {
                            send({
                                type: "error",
                                reason: "error",
                                error: failure(model, error instanceof Error ? error.message : String(error)),
                            });
                        }
                    } finally {
                        finish();
                    }
                })();
            },
            cancel: () => abort.abort(),
        });
        return new Response(body, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
    }
}

async function readBounded(request: Request): Promise<StreamRequest> {
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Missing stream body");
    const parts: Uint8Array[] = [];
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 8 * 1024 * 1024) {
            await reader.cancel();
            throw new Error("Stream body too large");
        }
        parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
    }
    const data: StreamRequest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
        !data || typeof data.id !== "string" || typeof data.provider !== "string" || typeof data.model !== "string" ||
        typeof data.simple !== "boolean" || !data.context || !data.options || typeof data.options !== "object"
    ) throw new Error("Invalid model request");
    safeOptions(data.options);
    return data;
}

/** Call only after control authentication, handshake, and live-connection checks. */
export async function handleModelRequest(bridge: LocalModelBridge, request: Request, path: string): Promise<Response> {
    if (request.method === "GET" && path === "/models/catalog") return Response.json(await bridge.catalog());
    if (request.method === "POST" && path === "/models/stream") {
        try {
            return bridge.stream(await readBounded(request));
        } catch {
            return new Response(null, { status: 400 });
        }
    }
    if (request.method === "POST" && path.startsWith("/models/cancel/")) {
        bridge.cancel(decodeURIComponent(path.slice("/models/cancel/".length)));
        return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
}

function call(connection: RemoteModelConnection, path: string, init?: RequestInit): Promise<Response> {
    return fetch(`http://127.0.0.1:${connection.port}/models/${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${connection.credential}`, "Content-Type": "application/json" },
    });
}

export async function fetchRemoteModelCatalog(connection: RemoteModelConnection): Promise<RemoteCatalog> {
    const response = await call(connection, "catalog");
    if (!response.ok) throw new Error(`Remote model catalog unavailable (${response.status})`);
    return await response.json();
}

function remoteStream(
    connection: RemoteModelConnection,
    model: Model<Api>,
    context: Context,
    simple: boolean,
    options: StreamOptions = {},
): AssistantMessageEventStream {
    const result = createAssistantMessageEventStream();
    const id = crypto.randomUUID();
    const transportAbort = new AbortController();
    let cancelAck: Promise<void> | undefined;
    const stop = () => {
        transportAbort.abort();
        cancelAck ??= call(connection, `cancel/${id}`, { method: "POST", signal: AbortSignal.timeout(4_000) })
            .then(() => {}, () => {});
    };
    options.signal?.addEventListener("abort", stop, { once: true });
    void (async () => {
        let terminal = false;
        try {
            const response = await call(connection, "stream", {
                method: "POST",
                body: JSON.stringify({
                    id,
                    provider: model.provider,
                    model: model.id,
                    simple,
                    context,
                    options: safeOptions(options, connection.callbackPolicy),
                }),
                signal: transportAbort.signal,
            });
            if (!response.ok || !response.body) throw new Error(`Remote model stream unavailable (${response.status})`);
            const reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8", { fatal: true });
            let buffer = "";
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                if (buffer.length > 16 * 1024 * 1024) throw new Error("Model event too large");
                let end;
                while ((end = buffer.indexOf("\n")) !== -1) {
                    const event: AssistantMessageEvent = JSON.parse(buffer.slice(0, end));
                    buffer = buffer.slice(end + 1);
                    if (terminal || !eventTypes.has(event.type)) throw new Error("Invalid model event");
                    result.push(event);
                    if (event.type === "done" || event.type === "error") terminal = true;
                }
            }
            if (!terminal) throw new Error("Model stream ended without a result");
        } catch (error) {
            if (!terminal) {
                stop();
                result.push({
                    type: "error",
                    reason: options.signal?.aborted ? "aborted" : "error",
                    error: failure(
                        model,
                        error instanceof Error ? error.message : String(error),
                        options.signal?.aborted ? "aborted" : "error",
                    ),
                });
            }
        } finally {
            options.signal?.removeEventListener("abort", stop);
            if (cancelAck) await cancelAck;
            result.end();
        }
    })();
    return result;
}

/** Credential-free Pi runtime. Every built-in provider is replaced, including unavailable ones. */
export async function createRemoteModelRuntime(
    connection: RemoteModelConnection,
    catalog: RemoteCatalog,
): Promise<ModelRuntime> {
    const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: false,
    });
    const providers = new Map(
        catalog.providers.filter((provider) => !isExternalCliProvider(provider.id)).map((
            provider,
        ) => [provider.id, provider]),
    );
    for (const provider of runtime.getProviders()) {
        if (!isExternalCliProvider(provider.id) && !providers.has(provider.id)) {
            providers.set(provider.id, {
                id: provider.id,
                name: provider.name,
                available: false,
                oauth: false,
                subscription: false,
            });
        }
    }
    for (const provider of providers.values()) {
        const models: Model<Api>[] = catalog.models.filter((model) => model.provider === provider.id).map((model) => ({
            ...model,
            baseUrl: "",
        }));
        const permitted = new Set(
            catalog.available.filter((model) => model.provider === provider.id).map((model) => model.id),
        );
        const api: ProviderStreams = {
            stream: (model, context, options) => remoteStream(connection, model, context, false, options),
            streamSimple: (model, context, options) => remoteStream(connection, model, context, true, options),
        };
        runtime.registerNativeProvider(
            createProvider({
                id: provider.id,
                name: provider.name,
                models,
                auth: {
                    apiKey: {
                        name: "Laptop model service",
                        check: () =>
                            Promise.resolve(provider.available ? { type: "api_key", source: "laptop" } : undefined),
                        resolve: () => Promise.resolve(provider.available ? { auth: {} } : undefined),
                    },
                },
                filterModels: (items) => items.filter((model) => permitted.has(model.id)),
                api,
            }),
        );
    }
    await runtime.refresh({ allowNetwork: false });
    // The native proxy authenticates transport with a non-secret availability
    // marker. Pi would otherwise call every OAuth provider an API-key provider.
    // Project only the laptop's status; never install an OAuth credential here.
    const oauth = new Set(
        catalog.providers.filter((provider) => provider.available && provider.oauth).map((provider) => provider.id),
    );
    const subscriptions = new Set(
        catalog.providers.filter((provider) => provider.available && provider.subscription).map((provider) =>
            provider.id
        ),
    );
    runtime.isUsingOAuth = (providerId) => oauth.has(providerId);
    runtime.isUsingSubscription = (providerId) => subscriptions.has(providerId);
    return runtime;
}
