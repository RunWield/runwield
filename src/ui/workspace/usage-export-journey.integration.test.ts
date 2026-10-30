import process from "node:process";
import { test } from "node:test";
import { setSystemTime } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ok as assert } from "node:assert/strict";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { assertEquals } from "../../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { runInstallCommand } from "../../cmd/install/index.ts";
import { resolveApprovedMetricsExporters } from "../../shared/extensions/metrics-exporter.ts";
import { setCustomSetting } from "../../shared/settings.js";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import {
    readMetricsExportHostIdentity,
    grantMetricsExportDestination,
    setMetricsExportCredentials,
} from "../../shared/workflow/metrics-export-grants.ts";
import { buildMetricsExportObservation } from "../../shared/workflow/metrics-export-record.ts";
import { readMetricsExportLedger } from "../../shared/workflow/metrics-export-ledger.ts";
import { readMetricsExportStatus, runMetricsExportCycle } from "../../shared/workflow/metrics-export-scheduler.ts";
import { captureForegroundProcess } from "../../shared/captured-process.ts";
import {
    attributes,
    copyProduction,
    metadata,
    native,
    readback,
    span,
    withServer,
    type JsonRecord,
} from "../../../packages/langfuse-exporter/test-fixture.ts";
import {
    configureJourneyModel,
    journeyRows,
    PRIVATE_TEXT,
    readJourneyReport,
    runJourneyCli,
    runJourneyGuide,
} from "../../testing/usage-export-journey-fixture.ts";
import { makePublicationOutcomeFixture } from "../../shared/workflow/testing/publication-outcome-fixture.ts";
import { runJourneyPublication, runJourneyRecovery } from "../../testing/usage-export-journey-workflows.ts";
import type { OwnerUsageReport } from "./server/owner-usage.ts";

interface IdFilter {
    value: string;
}

function almost(actual: number, expected: number) {
    assert(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
}
async function onDay(day: number, run: () => Promise<void>) {
    setSystemTime(new Date(`2026-09-0${day}T16:00:00Z`));
    try {
        await run();
    } finally {
        setSystemTime();
    }
}

test("collected producer evidence agrees with the owner report and Langfuse across gaps and restart", async () => {
    await withRuntimeCommandFixture("usage-journey-", async (fixture) => {
        const { homeDir: home, projectRoot: root } = fixture;
        const previousTz = process.env.TZ;
        const previousPrompt = globalThis.prompt;
        process.chdir(root);
        const publication = await makePublicationOutcomeFixture(root);
        const runtime = createSessionRuntime();
        const model = await configureJourneyModel();
        const received = new Map<string, JsonRecord>();
        let loseNext = false;
        let lostSpanId = "";
        async function pi() {
            model.respond(fauxAssistantMessage(PRIVATE_TEXT));
            const created = await runtime.createInteractiveSession({
                cwd: root,
                mode: "new",
                deferManagedActivationUntilAgentReady: true,
            });
            runtime.markPromptReadyAgent(created.sessionId, { agentName: "router" });
            const result = await runtime.promptUserTurn(created.sessionId, { initialRequest: PRIVATE_TEXT });
            assertEquals(result.ok, true);
            await runtime.closeSessionWhenIdle(created.sessionId);
        }
        process.env.TZ = "America/New_York";
        try {
            await withServer(
                async ({ context, requests }) => {
                    const source = join(home, "langfuse-package");
                    await copyProduction(source);
                    globalThis.prompt = () => "yes";
                    await runInstallCommand([source]);
                    assertEquals(process.exitCode, 0);
                    const [exporter] = await resolveApprovedMetricsExporters();
                    assert(exporter);
                    // This run is local history only. The grant must not upload it.
                    await onDay(1, async () => {
                        await setCustomSetting("workflowMetrics", true, "project", root);
                        await pi();
                    });
                    const beforeGrant = new Set((await journeyRows(root)).map((row) => row.eventId));
                    const grant = await grantMetricsExportDestination({
                        destinationId: "journey",
                        exporterId: "langfuse",
                        exporterSource: exporter.source,
                        endpoint: context.endpoint,
                        externalProject: context.externalProject,
                        allowInsecureLocalEndpoint: true,
                        projectRoots: [root],
                    });
                    assert(grant.projects[0].offset > 0);
                    await setMetricsExportCredentials("journey", context.credentials);
                    await onDay(1, async () => {
                        await pi();
                        await runJourneyCli(home, root, "claude-cli");
                        await runJourneyCli(home, root, "agy-cli");
                        await runJourneyGuide(root);
                        await runJourneyPublication(root, publication, model.respond);
                        await runJourneyRecovery(home, root, runtime, model.interruptNext);
                    });
                    await runMetricsExportCycle({ deadlineMs: 5000 });
                    assert(requests.filter((w) => w.method === "POST").length > 0);
                    const beforeDisabled = await journeyRows(root);
                    const postsBeforeDisabled = requests.filter((w) => w.method === "POST").length;
                    await onDay(2, async () => {
                        await setCustomSetting("workflowMetrics", false, "project", root);
                        await pi();
                    });
                    assertEquals(
                        (await journeyRows(root)).filter((row) => row.v === 2).length,
                        beforeDisabled.filter((row) => row.v === 2).length,
                    );
                    await runMetricsExportCycle({ deadlineMs: 5000 });
                    assertEquals(requests.filter((w) => w.method === "POST").length, postsBeforeDisabled);
                    await onDay(3, async () => {
                        await setCustomSetting("workflowMetrics", true, "project", root);
                        await pi();
                    });
                    loseNext = true;
                    await runMetricsExportCycle({ deadlineMs: 5000 });
                    assert(lostSpanId);
                    assertEquals((await readMetricsExportStatus())[0].counts.unconfirmed, 1);
                    const posted = requests.filter((w) => w.method === "POST").map((w) => span(w).spanId);
                    const beforeRestart = await readJourneyReport(home, root);
                    await runMetricsExportCycle({ deadlineMs: 5000 });
                    assertEquals(
                        requests.filter((w) => w.method === "POST").map((w) => span(w).spanId),
                        posted,
                    );
                    await runtime.closeAllSessionsWhenIdle();
                    const driver = join(home, "restart-journey.ts");
                    await writeFile(
                        driver,
                        `import {readJourneyReport} from ${JSON.stringify(new URL("../../testing/usage-export-journey-fixture.ts", import.meta.url).href)};
import {runMetricsExportCycle} from ${JSON.stringify(new URL("../../shared/workflow/metrics-export-scheduler.ts", import.meta.url).href)};
await runMetricsExportCycle({deadlineMs:5000});
console.log("JOURNEY_RESULT:"+JSON.stringify(await readJourneyReport(${JSON.stringify(home)},${JSON.stringify(root)})));`,
                    );
                    const child = await captureForegroundProcess(process.execPath, {
                        args: ["run", "--no-install", driver],
                        cwd: root,
                        env: { HOME: home, WLD_TEST_SANDBOX_HOME: home, TZ: "America/New_York" },
                    });
                    assertEquals(child.code, 0, new TextDecoder().decode(child.stderr));
                    const line = new TextDecoder()
                        .decode(child.stdout)
                        .split("\n")
                        .find((line) => line.startsWith("JOURNEY_RESULT:"));
                    assert(line);
                    const restarted: OwnerUsageReport = JSON.parse(line.slice("JOURNEY_RESULT:".length));
                    for (const key of ["totals", "daily", "backends", "models"] as const)
                        assertEquals(restarted[key], beforeRestart[key]);
                    assertEquals(
                        requests.filter((w) => w.method === "POST").map((w) => span(w).spanId),
                        posted,
                    );
                    assertEquals((await readMetricsExportStatus())[0].counts.unconfirmed, 1);
                    await onDay(3, pi);
                    await runMetricsExportCycle({ deadlineMs: 5000 });
                    const report = await readJourneyReport(home, root);
                    const rows = await journeyRows(root);
                    const spans = requests.filter((w) => w.method === "POST").map(span);
                    const usages = spans.filter((s) => metadata(s).kind === "model_usage");
                    assertEquals(report.timeZone, "America/New_York");
                    // Fixed inputs: seven Pi turns (pre-grant, normal, two repair calls, interrupted, lost, later),
                    // 16 tokens each; Claude's pinned 11871,
                    // agy's pinned 36195, and two guide frames (15 each).
                    assertEquals(report.totals.tokens.value, 7 * 16 + 11871 + 36195 + 30);
                    assertEquals(
                        {
                            published: report.totals.publishedChanges,
                            validations: report.totals.validationAttempts,
                            repairs: report.totals.repairRounds,
                            ongoing: report.totals.ongoing,
                            abandoned: report.totals.abandoned,
                        },
                        { published: 1, validations: 2, repairs: 1, ongoing: 1, abandoned: 1 },
                    );
                    assertEquals(report.totals.activeDays, 2);
                    assertEquals(
                        rows.filter((row) => row.event === "validation_attempt").map((row) => row.outcome),
                        ["failed", "succeeded"],
                    );
                    const repair = rows.filter((row) => row.event === "repair_round");
                    const repaired = rows.filter((row) => row.event === "repair_round_finished");
                    assertEquals(repair.length, 1);
                    assertEquals(repaired.length, 1);
                    assertEquals(repaired[0].roundId, repair[0].roundId);
                    assertEquals(
                        report.projects[0].ongoing.map((link) => link.planId),
                        ["plan-ongoing"],
                    );
                    const discussion = rows.find(
                        (row) => row.event === "execution_started" && row.userInitiated === true,
                    )!;
                    assert(discussion);
                    assertEquals(discussion.planId, undefined);
                    const discussionLink = report.projects[0].links.find(
                        (link) => link.eventId === discussion.eventId,
                    )!;
                    assert(discussionLink);
                    assertEquals(discussionLink.planId, undefined);
                    assertEquals(discussionLink.planHref, undefined);
                    assert(discussionLink.sessionHref);
                    assertEquals(
                        spans.reduce<Record<string, number>>((counts, s) => {
                            const kind = String(metadata(s).kind);
                            counts[kind] = (counts[kind] || 0) + 1;
                            return counts;
                        }, {}),
                        {
                            model_usage: 9,
                            execution_finished: 8, // Includes the external guide's auxiliary execution.
                            tool_call_finished: 3,
                            validation_attempt: 2,
                            repair_round_finished: 1,
                            publication_confirmed: 1,
                            workflow_abandoned: 1,
                        },
                    );
                    assertEquals(
                        report.backends.map((b) => [b.key, b.totals.tokens.value]).sort(),
                        [
                            ["agy-cli", 36195],
                            ["claude-cli", 11871],
                            ["pi", 142],
                        ].sort(),
                    );
                    // agy lacks cache-write coverage; the guide does not state its input/cache basis.
                    assertEquals(report.totals.tokens.exclusions, 2);
                    almost(report.totals.reportedCostUsd.value, 1 + 0.0594932);
                    assertEquals(report.totals.reportedCostUsd.exclusions, 1);
                    const agyCost = (19529 * 0.75 + 155 * 3.75 + 16511 * 0.075) / 1_000_000;
                    almost(report.totals.estimatedCostUsd.value, 7 * 0.125 + agyCost);
                    assertEquals(report.totals.estimatedCostUsd.exclusions, 0);
                    const gap = report.daily.find((day) => day.date === "2026-09-02")!;
                    assertEquals(gap.tokens, null);
                    assert(gap.gaps.includes("disabled"));
                    assertEquals(usages.length, 9);
                    assertEquals(
                        usages.reduce((sum, s) => {
                            const m = metadata(s);
                            return (
                                sum +
                                Number(m.inputTokens || 0) +
                                Number(m.outputTokens || 0) +
                                Number(m.cacheReadTokens || 0) +
                                Number(m.cacheWriteTokens || 0)
                            );
                        }, 0),
                        48192,
                    );
                    const guide = usages.find((s) => metadata(s).provider === "journey-guide")!;
                    assert(guide);
                    assertEquals(metadata(guide).costAvailability, "partial");
                    assertEquals(metadata(guide).costAmount, 1);
                    assertEquals(metadata(guide).cost_complete, false);
                    assertEquals(metadata(guide).inputTokens, 24);
                    assertEquals(metadata(guide).outputTokens, 6);
                    assertEquals(metadata(guide).native_usage_available, false);
                    assertEquals(native(guide, "usage_details"), undefined);
                    assertEquals(native(guide, "cost_details"), undefined);
                    assertEquals(attributes(guide)["langfuse.observation.model.name"], undefined);
                    const agy = usages.find((s) => metadata(s).backend === "agy-cli")!;
                    almost(native(agy, "cost_details")!.total, agyCost);
                    assertEquals(metadata(agy).measurementAvailability, "partial");
                    assertEquals(metadata(agy).costAvailability, "complete");
                    assertEquals(metadata(agy).missing_input_cache_creation, true);
                    assertEquals(native(agy, "usage_details")!.input_cache_creation, undefined);
                    assertEquals(report.totals.cacheWriteTokens.exclusions, 1);
                    assertEquals(
                        usages.reduce(
                            (sum, s) =>
                                sum + Object.values(native(s, "usage_details") || {}).reduce((a, b) => a + b, 0),
                            0,
                        ),
                        6 * 16 + 11871 + 36195,
                    );
                    almost(
                        usages.reduce((sum, s) => sum + (native(s, "cost_details")?.total || 0), 0),
                        6 * 0.125 + 0.0594932 + agyCost,
                    );
                    const ledger = [...readMetricsExportLedger("journey").values()];
                    assertEquals(
                        ledger.some((item) => beforeGrant.has(item.eventId)),
                        false,
                    );
                    const identity = await readMetricsExportHostIdentity();
                    const eligible = rows.filter(
                        (row) =>
                            row.v === 2 &&
                            !beforeGrant.has(row.eventId) &&
                            row.aggregationBasis !== "alternative" &&
                            [
                                "model_usage",
                                "execution_finished",
                                "tool_call_finished",
                                "validation_attempt",
                                "repair_round_finished",
                                "publication_confirmed",
                                "workflow_abandoned",
                            ].includes(row.event),
                    );
                    assertEquals(ledger.map((item) => item.eventId).sort(), eligible.map((row) => row.eventId).sort());
                    const expectedIds = await Promise.all(
                        eligible.map(
                            async (row) => (await buildMetricsExportObservation(row, root, identity))!.observationId,
                        ),
                    );
                    assertEquals(spans.map((s) => metadata(s).observationId).sort(), expectedIds.sort());
                    assertEquals(new Set(spans.map((s) => s.spanId)).size, spans.length);
                    assertEquals(spans.filter((s) => s.spanId === lostSpanId).length, 1);
                    assertEquals((await readMetricsExportStatus())[0].counts, {
                        pending: 0,
                        accepted: 0,
                        confirmed: 24,
                        unconfirmed: 1,
                        rejected: 0,
                    });
                    const lost = spans.find((s) => s.spanId === lostSpanId)!;
                    assertEquals(metadata(lost).backend, "pi");
                    almost(native(lost, "cost_details")!.total, 0.125);
                    for (const text of [JSON.stringify(report), JSON.stringify(rows), ...requests.map((w) => w.body)]) {
                        for (const forbidden of [
                            PRIVATE_TEXT,
                            root,
                            home,
                            "fixture-key",
                            context.credentials.publicKey,
                            context.credentials.secretKey,
                            "journey-guide-token",
                            "README.md",
                            "/fixture/readme.txt",
                            "readme.txt",
                            publication.executionCwd,
                            "Checking file.",
                            "export const b = 2",
                            "mint",
                        ])
                            assertEquals(text.includes(forbidden), false, forbidden);
                    }
                },
                (wire) => {
                    if (wire.method === "POST") {
                        const s = span(wire);
                        received.set(s.spanId, readback(s));
                        if (loseNext && metadata(s).kind === "model_usage") {
                            loseNext = false;
                            lostSpanId = s.spanId;
                            return new Response(
                                new ReadableStream({
                                    start(controller) {
                                        controller.enqueue(new TextEncoder().encode('{"accepted":'));
                                        setTimeout(() => controller.error(new Error("lost response")), 20);
                                    },
                                }),
                            );
                        }
                        return Response.json({});
                    }
                    const filters: IdFilter[] = JSON.parse(wire.url.searchParams.get("filter")!);
                    const row = received.get(filters[0].value);
                    return Response.json({ data: row && filters[0].value !== lostSpanId ? [row] : [], meta: {} });
                },
            );
        } finally {
            setSystemTime();
            globalThis.prompt = previousPrompt;
            if (previousTz === undefined) delete process.env.TZ;
            else process.env.TZ = previousTz;
            try {
                await runtime.closeAllSessionsWhenIdle();
            } finally {
                await publication.dispose();
                model.dispose();
            }
        }
    });
});
