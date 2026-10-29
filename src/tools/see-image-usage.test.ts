import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { assertEquals } from "../testing/assertions.ts";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { withWorkflowMetricsFixture } from "../testing/workflow-metrics-fixture.ts";
import { ExecutionMetricsRecorder, type ModelUsageObservation } from "../shared/workflow/execution-metrics.ts";
import { setCustomSetting } from "../shared/settings.js";
import { UsageReporter } from "../shared/workflow/usage-reporting.ts";
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
        await fsMkdir(join(fixture.homeDir, ".wld"), { recursive: true });
        await fsWriteFile(
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
        await fsWriteFile(join(fixture.projectRoot, "shot.png"), new Uint8Array([1, 2, 3]));
        const recorder = new ExecutionMetricsRecorder({
            projectRoot: fixture.projectRoot,
            sessionId: "vision-session",
            dispatchKind: "auxiliary",
            userInitiated: false,
        });
        const observations: ModelUsageObservation[] = [];
        const tool = createSeeImageTool({
            cwd: fixture.projectRoot,
            completeSimpleFn: async () => {
                const starts = (await fixture.readMetrics()).filter((row) => row.event === "execution_started");
                assertEquals(starts.length, testCase.disabled ? 0 : 1);
                if (testCase.rejects) throw new Error("Network unavailable with private payload");
                return testCase.response!;
            },
            onModelStart: async () => {
                await recorder.recordExecutionStart();
                return {
                    async finish(observation, outcome) {
                        observations.push(observation);
                        await recorder.recordModelUsage(observation);
                        await recorder.settleExecution(outcome);
                    },
                };
            },
        });
        const execute = tool.execute as DirectVisionExecution;
        const result = await execute("vision-call", { imageRef: "shot.png" });
        const records = (await fixture.readMetrics()).filter((record) => record.event === "model_usage");
        const failed = testCase.rejects || ["error", "aborted"].includes(testCase.response?.stopReason ?? "");
        assertEquals(result.details.ok, !failed);
        assertEquals(observations.length, 1);
        assertEquals(records.length, testCase.disabled ? 0 : 1);
        const journal = await fixture.readMetrics();
        const starts = journal.filter((row) => row.event === "execution_started");
        const finishes = journal.filter((row) => row.event === "execution_finished");
        assertEquals(starts.length, testCase.disabled ? 0 : 1);
        assertEquals(finishes.length, testCase.disabled ? 0 : 1);
        if (starts.length) {
            assertEquals(starts[0].dispatchKind, "auxiliary");
            assertEquals(starts[0].userInitiated, false);
            assertEquals(finishes[0].executionId, starts[0].executionId);
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
        if (failed && !testCase.disabled) {
            assertEquals(report.totals.tokens.exclusions > 0, true);
            assertEquals(String(records[0].unavailableReason).includes("private payload"), false);
            assertEquals(finishes[0].coverage, {
                tools: "unavailable",
                usage: observations[0].measurementAvailability,
                context: "unavailable",
            });
        }
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
        assertEquals(record.unavailableReason, failed ? "source_unavailable" : usage ? null : "not_reported");
        assertEquals(
            record.measurementAvailability,
            !usage
                ? "unavailable"
                : failed
                  ? "partial"
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

test("see_image records measured vision usage once, including measured zero", () =>
    observeVision({ response: completion() }));

test("see_image records unavailable usage for a completed response without measurements", () => {
    const response = completion();
    Reflect.deleteProperty(response, "usage");
    return observeVision({ response });
});

test("see_image keeps absent vision categories and cost unavailable", () => {
    const response = completion();
    Reflect.deleteProperty(response.usage, "cacheWrite");
    Reflect.deleteProperty(response.usage, "cost");
    return observeVision({ response });
});

test("see_image retains partial usage for an errored vision response", () => {
    const response = completion();
    response.stopReason = "error";
    response.errorMessage = "Provider failed with private payload";
    return observeVision({ response });
});

test("see_image records unavailable usage for a cancelled vision response", () => {
    const response = completion();
    response.stopReason = "aborted";
    Reflect.deleteProperty(response, "usage");
    return observeVision({ response });
});

test("see_image records unavailable usage when the vision network fails", () => observeVision({ rejects: true }));

test("see_image respects disabled workflow metrics", () => observeVision({ response: completion(), disabled: true }));

test("see_image preserves cache-only usage as partial rather than unavailable", () => {
    const response = completion();
    Reflect.deleteProperty(response.usage, "input");
    Reflect.deleteProperty(response.usage, "output");
    return observeVision({ response });
});

test("see_image retains partial usage from an aborted vision response", () => {
    const response = completion();
    response.stopReason = "aborted";
    return observeVision({ response });
});
