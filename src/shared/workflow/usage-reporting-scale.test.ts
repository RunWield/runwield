import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
import { assertEquals } from "../../testing/assertions.ts";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { getWorkflowMetricsFilePath } from "./metrics.js";
import { UsageReporter } from "./usage-reporting.ts";

test("a long report period handles retained legacy rows without repeated daily scans", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const path = getWorkflowMetricsFilePath(projectRoot);
        await mkdir(dirname(path), { recursive: true });
        const legacy = JSON.stringify({ v: 1, event: "tool_call_started", ts: "2026-09-30T23:30:00Z" }) + "\n";
        const usage = {
            v: 2,
            event: "model_usage",
            eventId: "usage:last-day",
            ts: "2026-10-01T03:59:59Z",
            inputTokens: 7,
            outputTokens: 3,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            inputCacheBasis: "excludes_cache",
            costAmount: 0.25,
            costCurrency: "USD",
            costSource: "calculated",
        };
        const enabled = { v: 1, event: "collection_epoch", ts: "2026-06-30T00:00:00Z", enabled: true };
        const gap = { v: 1, event: "measurement_gap", ts: "2026-09-29T16:00:00Z" };
        const excluded = { ...usage, eventId: "usage:next-day", ts: "2026-10-01T04:00:00Z", inputTokens: 999 };
        const watermark = { ...enabled, ts: "2026-10-02T00:00:00Z" };
        await writeFile(
            path,
            JSON.stringify(enabled) +
                "\n" +
                legacy.repeat(60_000) +
                [gap, usage, excluded, watermark].map((row) => JSON.stringify(row)).join("\n") +
                "\n",
        );
        const start = process.cpuUsage();
        const report = new UsageReporter().query(
            [projectRoot],
            { start: "2026-07-01", end: "2026-10-01" },
            "America/New_York",
        );
        const cpu = process.cpuUsage(start);
        const cpuMs = (cpu.user + cpu.system) / 1000;
        assert(cpuMs < 2000, `Legacy day coverage consumed ${Math.round(cpuMs)} ms of CPU`);
        assertEquals(report.daily.length, 92);
        assertEquals(report.totals.tokens.value, 10);
        assertEquals(report.totals.estimatedCostUsd.value, 0.25);
        assertEquals(report.daily.at(-1)?.gaps, ["legacy"]);
        assertEquals(report.daily.at(-1)?.tokens, null);
        assertEquals(report.daily.at(-2)?.gaps, ["incomplete"]);
        assertEquals(report.daily.at(-3)?.tokens, 0);
    });
});
