import { assert, assertEquals, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { getWorkflowMetricsFilePath, recordWorkflowMetric } from "./metrics.js";
import { ExecutionMetricsRecorder } from "./execution-metrics.ts";
import { UsageReporter } from "./usage-reporting.ts";
import { setCustomSetting } from "../settings.js";
import { defineCommittedGitFixture } from "../git-test-fixture.ts";

interface FixtureRow {
    v: number;
    event: string;
    ts: string;
    [key: string]: string | number | boolean | null;
}
const period = { start: "2026-11-01", end: "2026-11-05" };
const zone = "America/New_York";
function row(event: string, ts: string, fields: Record<string, string | number | boolean | null> = {}): FixtureRow {
    return { v: 2, event, ts, eventId: `${event}:${crypto.randomUUID()}`, ...fields };
}
function usage(ts: string, fields: Record<string, string | number | boolean | null> = {}) {
    return row("model_usage", ts, {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        costAmount: 0.5,
        costCurrency: "USD",
        costSource: "calculated",
        inputCacheBasis: "excludes_cache",
        aggregationBasis: "turn",
        backend: "pi",
        provider: "test",
        model: "model",
        ...fields,
    });
}
async function journal(root: string, rows: FixtureRow[]) {
    const path = getWorkflowMetricsFilePath(root);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, rows.map((item) => JSON.stringify(item)).join("\n") + "\n");
    return path;
}
const enabled = row("collection_epoch", "2026-10-31T00:00:00Z", { v: 1, enabled: true });
const watermark = row("collection_epoch", "2026-11-06T00:00:00Z", { v: 1, enabled: true });

Deno.test("report returns exact settled totals, backend/model values and durable watermark", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        await journal(projectRoot, [
            enabled,
            usage("2026-11-01T16:00:00Z"),
            row("response_latency", "2026-11-01T16:00:00Z", { totalLatencyMs: 150 }),
            watermark,
        ]);
        const report = new UsageReporter().query([projectRoot], period, zone);
        assertEquals(report.totals.tokens, { value: 19, exclusions: 0 });
        assertEquals(report.totals.estimatedCostUsd.value, 0.5);
        assertEquals(report.totals.latencyMs.value, 150);
        assertEquals(report.projects[0].backends[0].totals.tokens.value, 19);
        assertEquals(report.projects[0].models[0].key, "test/model");
        assertEquals(report.timeZone, zone);
        assertEquals(report.recordedThrough, watermark.ts);
    });
});

Deno.test("incomplete operations stay separate with no settled spend or latency", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        await journal(projectRoot, [
            enabled,
            row("execution_started", "2026-11-01T15:00:00Z", { executionId: "open" }),
            usage("2026-11-01T16:00:00Z", { executionId: "open" }),
            row("response_latency", "2026-11-01T16:00:00Z", { executionId: "open", totalLatencyMs: 99 }),
            row("execution_finished", "2026-11-01T16:00:00Z", { executionId: "open", outcome: "interrupted" }),
            watermark,
        ]);
        const report = new UsageReporter().query([projectRoot], period, zone);
        assertEquals(report.projects[0].incomplete.length, 1);
        assertEquals(report.totals.tokens.value, 0);
        assertEquals(report.totals.estimatedCostUsd.value, 0);
        assertEquals(report.totals.latencyMs.value, 0);
        assertEquals(report.totals.tokens.exclusions, 1);
        assertEquals(report.totals.latencyMs.exclusions, 1);
        assert(report.daily[0].gaps.includes("incomplete"));
    });
});

Deno.test("only human provenance or explicit commands make days active", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        await journal(projectRoot, [
            enabled,
            row("execution_started", "2026-11-01T16:00:00Z", { dispatchKind: "background_task_result" }),
            row("execution_started", "2026-11-02T16:00:00Z", { dispatchKind: "interactive", userInitiated: true }),
            row("command_started", "2026-11-03T16:00:00Z"),
            row("execution_started", "2026-11-04T16:00:00Z", {
                dispatchKind: "validation_repair",
                userInitiated: false,
            }),
            row("execution_started", "2026-11-04T16:01:00Z", { dispatchKind: "interactive", userInitiated: false }),
            watermark,
        ]);
        const report = new UsageReporter().query([projectRoot], period, zone);
        assertEquals(report.totals.activeDays, 2);
        assertEquals(report.daily.map((day) => day.totals.activeDays), [0, 1, 1, 0]);
    });
});

Deno.test("disabled, legacy and covered zero days are distinct; missing cost is excluded", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        await journal(projectRoot, [
            enabled,
            row("collection_epoch", "2026-11-01T04:00:00Z", { v: 1, enabled: false }),
            row("collection_epoch", "2026-11-02T05:00:00Z", { v: 1, enabled: true }),
            row("tool_call", "2026-11-02T16:00:00Z", { v: 1, planName: "private" }),
            usage("2026-11-04T16:00:00Z", { costAmount: null, costSource: "unavailable" }),
            watermark,
        ]);
        const report = new UsageReporter().query([projectRoot], period, zone);
        assert(report.daily[0].gaps.includes("disabled"));
        assert(report.daily[1].gaps.includes("legacy"));
        assertEquals(report.daily[2].gaps, []);
        assertEquals(report.daily.map((day) => day.tokens), [null, null, 0, null]);
        assertEquals(report.projects[0].daily.map((day) => day.tokens), [null, null, 0, null]);
        assertEquals(report.totals.estimatedCostUsd.exclusions, 1);
        assertEquals(report.projects[0].legacy, [{
            timestamp: "2026-11-02T16:00:00Z",
            event: "tool_call",
            availability: "legacy/partial",
        }]);
        assertEquals(JSON.stringify(report).includes("private"), false);
    });
});

Deno.test("DST repeated hour and midnight respect local half-open dates", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        await journal(projectRoot, [
            enabled,
            usage("2026-11-01T05:30:00Z"),
            usage("2026-11-01T06:30:00Z"),
            usage("2026-11-02T04:59:59Z"),
            usage("2026-11-02T05:00:00Z"),
            watermark,
        ]);
        const report = new UsageReporter().query([projectRoot], period, zone);
        assertEquals(report.daily.map((day) => day.totals.tokens.value), [57, 19, 0, 0]);
        const exclusive = new UsageReporter().query([projectRoot], { start: "2026-11-01", end: "2026-11-02" }, zone);
        assertEquals(exclusive.totals.tokens.value, 57);
    });
});

Deno.test("publication, validation, repair and observed delivery remain separate", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const publication = row("publication_confirmed", "2026-11-01T16:00:00Z", {
            eventId: "publication_confirmed:a",
            operationId: "a",
            attemptId: "a",
            planId: "plan",
            planKind: "PLANNED_CHANGE",
            outcome: "succeeded",
        });
        await journal(projectRoot, [
            enabled,
            row("validation_attempt", "2026-11-01T15:00:00Z", {
                operationId: "v",
                attemptId: "a",
                planId: "plan",
                outcome: "failed",
            }),
            row("repair_round", "2026-11-01T15:30:00Z", { operationId: "r", attemptId: "a", planId: "plan" }),
            publication,
            publication,
            row("publication_confirmed", "2026-11-01T16:00:00Z", {
                attemptId: "epic",
                planId: "container",
                planKind: "PROJECT",
                outcome: "succeeded",
            }),
            row("plan_execution_result", "2026-11-02T16:00:00Z", {
                attemptId: "b",
                planId: "other",
                outcome: "interrupted",
                managedSessionId: "session",
                segmentId: "segment",
            }),
            row("workflow_abandoned", "2026-11-03T16:00:00Z", {
                attemptId: "c",
                planId: "third",
                outcome: "succeeded",
            }),
            watermark,
        ]);
        const report = new UsageReporter().query([projectRoot], period, zone);
        assertEquals(report.totals.publishedChanges, 1);
        assertEquals(report.totals.validationAttempts, 1);
        assertEquals(report.totals.repairRounds, 1);
        assertEquals(report.totals.ongoing, 1);
        assertEquals(report.totals.abandoned, 1);
        assertEquals(report.projects[0].ongoing[0].asOf, "2026-11-02T16:00:00Z");
        assertEquals(report.projects[0].ongoing[0].sessionId, "session");
    });
});

Deno.test("alternative CLI representations excluded without discarding independent request usage", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        await journal(projectRoot, [
            enabled,
            usage("2026-11-01T16:00:00Z", { recorderId: "one", sourceId: "total" }),
            usage("2026-11-01T16:00:00Z", { recorderId: "one", sourceId: "detail", aggregationBasis: "alternative" }),
            usage("2026-11-01T16:00:00Z", { recorderId: "two", sourceId: "total", aggregationBasis: "request" }),
            watermark,
        ]);
        const report = new UsageReporter().query([projectRoot], period, zone);
        assertEquals(report.totals.tokens.value, 38);
        assertEquals(report.projects[0].coverage.overlappingUsage, 1);
    });
});

Deno.test("refresh reads only appended suffix and rebuilding changes no source files", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const rows = Array.from(
            { length: 20000 },
            (_, seq) => row("tool_exposure", "2026-11-01T16:00:00Z", { seq, toolName: "code_search" }),
        );
        const path = await journal(projectRoot, [enabled, ...rows, watermark]);
        const protectedPath = join(projectRoot, "transcript.jsonl");
        await Deno.writeTextFile(protectedPath, "private transcript");
        const reporter = new UsageReporter();
        reporter.query([projectRoot], period, zone);
        const before = reporter.diagnostics;
        const suffix = JSON.stringify(usage("2026-11-02T16:00:00Z")) + "\n";
        await Deno.writeTextFile(path, suffix, { append: true });
        const report = reporter.query([projectRoot], period, zone);
        assertEquals(reporter.diagnostics.linesParsed - before.linesParsed, 1);
        assertEquals(reporter.diagnostics.bytesRead - before.bytesRead, new TextEncoder().encode(suffix).length);
        assertEquals(report.totals.tokens.value, 19);
        const bytes = await Deno.readFile(path);
        assertEquals(new UsageReporter().query([projectRoot], period, zone).totals, report.totals);
        assertEquals(await Deno.readFile(path), bytes);
        assertEquals(await Deno.readTextFile(protectedPath), "private transcript");
        reporter.query([projectRoot], period, zone);
        assertEquals(reporter.diagnostics.linesParsed - before.linesParsed, 1);
    });
});

Deno.test("torn and corrupt records are gaps; absent history is not covered zero", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const reporter = new UsageReporter();
        assertEquals(reporter.query([projectRoot], period, zone).daily[0].tokens, null);
        const path = await journal(projectRoot, [enabled, usage("2026-11-01T16:00:00Z"), watermark]);
        await Deno.writeTextFile(path, 'bad interior\n{"v":2', { append: true });
        const report = reporter.query([projectRoot], period, zone);
        assertEquals(report.totals.tokens.value, 19);
        assertEquals(report.projects[0].coverage.corruptLines, 1);
        assertEquals(report.projects[0].coverage.incompleteTail, true);
        assertEquals(report.daily[0].tokens, null);
    });
});

Deno.test("clear keeps other Projects and source artifacts, then accepts fresh observations", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const other = join(projectRoot, "other");
        await Deno.mkdir(other);
        await journal(other, [enabled, usage("2026-11-01T16:00:00Z")]);
        const otherBytes = await Deno.readFile(getWorkflowMetricsFilePath(other));
        const artifact = join(projectRoot, "plan.md");
        await Deno.writeTextFile(artifact, "Plan and Session survive");
        const metric = {
            v: 2,
            category: "command",
            event: "command_started",
            recorderId: "test",
            seq: 0,
            command: "help",
            eventId: "command_started:old",
        };
        assert((await recordWorkflowMetric(metric, projectRoot)).persisted);
        const path = getWorkflowMetricsFilePath(projectRoot);
        await Deno.writeTextFile(path, JSON.stringify(row("old", "1999-01-01T00:00:00Z", { v: 1 })) + "\n", {
            append: true,
        });
        const reporter = new UsageReporter();
        reporter.query([projectRoot], { start: "1998-01-01", end: "2000-01-01" }, zone);
        const result = await reporter.clear([projectRoot]);
        assertEquals(result[0].persisted, true);
        assertEquals(await Deno.readFile(getWorkflowMetricsFilePath(other)), otherBytes);
        assertEquals(await Deno.readTextFile(artifact), "Plan and Session survive");
        const cleared = (await Deno.readTextFile(path)).trim().split("\n").map((line) => JSON.parse(line));
        assertEquals(cleared.length, 1);
        assertEquals(cleared[0].event, "history_epoch");
        assertEquals(
            new UsageReporter().query([projectRoot], { start: "1998-01-01", end: "2000-01-01" }, zone).projects[0]
                .legacy,
            [],
        );
        assert((await recordWorkflowMetric({ ...metric, eventId: "command_started:new" }, projectRoot)).persisted);
        const newRows = (await Deno.readTextFile(path)).trim().split("\n").map((line) => JSON.parse(line));
        assertEquals(newRows.some((item) => item.eventId === metric.eventId), false);
        // Reusing an identity in the NEW epoch is new evidence, not a stale offset lookup.
        assert((await recordWorkflowMetric(metric, projectRoot)).persisted);
        assertEquals(
            new UsageReporter().query([projectRoot], { start: "2020-01-01", end: "2030-01-01" }, zone).totals
                .activeDays,
            1,
        );
    });
});

Deno.test("a real paused second process cannot settle into cleared history", async () => {
    await withWorkflowMetricsFixture(async ({ homeDir, projectRoot }) => {
        await recordWorkflowMetric({ category: "command", event: "first" }, projectRoot);
        const path = getWorkflowMetricsFilePath(projectRoot);
        const script = join(projectRoot, "paused.ts");
        await Deno.writeTextFile(
            script,
            `import { appendWorkflowMetric, resolveCollectionEpoch } from ${
                JSON.stringify(new URL("./metrics-journal.ts", import.meta.url).href)
            };
const state = resolveCollectionEpoch(Deno.args[0], true);
const invocation = { enabled:true, epoch:state.collectionEpoch.id, historyEpoch:state.historyEpoch, deadline:Date.now()+30000 };
console.log("ready"); await Deno.stdin.read(new Uint8Array(1));
console.log(JSON.stringify(await appendWorkflowMetric(Deno.args[0], Deno.args[1], {v:2,event:"model_usage", eventId:"stale"}, invocation)));`,
        );
        const child = new Deno.Command(Deno.execPath(), {
            args: [
                "run",
                "-A",
                "--config",
                new URL("../../../deno.json", import.meta.url).pathname,
                script,
                path,
                projectRoot,
            ],
            env: { HOME: homeDir },
            stdin: "piped",
            stdout: "piped",
            stderr: "piped",
        }).spawn();
        const reader = child.stdout.getReader();
        await reader.read();
        const reporter = new UsageReporter();
        assert((await reporter.clear([projectRoot]))[0].persisted);
        const writer = child.stdin.getWriter();
        await writer.write(new Uint8Array([10]));
        await writer.close();
        writer.releaseLock();
        const result = await reader.read();
        assertEquals(JSON.parse(new TextDecoder().decode(result.value)).reason, "history_boundary");
        await reader.cancel();
        reader.releaseLock();
        await child.stderr.cancel();
        assertEquals((await child.status).code, 0);
        assertEquals((await Deno.readTextFile(path)).includes("stale"), false);
    });
});

Deno.test("an execution recorder cannot restore late usage after clear", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const recorder = new ExecutionMetricsRecorder({ projectRoot, userInitiated: true });
        await recorder.recordExecutionStart();
        const reporter = new UsageReporter();
        await reporter.clear([projectRoot]);
        await recorder.recordModelUsage({
            inputTokens: 9,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 4,
        });
        await recorder.settleExecution();
        assertEquals((await Deno.readTextFile(getWorkflowMetricsFilePath(projectRoot))).includes("model_usage"), false);
    });
});

const gitFixture = defineCommittedGitFixture();
Deno.test("worktree aliases report a Project once and no unauthorized root is read", async () => {
    await withWorkflowMetricsFixture(async () => {
        const root = await gitFixture.checkout();
        const worktree = `${root}-linked`;
        try {
            const result = await new Deno.Command("git", {
                args: ["-C", root, "worktree", "add", "-b", "linked", worktree],
                stdout: "piped",
                stderr: "piped",
            }).output();
            assertEquals(result.code, 0);
            await journal(root, [enabled, usage("2026-11-01T16:00:00Z"), watermark]);
            const report = new UsageReporter().query([root, worktree], period, zone);
            assertEquals(report.projects.length, 1);
            assertEquals(report.totals.tokens.value, 19);
            assertEquals(new UsageReporter().query([], period, zone).totals.tokens.value, 0);
        } finally {
            await Deno.remove(worktree, { recursive: true }).catch(() => {});
            await Deno.remove(root, { recursive: true });
        }
    });
});

Deno.test("invalid calendar ranges and time zones fail explicitly", () => {
    const reporter = new UsageReporter();
    assertThrows(() => reporter.query([], { start: "2026-02-30", end: "2026-03-02" }, zone));
    assertThrows(() => reporter.query([], period, "not-a-timezone"));
    assertThrows(() => reporter.query([], { start: "2026-01-02", end: "2026-01-01" }, zone));
});

Deno.test("reporting and retention glossary requirements exist in owning documents", async () => {
    const prd = await Deno.readTextFile(new URL("../../../docs/prd/runwield-core-prd.md", import.meta.url));
    const glossary = await Deno.readTextFile(new URL("../../../docs/domain-language.md", import.meta.url));
    for (
        const text of [
            "usage-measurement-and-export",
            "Report collected usage",
            "Keep and clear measurement history",
            "Usage gap",
        ]
    ) assert(prd.includes(text), text);
    for (const text of ["**Active day**", "**Usage gap**"]) assert(glossary.includes(text), text);
});

Deno.test("cache observes another reporter's clear and missing classification is excluded", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        await journal(projectRoot, [
            enabled,
            usage("2026-11-01T16:00:00Z"),
            row("publication_confirmed", "2026-11-01T16:00:00Z", {
                attemptId: "unknown",
                planId: "plan",
                outcome: "succeeded",
            }),
            watermark,
        ]);
        const cached = new UsageReporter();
        assertEquals(cached.query([projectRoot], period, zone).totals.tokens.value, 19);
        assertEquals(cached.query([projectRoot], period, zone).totals.publishedChangesExclusions, 1);
        assert((await new UsageReporter().clear([projectRoot]))[0].persisted);
        assertEquals(cached.query([projectRoot], period, zone).totals.tokens.value, 0);
        assertEquals(cached.query([projectRoot], period, zone).projects[0].links, []);
    });
});

Deno.test("interrupted clear hides old rows and the next writer completes deletion", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const first = await recordWorkflowMetric({
            v: 2,
            category: "command",
            event: "command_started",
            recorderId: "test",
            seq: 0,
            command: "help",
        }, projectRoot);
        assert(first.persisted);
        const path = getWorkflowMetricsFilePath(projectRoot);
        const state = JSON.parse(await Deno.readTextFile(join(dirname(path), "state.json")));
        const marker = JSON.stringify({
            v: 1,
            event: "history_epoch",
            historyEpoch: "fresh",
            enabled: true,
            collectionEpoch: state.collectionEpoch.id,
            ts: "2026-11-01T16:00:00Z",
        }) + "\n";
        await Deno.writeTextFile(
            join(dirname(path), "clear.json"),
            JSON.stringify({
                state: {
                    v: 1,
                    historyEpoch: "fresh",
                    collectionEpoch: state.collectionEpoch,
                    journalBytes: new TextEncoder().encode(marker).length,
                    journalLines: 1,
                },
                marker,
            }),
        );
        const fenced = new UsageReporter().query([projectRoot], period, zone);
        assertEquals(fenced.projects[0].coverage.unavailable, true);
        assertEquals(fenced.projects[0].links, []);
        assert(
            (await recordWorkflowMetric({
                v: 2,
                category: "command",
                event: "command_started",
                recorderId: "test",
                seq: 1,
                command: "help",
            }, projectRoot)).persisted,
        );
        const saved = await Deno.readTextFile(path);
        assertEquals(saved.includes(first.eventId!), false);
        assert(saved.includes('"historyEpoch":"fresh"'));
        assertEquals(new UsageReporter().query([projectRoot], period, zone).projects[0].coverage.unavailable, false);
    });
});

Deno.test("disk failure stays fail-open with explicit unavailable report and failed clear", async () => {
    await withWorkflowMetricsFixture(async ({ homeDir, projectRoot }) => {
        const metricsDirectory = join(homeDir, ".wld", "workflow-metrics");
        await Deno.mkdir(join(homeDir, ".wld"), { recursive: true });
        await Deno.writeTextFile(metricsDirectory, "blocks storage");
        assertEquals(
            (await recordWorkflowMetric({ category: "command", event: "help" }, projectRoot)).persisted,
            false,
        );
        const reporter = new UsageReporter();
        assertEquals(reporter.query([projectRoot], period, zone).coverage.unavailableProjects, 1);
        assertEquals((await reporter.clear([projectRoot]))[0].persisted, false);
    });
});

Deno.test("reported zero, included-cache tokens and unknown subtotals keep their meaning", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        await journal(projectRoot, [
            enabled,
            usage("2026-11-01T16:00:00Z", { inputCacheBasis: "includes_cache", costSource: "reported", costAmount: 0 }),
            usage("2026-11-02T16:00:00Z", {
                inputCacheBasis: "unknown",
                cacheReadTokens: null,
                costAmount: null,
                costSource: "unavailable",
            }),
            watermark,
        ]);
        const report = new UsageReporter().query([projectRoot], period, zone);
        assertEquals(report.totals.tokens, { value: 24, exclusions: 1 });
        assertEquals(report.totals.reportedCostUsd, { value: 0, exclusions: 1 });
        assertEquals(report.totals.cacheReadTokens, { value: 3, exclusions: 1 });
        assertEquals(report.daily[0].tokens, 12);
        assertEquals(report.daily[1].tokens, null);
    });
});

Deno.test("ongoing is evaluated as of the requested period, not a later publication", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        await journal(projectRoot, [
            enabled,
            row("validation_attempt", "2026-11-01T16:00:00Z", {
                attemptId: "attempt",
                planId: "plan",
                operationId: "validation",
            }),
            row("publication_confirmed", "2026-11-04T16:00:00Z", {
                attemptId: "attempt",
                planId: "plan",
                planKind: "PLANNED_CHANGE",
                outcome: "succeeded",
            }),
            watermark,
        ]);
        const report = new UsageReporter().query([projectRoot], { start: "2026-11-01", end: "2026-11-03" }, zone);
        assertEquals(report.totals.ongoing, 1);
        assertEquals(report.totals.publishedChanges, 0);
    });
});

Deno.test("concurrent processes report every persisted identity once across refreshes", async () => {
    await withWorkflowMetricsFixture(async ({ homeDir, projectRoot }) => {
        const script = join(projectRoot, "concurrent.ts");
        await Deno.writeTextFile(
            script,
            `import { recordWorkflowMetric } from ${JSON.stringify(new URL("./metrics.js", import.meta.url).href)};
for (let seq=0;seq<6;seq++) console.log(JSON.stringify(await recordWorkflowMetric({v:2,category:"command",event:"command_started",recorderId:Deno.args[1],seq,command:"help"},Deno.args[0])));`,
        );
        const outputs = await Promise.all(
            ["a", "b"].map((id) =>
                new Deno.Command(Deno.execPath(), {
                    args: [
                        "run",
                        "-A",
                        "--config",
                        new URL("../../../deno.json", import.meta.url).pathname,
                        script,
                        projectRoot,
                        id,
                    ],
                    env: { HOME: homeDir },
                    stdout: "piped",
                    stderr: "piped",
                }).output()
            ),
        );
        const saved = outputs.flatMap((output) => {
            assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
            return new TextDecoder().decode(output.stdout).trim().split("\n").map((line) => JSON.parse(line)).filter((
                item,
            ) => item.persisted).map((item) => item.eventId);
        });
        assert(saved.length > 0);
        const reporter = new UsageReporter();
        const widePeriod = { start: "2020-01-01", end: "2030-01-01" };
        const ids = reporter.query([projectRoot], widePeriod, zone).projects[0].links.map((item) => item.eventId);
        assertEquals(ids.sort(), saved.sort());
        assertEquals(reporter.query([projectRoot], widePeriod, zone).projects[0].links.length, saved.length);
    });
});

Deno.test("incomplete operations crossing the period cannot contribute totals", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        await journal(projectRoot, [
            enabled,
            row("execution_started", "2026-10-31T16:00:00Z", { executionId: "crossing" }),
            usage("2026-11-01T16:00:00Z", { executionId: "crossing" }),
            row("response_latency", "2026-11-01T16:00:00Z", { executionId: "crossing", totalLatencyMs: 99 }),
            row("execution_finished", "2026-11-06T16:00:00Z", { executionId: "crossing", outcome: "interrupted" }),
            watermark,
        ]);
        const report = new UsageReporter().query([projectRoot], period, zone);
        assertEquals(report.totals.tokens.value, 0);
        assertEquals(report.totals.latencyMs.value, 0);
        assertEquals(report.projects[0].incomplete.length, 1);
    });
});

Deno.test("unavailable completion coverage is a gap even without a usage row", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const path = await journal(projectRoot, [enabled, watermark]);
        await Deno.writeTextFile(
            path,
            JSON.stringify({
                ...row("execution_finished", "2026-11-01T16:00:00Z", { outcome: "succeeded", executionId: "missing" }),
                coverage: { usage: "unavailable" },
            }) + "\n",
            { append: true },
        );
        const report = new UsageReporter().query([projectRoot], period, zone);
        assertEquals(report.totals.tokens.exclusions, 1);
        assertEquals(report.daily[0].tokens, null);
        assert(report.daily[0].gaps.includes("unavailable"));
    });
});

Deno.test("completion timestamp, not persistence delay, assigns latency to a local day", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        await journal(projectRoot, [
            enabled,
            row("response_latency", "2026-11-02T05:01:00Z", {
                completedAt: Date.parse("2026-11-02T04:59:00Z"),
                totalLatencyMs: 500,
            }),
            watermark,
        ]);
        const report = new UsageReporter().query([projectRoot], period, zone);
        assertEquals(report.daily.map((day) => day.totals.latencyMs.value), [500, 0, 0, 0]);
    });
});

Deno.test("a later generic transition never reopens a terminal delivery attempt", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        await journal(projectRoot, [
            enabled,
            row("publication_confirmed", "2026-11-01T16:00:00Z", {
                attemptId: "published",
                planId: "plan",
                planKind: "PLANNED_CHANGE",
                outcome: "succeeded",
            }),
            row("workflow_abandoned", "2026-11-01T16:00:00Z", {
                attemptId: "abandoned",
                planId: "other",
                outcome: "succeeded",
            }),
            row("workflow_transition_committed", "2026-11-02T16:00:00Z", { attemptId: "published", planId: "plan" }),
            row("workflow_transition_committed", "2026-11-02T16:00:00Z", { attemptId: "abandoned", planId: "other" }),
            watermark,
        ]);
        const report = new UsageReporter().query([projectRoot], period, zone);
        assertEquals(report.totals.ongoing, 0);
        assertEquals(report.totals.abandoned, 1);
    });
});

Deno.test("oversized corrupt tails are bounded and cannot swallow later complete records", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const path = await journal(projectRoot, [enabled]);
        await Deno.writeTextFile(path, "x".repeat(2 * 1024 * 1024), { append: true });
        const reporter = new UsageReporter();
        assertEquals(reporter.query([projectRoot], period, zone).projects[0].coverage.incompleteTail, true);
        await Deno.writeTextFile(path, "\n" + JSON.stringify(usage("2026-11-01T16:00:00Z")) + "\n", { append: true });
        const report = reporter.query([projectRoot], period, zone);
        assertEquals(report.totals.tokens.value, 19);
        assertEquals(report.projects[0].coverage.corruptLines, 1);
    });
});

Deno.test("a covered zero day begins at DST-correct local midnight", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        await journal(projectRoot, [
            row("collection_epoch", "2026-11-02T05:00:00Z", { v: 1, enabled: true }),
            watermark,
        ]);
        const report = new UsageReporter().query([projectRoot], { start: "2026-11-02", end: "2026-11-03" }, zone);
        assertEquals(report.daily[0].gaps, []);
        assertEquals(report.daily[0].tokens, 0);
    });
});

Deno.test("old measurements remain readable after recording is off and targets are removed", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const target = join(projectRoot, "session.jsonl");
        await Deno.writeTextFile(target, "private Session history\n");
        await journal(projectRoot, [usage("1999-01-01T12:00:00Z", { managedSessionId: "removed-session" })]);
        const reporter = new UsageReporter();
        const oldPeriod = { start: "1999-01-01", end: "1999-01-02" };
        assertEquals(reporter.query([projectRoot], oldPeriod, "UTC").totals.tokens.value, 19);
        await setCustomSetting("workflowMetrics", false, "project", projectRoot);
        await Deno.remove(target);
        assertEquals(new UsageReporter().query([projectRoot], oldPeriod, "UTC").totals.tokens.value, 19);
    });
});

Deno.test("older interactive starts disclose active-day exclusions at every aggregation level", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        await journal(projectRoot, [
            enabled,
            row("execution_started", "2026-11-01T16:00:00Z", {
                dispatchKind: "interactive",
            }),
            watermark,
        ]);
        const report = new UsageReporter().query([projectRoot], period, zone);
        for (
            const total of [
                report.projects[0].daily[0].totals,
                report.projects[0].totals,
                report.daily[0].totals,
                report.totals,
            ]
        ) {
            assertEquals(total.activeDays, 0);
            assertEquals(total.activeDaysExclusions, 1);
        }
    });
});

Deno.test("partial numeric token observations retain subtotals with exclusions", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        await journal(projectRoot, [
            enabled,
            usage("2026-11-01T16:00:00Z", {
                measurementAvailability: "partial",
            }),
            watermark,
        ]);
        const report = new UsageReporter().query([projectRoot], period, zone);
        for (
            const total of [
                report.totals,
                report.projects[0].totals,
                report.daily[0].totals,
                report.backends[0].totals,
                report.models[0].totals,
            ]
        ) {
            assertEquals(total.inputTokens, { value: 10, exclusions: 1 });
            assertEquals(total.outputTokens, { value: 2, exclusions: 1 });
            assertEquals(total.cacheReadTokens, { value: 3, exclusions: 1 });
            assertEquals(total.cacheWriteTokens, { value: 4, exclusions: 1 });
            assertEquals(total.tokens, { value: 19, exclusions: 1 });
        }
        assertEquals(report.daily[0].tokens, null);
    });
});

Deno.test("backend and model subtotals disclose incomplete usage and latency exclusions", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        await journal(projectRoot, [
            enabled,
            usage("2026-11-01T16:00:00Z"),
            row("response_latency", "2026-11-01T16:00:00Z", {
                backend: "pi",
                provider: "test",
                model: "model",
                totalLatencyMs: 50,
            }),
            row("execution_started", "2026-11-01T16:01:00Z", { executionId: "open" }),
            usage("2026-11-01T16:02:00Z", { executionId: "open" }),
            row("response_latency", "2026-11-01T16:02:00Z", {
                executionId: "open",
                backend: "pi",
                provider: "test",
                model: "model",
                totalLatencyMs: 99,
            }),
            watermark,
        ]);
        const report = new UsageReporter().query([projectRoot], period, zone);
        for (
            const total of [
                report.totals,
                report.projects[0].backends[0].totals,
                report.projects[0].models[0].totals,
                report.backends[0].totals,
                report.models[0].totals,
            ]
        ) {
            assertEquals(total.tokens, { value: 19, exclusions: 1 });
            assertEquals(total.inputTokens, { value: 10, exclusions: 1 });
            assertEquals(total.outputTokens, { value: 2, exclusions: 1 });
            assertEquals(total.cacheReadTokens, { value: 3, exclusions: 1 });
            assertEquals(total.cacheWriteTokens, { value: 4, exclusions: 1 });
            assertEquals(total.estimatedCostUsd, { value: 0.5, exclusions: 1 });
            assertEquals(total.reportedCostUsd, { value: 0, exclusions: 1 });
            assertEquals(total.latencyMs, { value: 50, exclusions: 1 });
        }
    });
});
