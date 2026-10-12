import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
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
import { drainWorkflowMetrics, getWorkflowMetricsFilePath } from "../workflow/metrics.js";

/** @typedef {import('../../cmd/testing/runtime-command-fixture.ts').RuntimeCommandFixture} VisionFixture */
/** @typedef {{ event: string, sessionId: string, executionId: string, requestId: string | null, turnId: string | null, model: string, usageKind: string, aggregationBasis: string, inputTokens: number, cacheReadTokens: number, costAmount: number, collectionEpoch: string }} VisionMetric */

/** @param {VisionFixture} fixture */
async function configureVision(fixture) {
    const settings = JSON.parse(await Deno.readTextFile(fixture.settingsPath));
    settings.visionFallback = { model: "runtime-command-fixture/fixture-model" };
    settings.workflowMetrics = true;
    await Deno.writeTextFile(fixture.settingsPath, JSON.stringify(settings));
    await Deno.writeFile(join(fixture.projectRoot, "shot.png"), new Uint8Array([1, 2, 3]));
    const runtime = await getModelRegistry().getRuntime();
    let primaryRequests = 0;
    /** @type {import('@earendil-works/pi-ai').ProviderStreams['streamSimple']} */
    const stream = () => {
        const result = createAssistantMessageEventStream();
        const reply = ++primaryRequests % 2 === 1
            ? fauxAssistantMessage(fauxToolCall("see_image", { imageRef: "shot.png" }))
            : fauxAssistantMessage(fauxText("Vision completed"));
        queueMicrotask(() => {
            result.push({ type: "done", reason: "stop", message: reply });
            result.end();
        });
        return result;
    };
    runtime.registerNativeProvider(createProvider({
        id: "vision-usage-primary",
        name: "Vision usage primary",
        models: [{
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
        }],
        auth: {
            apiKey: {
                name: "Fixture",
                check: () => Promise.resolve({ type: "api_key" }),
                resolve: () => Promise.resolve({ auth: {} }),
            },
        },
        api: { stream, streamSimple: stream },
    }));
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
    const visionStream = () => {
        const result = createAssistantMessageEventStream();
        queueMicrotask(() => {
            result.push({ type: "done", reason: "stop", message: visionReply });
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
    const contents = await Deno.readTextFile(getWorkflowMetricsFilePath(fixture.projectRoot));
    return contents.trim().split("\n").map((line) => JSON.parse(line));
}

Deno.test("local see_image outside a managed execution links usage to the session", async () => {
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

Deno.test("local see_image links vision usage to the active execution, request and turn", async () => {
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
