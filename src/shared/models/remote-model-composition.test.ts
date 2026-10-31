import { serveHttp } from "../http-server.ts";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { mkdtemp as fsMkdtemp, writeFile as fsWriteFile, readFile as fsReadFile, rm as fsRm } from "node:fs/promises";
import { join } from "node:path";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects, assertThrows } from "../../testing/assertions.ts";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { configureRemoteModelConnection, getModelRegistry, getModelRuntime } from "./model-registry.ts";
import { handleModelRequest, LocalModelBridge } from "../remote/model-bridge.ts";
import { configureRemotePersonalResources } from "../remote/personal-resources.ts";

async function fixture() {
    let upstreamAuthorization = "";
    let upstreamBody = "";
    const provider = serveHttp({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
        if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response(null, { status: 404 });
        upstreamAuthorization = request.headers.get("Authorization") ?? "";
        upstreamBody = await request.text();
        const chunk = {
            id: "synthetic-reply",
            object: "chat.completion.chunk",
            created: 1,
            model: "allowed",
            choices: [{ index: 0, delta: { role: "assistant", content: "from laptop HTTP" }, finish_reason: null }],
        };
        return new Response(
            `data: ${JSON.stringify(chunk)}\n\n` +
                `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
                "data: [DONE]\n\n",
            { headers: { "Content-Type": "text/event-stream" } },
        );
    });
    const source = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: false,
    });
    source.registerProvider("laptop-synthetic", {
        name: "Laptop HTTP",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${provider.addr.port}/v1`,
        apiKey: "laptop-api-secret",
        models: [
            {
                id: "allowed",
                name: "Allowed",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1000,
                maxTokens: 100,
            },
        ],
    });
    await source.refresh({ allowNetwork: false });
    const bridge = new LocalModelBridge(source);
    const credential = "a".repeat(64);
    let catalogStatus = 200;
    let holdCatalog: (() => Promise<void>) | undefined;
    const control = serveHttp({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
        if (request.headers.get("Authorization") !== `Bearer ${credential}`) return new Response(null, { status: 401 });
        const path = new URL(request.url).pathname;
        if (path === "/models/catalog") {
            if (holdCatalog) await holdCatalog();
            if (catalogStatus !== 200) return new Response(null, { status: catalogStatus });
        }
        return handleModelRequest(bridge, request, path);
    });
    return {
        connection: { port: control.addr.port, credential },
        setCatalogStatus: (status: number) => (catalogStatus = status),
        holdCatalog: (hold?: () => Promise<void>) => (holdCatalog = hold),
        upstreamAuthorization: () => upstreamAuthorization,
        upstreamBody: () => upstreamBody,
        async close() {
            bridge.close();
            await control.shutdown();
            await provider.shutdown();
        },
    };
}

function assertClosed() {
    assertThrows(() => getModelRuntime(), Error, "explicit control connection");
    assertThrows(() => getModelRegistry(), Error, "explicit control connection");
}

test("production remote model composition boundary", async (test) => {
    const root = await fsMkdtemp(join(tmpdir(), "remote-model-composition-"));
    const service = await fixture();
    const auth = '{"mounted-only":{"type":"api_key","key":"mounted-secret"}}';
    const models = JSON.stringify({
        providers: {
            "mounted-only": {
                apiKey: "mounted-secret",
                api: "openai-completions",
                baseUrl: "https://must-not-run.invalid",
                models: [{ id: "mounted-model" }],
            },
        },
    });
    await fsWriteFile(join(root, "auth.json"), auth);
    await fsWriteFile(join(root, "models.json"), models);
    try {
        await test.test("setup requires an active mounted context", async () => {
            await assertRejects(() => configureRemoteModelConnection(service.connection), Error, "mounted context");
        });
        configureRemotePersonalResources({ globalRoot: root });

        await test.test("unconfigured consumers fail closed", () => assertClosed());

        await test.test("invalid control descriptors do not install a composition", async () => {
            for (const connection of [
                { ...service.connection, port: 0 },
                { ...service.connection, port: 65536 },
                { ...service.connection, port: 1.5 },
                { ...service.connection, credential: "invalid" },
            ]) {
                await assertRejects(
                    () => configureRemoteModelConnection(connection),
                    Error,
                    "valid control connection",
                );
                assertClosed();
            }
        });

        await test.test("catalog failures leave no local fallback and permit a retry", async () => {
            for (const status of [401, 503]) {
                service.setCatalogStatus(status);
                await assertRejects(() => configureRemoteModelConnection(service.connection), Error, `(${status})`);
                assertClosed();
            }
            service.setCatalogStatus(200);
            const clear = await configureRemoteModelConnection(service.connection);
            clear();
            assertClosed();
        });

        await test.test("setup is atomic and rejects a concurrent installation", async () => {
            let arrived = () => {};
            let release = () => {};
            const requestArrived = new Promise<void>((resolve) => (arrived = resolve));
            const held = new Promise<void>((resolve) => (release = resolve));
            service.holdCatalog(() => {
                arrived();
                return held;
            });
            const pending = configureRemoteModelConnection(service.connection);
            let clear = () => {};
            try {
                await requestArrived;
                assertClosed();
                await assertRejects(() => configureRemoteModelConnection(service.connection), Error, "fresh valid");
            } finally {
                release();
                service.holdCatalog();
                clear = await pending;
                clear();
            }
        });

        await test.test("normal consumers use the installed laptop runtime and real HTTP provider", async () => {
            const connection = { ...service.connection };
            const clear = await configureRemoteModelConnection(connection);
            try {
                const registry = getModelRegistry();
                const runtime = await getModelRuntime();
                assert(registry.remote);
                assertEquals(await registry.getRuntime(), runtime);
                assertEquals(getModelRegistry(), registry);
                assertEquals(
                    registry.getSelectable().map(({ provider, id }) => `${provider}/${id}`),
                    ["laptop-synthetic/allowed"],
                );
                assertEquals(registry.find("mounted-only", "mounted-model"), undefined);
                assertEquals(registry.find("claude-cli", "sonnet"), undefined);
                const model = registry.find("laptop-synthetic", "allowed")!;
                assertEquals(model.baseUrl, "");
                assertEquals(model.headers, undefined);
                // A caller cannot retarget the installed runtime by changing its original descriptor.
                connection.credential = "b".repeat(64);
                connection.port = 1;
                const stream = runtime.streamSimple(model, {
                    messages: [{ role: "user", content: "remote project result", timestamp: 1 }],
                });
                const result = await stream.result();
                assertEquals(result.stopReason, "stop");
                assertEquals(result.content, [{ type: "text", text: "from laptop HTTP" }]);
                assertEquals(service.upstreamAuthorization(), "Bearer laptop-api-secret");
                assert(service.upstreamBody().includes("remote project result"));
            } finally {
                clear();
            }
        });

        await test.test("installed registry keeps authentication and catalog mutations laptop-owned", async () => {
            const clear = await configureRemoteModelConnection(service.connection);
            try {
                const registry = getModelRegistry();
                const model = registry.find("laptop-synthetic", "allowed")!;
                assertEquals(await registry.getApiKeyAndHeaders(model), {
                    ok: false,
                    error: "Remote model credentials stay on the laptop",
                });
                assertEquals(await registry.getApiKeyForProvider("mounted-only"), undefined);
                assertEquals(await registry.listStoredCredentialProviders(), []);
                await assertRejects(
                    () => registry.setProviderApiKey("laptop-synthetic", "new-key"),
                    Error,
                    "laptop-owned",
                );
                await assertRejects(() => registry.logoutProvider("laptop-synthetic"), Error, "laptop-owned");
                await assertRejects(
                    () =>
                        registry.loginProvider("laptop-synthetic", "api_key", {
                            prompt: () => Promise.resolve("key"),
                            notify() {},
                        }),
                    Error,
                    "laptop-owned",
                );
                await assertRejects(() => registry.refresh(), Error, "new control connection");
                assertThrows(() => registry.registerProvider("new-provider", {}), Error, "laptop-owned");
                assertThrows(() => registry.unregisterProvider("laptop-synthetic"), Error, "laptop-owned");
                assertEquals(
                    registry.getSelectable().map((item) => item.id),
                    ["allowed"],
                );
                assertEquals(await fsReadFile(join(root, "auth.json"), "utf8"), auth);
                assertEquals(await fsReadFile(join(root, "models.json"), "utf8"), models);
            } finally {
                clear();
            }
        });

        await test.test("cleanup is idempotent and cannot clear a successor connection", async () => {
            const firstClear = await configureRemoteModelConnection(service.connection);
            const firstRuntime = await getModelRuntime();
            await assertRejects(() => configureRemoteModelConnection(service.connection), Error, "fresh valid");
            firstClear();
            firstClear();
            assertClosed();
            const nextClear = await configureRemoteModelConnection(service.connection);
            try {
                const nextRuntime = await getModelRuntime();
                assert(nextRuntime !== firstRuntime);
                firstClear();
                assertEquals(await getModelRuntime(), nextRuntime);
                assertEquals(await getModelRegistry().getRuntime(), nextRuntime);
            } finally {
                nextClear();
            }
            assertClosed();
        });
    } finally {
        await service.close();
        await fsRm(root, { recursive: true });
    }
});
