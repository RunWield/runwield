import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { SlashCommandMetricsTracker } from "./command-metrics.ts";

test("picker cancellation has one opened command and no dispatch", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const tracker = new SlashCommandMetricsTracker({
            command: "agent",
            kind: "builtin",
            surface: "tui",
            projectRoot,
        });
        await tracker.recordStart("opened");
        await tracker.recordFinish({ outcome: "canceled" });
        const rows = await readMetrics();
        assertEquals(rows.map((row) => [row.event, row.phase, row.outcome]), [
            ["command_started", "opened", undefined],
            ["command_finished", "finish", "canceled"],
        ]);
        assertEquals(new Set(rows.map((row) => row.commandId)).size, 1);
    });
});

test("one selected picker command tracks dispatch and failed settlement", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const tracker = new SlashCommandMetricsTracker({
            command: "model",
            kind: "builtin",
            surface: "acp",
            projectRoot,
        });
        await tracker.recordStart("opened");
        await tracker.recordDispatched();
        await tracker.recordDispatched();
        await tracker.recordFinish({ outcome: "failed", errorReason: "failed" });
        const rows = await readMetrics();
        assertEquals(rows.map((row) => [row.event, row.phase, row.outcome, row.seq]), [
            ["command_started", "opened", undefined, 0],
            ["command_dispatched", "dispatched", undefined, 1],
            ["command_finished", "finish", "failed", 2],
        ]);
        assertEquals(new Set(rows.map((row) => row.commandId)).size, 1);
    });
});
