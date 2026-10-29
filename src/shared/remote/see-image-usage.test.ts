import { serveHttp } from "../http-server.ts";
import { test } from "node:test";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
    createAssistantMessageEventStream,
    createProvider,
    fauxAssistantMessage,
    fauxText,
    fauxToolCall,
    InMemoryCredentialStore,
    type ProviderStreams,
} from "@earendil-works/pi-ai";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { createBoundedRemoteModelSession } from "./bounded-model-session.ts";
import { UsageReporter } from "../workflow/usage-reporting.ts";
import { handleModelRequest, LocalModelBridge } from "./model-bridge.ts";

test("bounded remote see_image records vision requests, not verification turns", async (t) => {
    await withWorkflowMetricsFixture(async (fixture) => {
        const personal = join(fixture.homeDir, ".wld");
        await fsMkdir(personal, { recursive: true });
        await fsWriteFile(
            join(fixture.projectRoot, ".wld", "settings.json"),
            JSON.stringify({
                workflowMetrics: true,
                visionFallback: { model: "remote-usage/vision" },
            }),
        );
        await fsWriteFile(join(fixture.projectRoot, "shot.png"), new Uint8Array([1, 2, 3]));
        let primaryRequests = 0;
        let visionResponse = fauxAssistantMessage(fauxText("remote vision"));
        let networkFailure = false;
        const stream: ProviderStreams["streamSimple"] = (model) => {
            if (model.id === "vision") {
                const now = Date.now();
                const pending = new UsageReporter().query(
                    [fixture.projectRoot],
                    {
                        start: new Date(now).toISOString().slice(0, 10),
                        end: new Date(now + 86400000).toISOString().slice(0, 10),
                    },
                    "UTC",
                );
                assertEquals(pending.projects[0].incomplete.length, 1);
            }
            if (model.id === "vision" && networkFailure) throw new Error("Network unavailable");
            const result = createAssistantMessageEventStream();
            const reply =
                model.id === "vision"
                    ? visionResponse
                    : ++primaryRequests % 2 === 1
                      ? fauxAssistantMessage(fauxToolCall("see_image", { imageRef: "shot.png" }))
                      : fauxAssistantMessage(fauxText("Verification complete"));
            queueMicrotask(() => {
                if (reply.stopReason === "error" || reply.stopReason === "aborted") {
                    result.push({ type: "error", reason: reply.stopReason, error: reply });
                } else result.push({ type: "done", reason: "stop", message: reply });
                result.end();
            });
            return result;
        };
        const runtime = await ModelRuntime.create({
            credentials: new InMemoryCredentialStore(),
            modelsPath: null,
            allowModelNetwork: false,
            refreshOnCreate: false,
        });
        runtime.registerNativeProvider(
            createProvider({
                id: "remote-usage",
                name: "Remote usage fixture",
                models: ["primary", "vision"].map((id) => ({
                    provider: "remote-usage",
                    id,
                    name: id,
                    api: "openai-completions",
                    baseUrl: "https://example.invalid",
                    reasoning: false,
                    input: id === "vision" ? ["text", "image"] : ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128000,
                    maxTokens: 100,
                })),
                auth: {
                    apiKey: {
                        name: "Fixture",
                        check: () => Promise.resolve({ type: "api_key" }),
                        resolve: () => Promise.resolve({ auth: {} }),
                    },
                },
                api: { stream, streamSimple: stream },
            }),
        );
        await runtime.refresh({ allowNetwork: false });
        const bridge = new LocalModelBridge(runtime);
        const credential = "a".repeat(64);
        const server = serveHttp({ hostname: "127.0.0.1", port: 0, onListen() {} }, (request) =>
            request.headers.get("Authorization") === `Bearer ${credential}`
                ? handleModelRequest(bridge, request, new URL(request.url).pathname)
                : new Response(null, { status: 401 }),
        );
        try {
            const { session } = await createBoundedRemoteModelSession({
                cwd: fixture.projectRoot,
                mount: { globalRoot: personal, lost: new Promise<void>(() => {}), close: () => Promise.resolve() },
                connection: { port: server.addr.transport === "tcp" ? server.addr.port : 0, credential },
                provider: "remote-usage",
                modelId: "primary",
                agentDef: {
                    name: "engineer",
                    displayName: "Engineer",
                    description: "",
                    tools: [],
                    model: "",
                    systemPrompt: "",
                },
            });
            try {
                await t.test("measured usage crosses streamSimple and keeps supplied zero", async () => {
                    visionResponse.usage = {
                        input: 41,
                        output: 12,
                        cacheRead: 0,
                        cacheWrite: 5,
                        totalTokens: 58,
                        cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0.3, total: 0.6 },
                    };
                    await session.prompt("Describe shot.png");
                    assertStringIncludes(JSON.stringify(session.messages), "remote vision");
                    const journal = await fixture.readMetrics();
                    assertEquals(
                        journal.filter((record) => record.event === "execution_started").length,
                        journal.filter((record) => record.event === "model_usage").length,
                    );
                    const records = journal.filter((record) => record.event === "model_usage");
                    assertEquals(records.length, 1);
                    assertEquals(records[0].event, "model_usage");
                    assertEquals(records[0].v, 2);
                    assertEquals(records[0].sessionId, session.sessionManager.getSessionId());
                    assertEquals(records[0].requestId ?? null, null);
                    assertEquals(records[0].turnId, null);
                    assertEquals(records[0].provider, "remote-usage");
                    assertEquals(records[0].model, "vision");
                    assertEquals(records[0].usageKind, "request");
                    assertEquals(records[0].aggregationBasis, "request");
                    assertEquals(records[0].inputTokens, 41);
                    assertEquals(records[0].outputTokens, 12);
                    assertEquals(records[0].cacheReadTokens, 0);
                    assertEquals(records[0].cacheWriteTokens, 5);
                    assertEquals(records[0].costAmount, 0.6);
                    assertEquals(records[0].costSource, "calculated");
                    assertEquals(records[0].measurementAvailability, "complete");
                });
                await t.test("upstream absence crosses the bridge as unavailable", async () => {
                    visionResponse = fauxAssistantMessage(fauxText("vision without usage"));
                    Reflect.deleteProperty(visionResponse, "usage");
                    await session.prompt("Describe shot.png again");
                    assertStringIncludes(JSON.stringify(session.messages), "vision without usage");
                    const journal = await fixture.readMetrics();
                    assertEquals(
                        journal.filter((record) => record.event === "execution_started").length,
                        journal.filter((record) => record.event === "model_usage").length,
                    );
                    const records = journal.filter((record) => record.event === "model_usage");
                    assertEquals(records.length, 2);
                    assertEquals(records[1].inputTokens, null);
                    assertEquals(records[1].outputTokens, null);
                    assertEquals(records[1].cacheReadTokens, null);
                    assertEquals(records[1].cacheWriteTokens, null);
                    assertEquals(records[1].costAmount, null);
                    assertEquals(records[1].costSource, "unavailable");
                    assertEquals(records[1].measurementAvailability, "unavailable");
                });
                await t.test("absent upstream cost crosses the bridge without zero filling", async () => {
                    visionResponse = fauxAssistantMessage(fauxText("vision without cost"));
                    Reflect.deleteProperty(visionResponse.usage, "cost");
                    await session.prompt("Describe shot.png without cost");
                    const journal = await fixture.readMetrics();
                    assertEquals(
                        journal.filter((record) => record.event === "execution_started").length,
                        journal.filter((record) => record.event === "model_usage").length,
                    );
                    const records = journal.filter((record) => record.event === "model_usage");
                    assertEquals(records.length, 3);
                    assertEquals(records[2].costAmount, null);
                    assertEquals(records[2].costSource, "unavailable");
                });
                await t.test("errored remote vision retains partial response usage", async () => {
                    visionResponse = fauxAssistantMessage(fauxText(""), {
                        stopReason: "error",
                        errorMessage: "Provider failed",
                    });
                    await session.prompt("Describe shot.png with provider error");
                    assertEquals(
                        (await fixture.readMetrics()).filter((record) => record.event === "model_usage").length,
                        4,
                    );
                    const rows = await fixture.readMetrics();
                    const usage = rows.filter((row) => row.event === "model_usage").at(-1)!;
                    assertEquals(usage.measurementAvailability, "partial");
                    assertEquals(usage.unavailableReason, "source_unavailable");
                });
                await t.test("aborted remote vision records unavailable usage", async () => {
                    visionResponse = fauxAssistantMessage(fauxText(""), { stopReason: "aborted" });
                    Reflect.deleteProperty(visionResponse, "usage");
                    await session.prompt("Describe shot.png with abort");
                    const rows = await fixture.readMetrics();
                    const usage = rows.filter((row) => row.event === "model_usage").at(-1)!;
                    assertEquals(usage.measurementAvailability, "unavailable");
                    assertEquals(usage.unavailableReason, "source_unavailable");
                });
                await t.test("remote network failure records incomplete usage", async () => {
                    networkFailure = true;
                    await session.prompt("Describe shot.png with network error");
                    assertEquals(
                        (await fixture.readMetrics()).filter((record) => record.event === "model_usage").length,
                        6,
                    );
                    const rows = await fixture.readMetrics();
                    const usage = rows.filter((row) => row.event === "model_usage").at(-1)!;
                    // The upstream runtime turns the thrown provider error into an error
                    // response with zero usage. It must never be complete measurement.
                    assertEquals(usage.measurementAvailability === "complete", false);
                    assertEquals(usage.unavailableReason, "source_unavailable");
                    const starts = rows.filter((row) => row.event === "execution_started");
                    const finishes = rows.filter((row) => row.event === "execution_finished");
                    assertEquals(starts.length, 6);
                    assertEquals(finishes.length, 6);
                    assertEquals(new Set(starts.map((row) => row.executionId)).size, 6);
                    for (const start of starts) {
                        assertEquals(start.dispatchKind, "auxiliary");
                        assertEquals(start.userInitiated, false);
                        assertEquals(
                            finishes.some((finish) => finish.executionId === start.executionId),
                            true,
                        );
                    }
                    const now = Date.now();
                    const report = new UsageReporter().query(
                        [fixture.projectRoot],
                        {
                            start: new Date(now).toISOString().slice(0, 10),
                            end: new Date(now + 86400000).toISOString().slice(0, 10),
                        },
                        "UTC",
                    );
                    assertEquals(report.totals.activeDays, 0);
                    assertEquals(report.totals.tokens.exclusions > 0, true);
                });
            } finally {
                session.dispose();
            }
        } finally {
            bridge.close();
            await server.shutdown();
        }
    });
});
