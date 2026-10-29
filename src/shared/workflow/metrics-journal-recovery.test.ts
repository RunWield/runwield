import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { assertEquals } from "../../testing/assertions.ts";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { getWorkflowMetricsFilePath, recordWorkflowMetric } from "./metrics.js";
import {
    clearWorkflowMetricJournal,
    resolveCollectionEpoch,
    withWorkflowMetricJournalLock,
} from "./metrics-journal.ts";

const metric = { v: 2, category: "command", event: "command_started", recorderId: "test", seq: 0, command: "help" };
const retained = (JSON.stringify({ v: 1, event: "legacy", padding: "x".repeat(1024) }) + "\n").repeat(4096);

test("clear waits for automatic recovery and does not restore the removed history", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const path = getWorkflowMetricsFilePath(projectRoot);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, retained);
        assertEquals((await recordWorkflowMetric(metric, projectRoot)).reason, "recovery_pending");
        const cleared = await clearWorkflowMetricJournal(path);
        assertEquals(cleared.persisted, true);
        await withWorkflowMetricJournalLock(path, () => undefined);
        assertEquals((await recordWorkflowMetric({ ...metric, seq: 1 }, projectRoot)).persisted, true);
        const content = await readFile(path, "utf8");
        assertEquals(content.includes('"legacy"'), false);
        const rows = content
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        assertEquals(rows[0].event, "history_epoch");
        assertEquals(rows[0].historyEpoch, cleared.historyEpoch);
        assert(rows.every((row) => row.historyEpoch === cleared.historyEpoch));
        assertEquals(rows.filter((row) => row.v === 2).length, 1);
    });
});

test("a bounded write starts automatic history recovery without more observations", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const path = getWorkflowMetricsFilePath(projectRoot);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, retained);
        assertEquals((await recordWorkflowMetric(metric, projectRoot)).reason, "recovery_pending");
        // These reads do not advance the durable checkpoint. Recovery must make its own progress.
        const deadline = Date.now() + 10_000;
        const size = Buffer.byteLength(retained);
        let epoch = resolveCollectionEpoch(path);
        while ((epoch.journalBytes !== size || epoch.recoveryBytes) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            epoch = resolveCollectionEpoch(path);
        }
        assert(epoch.journalBytes === size && !epoch.recoveryBytes, "History recovery did not finish");
        const saved = await recordWorkflowMetric({ ...metric, seq: 1 }, projectRoot);
        assertEquals(saved.persisted, true);
        const content = await readFile(path, "utf8");
        assert(content.startsWith(retained));
        assertEquals(content.split("\n").filter((line) => line.includes('"v":2')).length, 1);
        await withWorkflowMetricJournalLock(path, () => undefined);
    });
});

test("authorization recovers retained history and preserves corruption evidence before capturing its boundary", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const path = getWorkflowMetricsFilePath(projectRoot);
        await mkdir(dirname(path), { recursive: true });
        const history = "broken-interior\n" + retained;
        await writeFile(path, history);
        const epoch = await withWorkflowMetricJournalLock(path, (historyEpoch) => historyEpoch);
        assert(epoch !== "initial");
        const content = await readFile(path, "utf8");
        assert(content.startsWith(history));
        const appended = content
            .slice(history.length)
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
        assertEquals(appended.length, 1);
        assertEquals(appended[0].event, "measurement_gap");
        assertEquals(appended[0].reason, "interior_corruption");
        assertEquals(appended[0].corruptLines, [1]);
        assertEquals(appended[0].historyEpoch, epoch);
        assertEquals(resolveCollectionEpoch(path).historyEpoch, epoch);
        assertEquals((await recordWorkflowMetric(metric, projectRoot)).persisted, true);
    });
});
