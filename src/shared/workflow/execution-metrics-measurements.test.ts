import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { ExecutionMetricsRecorder } from "./execution-metrics.ts";

test("saved latency, retry, compaction, and multibyte result measurements keep their sources", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const recorder = new ExecutionMetricsRecorder({
            projectRoot,
            sessionId: "measurement-session",
            executionId: "measurement-turn",
            agentName: "engineer",
            provider: "anthropic",
            model: "claude-sonnet",
            backend: "pi",
            sourceSurface: "tui",
            executionKind: "root",
            mode: "foreground",
        });
        await recorder.recordExecutionStart();
        await recorder.recordResponseLatency("turn_start");
        await new Promise((resolve) => setTimeout(resolve, 8));
        await recorder.recordResponseLatency("first_response");
        await new Promise((resolve) => setTimeout(resolve, 8));
        await recorder.recordResponseLatency("first_text");
        await recorder.recordToolStart("unicode-call", "read");
        await recorder.recordToolFinish("unicode-call", "read", {
            result: { content: [{ type: "text", text: "é🙂" }, { type: "image", data: "secret-pixels" }] },
            truncated: false,
        });
        await recorder.recordToolStart("unmeasured-call", "read");
        await recorder.recordToolFinish("unmeasured-call", "read", { result: undefined });
        await recorder.recordRetry({ retrySource: "model", attempt: 2, maxAttempts: 3, delayMs: 12 });
        await recorder.recordRetry({ retrySource: "model", attempt: 2, outcome: "canceled", reason: "canceled" });
        await recorder.recordCompaction({ reason: "threshold", phase: "start", tokensBefore: 150 });
        await recorder.recordContextSnapshot("after_compaction", {
            capacityTokens: 200,
            currentTokens: null,
            usageState: "unknown_after_compaction",
        });
        await recorder.recordCompaction({
            reason: "threshold",
            phase: "end",
            outcome: "success",
            tokensBefore: 150,
            tokensAfter: 70,
        });
        await new Promise((resolve) => setTimeout(resolve, 8));
        await recorder.recordResponseLatency("turn_finish");
        await recorder.settleExecution("succeeded");
        const rows = await readMetrics();
        const latency = rows.find((row) => row.event === "response_latency");
        assert(latency);
        const {
            requestStartedAt,
            firstResponseAt,
            firstVisibleTextAt,
            completedAt,
            firstResponseLatencyMs,
            firstVisibleTextLatencyMs,
            totalLatencyMs,
        } = latency;
        assert(
            typeof requestStartedAt === "number" && typeof firstResponseAt === "number" &&
                typeof firstVisibleTextAt === "number" && typeof completedAt === "number" &&
                typeof firstResponseLatencyMs === "number" && typeof firstVisibleTextLatencyMs === "number" &&
                typeof totalLatencyMs === "number",
        );
        assert(
            requestStartedAt < firstResponseAt && firstResponseAt < firstVisibleTextAt &&
                firstVisibleTextAt < completedAt,
        );
        assert(
            firstResponseLatencyMs > 0 && firstVisibleTextLatencyMs > firstResponseLatencyMs &&
                totalLatencyMs > firstVisibleTextLatencyMs,
        );
        const unicode = rows.find((row) => row.event === "tool_call_finished" && row.callId === "unicode-call");
        assertEquals([unicode?.resultBytes, unicode?.resultTokens, unicode?.imageCount, unicode?.truncated], [
            6,
            1,
            1,
            false,
        ]);
        const missing = rows.find((row) => row.event === "tool_call_finished" && row.callId === "unmeasured-call");
        assertEquals([missing?.resultBytes, missing?.resultTokens, missing?.truncated], [null, null, null]);
        assertEquals(
            rows.filter((row) => row.event.startsWith("retry_")).map((
                row,
            ) => [row.event, row.retrySource, row.attempt, row.outcome]),
            [
                ["retry_started", "auto_retry", 2, undefined],
                ["retry_finished", "auto_retry", 2, "canceled"],
            ],
        );
        assertEquals(rows.find((row) => row.event === "compaction_started")?.beforeTokens, 150);
        assertEquals(rows.find((row) => row.event === "compaction_finished")?.afterTokens, 70);
        const context = rows.find((row) =>
            row.event === "context_snapshot" && row.samplingPoint === "after_compaction"
        );
        assertEquals([context?.currentUsage, context?.usageState], [null, "unknown_after_compaction"]);
        assertEquals(JSON.stringify(rows).includes("secret-pixels"), false);
    });
});
