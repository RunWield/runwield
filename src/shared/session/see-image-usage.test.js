import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import { join } from "node:path";
import {
    createAssistantMessageEventStream,
    createProvider,
    fauxAssistantMessage,
    fauxText,
    fauxToolCall,
} from "@earendil-works/pi-ai";
import { registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { getModelRegistry } from "../models/model-registry.ts";
import { buildAgentSession, runIsolatedAgentSession } from "./session.js";
import { HostedSession } from "./hosted-session.js";
import { UsageReporter } from "../workflow/usage-reporting.ts";
import { drainWorkflowMetrics, getWorkflowMetricsFilePath } from "../workflow/metrics.js";

/** @typedef {import('../../cmd/testing/runtime-command-fixture.ts').RuntimeCommandFixture} VisionFixture */
/** @typedef {Object} VisionCoverage
 * @property {string} usage
 */
/** @typedef {{ dispatchKind: string, userInitiated: boolean, measurementAvailability: string, coverage: VisionCoverage, unavailableReason: string | null, event: string, sessionId: string, executionId: string, requestId: string | null, turnId: string | null, model: string, usageKind: string, aggregationBasis: string, inputTokens: number, cacheReadTokens: number, costAmount: number, collectionEpoch: string }} VisionMetric */

/** @typedef {Object} VisionScenario
 * @property {"error" | "aborted"} [stopReason]
 * @property {boolean} [throws]
 * @property {() => Promise<void>} [duringVision]
 */
/** @param {VisionFixture} fixture @param {VisionScenario} [scenario] */
async function configureVision(fixture, scenario = {}) {
    const settings = JSON.parse(await fsReadFile(fixture.settingsPath, "utf8"));
    settings.visionFallback = { model: "runtime-command-fixture/fixture-model" };
    settings.workflowMetrics = true;
    await fsWriteFile(fixture.settingsPath, JSON.stringify(settings));
    await fsWriteFile(join(fixture.projectRoot, "shot.png"), new Uint8Array([1, 2, 3]));
    const runtime = await getModelRegistry().getRuntime();
    let primaryRequests = 0;
    /** @type {import('@earendil-works/pi-ai').ProviderStreams['streamSimple']} */
    const stream = () => {
        const result = createAssistantMessageEventStream();
        const reply =
            ++primaryRequests % 2 === 1
                ? fauxAssistantMessage(fauxToolCall("see_image", { imageRef: "shot.png" }))
                : fauxAssistantMessage(fauxText("Vision completed"));
        queueMicrotask(() => {
            result.push({ type: "done", reason: "stop", message: reply });
            result.end();
        });
        return result;
    };
    runtime.registerNativeProvider(
        createProvider({
            id: "vision-usage-primary",
            name: "Vision usage primary",
            models: [
                {
                    id: "text-only",
                    name: "Text only",
                    provider: "vision-usage-primary",
                    api: "openai-completions",
                    baseUrl: "https://example.invalid",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128000,
                    maxTokens: 100,
                },
            ],
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
    const visionReply = fauxAssistantMessage(fauxText("local vision description"));
    visionReply.usage = {
        input: 23,
        output: 7,
        cacheRead: 0,
        cacheWrite: 2,
        totalTokens: 32,
        cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0.3, total: 0.6 },
    };
    if (scenario.stopReason) visionReply.stopReason = scenario.stopReason;
    if (scenario.stopReason === "aborted") Reflect.deleteProperty(visionReply, "usage");
    const visionStream = () => {
        if (scenario.throws) throw new Error("private network failure");
        const result = createAssistantMessageEventStream();
        queueMicrotask(async () => {
            try {
                await scenario.duringVision?.();
            } catch (error) {
                const failed = fauxAssistantMessage(fauxText(""), {
                    stopReason: "error",
                    errorMessage: String(error),
                });
                result.push({ type: "error", reason: "error", error: failed });
                result.end();
                return;
            }
            if (scenario.stopReason) result.push({ type: "error", reason: scenario.stopReason, error: visionReply });
            else result.push({ type: "done", reason: "stop", message: visionReply });
            result.end();
        });
        return result;
    };
    registerApiProvider(
        { api: "runtime-command-faux", stream: visionStream, streamSimple: visionStream },
        "vision-usage-fixture",
    );
    return () => {
        unregisterApiProviders("vision-usage-fixture");
        runtime.unregisterProvider("vision-usage-primary");
    };
}

/** @param {VisionFixture} fixture
 * @returns {Promise<VisionMetric[]>} */
async function readMetrics(fixture) {
    await drainWorkflowMetrics();
    const contents = await fsReadFile(getWorkflowMetricsFilePath(fixture.projectRoot), "utf8");
    return contents
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
}

test("local see_image outside a managed execution links usage to the session", async () => {
    await withRuntimeCommandFixture("vision-session-usage-", async (fixture) => {
        const cleanup = await configureVision(fixture);
        const { session } = await buildAgentSession({
            cwd: fixture.projectRoot,
            agentName: "guide",
            toolNames: [],
            modelOverride: "vision-usage-primary/text-only",
        });
        try {
            await session.prompt("Describe shot.png");
            const records = await readMetrics(fixture);
            const vision = records.filter((record) => record.event === "model_usage");
            assertEquals(vision.length, 1);
            assertEquals(vision[0].sessionId, session.sessionManager.getSessionId());
            assertEquals(vision[0].requestId ?? null, null);
            assertEquals(vision[0].turnId, null);
            assertEquals(vision[0].model, "fixture-model");
            assertEquals(vision[0].inputTokens, 23);
            assertEquals(vision[0].cacheReadTokens, 0);
            assertEquals(vision[0].costAmount, 0.6);
            assertEquals(vision[0].usageKind, "request");
            assertEquals(vision[0].aggregationBasis, "request");
            const epoch = records.find((record) => record.event === "collection_epoch");
            assert(epoch);
            assert(vision[0].collectionEpoch);
            assertEquals(vision[0].collectionEpoch, epoch.collectionEpoch);
        } finally {
            session.dispose();
            cleanup();
        }
    });
});

test("local see_image links vision usage to the active execution, request and turn", async () => {
    await withRuntimeCommandFixture("vision-execution-usage-", async (fixture) => {
        const cleanup = await configureVision(fixture);
        const hostedSession = new HostedSession({ id: "vision-execution", cwd: fixture.projectRoot });
        try {
            await runIsolatedAgentSession({
                hostedSession,
                cwd: fixture.projectRoot,
                agentName: "guide",
                toolNames: [],
                modelOverride: "vision-usage-primary/text-only",
                userRequest: "Describe shot.png",
                background: true,
            });
            const records = await readMetrics(fixture);
            const vision = records.filter((record) => record.event === "model_usage" && record.usageKind === "request");
            assertEquals(vision.length, 1);
            const execution = records.find((record) => record.event === "execution_started");
            const turn = records.find((record) => record.event === "response_latency");
            assert(execution);
            assert(turn);
            assertEquals(vision[0].executionId, execution.executionId);
            assertEquals(vision[0].sessionId, execution.sessionId);
            assertEquals(vision[0].requestId, execution.requestId);
            assert(vision[0].requestId);
            assertEquals(vision[0].turnId, turn.turnId);
            assert(vision[0].turnId);
            assertEquals(vision[0].inputTokens, 23);
            assertEquals(vision[0].cacheReadTokens, 0);
            assertEquals(vision[0].costAmount, 0.6);
        } finally {
            hostedSession.dispose();
            cleanup();
        }
    });
});

for (const failure of ["error", "aborted", "thrown"]) {
    test(`local see_image ${failure} settles an auxiliary request with incomplete usage`, async () => {
        await withRuntimeCommandFixture("vision-failure-usage-", async (fixture) => {
            const cleanup = await configureVision(fixture, {
                throws: failure === "thrown",
                stopReason: failure === "error" ? "error" : failure === "aborted" ? "aborted" : undefined,
                duringVision: async () => {
                    const rows = await readMetrics(fixture);
                    assertEquals(rows.filter((row) => row.event === "execution_started").length, 1);
                },
            });
            const { session } = await buildAgentSession({
                cwd: fixture.projectRoot,
                agentName: "guide",
                toolNames: [],
                modelOverride: "vision-usage-primary/text-only",
            });
            try {
                await session.prompt("Describe shot.png");
                const rows = await readMetrics(fixture);
                const starts = rows.filter((row) => row.event === "execution_started");
                const usages = rows.filter((row) => row.event === "model_usage");
                const finishes = rows.filter((row) => row.event === "execution_finished");
                assertEquals(starts.length, 1);
                assertEquals(starts[0].dispatchKind, "auxiliary");
                assertEquals(starts[0].userInitiated, false);
                assertEquals(usages.length, 1);
                assertEquals(usages[0].executionId, starts[0].executionId);
                assertEquals(usages[0].measurementAvailability, failure === "error" ? "partial" : "unavailable");
                assertEquals(usages[0].inputTokens, failure === "error" ? 23 : null);
                assertEquals(finishes.length, 1);
                assertEquals(finishes[0].executionId, starts[0].executionId);
                assertEquals(finishes[0].coverage.usage === "complete", false);
                assertEquals(String(usages[0].unavailableReason).includes("private"), false);
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
                assert(report.totals.tokens.exclusions > 0);
            } finally {
                session.dispose();
                cleanup();
            }
        });
    });
}
