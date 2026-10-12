import { assert, assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
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
    Deno.test(`confirmed publication is counted once through ${early ? "early" : "full"} cleanup`, async () => {
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
                const before = await Deno.readTextFile(getWorkflowMetricsFilePath(metrics.projectRoot));
                assert((await cleanupStoredPublication(metrics.projectRoot, cleanup.attempt)).complete);
                assertEquals(await Deno.readTextFile(getWorkflowMetricsFilePath(metrics.projectRoot)), before);
            } finally {
                await fixture.dispose();
            }
        });
    });
}

for (const failure of ["disabled", "unwritable"]) {
    Deno.test(`publication completes with incomplete coverage when measurement is ${failure}`, async () => {
        await withWorkflowMetricsFixture(async (metrics) => {
            const fixture = await makePublicationOutcomeFixture(metrics.projectRoot);
            try {
                const attempt = await fixture.confirm();
                if (failure === "disabled") {
                    await setCustomSetting("workflowMetrics", false, "project", metrics.projectRoot);
                } else {
                    const file = getWorkflowMetricsFilePath(metrics.projectRoot);
                    await Deno.mkdir(dirname(file), { recursive: true });
                    await Deno.mkdir(file); // A directory at the file path fails on every host, including root.
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
    Deno.test(`fresh-process death ${boundary} observation preserves only observed publication`, async () => {
        await withWorkflowMetricsFixture(async (metrics) => {
            const fixture = await makePublicationOutcomeFixture(metrics.projectRoot);
            try {
                const attempt = await fixture.confirm();
                const output = await new Deno.Command(Deno.execPath(), {
                    args: [
                        "run",
                        "-A",
                        new URL("./testing/publication-outcome-process-driver.ts", import.meta.url).pathname,
                        metrics.projectRoot,
                        boundary,
                    ],
                    stdout: "piped",
                    stderr: "piped",
                }).output();
                assert(!output.success, new TextDecoder().decode(output.stderr));
                assert(await findById(metrics.projectRoot, attempt.attemptId, { migrate: false }));
                const publications = (await metrics.readMetrics()).filter((row) =>
                    row.event === "publication_confirmed"
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
                const resumed = await new Deno.Command(Deno.execPath(), {
                    args: [
                        "run",
                        "-A",
                        new URL("./testing/publication-outcome-process-driver.ts", import.meta.url).pathname,
                        metrics.projectRoot,
                        "resume",
                    ],
                    stdout: "piped",
                    stderr: "piped",
                }).output();
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

Deno.test("confirmed publication is observed even when cleanup keeps user files", async () => {
    await withWorkflowMetricsFixture(async (metrics) => {
        const fixture = await makePublicationOutcomeFixture(metrics.projectRoot);
        try {
            const attempt = await fixture.confirm();
            await Deno.writeTextFile(join(fixture.executionCwd, "feature.txt"), "user edit\n");
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

Deno.test("repeat cleanup preserves saved publication coverage after collection is disabled", async () => {
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

Deno.test("a lost journal checkpoint recovers stable publication identity without recounting", async () => {
    await withWorkflowMetricsFixture(async (metrics) => {
        const fixture = await makePublicationOutcomeFixture(metrics.projectRoot);
        try {
            const cleanup = await cleanupStoredPublication(metrics.projectRoot, await fixture.confirm());
            const file = getWorkflowMetricsFilePath(metrics.projectRoot);
            const before = await Deno.readTextFile(file);
            await Deno.remove(join(dirname(file), "state.json"));
            assert((await cleanupStoredPublication(metrics.projectRoot, cleanup.attempt)).complete);
            assertEquals(await Deno.readTextFile(file), before);
        } finally {
            await fixture.dispose();
        }
    });
});

Deno.test("restart cleanup cannot restore a publication removed by clear", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, homeDir }) => {
        const fixture = await makePublicationOutcomeFixture(projectRoot);
        try {
            const cleanup = await cleanupStoredPublication(projectRoot, await fixture.confirm());
            assert(cleanup.complete);
            const reporter = new UsageReporter();
            assert((await reporter.clear([projectRoot]))[0].persisted);
            const path = getWorkflowMetricsFilePath(projectRoot);
            const cleared = await Deno.readTextFile(path);
            const script = join(projectRoot, "restart-cleanup.ts");
            await Deno.writeTextFile(
                script,
                `import { cleanupStoredPublication } from ${
                    JSON.stringify(new URL("./publication-machine.ts", import.meta.url).href)
                };
console.log(JSON.stringify(await cleanupStoredPublication(Deno.args[0], JSON.parse(Deno.args[1]))));`,
            );
            const restarted = await new Deno.Command(Deno.execPath(), {
                args: [
                    "run",
                    "-A",
                    "--config",
                    new URL("../../../deno.json", import.meta.url).pathname,
                    script,
                    projectRoot,
                    JSON.stringify(cleanup.attempt),
                ],
                env: { HOME: homeDir },
                stdout: "piped",
                stderr: "piped",
            }).output();
            assert(restarted.success, new TextDecoder().decode(restarted.stderr));
            assertEquals(await Deno.readTextFile(path), cleared);
        } finally {
            await fixture.dispose();
        }
    });
});
