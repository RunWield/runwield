import { test } from "node:test";
import { mock, setSystemTime } from "bun:test";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { mkdir as fsMkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertEquals } from "../../testing/assertions.ts";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { ExecutionMetricsRecorder } from "./execution-metrics.ts";
import { getWorkflowMetricsFilePath } from "./metrics.js";
import { setCustomSetting } from "../settings.js";

// Bun snapshots built-in named imports. Load the reporter after controlling this
// filesystem boundary, in its own isolated test file. All journal writes stay real.
let afterRead: ((fd: number) => void) | undefined;
const read = fs.readSync;
mock.module("node:fs", () => ({
    ...fs,
    readSync(fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) {
        const count = read(fd, buffer, offset, length, position);
        afterRead?.(fd);
        return count;
    },
}));
const { UsageReporter } = await import("./usage-reporting.ts");
type UsageReport = ReturnType<InstanceType<typeof UsageReporter>["query"]>;
const period = { start: "2026-11-01", end: "2026-11-05" };
const zone = "America/New_York";

// A synchronous filesystem read is the only controlled boundary. The other process
// runs the real clear, epoch transition and producer while refresh holds old bytes.
for (const clears of [1, 3]) {
    test(`refresh-time clear retries are bounded and preserve stable Project totals (${clears} clears)`, async () => {
        await withWorkflowMetricsFixture(async ({ projectRoot }) => {
            setSystemTime(new Date("2026-11-02T16:00:00Z"));
            const other = join(projectRoot, "stable-project");
            const record = async (root: string, tokens: number, cost: number) => {
                await new ExecutionMetricsRecorder({ projectRoot: root }).recordModelUsage({
                    inputTokens: tokens,
                    outputTokens: 0,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    inputCacheBasis: "excludes_cache",
                    costAmount: cost,
                });
            };
            try {
                await fsMkdir(other);
                await setCustomSetting("workflowMetrics", true, "project", other);
                await record(projectRoot, 19, 0.5);
                await record(other, 31, 0.75);
                const reporter = new UsageReporter();
                const stableBefore = reporter.query([other], period, zone).projects[0];
                const path = getWorkflowMetricsFilePath(projectRoot);
                const inode = fs.statSync(path).ino;
                let races = 0;
                afterRead = (fd) => {
                    if (fs.fstatSync(fd).ino === inode && races < clears) {
                        races++;
                        const script = `
                            import { setSystemTime } from "bun:test";
                            import { clearWorkflowMetricJournal } from ${JSON.stringify(new URL("./metrics-journal.ts", import.meta.url).href)};
                            import { ExecutionMetricsRecorder } from ${JSON.stringify(new URL("./execution-metrics.ts", import.meta.url).href)};
                            setSystemTime(new Date("2026-11-02T16:01:00Z"));
                            const result = await clearWorkflowMetricJournal(${JSON.stringify(path)});
                            if (!result.persisted) throw new Error(JSON.stringify(result));
                            await new ExecutionMetricsRecorder({projectRoot:${JSON.stringify(projectRoot)}}).recordModelUsage({
                                inputTokens:7, outputTokens:0, cacheReadTokens:0, cacheWriteTokens:0,
                                inputCacheBasis:"excludes_cache", costAmount:0.25,
                            });
                        `;
                        const child = spawnSync(process.execPath, runtimeSourceArgs(["eval", script]), {
                            encoding: "utf8",
                            env: process.env,
                            timeout: 15000,
                        });
                        assertEquals(child.status, 0, child.stderr);
                    }
                };
                let report: UsageReport;
                try {
                    report = reporter.query([projectRoot, other], period, zone);
                } finally {
                    afterRead = undefined;
                }
                assertEquals(races, clears);
                assertEquals(report.projects[1], stableBefore);
                assertEquals(report.projects[0].coverage.historyClearPending, clears === 3);
                assertEquals(report.projects[0].totals.tokens.value, clears === 3 ? 0 : 7);
                assertEquals(report.totals.tokens.value, clears === 3 ? 31 : 38);
                assertEquals(report.totals.estimatedCostUsd.value, clears === 3 ? 0.75 : 1);
                // Withholding is per query, not a permanent loss of this Project.
                const settled = reporter.query([projectRoot, other], period, zone);
                assertEquals(settled.projects[0].coverage.historyClearPending, false);
                assertEquals(settled.totals.tokens.value, 38);
            } finally {
                setSystemTime();
            }
        });
    });
}

test("a real interrupted clear stays read-only until explicit retry", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        setSystemTime(new Date("2026-11-02T16:00:00Z"));
        try {
            const recorder = new ExecutionMetricsRecorder({ projectRoot });
            await recorder.recordModelUsage({ inputTokens: 19, outputTokens: 0 });
            const reporter = new UsageReporter();
            assertEquals(reporter.query([projectRoot], period, zone).totals.tokens.value, 19);
            const path = getWorkflowMetricsFilePath(projectRoot);
            const script = `
                import { mock } from "bun:test";
                import fs from "node:fs";
                const open = fs.openSync;
                mock.module("node:fs", () => ({ ...fs, openSync(...args) {
                    if (args[0] === ${JSON.stringify(path)} && args[1] === "w") {
                        throw Object.assign(new Error("Interrupted truncation"), { code: "EIO" });
                    }
                    return open(...args);
                }}));
                const { clearWorkflowMetricJournal } = await import(${JSON.stringify(new URL("./metrics-journal.ts", import.meta.url).href)});
                const result = await clearWorkflowMetricJournal(${JSON.stringify(path)});
                if (result.persisted || result.reason !== "storage_failure") throw new Error(JSON.stringify(result));
            `;
            const child = spawnSync(process.execPath, runtimeSourceArgs(["eval", script]), {
                encoding: "utf8",
                env: process.env,
                timeout: 15000,
            });
            assertEquals(child.status, 0, child.stderr);
            await setCustomSetting("workflowMetrics", false, "project", projectRoot);
            const directory = dirname(path);
            const artifacts = [path, join(directory, "clear.json"), join(directory, "state.json")];
            const before = artifacts.map((file) => fs.readFileSync(file, "utf8"));
            for (let query = 0; query < 2; query++) {
                const report = reporter.query([projectRoot], period, zone);
                assertEquals(report.projects[0].coverage.historyClearPending, true);
                assertEquals(report.totals.tokens.value, 0);
                assertEquals(report.projects[0].links, []);
            }
            assertEquals(
                artifacts.map((file) => fs.readFileSync(file, "utf8")),
                before,
            );
            assertEquals((await reporter.clear([projectRoot]))[0].persisted, true);
            assertEquals(reporter.query([projectRoot], period, zone).projects[0].coverage.historyClearPending, false);
        } finally {
            setSystemTime();
        }
    });
});
