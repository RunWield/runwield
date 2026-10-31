import lockfile from "proper-lockfile";
import type { PublicationAttempt } from "./publication-attempt.ts";
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
import { readControllerRecord, writeControllerState } from "./controller-registry.ts";
import { getWorkflowMetricsFilePath } from "./metrics.js";
import { UsageReporter } from "./usage-reporting.ts";
import { workflowOutcomeEventId } from "./outcome-observations.ts";
import {
    type PublicationCleanupResult,
    advanceStoredPublication,
    cleanupStoredPublication,
} from "./publication-machine.ts";
import { makePublicationOutcomeFixture } from "./testing/publication-outcome-fixture.ts";

interface CleanupProcessResult {
    complete: boolean;
    attempt: PublicationAttempt;
    elapsedMs: number;
    metadataReads: number;
    injectedFaults: number;
    coverageFaults: number;
    afterCoverageFaultMs: number | null;
}

function runCleanupProcess(projectRoot: string, attempt: PublicationAttempt, boundary = "resume") {
    return captureForegroundProcess(process.execPath, {
        args: runtimeSourceArgs([
            "run",
            "-A",
            new URL("./testing/publication-outcome-process-driver.ts", import.meta.url).pathname,
            projectRoot,
            boundary,
            JSON.stringify(attempt),
        ]),
        cwd: getCwd(),
    });
}

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
                assertEquals(await findById(metrics.projectRoot, attempt.attemptId), null);
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

for (const early of [false, true]) {
    for (const failure of ["disabled", "unwritable"]) {
        test(`publication completes with incomplete coverage when measurement is ${failure} through ${early ? "early" : "full"} cleanup`, async () => {
            await withWorkflowMetricsFixture(async (metrics) => {
                const fixture = await makePublicationOutcomeFixture(metrics.projectRoot);
                try {
                    let attempt = await fixture.confirm();
                    if (early) {
                        attempt = await advanceStoredPublication(metrics.projectRoot, attempt, "cleanup_complete", {
                            cleanedAt: new Date().toISOString(),
                        });
                    }
                    if (failure === "disabled") {
                        await setCustomSetting("workflowMetrics", false, "project", metrics.projectRoot);
                    } else {
                        const file = getWorkflowMetricsFilePath(metrics.projectRoot);
                        await fsMkdir(dirname(file), { recursive: true });
                        await fsMkdir(file); // A directory at the file path fails on every host, including root.
                    }
                    const cleanup = await cleanupStoredPublication(metrics.projectRoot, attempt);
                    assert(cleanup.complete);
                    assertEquals(await findById(metrics.projectRoot, attempt.attemptId), null);
                    const record = await readControllerRecord(metrics.projectRoot, {
                        planId: "plan-demo",
                        planName: "demo",
                    });
                    assertEquals(record?.state.publicationObservation?.coverage, "incomplete");
                    assertEquals(record?.state.verifiedAt, attempt.verifiedAt);
                    assertEquals(
                        record?.state.publicationObservation?.reason,
                        failure === "disabled" ? "disabled" : "storage_failure",
                    );
                    if (failure === "disabled") {
                        assertEquals((await metrics.readMetrics()).length, 0);
                        await setCustomSetting("workflowMetrics", true, "project", metrics.projectRoot);
                    } else {
                        await fsRm(getWorkflowMetricsFilePath(metrics.projectRoot), { recursive: true });
                    }
                    assert((await runCleanupProcess(metrics.projectRoot, cleanup.attempt)).success);
                    assertEquals(
                        (await metrics.readMetrics()).filter((row) => row.event === "publication_confirmed").length,
                        0,
                    );
                } finally {
                    await fixture.dispose();
                }
            });
        });
    }
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
                assert(await findById(metrics.projectRoot, attempt.attemptId));
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
                    boundary === "after" ? "complete" : "incomplete",
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
                    boundary === "after" ? 1 : 0,
                );
                assertEquals(await findById(metrics.projectRoot, attempt.attemptId), null);
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

test("a lost journal checkpoint cannot replay retained publication", async () => {
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

for (const early of [false, true]) {
    for (const fault of ["slow", "throw"]) {
        test(`redundant ${fault} metadata cannot lose remote publication through ${early ? "early" : "full"} cleanup`, async () => {
            await withWorkflowMetricsFixture(async (metrics) => {
                const fixture = await makePublicationOutcomeFixture(metrics.projectRoot, true);
                try {
                    let attempt = await fixture.confirm();
                    if (early) {
                        attempt = await advanceStoredPublication(metrics.projectRoot, attempt, "cleanup_complete", {
                            cleanedAt: new Date().toISOString(),
                        });
                    }
                    const output = await runCleanupProcess(
                        metrics.projectRoot,
                        attempt,
                        `metadata-${fault}-${early ? "early" : "full"}`,
                    );
                    assert(output.success, new TextDecoder().decode(output.stderr));
                    const result: CleanupProcessResult = JSON.parse(
                        new TextDecoder().decode(output.stdout).trim().split("\n").at(-1)!,
                    );
                    assert(result.complete);
                    const publications = (await metrics.readMetrics()).filter(
                        (row) => row.event === "publication_confirmed",
                    );
                    assertEquals(publications.length, 1);
                    assertEquals(publications[0].planKind, "PLANNED_CHANGE");
                    assertEquals(result.metadataReads, early ? 0 : 1);
                    assertEquals(
                        result.injectedFaults,
                        0,
                        "already verified metadata must not be read again for recording",
                    );
                    assert(
                        result.elapsedMs < 5000,
                        `cleanup exceeded the existing observation budget: ${result.elapsedMs}ms`,
                    );
                    const record = await readControllerRecord(metrics.projectRoot, {
                        planId: "plan-demo",
                        planName: "demo",
                    });
                    assertEquals(record?.state.publicationObservation?.coverage, "complete");
                    const before = await fsReadFile(getWorkflowMetricsFilePath(metrics.projectRoot), "utf8");
                    assert((await runCleanupProcess(metrics.projectRoot, result.attempt)).success);
                    assertEquals(await fsReadFile(getWorkflowMetricsFilePath(metrics.projectRoot), "utf8"), before);
                } finally {
                    await fixture.dispose();
                }
            });
        });
    }

    test(`journal contention is bounded and is not replayed through ${early ? "early" : "full"} cleanup`, async () => {
        await withWorkflowMetricsFixture(async (metrics) => {
            const fixture = await makePublicationOutcomeFixture(metrics.projectRoot);
            try {
                let attempt = await fixture.confirm();
                if (early) {
                    attempt = await advanceStoredPublication(metrics.projectRoot, attempt, "cleanup_complete", {
                        cleanedAt: new Date().toISOString(),
                    });
                }
                const directory = dirname(getWorkflowMetricsFilePath(metrics.projectRoot));
                await fsMkdir(directory, { recursive: true });
                const release = lockfile.lockSync(join(directory, ".journal.lock"), { realpath: false });
                const started = Date.now();
                let cleanup: PublicationCleanupResult;
                try {
                    cleanup = await cleanupStoredPublication(metrics.projectRoot, attempt);
                } finally {
                    release();
                }
                assert(cleanup.complete);
                assert(Date.now() - started < 5000, "measurement lock must not hold delivery open");
                const record = await readControllerRecord(metrics.projectRoot, {
                    planId: "plan-demo",
                    planName: "demo",
                });
                assertEquals(record?.state.publicationObservation?.coverage, "incomplete");
                assertEquals(record?.state.publicationObservation?.reason, "lock_timeout");
                assertEquals(
                    (await metrics.readMetrics()).filter((row) => row.event === "publication_confirmed").length,
                    0,
                );
                assert((await runCleanupProcess(metrics.projectRoot, cleanup.attempt)).success);
                assertEquals(
                    (await metrics.readMetrics()).filter((row) => row.event === "publication_confirmed").length,
                    0,
                );
                assertEquals(await findById(metrics.projectRoot, attempt.attemptId), null);
            } finally {
                await fixture.dispose();
            }
        });
    });
}

for (const early of [false, true]) {
    for (const fault of ["slow", "throw"]) {
        test(`coverage ${fault} stays nonfatal and incomplete through ${early ? "early" : "full"} cleanup`, async () => {
            await withWorkflowMetricsFixture(async (metrics) => {
                const fixture = await makePublicationOutcomeFixture(metrics.projectRoot);
                try {
                    let attempt = await fixture.confirm();
                    if (early) {
                        attempt = await advanceStoredPublication(metrics.projectRoot, attempt, "cleanup_complete", {
                            cleanedAt: new Date().toISOString(),
                        });
                    }
                    const output = await runCleanupProcess(metrics.projectRoot, attempt, `coverage-${fault}`);
                    assert(output.success, new TextDecoder().decode(output.stderr));
                    const result: CleanupProcessResult = JSON.parse(
                        new TextDecoder().decode(output.stdout).trim().split("\n").at(-1)!,
                    );
                    assert(result.complete);
                    assertEquals(result.coverageFaults, 1);
                    assert(
                        result.afterCoverageFaultMs !== null && result.afterCoverageFaultMs < 5300,
                        `coverage must not hold delivery beyond the existing budget: ${result.afterCoverageFaultMs}ms`,
                    );
                    const record = await readControllerRecord(metrics.projectRoot, {
                        planId: "plan-demo",
                        planName: "demo",
                    });
                    assertEquals(record?.state.publicationObservation?.coverage, "incomplete");
                    assertEquals(record?.state.publicationObservation?.reason, "recording_unconfirmed");
                    assertEquals(
                        (await metrics.readMetrics()).filter((row) => row.event === "publication_confirmed").length,
                        1,
                    );
                    const before = await fsReadFile(getWorkflowMetricsFilePath(metrics.projectRoot), "utf8");
                    assert((await runCleanupProcess(metrics.projectRoot, result.attempt)).success);
                    assertEquals(await fsReadFile(getWorkflowMetricsFilePath(metrics.projectRoot), "utf8"), before);
                    assertEquals(await findById(metrics.projectRoot, attempt.attemptId), null);
                } finally {
                    await fixture.dispose();
                }
            });
        });
    }
}

test("legacy unverified coverage is incomplete after restart without backfilling publication", async () => {
    await withWorkflowMetricsFixture(async (metrics) => {
        const fixture = await makePublicationOutcomeFixture(metrics.projectRoot);
        try {
            const attempt = await fixture.confirm();
            await writeControllerState(
                metrics.projectRoot,
                { planId: attempt.planId, planName: attempt.planName },
                {
                    publicationObservation: {
                        attemptId: attempt.attemptId,
                        eventId: workflowOutcomeEventId("publication_confirmed", attempt.attemptId),
                        coverage: "unverified",
                    },
                },
            );
            const output = await runCleanupProcess(metrics.projectRoot, attempt);
            assert(output.success, new TextDecoder().decode(output.stderr));
            assertEquals(
                (await metrics.readMetrics()).filter((row) => row.event === "publication_confirmed").length,
                0,
            );
            const record = await readControllerRecord(metrics.projectRoot, {
                planId: attempt.planId,
                planName: attempt.planName,
            });
            assertEquals(record?.state.publicationObservation?.coverage, "incomplete");
            assertEquals(record?.state.publicationObservation?.reason, "recording_unconfirmed");
            assertEquals(await findById(metrics.projectRoot, attempt.attemptId), null);
        } finally {
            await fixture.dispose();
        }
    });
});
