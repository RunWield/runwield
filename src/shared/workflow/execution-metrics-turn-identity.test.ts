import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { ok as assert, notDeepStrictEqual as assertNotEquals } from "node:assert/strict";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { ExecutionMetricsRecorder } from "./execution-metrics.ts";

test("observations identify their turn without reusing the previous turn ID", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const recorder = new ExecutionMetricsRecorder({ projectRoot });
        await recorder.recordExecutionStart();
        await recorder.recordResponseLatency("turn_start");
        await recorder.recordToolStart("first-call", "read");
        await recorder.recordToolFinish("first-call", "read");
        await recorder.recordResponseLatency("turn_finish");
        await recorder.recordResponseLatency("turn_start");
        await recorder.recordToolStart("second-call", "read");
        await recorder.recordToolFinish("second-call", "read");
        await recorder.recordResponseLatency("turn_finish");
        await recorder.settleExecution();
        const rows = await readMetrics();
        const first = rows.find((row) => row.event === "tool_call_started" && row.callId === "first-call");
        const second = rows.find((row) => row.event === "tool_call_started" && row.callId === "second-call");
        assert(typeof first?.turnId === "string" && typeof second?.turnId === "string");
        assertNotEquals(first.turnId, second.turnId);
        assertEquals(rows.find((row) => row.event === "execution_started")?.turnId, null);
        assertEquals(
            rows.find((row) => row.event === "tool_call_finished" && row.callId === "second-call")?.turnId,
            second.turnId,
        );
    });
});

test("Pi turn usage retains its identity when the previous latency write is pending", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const recorder = new ExecutionMetricsRecorder({ projectRoot });
        const usage = {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        const entries = [
            { id: "first", type: "usage", usage, kind: "cache_warm", provider: "anthropic", model: "claude" },
            { id: "second", type: "usage", usage, kind: "cache_warm", provider: "anthropic", model: "claude" },
        ] as Parameters<typeof recorder.reconcilePiEntries>[0];
        await recorder.recordResponseLatency("turn_start");
        recorder.associatePiTurnEntries(entries.slice(0, 1), new Set());
        const previousFinish = recorder.recordResponseLatency("turn_finish");
        const nextStart = recorder.recordResponseLatency("turn_start");
        await previousFinish;
        await nextStart;
        recorder.associatePiTurnEntries(entries, new Set(["first"]));
        await recorder.recordResponseLatency("turn_finish");
        await recorder.reconcilePiEntries(entries, new Set());
        await recorder.settleExecution();
        const rows = await readMetrics();
        const turns = rows.filter((row) => row.event === "response_latency");
        const linked = rows.filter((row) => row.event === "model_usage");
        assertEquals(turns.length, 2);
        assertEquals(linked.length, 2);
        assert(typeof turns[1].turnId === "string");
        assertEquals(linked.map((row) => row.turnId), turns.map((row) => row.turnId));
        assertNotEquals(turns[0].turnId, turns[1].turnId);
    });
});
