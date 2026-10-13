import { serveHttp } from "../http-server.ts";
import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
    createAssistantMessageEventStream,
    createProvider,
    fauxAssistantMessage,
    InMemoryCredentialStore,
    type ProviderStreams,
} from "@earendil-works/pi-ai";
import { handleModelRequest, LocalModelBridge } from "./model-bridge.ts";
import { runRemoteModelProof } from "./model-proof.ts";

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(label)), 3_000);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

test("LIVE proof cancels a pending provider turn when its connection closes", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    const project = join(root, "project");
    const personal = join(root, "personal");
    await fsMkdir(project);
    await fsMkdir(personal);
    await fsWriteFile(join(personal, "settings.json"), "{}");
    await fsWriteFile(join(project, "sentinel.txt"), "remote-test");
    let started = () => {};
    const providerStarted = new Promise<void>((resolve) => started = resolve);
    let upstreamAborts = 0;
    let upstreamStopped = () => {};
    const upstreamDone = new Promise<void>((resolve) => upstreamStopped = resolve);
    const stream: ProviderStreams["streamSimple"] = (_model, _context, options) => {
        const events = createAssistantMessageEventStream();
        options?.signal?.addEventListener("abort", () => {
            upstreamAborts++;
            events.push({
                type: "error",
                reason: "aborted",
                error: { ...fauxAssistantMessage(""), stopReason: "aborted" },
            });
            events.end();
            upstreamStopped();
        }, { once: true });
        started();
        return events;
    };
    const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: false,
    });
    runtime.registerNativeProvider(createProvider({
        id: "proof-local",
        name: "Proof",
        models: [{
            provider: "proof-local",
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
        api: { stream, streamSimple: stream },
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
    const controller = new AbortController();
    try {
        const proof = runRemoteModelProof({
            proof: { provider: "proof-local", modelId: "test", sentinelFile: "sentinel.txt" },
            mount: { globalRoot: personal, lost: new Promise<void>(() => {}), close: () => Promise.resolve() },
            connection: { port: server.addr.transport === "tcp" ? server.addr.port : 0, credential },
            cwd: project,
            signal: controller.signal,
        });
        await within(providerStarted, "Provider did not start");
        controller.abort();
        await within(assertRejects(() => proof, Error), "Proof did not stop");
        await within(upstreamDone, "Upstream request did not stop");
        assertEquals(upstreamAborts, 1);
    } finally {
        controller.abort();
        bridge.close();
        await server.shutdown();
        await fsRm(root, { recursive: true });
    }
});
