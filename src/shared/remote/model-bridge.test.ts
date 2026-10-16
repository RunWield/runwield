import { serveHttp } from "../http-server.ts";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
    type AssistantMessage,
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
    id: "test-model",
    name: "Test model",
    api: "openai-completions",
    provider: "test-provider",
    baseUrl: "https://secret.endpoint.invalid",
    headers: { Authorization: "secret" },
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
};
const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    provider: model.provider,
    model: model.id,
    api: model.api,
    stopReason: "stop",
    timestamp: 123,
    usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
    },
};

async function fixture() {
    const source = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: false,
    });
    let aborted = false;
    let pending = false;
    let providerError = "";
    const send: ProviderStreams["stream"] = (_model, _context, options) => {
        const stream = createAssistantMessageEventStream();
        if (pending) {
            options?.signal?.addEventListener("abort", () => {
                aborted = true;
                stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } });
            }, { once: true });
        } else {
            queueMicrotask(() => {
                if (providerError) {
                    stream.push({
                        type: "error",
                        reason: "error",
                        error: { ...message, stopReason: "error", errorMessage: providerError },
                    });
                } else {
                    stream.push({ type: "text_delta", contentIndex: 0, delta: "hello", partial: message });
                    stream.push({ type: "done", reason: "stop", message });
                }
                stream.end();
            });
        }
        return stream;
    };
    source.registerNativeProvider(
        createProvider({
            id: model.provider,
            name: "Test provider",
            models: [model],
            auth: {
                apiKey: {
                    name: "Local",
                    check: () => Promise.resolve({ type: "api_key" }),
                    resolve: () => Promise.resolve({ auth: {} }),
                },
            },
            api: { stream: send, streamSimple: send },
        }),
    );
    await source.refresh({ allowNetwork: false });
    const bridge = new LocalModelBridge(source);
    const server = serveHttp({ hostname: "127.0.0.1", port: 0, onListen() {} }, (request) => {
        if (request.headers.get("Authorization") !== "Bearer test-secret") return new Response(null, { status: 401 });
        return handleModelRequest(bridge, request, new URL(request.url).pathname);
    });
    const connection = { port: server.addr.transport === "tcp" ? server.addr.port : 0, credential: "test-secret" };
    return {
        bridge,
        connection,
        setPending: () => {
            pending = true;
        },
        setProviderError: (diagnostic = "Authorization: secret") => {
            providerError = diagnostic;
        },
        wasAborted: () => aborted,
        async close() {
            bridge.close();
            await server.shutdown();
        },
    };
}

test("model bridge does not offer or execute external CLI provider models", async () => {
    const source = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: false,
    });
    let executed = false;
    source.registerNativeProvider(createProvider({
        id: "claude-cli",
        name: "CLI",
        models: [{ ...model, provider: "claude-cli", id: "sonnet" }],
        auth: {
            apiKey: {
                name: "CLI",
                check: () => Promise.resolve({ type: "api_key" }),
                resolve: () => Promise.resolve({ auth: {} }),
            },
        },
        api: {
            stream: () => {
                executed = true;
                return createAssistantMessageEventStream();
            },
            streamSimple: () => {
                executed = true;
                return createAssistantMessageEventStream();
            },
        },
    }));
    await source.refresh({ allowNetwork: false });
    const bridge = new LocalModelBridge(source);
    try {
        const catalog = await bridge.catalog();
        assertEquals(catalog.models.some((item) => item.provider === "claude-cli"), false);
        const response = bridge.stream({
            id: "blocked",
            provider: "claude-cli",
            model: "sonnet",
            simple: true,
            context: { messages: [] },
            options: {},
        });
        assertEquals(response.status, 404);
        assertEquals(executed, false);
    } finally {
        bridge.close();
    }
});

test("remote model catalog omits endpoints and headers while projecting Pi availability", async () => {
    const test = await fixture();
    try {
        const catalog = await fetchRemoteModelCatalog(test.connection);
        assertEquals(catalog.available, [{ provider: model.provider, id: model.id }]);
        assert(!JSON.stringify(catalog).includes("secret"));
        const runtime = await createRemoteModelRuntime(test.connection, catalog);
        assertEquals(runtime.getAvailableSnapshot().map((item) => item.id), [model.id]);
        assertEquals(runtime.getModel(model.provider, model.id)?.baseUrl, "");
        assertEquals(await runtime.getAuth(model.provider), { auth: {} });
    } finally {
        await test.close();
    }
});

test("providers missing from laptop catalog cannot use remote ambient credentials", async () => {
    const test = await fixture();
    try {
        const catalog = await fetchRemoteModelCatalog(test.connection);
        const runtime = await createRemoteModelRuntime(test.connection, {
            providers: catalog.providers.filter((provider) => provider.id === model.provider),
            models: catalog.models.filter((item) => item.provider === model.provider),
            available: catalog.available.filter((item) => item.provider === model.provider),
        });
        assertEquals(runtime.hasConfiguredAuth("anthropic"), false);
        assertEquals(await runtime.getAuth("anthropic"), undefined);
        assertEquals(runtime.getModels("anthropic"), []);
    } finally {
        await test.close();
    }
});

test("remote Pi stream and simple stream preserve terminal result", async () => {
    const test = await fixture();
    try {
        const runtime = await createRemoteModelRuntime(test.connection, await fetchRemoteModelCatalog(test.connection));
        const projected = runtime.getModel(model.provider, model.id)!;
        for (const simple of [false, true]) {
            const stream = simple
                ? runtime.streamSimple(projected, { messages: [] })
                : runtime.stream(projected, { messages: [] });
            const events = [];
            for await (const event of stream) events.push(event.type);
            assertEquals(events, ["text_delta", "done"]);
            assertEquals(await stream.result(), message);
        }
    } finally {
        await test.close();
    }
});

test("laptop provider error settles without exporting sensitive diagnostic text", async () => {
    const test = await fixture();
    try {
        test.setProviderError();
        const runtime = await createRemoteModelRuntime(test.connection, await fetchRemoteModelCatalog(test.connection));
        const stream = runtime.streamSimple(runtime.getModel(model.provider, model.id)!, { messages: [] });
        assertEquals((await stream.result()).errorMessage, "Laptop model request failed");
    } finally {
        await test.close();
    }
});

test("laptop transient provider errors retain a safe Pi retry category", async () => {
    const test = await fixture();
    try {
        test.setProviderError("Unexpected EOF at https://private.invalid?token=secret");
        const runtime = await createRemoteModelRuntime(test.connection, await fetchRemoteModelCatalog(test.connection));
        const stream = runtime.streamSimple(runtime.getModel(model.provider, model.id)!, { messages: [] });
        assertEquals((await stream.result()).errorMessage, "Network error: Unexpected EOF");
    } finally {
        await test.close();
    }
});

test("remote transport loss settles a stream result as an error", async () => {
    const test = await fixture();
    const interrupted = serveHttp(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        () =>
            new Response(
                '{"type":"text_delta","contentIndex":0,"delta":"partial","partial":' + JSON.stringify(message) + "}\n",
                { headers: { "Content-Type": "application/x-ndjson" } },
            ),
    );
    try {
        const catalog = await fetchRemoteModelCatalog(test.connection);
        const connection = {
            port: interrupted.addr.transport === "tcp" ? interrupted.addr.port : 0,
            credential: "test-secret",
        };
        const runtime = await createRemoteModelRuntime(connection, catalog);
        const stream = runtime.streamSimple(runtime.getModel(model.provider, model.id)!, { messages: [] });
        assertStringIncludes((await stream.result()).errorMessage ?? "", "without a result");
    } finally {
        await interrupted.shutdown();
        await test.close();
    }
});

test("remote cancellation settles result and aborts laptop provider", async () => {
    const test = await fixture();
    try {
        test.setPending();
        const runtime = await createRemoteModelRuntime(test.connection, await fetchRemoteModelCatalog(test.connection));
        const abort = new AbortController();
        const stream = runtime.streamSimple(runtime.getModel(model.provider, model.id)!, { messages: [] }, {
            signal: abort.signal,
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        abort.abort();
        assertEquals((await stream.result()).stopReason, "aborted");
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert(test.wasAborted());
    } finally {
        await test.close();
    }
});

test("cancel before start prevents a late paid request and duplicate IDs cannot replay", async () => {
    const test = await fixture();
    try {
        test.bridge.cancel("late-request");
        const body = JSON.stringify({
            id: "late-request",
            provider: model.provider,
            model: model.id,
            simple: true,
            context: { messages: [] },
            options: {},
        });
        const start = () =>
            fetch(`http://127.0.0.1:${test.connection.port}/models/stream`, {
                method: "POST",
                headers: { Authorization: `Bearer ${test.connection.credential}` },
                body,
            });
        assertEquals((await start()).status, 409);
        assertEquals((await start()).status, 409);
    } finally {
        await test.close();
    }
});

test("remote stream rejects unsupported hooks before provider execution", async () => {
    const test = await fixture();
    try {
        const runtime = await createRemoteModelRuntime(test.connection, await fetchRemoteModelCatalog(test.connection));
        const stream = runtime.streamSimple(runtime.getModel(model.provider, model.id)!, { messages: [] }, {
            onPayload: () => undefined,
        });
        assertStringIncludes((await stream.result()).errorMessage ?? "", "Unsupported remote model option");
        const denied = await fetch(`http://127.0.0.1:${test.connection.port}/models/catalog`);
        assertEquals(denied.status, 401);
    } finally {
        await test.close();
    }
});
