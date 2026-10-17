import { getCwd } from "../../constants.js";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import { test } from "node:test";
import { readFile as fsReadFile, mkdir as fsMkdir, writeFile as fsWriteFile, rm as fsRm } from "node:fs/promises";
import process from "node:process";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import { dirname, join } from "node:path";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { setCustomSetting } from "../settings.js";
import { findById } from "../worktree-registry.js";
import { readControllerRecord } from "./controller-registry.ts";
import { getWorkflowMetricsFilePath } from "./metrics.js";
import { UsageReporter } from "./usage-reporting.ts";
import { workflowOutcomeEventId } from "./outcome-observations.ts";
import { advanceStoredPublication, cleanupStoredPublication } from "./publication-machine.ts";
import { makePublicationOutcomeFixture } from "./testing/publication-outcome-fixture.ts";

for (const early of [false, true]) {
    test(`confirmed publication is counted once through ${early ? "early" : "full"} cleanup`, async () => {
        await withWorkflowMetricsFixture(async (metrics) => {
            const fixture = await makePublicationOutcomeFixture(metrics.projectRoot);
            try {
                let attempt = await fixture.confirm();
                if (early) {
                    attempt = await advanceStoredPublication(metrics.projectRoot, attempt, "cleanup_complete", {
                        cleanedAt: new Date().toISOString(),
                    });
                }
                const cleanup = await cleanupStoredPublication(metrics.projectRoot, attempt);
                assert(cleanup.complete);
                assertEquals(await findById(metrics.projectRoot, attempt.attemptId, { migrate: false }), null);
                const rows = await metrics.readMetrics();
                const publications = rows.filter((row) => row.event === "publication_confirmed");
                assertEquals(publications.length, 1);
                assertEquals(publications[0].v, 2);
                assertEquals(
                    publications[0].eventId,
                    workflowOutcomeEventId("publication_confirmed", attempt.attemptId),
                );
                assertEquals(publications[0].planId, "plan-demo");
                const before = await fsReadFile(getWorkflowMetricsFilePath(metrics.projectRoot), "utf8");
                assert((await cleanupStoredPublication(metrics.projectRoot, cleanup.attempt)).complete);
                assertEquals(await fsReadFile(getWorkflowMetricsFilePath(metrics.projectRoot), "utf8"), before);
            } finally {
                await fixture.dispose();
            }
        });
    });
}

for (const failure of ["disabled", "unwritable"]) {
    test(`publication completes with incomplete coverage when measurement is ${failure}`, async () => {
        await withWorkflowMetricsFixture(async (metrics) => {
            const fixture = await makePublicationOutcomeFixture(metrics.projectRoot);
            try {
                const attempt = await fixture.confirm();
                if (failure === "disabled") {
                    await setCustomSetting("workflowMetrics", false, "project", metrics.projectRoot);
                } else {
                    const file = getWorkflowMetricsFilePath(metrics.projectRoot);
                    await fsMkdir(dirname(file), { recursive: true });
                    await fsMkdir(file); // A directory at the file path fails on every host, including root.
                }
                assert((await cleanupStoredPublication(metrics.projectRoot, attempt)).complete);
                assertEquals(await findById(metrics.projectRoot, attempt.attemptId, { migrate: false }), null);
                const record = await readControllerRecord(metrics.projectRoot, {
                    planId: "plan-demo",
                    planName: "demo",
                });
                assertEquals(record?.state.publicationObservation?.coverage, "incomplete");
                assertEquals(record?.state.verifiedAt, attempt.verifiedAt);
            } finally {
                await fixture.dispose();
            }
        });
    });
}

for (const boundary of ["before", "after"]) {
    test(`fresh-process death ${boundary} observation preserves only observed publication`, async () => {
        await withWorkflowMetricsFixture(async (metrics) => {
            const fixture = await makePublicationOutcomeFixture(metrics.projectRoot);
            try {
                const attempt = await fixture.confirm();
                const output = await captureForegroundProcess(process.execPath, {
                    args: runtimeSourceArgs([
                        "run",
                        "-A",
                        new URL("./testing/publication-outcome-process-driver.ts", import.meta.url).pathname,
                        metrics.projectRoot,
                        boundary,
                    ]),
                    cwd: getCwd(),
                });
                assert(!output.success, new TextDecoder().decode(output.stderr));
                assert(await findById(metrics.projectRoot, attempt.attemptId, { migrate: false }));
                const publications = (await metrics.readMetrics()).filter(
                    (row) => row.event === "publication_confirmed",
                );
                assertEquals(publications.length, boundary === "after" ? 1 : 0);
                const record = await readControllerRecord(metrics.projectRoot, {
                    planId: "plan-demo",
                    planName: "demo",
                });
                assertEquals(
                    record?.state.publicationObservation?.coverage,
                    boundary === "after" ? "complete" : "unverified",
                );
                const resumed = await captureForegroundProcess(process.execPath, {
                    args: runtimeSourceArgs([
                        "run",
                        "-A",
                        new URL("./testing/publication-outcome-process-driver.ts", import.meta.url).pathname,
                        metrics.projectRoot,
                        "resume",
                    ]),
                    cwd: getCwd(),
                });
                assert(resumed.success, new TextDecoder().decode(resumed.stderr));
                assertEquals(
                    (await metrics.readMetrics()).filter((row) => row.event === "publication_confirmed").length,
                    1,
                );
                assertEquals(await findById(metrics.projectRoot, attempt.attemptId, { migrate: false }), null);
            } finally {
                await fixture.dispose();
            }
        });
    });
}

test("confirmed publication is observed even when cleanup keeps user files", async () => {
    await withWorkflowMetricsFixture(async (metrics) => {
        const fixture = await makePublicationOutcomeFixture(metrics.projectRoot);
        try {
            const attempt = await fixture.confirm();
            await fsWriteFile(join(fixture.executionCwd, "feature.txt"), "user edit\n");
            const result = await cleanupStoredPublication(metrics.projectRoot, attempt);
            assertEquals(result.complete, false);
            assertEquals(result.worktreeKept, true);
            assertEquals(
                (await metrics.readMetrics()).filter((row) => row.event === "publication_confirmed").length,
                1,
            );
        } finally {
            await fixture.dispose();
        }
    });
});

test("repeat cleanup preserves saved publication coverage after collection is disabled", async () => {
    await withWorkflowMetricsFixture(async (metrics) => {
        const fixture = await makePublicationOutcomeFixture(metrics.projectRoot);
        try {
            const attempt = await fixture.confirm();
            const cleanup = await cleanupStoredPublication(metrics.projectRoot, attempt);
            assert(cleanup.complete);
            await setCustomSetting("workflowMetrics", false, "project", metrics.projectRoot);
            assert((await cleanupStoredPublication(metrics.projectRoot, cleanup.attempt)).complete);
            const record = await readControllerRecord(metrics.projectRoot, { planId: "plan-demo", planName: "demo" });
            assertEquals(record?.state.publicationObservation?.coverage, "complete");
            assertEquals(
                (await metrics.readMetrics()).filter((row) => row.event === "publication_confirmed").length,
                1,
            );
        } finally {
            await fixture.dispose();
        }
    });
});

test("a lost journal checkpoint recovers stable publication identity without recounting", async () => {
    await withWorkflowMetricsFixture(async (metrics) => {
        const fixture = await makePublicationOutcomeFixture(metrics.projectRoot);
        try {
            const cleanup = await cleanupStoredPublication(metrics.projectRoot, await fixture.confirm());
            const file = getWorkflowMetricsFilePath(metrics.projectRoot);
            const before = await fsReadFile(file, "utf8");
            await fsRm(join(dirname(file), "state.json"));
            assert((await cleanupStoredPublication(metrics.projectRoot, cleanup.attempt)).complete);
            assertEquals(await fsReadFile(file, "utf8"), before);
        } finally {
            await fixture.dispose();
        }
    });
});

test("restart cleanup cannot restore a publication removed by clear", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, homeDir }) => {
        const fixture = await makePublicationOutcomeFixture(projectRoot);
        try {
            const cleanup = await cleanupStoredPublication(projectRoot, await fixture.confirm());
            assert(cleanup.complete);
            const reporter = new UsageReporter();
            assert((await reporter.clear([projectRoot]))[0].persisted);
            const path = getWorkflowMetricsFilePath(projectRoot);
            const cleared = await fsReadFile(path, "utf8");
            const script = join(projectRoot, "restart-cleanup.ts");
            await fsWriteFile(
                script,
                `import { cleanupStoredPublication } from ${JSON.stringify(
                    new URL("./publication-machine.ts", import.meta.url).href,
                )};
console.log(JSON.stringify(await cleanupStoredPublication((await import("node:process")).argv.slice(2)[0], JSON.parse((await import("node:process")).argv.slice(2)[1]))));`,
            );
            const restarted = await captureForegroundProcess(process.execPath, {
                args: runtimeSourceArgs([
                    "run",
                    "-A",
                    "--config",
                    new URL("../../../deno.json", import.meta.url).pathname,
                    script,
                    projectRoot,
                    JSON.stringify(cleanup.attempt),
                ]),
                env: { HOME: homeDir },
                cwd: getCwd(),
            });
            assert(restarted.success, new TextDecoder().decode(restarted.stderr));
            assertEquals(await fsReadFile(path, "utf8"), cleared);
        } finally {
            await fixture.dispose();
        }
    });
});
