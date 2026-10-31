import process from "node:process";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertEquals } from "../../testing/assertions.ts";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { makeManagedSessionFixture } from "../../testing/managed-session-fixture.ts";
import { getWorkflowMetricsFilePath } from "../../shared/workflow/metrics.js";
import { loadOwnerUsageReport } from "./server/owner-usage.ts";

function usageRow(sessionId: string, index: number) {
    return {
        v: 2,
        event: "model_usage",
        eventId: `usage-${index}`,
        ts: "2026-09-01T16:00:00Z",
        managedSessionId: sessionId,
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        inputCacheBasis: "excludes_cache",
        aggregationBasis: "turn",
        backend: "pi",
        provider: "test",
        model: "model",
    };
}

test("large reports preserve available and missing Session links within a bounded CPU cost", async () => {
    await withWorkflowMetricsFixture(async ({ homeDir, projectRoot }) => {
        const fixture = await makeManagedSessionFixture({
            home: homeDir,
            projectRoot,
            dbPath: join(homeDir, "owner.sqlite3"),
        });
        try {
            const count = 20_000;
            const rows = Array.from({ length: count }, (_, index) =>
                usageRow(index % 2 ? "missing-session" : fixture.session.runwieldSessionId, index),
            );
            const path = getWorkflowMetricsFilePath(fixture.store.requireEnabledProjectRoot(fixture.project.projectId));
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
            const before = process.cpuUsage();
            const report = await loadOwnerUsageReport(
                fixture.store,
                new URLSearchParams({ start: "2026-09-01", end: "2026-09-02" }),
            );
            const cpu = process.cpuUsage(before);
            const cpuMs = (cpu.user + cpu.system) / 1000;
            const links = report.projects[0].links;
            assertEquals(report.totals.tokens.value, count);
            assertEquals(links.length, count);
            assertEquals(links.filter((link) => link.sessionHref).length, count / 2);
            assertEquals(
                links.filter((link) => link.sessionId === "missing-session").every((link) => !link.sessionHref),
                true,
            );
            // CPU time excludes time waiting for other test processes or the filesystem.
            assert(cpuMs < 2_000, `Repeated Session references consumed ${Math.round(cpuMs)} ms of CPU`);
        } finally {
            await fixture.cleanup();
        }
    });
});

test("many distinct missing Session links do not rescan the retained Session catalog", async () => {
    await withWorkflowMetricsFixture(async ({ homeDir, projectRoot }) => {
        const fixture = await makeManagedSessionFixture({
            home: homeDir,
            projectRoot,
            dbPath: join(homeDir, "owner.sqlite3"),
        });
        try {
            const available = [fixture.session.runwieldSessionId];
            for (let index = 0; index < 100; index++) {
                const piSessionId = crypto.randomUUID();
                const timestamp = "2026-09-01T16:00:00.000Z";
                const transcriptPath = join(
                    fixture.sessionDir,
                    `${timestamp.replace(/[:.]/g, "-")}_${piSessionId}.jsonl`,
                );
                await writeFile(
                    transcriptPath,
                    JSON.stringify({ type: "session", id: piSessionId, timestamp, cwd: projectRoot }) + "\n",
                );
                const session = await fixture.store.ensureSessionCatalogRecord({
                    projectId: fixture.project.projectId,
                    piSessionId,
                    transcriptPath,
                    transcriptCwd: projectRoot,
                    source: "catalog",
                });
                available.push(session.runwieldSessionId);
            }
            fixture.store.archiveSession(available[1], fixture.project.projectId);
            const missing = Array.from({ length: 1000 }, (_, index) => `missing-${index}`);
            const rows = [...available, ...missing].map(usageRow);
            const path = getWorkflowMetricsFilePath(fixture.store.requireEnabledProjectRoot(fixture.project.projectId));
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
            const before = process.cpuUsage();
            const report = await loadOwnerUsageReport(
                fixture.store,
                new URLSearchParams({ start: "2026-09-01", end: "2026-09-02" }),
            );
            const cpu = process.cpuUsage(before);
            const cpuMs = (cpu.user + cpu.system) / 1000;
            const links = report.projects[0].links;
            assertEquals(report.totals.tokens.value, rows.length);
            assertEquals(links.length, rows.length);
            assertEquals(links.filter((link) => link.sessionHref).length, available.length);
            assert(links.find((link) => link.sessionId === available[1])?.sessionHref);
            assert(cpuMs < 1000, `Distinct missing Session references consumed ${Math.round(cpuMs)} ms of CPU`);
        } finally {
            await fixture.cleanup();
        }
    });
});
