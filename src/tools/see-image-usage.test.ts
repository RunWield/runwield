import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { withWorkflowMetricsFixture } from "../testing/workflow-metrics-fixture.ts";
import { ExecutionMetricsRecorder } from "../shared/workflow/execution-metrics.ts";
import { setCustomSetting } from "../shared/settings.js";
import { createSeeImageTool } from "./see-image.ts";

const measuredUsage = {
    input: 17,
    output: 9,
    cacheRead: 0,
    cacheWrite: 3,
    totalTokens: 29,
    cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0.03, total: 0.06 },
};

interface VisionParameters {
    imageRef: string;
}

// Direct tool execution has no Pi extension context; see_image does not use that context.
type DirectVisionExecution = (
    callId: string,
    parameters: VisionParameters,
) => ReturnType<ReturnType<typeof createSeeImageTool>["execute"]>;

interface VisionCase {
    response?: AssistantMessage;
    rejects?: boolean;
    disabled?: boolean;
}

async function observeVision(testCase: VisionCase) {
    await withWorkflowMetricsFixture(async (fixture) => {
        await Deno.mkdir(join(fixture.homeDir, ".wld"), { recursive: true });
        await Deno.writeTextFile(
            join(fixture.homeDir, ".wld", "models.json"),
            JSON.stringify({
                providers: {
                    vision: {
                        api: "openai-completions",
                        baseUrl: "https://example.invalid/v1",
                        apiKey: "test-key",
                        models: [{ id: "model", input: ["text", "image"] }],
                    },
                },
            }),
        );
        await setCustomSetting("visionFallback", { model: "vision/model" }, "project", fixture.projectRoot);
        if (testCase.disabled) await setCustomSetting("workflowMetrics", false, "project", fixture.projectRoot);
        await Deno.writeFile(join(fixture.projectRoot, "shot.png"), new Uint8Array([1, 2, 3]));
        const recorder = new ExecutionMetricsRecorder({
            projectRoot: fixture.projectRoot,
            sessionId: "vision-session",
        });
        const observations = [];
        const tool = createSeeImageTool({
            cwd: fixture.projectRoot,
            completeSimpleFn: () =>
                testCase.rejects
                    ? Promise.reject(new Error("Network unavailable"))
                    : Promise.resolve(testCase.response!),
            onModelUsage: async (observation) => {
                observations.push(observation);
                await recorder.recordModelUsage(observation);
            },
        });
        const execute = tool.execute as DirectVisionExecution;
        const result = await execute("vision-call", { imageRef: "shot.png" });
        const records = (await fixture.readMetrics()).filter((record) => record.event === "model_usage");
        const failed = testCase.rejects || ["error", "aborted"].includes(testCase.response?.stopReason ?? "");
        assertEquals(result.details.ok, !failed);
        assertEquals(observations.length, failed ? 0 : 1);
        assertEquals(records.length, failed || testCase.disabled ? 0 : 1);
        if (!records.length) return;
        const record = records[0];
        assertEquals(record.v, 2);
        assertEquals(record.sessionId, "vision-session");
        assertEquals(record.usageKind, "request");
        assertEquals(record.aggregationBasis, "request");
        assertEquals(record.provider, "vision");
        assertEquals(record.model, "model");
        const usage = testCase.response?.usage;
        assertEquals(record.inputTokens, usage?.input ?? null);
        assertEquals(record.outputTokens, usage?.output ?? null);
        assertEquals(record.cacheReadTokens, usage?.cacheRead ?? null);
        assertEquals(record.cacheWriteTokens, usage?.cacheWrite ?? null);
        assertEquals(record.costAmount, usage?.cost?.total ?? null);
        assertEquals(record.costSource, usage?.cost?.total != null ? "calculated" : "unavailable");
        assertEquals(
            record.measurementAvailability,
            !usage
                ? "unavailable"
                : usage.input == null || usage.output == null || usage.cacheRead == null || usage.cacheWrite == null
                ? "partial"
                : "complete",
        );
    });
}

function completion() {
    const response = fauxAssistantMessage(fauxText("Vision description"));
    response.usage = structuredClone(measuredUsage);
    return response;
}

Deno.test("see_image records measured vision usage once, including measured zero", () =>
    observeVision({ response: completion() }));

Deno.test("see_image records unavailable usage for a completed response without measurements", () => {
    const response = completion();
    Reflect.deleteProperty(response, "usage");
    return observeVision({ response });
});

Deno.test("see_image keeps absent vision categories and cost unavailable", () => {
    const response = completion();
    Reflect.deleteProperty(response.usage, "cacheWrite");
    Reflect.deleteProperty(response.usage, "cost");
    return observeVision({ response });
});

Deno.test("see_image does not observe an errored vision response", () =>
    observeVision({
        response: fauxAssistantMessage(fauxText(""), { stopReason: "error", errorMessage: "Provider failed" }),
    }));

Deno.test("see_image does not observe a cancelled vision response", () =>
    observeVision({
        response: fauxAssistantMessage(fauxText(""), { stopReason: "aborted" }),
    }));

Deno.test("see_image does not invent usage when the vision network fails", () => observeVision({ rejects: true }));

Deno.test("see_image respects disabled workflow metrics", () =>
    observeVision({ response: completion(), disabled: true }));

Deno.test("see_image preserves cache-only usage as partial rather than unavailable", () => {
    const response = completion();
    Reflect.deleteProperty(response.usage, "input");
    Reflect.deleteProperty(response.usage, "output");
    return observeVision({ response });
});
