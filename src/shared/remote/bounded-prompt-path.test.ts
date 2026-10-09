import { serveHttp } from "../http-server.ts";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    rm as fsRm,
    symlink as fsSymlink,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { assertRejects } from "../../testing/assertions.ts";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createBoundedRemoteModelSession } from "./bounded-model-session.ts";
import { handleModelRequest, LocalModelBridge } from "./model-bridge.ts";

test("bounded Pi loader rejects a personal prompt link into a server file", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    const project = join(root, "project");
    const personal = join(root, "personal");
    await fsMkdir(project);
    await fsMkdir(join(personal, "prompts"), { recursive: true });
    const serverFile = join(root, "server-secret.md");
    await fsWriteFile(serverFile, "server-only");
    await fsSymlink(serverFile, join(personal, "prompts", "example.md"));
    const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: false,
    });
    runtime.registerNativeProvider(createProvider({
        id: "test-local",
        name: "Test",
        models: [{
            provider: "test-local",
            id: "test",
            name: "Test",
            api: "openai-completions",
            baseUrl: "https://private-laptop.invalid",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1000,
            maxTokens: 100,
        }],
        auth: {
            apiKey: {
                name: "Local",
                check: () => Promise.resolve({ type: "api_key" }),
                resolve: () => Promise.resolve({ auth: {} }),
            },
        },
        api: {
            stream: () => {
                throw new Error("No turn expected");
            },
            streamSimple: () => {
                throw new Error("No turn expected");
            },
        },
    }));
    await runtime.refresh({ allowNetwork: false });
    const bridge = new LocalModelBridge(runtime);
    const credential = "a".repeat(64);
    const server = serveHttp(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        (request) =>
            request.headers.get("Authorization") === `Bearer ${credential}`
                ? handleModelRequest(bridge, request, new URL(request.url).pathname)
                : new Response(null, { status: 401 }),
    );
    try {
        await assertRejects(
            () =>
                createBoundedRemoteModelSession({
                    mount: { globalRoot: personal, lost: new Promise<void>(() => {}), close: () => Promise.resolve() },
                    connection: { port: server.addr.transport === "tcp" ? server.addr.port : 0, credential },
                    cwd: project,
                    provider: "test-local",
                    modelId: "test",
                }),
            Error,
            "resolved outside mounted roots",
        );
    } finally {
        bridge.close();
        await server.shutdown();
        await fsRm(root, { recursive: true });
    }
});
