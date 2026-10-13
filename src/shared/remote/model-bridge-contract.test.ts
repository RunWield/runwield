import { serveHttp } from "../http-server.ts";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
    type AssistantMessage,
    type AssistantMessageEvent,
    createAssistantMessageEventStream,
    createProvider,
    InMemoryCredentialStore,
    type Model,
    type ProviderStreams,
} from "@earendil-works/pi-ai";
import {
    createRemoteModelRuntime,
    fetchRemoteModelCatalog,
    handleModelRequest,
    LocalModelBridge,
} from "./model-bridge.ts";

const model: Model<"openai-completions"> = {
    id: "local",
    name: "Local",
    api: "openai-completions",
    provider: "laptop-synthetic",
    baseUrl: "https://private.invalid/secret",
    headers: { Authorization: "private-header" },
    reasoning: true,
    thinkingLevelMap: { high: "intense" },
    input: ["text", "image"],
    inputLimits: { images: { maxPerRequest: 2 } },
    promptCache: { short: 300 },
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    contextWindow: 1000,
    maxTokens: 100,
};
const completed: AssistantMessage = {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [
        { type: "thinking", thinking: "consider", thinkingSignature: "thought", redacted: true },
        {
            type: "toolCall",
            id: "call-1",
            name: "lookup",
            arguments: { query: "answer" },
            thoughtSignature: "sig",
            namespace: "local",
        },
        { type: "text", text: "done", textSignature: "text-sig" },
    ],
    responseId: "response-1",
    responseModel: "local-v2",
    providerThinkingLevel: "intense",
    usage: {
        input: 12,
        output: 8,
        cacheRead: 4,
        cacheWrite: 2,
        cacheWrite1h: 1,
        reasoning: 3,
        totalTokens: 26,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    },
    stopReason: "toolUse",
    rawStopReason: "tool_calls",
    endTurn: false,
    timestamp: 123,
};
const toolCall = completed.content[1];
assert(toolCall.type === "toolCall");
const events: AssistantMessageEvent[] = [
    { type: "start", partial: completed },
    { type: "thinking_start", contentIndex: 0, partial: completed },
    { type: "thinking_delta", contentIndex: 0, delta: "consider", partial: completed },
    { type: "thinking_end", contentIndex: 0, content: "consider", partial: completed },
    { type: "toolcall_start", contentIndex: 1, partial: completed },
    { type: "toolcall_delta", contentIndex: 1, delta: '{"query":"answer"}', partial: completed },
    { type: "toolcall_end", contentIndex: 1, toolCall, partial: completed },
    { type: "text_start", contentIndex: 2, partial: completed },
    { type: "text_delta", contentIndex: 2, delta: "done", partial: completed },
    { type: "text_end", contentIndex: 2, content: "done", partial: completed },
    { type: "done", reason: "toolUse", message: completed },
];

function control(source: ModelRuntime) {
    const bridge = new LocalModelBridge(source);
    let streamBody = "";
    const server = serveHttp({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
        if (request.headers.get("Authorization") !== "Bearer control-token") return new Response(null, { status: 401 });
        if (new URL(request.url).pathname === "/models/stream") streamBody = await request.clone().text();
        return handleModelRequest(bridge, request, new URL(request.url).pathname);
    });
    const connection = { port: server.addr.transport === "tcp" ? server.addr.port : 0, credential: "control-token" };
    return {
        connection,
        lastStreamBody: () => streamBody,
        async close() {
            bridge.close();
            await server.shutdown();
        },
    };
}

async function fixture(emittedEvents: AssistantMessageEvent[] = events) {
    const source = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: false,
    });
    let receivedOptions: Parameters<ProviderStreams["streamSimple"]>[2];
    let receivedContext: Parameters<ProviderStreams["streamSimple"]>[1];
    const stream: ProviderStreams["stream"] = (_model, context, options) => {
        receivedOptions = options;
        receivedContext = context;
        const output = createAssistantMessageEventStream();
        queueMicrotask(() => {
            for (const event of emittedEvents) output.push(event);
            output.end();
        });
        return output;
    };
    source.registerNativeProvider(createProvider({
        id: model.provider,
        models: [model],
        auth: {
            apiKey: {
                name: "Laptop",
                check: () => Promise.resolve({ type: "api_key" }),
                resolve: () => Promise.resolve({ auth: {} }),
            },
        },
        api: { stream, streamSimple: stream },
    }));
    await source.refresh({ allowNetwork: false });
    const service = control(source);
    return { ...service, options: () => receivedOptions, context: () => receivedContext };
}

test("remote Pi streams preserve thinking, tool calls, usage, and image input", async () => {
    const test = await fixture();
    try {
        const catalog = await fetchRemoteModelCatalog(test.connection);
        const runtime = await createRemoteModelRuntime(test.connection, catalog);
        const projected = runtime.getModel(model.provider, model.id)!;
        const context = {
            messages: [{
                role: "user" as const,
                content: [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }, {
                    type: "text" as const,
                    text: "describe",
                }],
                timestamp: 1,
            }],
        };
        for (const simple of [false, true]) {
            const result = simple ? runtime.streamSimple(projected, context) : runtime.stream(projected, context);
            const received: AssistantMessageEvent[] = [];
            for await (const event of result) received.push(event);
            assertEquals(received, events);
            assertEquals(await result.result(), completed);
            assertEquals(test.context()?.messages.at(-1), context.messages[0]);
            assertStringIncludes(test.lastStreamBody(), "aGVsbG8=");
            for (const forbidden of ["private.invalid", "private-header", "baseUrl", "headers", "control-token"]) {
                assert(!test.lastStreamBody().includes(forbidden));
            }
        }
    } finally {
        await test.close();
    }
});

test("remote model errors retain a safe unsupported-temperature reason", async () => {
    const test = await fixture([{
        type: "error",
        reason: "error",
        error: {
            ...completed,
            content: [],
            stopReason: "error",
            errorMessage: "temperature not supported at https://private.invalid/secret",
        },
    }]);
    try {
        const catalog = await fetchRemoteModelCatalog(test.connection);
        const runtime = await createRemoteModelRuntime(test.connection, catalog);
        const projected = runtime.getModel(model.provider, model.id)!;
        const result = await runtime.streamSimple(projected, { messages: [] }, { temperature: 0.4 }).result();
        assertEquals(result.errorMessage, "temperature is not supported");
        assert(!JSON.stringify(result).includes("private.invalid"));
    } finally {
        await test.close();
    }
});

test("Pi streams forward approved reasoning, sampling, caching, and timeout options", async () => {
    const test = await fixture();
    try {
        const runtime = await createRemoteModelRuntime(test.connection, await fetchRemoteModelCatalog(test.connection));
        const projected = runtime.getModel(model.provider, model.id)!;
        const common = {
            temperature: 0.4,
            maxTokens: 42,
            timeoutMs: 2500,
            cacheRetention: "long" as const,
            samplingParams: { top_p: 0.7, top_k: 3 },
        };
        for (const simple of [false, true]) {
            const options = simple ? { ...common, reasoning: "high" as const, thinkingBudgets: { high: 512 } } : common;
            const output = simple
                ? runtime.streamSimple(projected, { messages: [] }, options)
                : runtime.stream(projected, { messages: [] }, options);
            await output.result();
            const received = test.options()!;
            assertEquals(
                Object.fromEntries(Object.keys(options).map((key) => [key, Reflect.get(received, key)])),
                options,
            );
            assertEquals(received.headers, model.headers); // Laptop-only model headers are applied after the wire hop.
        }
    } finally {
        await test.close();
    }
});

test("catalog projects Pi availability without exposing laptop endpoint or auth", async () => {
    const test = await fixture();
    try {
        const catalog = await fetchRemoteModelCatalog(test.connection);
        assertEquals(catalog.providers.find((item) => item.id === model.provider), {
            id: model.provider,
            name: model.provider,
            available: true,
            oauth: false,
            subscription: false,
        });
        assertEquals(catalog.available, [{ provider: model.provider, id: model.id }]);
        assertEquals(catalog.models.find((item) => item.id === model.id), {
            id: model.id,
            name: model.name,
            api: model.api,
            provider: model.provider,
            reasoning: true,
            thinkingLevelMap: model.thinkingLevelMap,
            input: model.input,
            inputLimits: model.inputLimits,
            cost: model.cost,
            promptCache: model.promptCache,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
        });
        const wire = JSON.stringify(catalog);
        for (const secret of ["private.invalid", "private-header", "secret", "baseUrl", "headers"]) {
            assert(!wire.includes(secret));
        }
        const runtime = await createRemoteModelRuntime(test.connection, catalog);
        assertEquals(runtime.hasConfiguredAuth(model.provider), true);
        assertEquals(runtime.isUsingSubscription(model.provider), false);
        assertEquals(runtime.getAvailableSnapshot().map((item) => item.id), [model.id]);
    } finally {
        await test.close();
    }
});

test("empty laptop catalog cannot activate ambient Pi providers", async () => {
    const test = await fixture();
    try {
        const runtime = await createRemoteModelRuntime(test.connection, { providers: [], models: [], available: [] });
        for (const provider of ["anthropic", "openai", "laptop-synthetic"]) {
            assertEquals(runtime.hasConfiguredAuth(provider), false);
            assertEquals(await runtime.getAuth(provider), undefined);
            assertEquals(runtime.getAvailableSnapshot().filter((item) => item.provider === provider), []);
        }
        assertEquals(runtime.getAvailableSnapshot(), []);
    } finally {
        await test.close();
    }
});

test("malformed callbacks settle with a safe terminal error on both Pi streams", async () => {
    const test = await fixture();
    try {
        const runtime = await createRemoteModelRuntime(test.connection, await fetchRemoteModelCatalog(test.connection));
        const projected = runtime.getModel(model.provider, model.id)!;
        for (const simple of [false, true]) {
            for (
                const options of [
                    { onPayload: () => undefined },
                    { samplingParams: { top_p: Number.NaN } },
                    { headers: { Authorization: "private-header" } },
                ]
            ) {
                const output = simple
                    ? runtime.streamSimple(projected, { messages: [] }, options)
                    : runtime.stream(projected, { messages: [] }, options);
                const received: AssistantMessageEvent[] = [];
                for await (const event of output) received.push(event);
                assertEquals(received.map((event) => event.type), ["error"]);
                const result = await output.result();
                assertEquals(result.stopReason, "error");
                assertStringIncludes(result.errorMessage ?? "", "Unsupported remote model option");
                assert(!result.errorMessage?.includes("private-header"));
                assertEquals(test.options(), undefined);
            }
        }
    } finally {
        await test.close();
    }
});

test("laptop OAuth renewal stays on laptop and projects subscription status", async () => {
    const credentials = new InMemoryCredentialStore();
    const source = await ModelRuntime.create({
        credentials,
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: false,
    });
    let usedToken = "";
    const send: ProviderStreams["stream"] = (_model, _context, options) => {
        usedToken = options?.apiKey ?? "";
        const output = createAssistantMessageEventStream();
        queueMicrotask(() => {
            output.push({ type: "done", reason: "toolUse", message: completed });
            output.end();
        });
        return output;
    };
    source.registerNativeProvider(createProvider({
        id: model.provider,
        models: [model],
        auth: {
            oauth: {
                name: "Synthetic subscription",
                isSubscription: true,
                login: () =>
                    Promise.resolve({ type: "oauth", access: "expired-token", refresh: "refresh-secret", expires: 1 }),
                refresh: () =>
                    Promise.resolve({
                        type: "oauth",
                        access: "renewed-token",
                        refresh: "next-secret",
                        expires: Date.now() + 3_600_000,
                    }),
                toAuth: (credential) => Promise.resolve({ apiKey: credential.access }),
            },
        },
        api: { stream: send, streamSimple: send },
    }));
    await source.login(model.provider, "oauth", { prompt: () => Promise.resolve(""), notify: () => {} });
    await source.refresh({ allowNetwork: false });
    const test = control(source);
    try {
        const catalog = await fetchRemoteModelCatalog(test.connection);
        assertEquals(catalog.providers.find((provider) => provider.id === model.provider)?.subscription, true);
        assertEquals(catalog.providers.find((provider) => provider.id === model.provider)?.oauth, true);
        assertEquals(catalog.providers.find((provider) => provider.id === model.provider)?.available, true);
        assert(!JSON.stringify(catalog).includes("renewed-token"));
        const remote = await createRemoteModelRuntime(test.connection, catalog);
        assertEquals(remote.isUsingSubscription(model.provider), true); // Projection is status, not a credential.
        assertEquals(remote.isUsingOAuth(model.provider), true);
        for (const simple of [false, true]) {
            const projected = remote.getModel(model.provider, model.id)!;
            const output = simple
                ? remote.streamSimple(projected, { messages: [] })
                : remote.stream(projected, { messages: [] });
            assertEquals((await output.result()).stopReason, "toolUse");
            assertEquals(usedToken, "renewed-token");
            assert(!test.lastStreamBody().includes("renewed-token"));
            assert(!test.lastStreamBody().includes("refresh-secret"));
        }
        assertEquals(await remote.getAuth(model.provider), { auth: {} });
    } finally {
        await test.close();
    }
});
