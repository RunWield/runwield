import { assertEquals } from "../../testing/assertions.ts";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { setImmediate } from "node:timers/promises";
import { openNativeFileLock } from "../native-file-lock.ts";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { recordSlashCommandMetric, SlashCommandMetricsTracker } from "./command-metrics.ts";
import { drainWorkflowMetrics, getWorkflowMetricsFilePath } from "./metrics.js";

test("recordSlashCommandMetric records direct start and finish observations", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const invocationId = "inv-direct-1";

        // Record start
        await recordSlashCommandMetric({
            invocationId,
            command: "plan-review",
            kind: "builtin",
            surface: "workspace",
            projectRoot,
            sessionId: "session-abc",
            phase: "start",
        });

        // Record finish
        await recordSlashCommandMetric({
            invocationId,
            command: "plan-review",
            kind: "builtin",
            surface: "workspace",
            projectRoot,
            sessionId: "session-abc",
            phase: "finish",
            outcome: "succeeded",
            durationMs: 42,
        });

        const records = await readMetrics();
        assertEquals(records.length, 2);

        const start = records[0];
        assertEquals(start.v, 2);
        assertEquals(start.category, "command");
        assertEquals(start.event, "command_started");
        assertEquals(start.commandId, invocationId);
        assertEquals(start.command, "plan-review");
        assertEquals(start.kind, "builtin");
        assertEquals(start.sourceSurface, "workspace");
        assertEquals(start.sessionId, "session-abc");

        const finish = records[1];
        assertEquals(finish.v, 2);
        assertEquals(finish.category, "command");
        assertEquals(finish.event, "command_finished");
        assertEquals(finish.commandId, invocationId);
        assertEquals(finish.command, "plan-review");
        assertEquals(finish.outcome, "succeeded");
        assertEquals(finish.durationMs, 42);
    });
});

test("SlashCommandMetricsTracker measures duration and emits linked start/finish events", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const tracker = new SlashCommandMetricsTracker({
            command: "tdd",
            alias: "test-driven-dev",
            kind: "skill",
            surface: "tui",
            projectRoot,
            sessionId: "session-xyz",
            requestId: "req-99",
        });

        await tracker.recordStart();

        // Simulate work
        await new Promise((resolve) => setTimeout(resolve, 15));

        await tracker.recordFinish({
            outcome: "succeeded",
            executionId: "exec-child-42",
        });

        const records = await readMetrics();
        assertEquals(records.length, 2);

        const start = records[0];
        assertEquals(start.event, "command_started");
        assertEquals(start.command, "tdd");
        assertEquals(start.alias, "test-driven-dev");
        assertEquals(start.kind, "skill");
        assertEquals(start.sourceSurface, "tui");
        assertEquals(start.commandId, tracker.invocationId);

        const finish = records[1];
        assertEquals(finish.event, "command_finished");
        assertEquals(finish.commandId, tracker.invocationId);
        assertEquals(finish.outcome, "succeeded");
        assertEquals(finish.executionId, "exec-child-42");
        assert(typeof finish.durationMs === "number" && (finish.durationMs as number) >= 10);
    });
});

test("SlashCommandMetricsTracker records failures with reason codes", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const tracker = new SlashCommandMetricsTracker({
            command: "unknown-cmd",
            kind: "builtin",
            surface: "acp",
            projectRoot,
        });

        await tracker.recordStart();
        await tracker.recordFinish({
            outcome: "failed",
            errorReason: "unknown_command",
        });

        const records = await readMetrics();
        assertEquals(records.length, 2);
        const finish = records[1];
        assertEquals(finish.event, "command_finished");
        assertEquals(finish.outcome, "failed");
        assertEquals(finish.errorReason, "unknown_command");
    });
});

for (const api of ["tracker", "direct"] as const) {
    test(`${api} command finish awaits its bounded drain and preserves queued records`, async () => {
        await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
            const file = getWorkflowMetricsFilePath(projectRoot);
            await mkdir(dirname(file), { recursive: true });
            const lock = openNativeFileLock(`${file}.lock`);
            lock.lockSync(true);
            const originalTimeout = globalThis.setTimeout;
            const originalNow = performance.now;
            const fixedNow = originalNow.call(performance);
            let fireDrain = () => {};
            let signalScheduled = () => {};
            const scheduled = new Promise<void>((resolve) => {
                signalScheduled = resolve;
            });
            const timers: ReturnType<typeof setTimeout>[] = [];
            let settled = false;
            let pending: Promise<void> | undefined;
            try {
                // The real writer lock blocks persistence. Control only the external clock,
                // so scheduler load cannot consume the writer's separate contention budget.
                performance.now = () => fixedNow;
                globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
                    const [callback, delay, ...callbackArgs] = args;
                    if (delay === 100) {
                        fireDrain = () => callback(...callbackArgs);
                        signalScheduled();
                        const timer = originalTimeout(() => {}, 60000);
                        timers.push(timer);
                        return timer;
                    }
                    return originalTimeout(...args);
                }) as typeof setTimeout;
                const invocationId = `bounded-${api}`;
                const tracker = new SlashCommandMetricsTracker({
                    invocationId,
                    projectRoot,
                    command: "share",
                    kind: "builtin",
                    surface: "tui",
                });
                pending = (
                    api === "tracker"
                        ? tracker.recordFinish({ outcome: "failed" })
                        : recordSlashCommandMetric({
                              projectRoot,
                              invocationId,
                              command: "share",
                              kind: "builtin",
                              surface: "tui",
                              phase: "finish",
                              outcome: "failed",
                          })
                ).then(() => {
                    settled = true;
                });
                const watchdog = new Promise<never>((_, reject) => {
                    timers.push(originalTimeout(() => reject(new Error("Finish did not await its drain timer")), 5000));
                });
                await Promise.race([scheduled, watchdog]);
                await setImmediate();
                assertEquals(settled, false, "Finish must wait for the bounded drain");
                fireDrain();
                await Promise.race([pending, watchdog]);
                assertEquals(settled, true, "A held writer lock must not block command completion");
            } finally {
                globalThis.setTimeout = originalTimeout;
                performance.now = originalNow;
                fireDrain();
                for (const timer of timers) clearTimeout(timer);
                lock.close();
                await pending;
                await drainWorkflowMetrics();
            }
            const rows = await readMetrics();
            assertEquals(
                rows.map((row) => ({
                    event: row.event,
                    commandId: row.commandId,
                    outcome: row.outcome,
                })),
                [{ event: "command_finished", commandId: `bounded-${api}`, outcome: "failed" }],
            );
        });
    });
}
