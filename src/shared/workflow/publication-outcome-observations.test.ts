import { inspectPlanFixtureController, seedPlanController } from "../testing/plan-state-fixture.ts";
import { withRetainedPlanFixture } from "../testing/retained-plan-fixture.ts";
import lockfile from "proper-lockfile";
import type { PublicationAttempt } from "@runwield/workflow/publication";
import { getCwd } from "../../constants.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import { test } from "node:test";
import { readFile as fsReadFile, mkdir as fsMkdir, writeFile as fsWriteFile, rm as fsRm } from "node:fs/promises";
import process from "node:process";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import { dirname, join } from "node:path";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { setCustomSetting } from "../settings.ts";
import { findById } from "../worktree-registry.ts";

import { getWorkflowMetricsFilePath } from "./metrics.ts";
import { UsageReporter } from "./usage-reporting.ts";
import { workflowOutcomeEventId } from "./outcome-observations.ts";
import { openPublication, type PublicationCleanupResult } from "@runwield/workflow/publication-runtime";
import { makePublicationOutcomeFixture } from "./testing/publication-outcome-fixture.ts";

interface CleanupProcessResult {
    complete: boolean;
    attempt: PublicationAttempt;
    elapsedMs: number;
    metadataReads: number;
    injectedFaults: number;
    coverageFaults: number;
    coverageReadBlocked: boolean;
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
        ...(boundary === "coverage-slow" ? { timeoutMs: 15_000 } : {}),
    });
}

for (const early of [false, true]) {
    test(`confirmed publication is counted once through ${early ? "early" : "full"} cleanup`, async () => {
        await withWorkflowMetricsFixture(async (metrics) => {
            const fixture = await makePublicationOutcomeFixture(metrics.projectRoot);
            return await withRetainedPlanFixture(metrics.projectRoot, async () => {
                try {
                    let attempt = await fixture.confirm();
                    if (early) {
                        attempt = await fixture.interruptAfterCleanup(attempt);
                    }
                    const cleanup = await openPublication(metrics.projectRoot).resume(attempt).cleanup();
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
                    assert((await openPublication(metrics.projectRoot).resume(cleanup.attempt).cleanup()).complete);
                    assertEquals(await fsReadFile(getWorkflowMetricsFilePath(metrics.projectRoot), "utf8"), before);
                } finally {
                    await fixture.dispose();
                }
            });
        });
    });
}

for (const early of [false, true]) {
    for (const failure of ["disabled", "unwritable"]) {
        test(`publication completes with incomplete coverage when measurement is ${failure} through ${early ? "early" : "full"} cleanup`, async () => {
            await withWorkflowMetricsFixture(async (metrics) => {
                const fixture = await makePublicationOutcomeFixture(metrics.projectRoot);
                return await withRetainedPlanFixture(metrics.projectRoot, async () => {
                    try {
                        let attempt = await fixture.confirm();
                        if (early) {
                            attempt = await fixture.interruptAfterCleanup(attempt);
                        }
                        if (failure === "disabled") {
                            await setCustomSetting("workflowMetrics", false, "project", metrics.projectRoot);
                        } else {
                            const file = getWorkflowMetricsFilePath(metrics.projectRoot);
                            await fsMkdir(dirname(file), { recursive: true });
                            await fsMkdir(file); // A directory at the file path fails on every host, including root.
                        }
                        const cleanup = await openPublication(metrics.projectRoot).resume(attempt).cleanup();
                        assert(cleanup.complete);
                        assertEquals(await findById(metrics.projectRoot, attempt.attemptId), null);
                        const record = await inspectPlanFixtureController(metrics.projectRoot, {
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
        });
    }
}

for (const boundary of ["before", "after"]) {
    test(`fresh-process death ${boundary} observation preserves only observed publication`, async () => {
        await withWorkflowMetricsFixture(async (metrics) => {
            const fixture = await makePublicationOutcomeFixture(metrics.projectRoot);
            return await withRetainedPlanFixture(metrics.projectRoot, async () => {
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
                    const record = await inspectPlanFixtureController(metrics.projectRoot, {
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
    });
}

test("confirmed publication is observed even when cleanup keeps user files", async () => {
    await withWorkflowMetricsFixture(async (metrics) => {
        const fixture = await makePublicationOutcomeFixture(metrics.projectRoot);
        return await withRetainedPlanFixture(metrics.projectRoot, async () => {
            try {
                const attempt = await fixture.confirm();
                await fsWriteFile(join(fixture.executionCwd, "feature.txt"), "user edit\n");
                const result = await openPublication(metrics.projectRoot).resume(attempt).cleanup();
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
});

test("repeat cleanup preserves saved publication coverage after collection is disabled", async () => {
    await withWorkflowMetricsFixture(async (metrics) => {
        const fixture = await makePublicationOutcomeFixture(metrics.projectRoot);
        return await withRetainedPlanFixture(metrics.projectRoot, async () => {
            try {
                const attempt = await fixture.confirm();
                const cleanup = await openPublication(metrics.projectRoot).resume(attempt).cleanup();
                assert(cleanup.complete);
                await setCustomSetting("workflowMetrics", false, "project", metrics.projectRoot);
                assert((await openPublication(metrics.projectRoot).resume(cleanup.attempt).cleanup()).complete);
                const record = await inspectPlanFixtureController(metrics.projectRoot, {
                    planId: "plan-demo",
                    planName: "demo",
                });
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
});

test("a lost journal checkpoint cannot replay retained publication", async () => {
    await withWorkflowMetricsFixture(async (metrics) => {
        const fixture = await makePublicationOutcomeFixture(metrics.projectRoot);
        return await withRetainedPlanFixture(metrics.projectRoot, async () => {
            try {
                const cleanup = await openPublication(metrics.projectRoot)
                    .resume(await fixture.confirm())
                    .cleanup();
                const file = getWorkflowMetricsFilePath(metrics.projectRoot);
                const before = await fsReadFile(file, "utf8");
                await fsRm(join(dirname(file), "state.json"));
                assert((await openPublication(metrics.projectRoot).resume(cleanup.attempt).cleanup()).complete);
                assertEquals(await fsReadFile(file, "utf8"), before);
            } finally {
                await fixture.dispose();
            }
        });
    });
});

test("restart cleanup cannot restore a publication removed by clear", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, homeDir }) => {
        const fixture = await makePublicationOutcomeFixture(projectRoot);
        return await withRetainedPlanFixture(projectRoot, async () => {
            try {
                const cleanup = await openPublication(projectRoot)
                    .resume(await fixture.confirm())
                    .cleanup();
                assert(cleanup.complete);
                const reporter = new UsageReporter();
                assert((await reporter.clear([projectRoot]))[0].persisted);
                const path = getWorkflowMetricsFilePath(projectRoot);
                const cleared = await fsReadFile(path, "utf8");
                const script = join(projectRoot, "restart-cleanup.ts");
                await fsWriteFile(
                    script,
                    `import { openPublication } from ${JSON.stringify(
                        import.meta.resolve("@runwield/workflow/publication-runtime"),
                    )};
const [root, saved] = (await import("node:process")).argv.slice(2);
console.log(JSON.stringify(await openPublication(root).resume(JSON.parse(saved)).cleanup()));`,
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
});

for (const early of [false, true]) {
    for (const fault of ["slow", "throw"]) {
        test(`redundant ${fault} metadata cannot lose remote publication through ${early ? "early" : "full"} cleanup`, async () => {
            await withWorkflowMetricsFixture(async (metrics) => {
                const fixture = await makePublicationOutcomeFixture(metrics.projectRoot, true);
                return await withRetainedPlanFixture(metrics.projectRoot, async () => {
                    try {
                        let attempt = await fixture.confirm();
                        if (early) {
                            attempt = await fixture.interruptAfterCleanup(attempt);
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
                        const record = await inspectPlanFixtureController(metrics.projectRoot, {
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
        });
    }

    test(`journal contention is bounded and is not replayed through ${early ? "early" : "full"} cleanup`, async () => {
        await withWorkflowMetricsFixture(async (metrics) => {
            const fixture = await makePublicationOutcomeFixture(metrics.projectRoot);
            return await withRetainedPlanFixture(metrics.projectRoot, async () => {
                try {
                    let attempt = await fixture.confirm();
                    if (early) {
                        attempt = await fixture.interruptAfterCleanup(attempt);
                    }
                    const directory = dirname(getWorkflowMetricsFilePath(metrics.projectRoot));
                    await fsMkdir(directory, { recursive: true });
                    const release = lockfile.lockSync(join(directory, ".journal.lock"), { realpath: false });
                    const started = Date.now();
                    let cleanup: PublicationCleanupResult;
                    try {
                        cleanup = await openPublication(metrics.projectRoot).resume(attempt).cleanup();
                    } finally {
                        release();
                    }
                    assert(cleanup.complete);
                    assert(Date.now() - started < 5000, "measurement lock must not hold delivery open");
                    const record = await inspectPlanFixtureController(metrics.projectRoot, {
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
    });
}

for (const early of [false, true]) {
    for (const fault of ["slow", "throw"]) {
        test(`coverage ${fault} stays nonfatal and incomplete through ${early ? "early" : "full"} cleanup`, async () => {
            await withWorkflowMetricsFixture(async (metrics) => {
                const fixture = await makePublicationOutcomeFixture(metrics.projectRoot);
                return await withRetainedPlanFixture(metrics.projectRoot, async () => {
                    try {
                        let attempt = await fixture.confirm();
                        if (early) {
                            attempt = await fixture.interruptAfterCleanup(attempt);
                        }
                        const output = await runCleanupProcess(metrics.projectRoot, attempt, `coverage-${fault}`);
                        assert(output.success, new TextDecoder().decode(output.stderr));
                        const result: CleanupProcessResult = JSON.parse(
                            new TextDecoder().decode(output.stdout).trim().split("\n").at(-1)!,
                        );
                        assert(result.complete);
                        assertEquals(result.coverageFaults, 1);
                        assertEquals(
                            result.coverageReadBlocked,
                            fault === "slow",
                            "cleanup must complete while the slow coverage read is still blocked",
                        );
                        const record = await inspectPlanFixtureController(metrics.projectRoot, {
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
        });
    }
}

test("legacy unverified coverage is incomplete after restart without backfilling publication", async () => {
    await withWorkflowMetricsFixture(async (metrics) => {
        const fixture = await makePublicationOutcomeFixture(metrics.projectRoot);
        return await withRetainedPlanFixture(metrics.projectRoot, async () => {
            try {
                const attempt = await fixture.confirm();
                await seedPlanController(
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
                const record = await inspectPlanFixtureController(metrics.projectRoot, {
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
});
