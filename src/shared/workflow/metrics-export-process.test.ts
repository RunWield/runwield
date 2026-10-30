import { open as fsOpen } from "node:fs/promises";
import { collectProcessOutput } from "../../testing/subprocess-output.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { spawnNativeProcess } from "../foreground-process.ts";
import { openNativeFileLock } from "../native-file-lock.ts";
import { getCwd } from "../../constants.js";
import { captureForegroundProcess } from "../captured-process.ts";
import { readFile as fsReadFile, rename as fsRename, rm as fsRm, symlink as fsSymlink } from "node:fs/promises";
import process from "node:process";
import { test } from "node:test";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import { fileURLToPath as fromFileUrl } from "node:url";
import { dirname, join } from "node:path";
import { type MetricsExportFixture, withMetricsExportFixture } from "../../testing/metrics-export-fixture.ts";
import { withCollidingMetricProjects } from "../../testing/workflow-metrics-fixture.ts";
import { setCustomSetting } from "../settings.js";
import { getWorkflowMetricsFilePath, hashMetricCwd } from "./metrics.js";
import { encodeCwdForSessionDir } from "../session/root-session.js";
import { metricsExportReference } from "./metrics-export-record.ts";
import {
    readMetricsExportGrants,
    readMetricsExportHostIdentity,
    revokeMetricsExportDestination,
} from "./metrics-export-grants.ts";
import { clearUsageHistory, UsageReporter } from "./usage-reporting.ts";
import { withWorkflowMetricJournalLock } from "./metrics-journal.ts";
import {
    appendMetricsExportLedger,
    readMetricsExportLedger,
    metricsDeliveryInFlight,
    metricsDeliveryInFlightForJournal,
} from "./metrics-export-ledger.ts";
import {
    readMetricsExportStatus,
    runMetricsExportCycle,
    startMetricsExportScheduler,
} from "./metrics-export-scheduler.ts";
import { exportDestinationDirectory, tryExportLock } from "./metrics-export-storage.ts";

function startCycle(f: MetricsExportFixture, clockAdvance = 0) {
    const module = new URL("./metrics-export-scheduler.ts", import.meta.url).href;
    return spawnNativeProcess(process.execPath, {
        args: runtimeSourceArgs([
            "eval",
            "--no-check",
            "--config",
            fromFileUrl(new URL("../../../deno.json", import.meta.url)),
            `import { runMetricsExportCycle } from ${JSON.stringify(module)};
             const now = Date.now; Date.now = () => now() + ${clockAdvance};
             await runMetricsExportCycle();`,
        ]),
        cwd: f.project,
        env: { HOME: f.home, WLD_TEST_SANDBOX_HOME: f.home },
        stdout: "piped",
        stderr: "piped",
        stdin: "null",
    });
}
test("two host processes send each observation exactly once", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.grant();
        for (let i = 0; i < 4; i++) await f.record();
        const children = [startCycle(f), startCycle(f)];
        for (const result of await Promise.all(children.map((c) => collectProcessOutput(c)))) {
            assert(result.success, new TextDecoder().decode(result.stderr));
        }
        assertEquals(f.requests.length, 4);
        assertEquals(new Set(f.requests.map((o) => o.observationId)).size, 4);
    });
});
test("process loss becomes unconfirmed and restart never duplicates the request", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.grant();
        await f.record();
        f.hold();
        const child = startCycle(f);
        await f.waitForRequest();
        child.kill((process.platform === "win32" ? "windows" : process.platform) === "windows" ? "SIGTERM" : "SIGKILL");
        await collectProcessOutput(child);
        f.release();
        assertEquals([...readMetricsExportLedger("fixture").values()][0].state, "sending");
        await runMetricsExportCycle();
        const item = [...readMetricsExportLedger("fixture").values()][0];
        assertEquals(item.state, "unconfirmed");
        assertEquals(item.code, "process_lost");
        await f.record();
        const restarted = await collectProcessOutput(startCycle(f));
        assert(restarted.success);
        assertEquals(f.requests.length, 2);
    });
});
test("cross-Project discovery does not depend on cwd or Workspace registration", async () => {
    await withMetricsExportFixture(async (f) => {
        const other = join(f.project, "unregistered");
        await fsMkdir(other);
        await setCustomSetting("workflowMetrics", true, "project", other);
        await f.grant("/accept", [other]);
        await f.record("model_usage", undefined, other);
        const result = await collectProcessOutput(startCycle(f));
        assert(result.success, new TextDecoder().decode(result.stderr));
        assertEquals(f.requests.length, 1);
    });
});
test("held journal guard prevents authorization and releases without network work", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.grant();
        await f.record();
        await withWorkflowMetricJournalLock(getWorkflowMetricsFilePath(f.project), async () => {
            await runMetricsExportCycle();
            assertEquals(f.requests, []);
        });
        await runMetricsExportCycle();
        assertEquals(f.requests.length, 1);
    });
});
test("torn ledger tails retain accepted fences through restart", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.grant();
        await f.record();
        await runMetricsExportCycle();
        await fsWriteFile(
            join(f.home, ".wld", "metrics-export", "destinations", "fixture", "ledger.jsonl"),
            '{"partial":',
            { flag: "a" },
        );
        await f.record();
        assert((await collectProcessOutput(startCycle(f))).success);
        assertEquals(f.requests.length, 2);
        assertEquals((await readMetricsExportStatus())[0].counts.accepted, 2);
    });
});

test("retryable payload survives restart and resumes only after its saved backoff", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.grant("/503");
        await f.record();
        await runMetricsExportCycle();
        assert((await collectProcessOutput(startCycle(f))).success);
        assertEquals(f.requests.length, 1);
        const item = [...readMetricsExportLedger("fixture").values()][0];
        const advance = item.nextAttemptAt! - Date.now() + 1000;
        assert((await collectProcessOutput(startCycle(f, advance))).success);
        assertEquals(f.requests.length, 2);
        assertEquals(f.requests[0], f.requests[1]);
        assertEquals([...readMetricsExportLedger("fixture").values()][0].attempts, 2);
    });
});
test("restart retains eligible open executions across incremental journal scans", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.record();
        await f.grant();
        await f.record("execution_started", "open");
        assert((await collectProcessOutput(startCycle(f))).success);
        await f.record("model_usage", "open");
        assert((await collectProcessOutput(startCycle(f))).success);
        await f.record("execution_finished", "open");
        assert((await collectProcessOutput(startCycle(f))).success);
        assertEquals(
            f.requests.map((o) => o.kind),
            ["model_usage", "execution_finished"],
        );
    });
});

test(
    "shutdown cancels stalled package inventory and releases destination ownership",
    { skip: (process.platform === "win32" ? "windows" : process.platform) === "windows" },
    async () => {
        await withMetricsExportFixture(async (f) => {
            await f.grant();
            await f.record();
            const manifest = join(f.packageRoot, "package.json");
            const original = manifest + ".original";
            const contents = await fsReadFile(manifest, "utf8");
            await fsRename(manifest, original);
            assert((await captureForegroundProcess("mkfifo", { args: [manifest], cwd: getCwd() })).success);
            const stop = startMetricsExportScheduler();
            // Opening the writer proves that inventory opened the reader. Keep it
            // open without bytes or EOF so the real package read cannot complete.
            const writer = await fsOpen(manifest, "w");
            try {
                const start = Date.now();
                await stop();
                assert(Date.now() - start < 2200);
                const lock = tryExportLock(join(exportDestinationDirectory("fixture"), ".send.lock"));
                assert(lock, "shutdown must release destination ownership before returning");
                lock.close();
                assertEquals(f.requests, []);
            } finally {
                await stop();
                await fsRm(manifest);
                await fsRename(original, manifest);
                await writer.write(new TextEncoder().encode(contents));
                await writer.close();
                // Let the canceled, read-only inventory finish against the restored package.
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        });
    },
);

test("R2-1: a grant for a-b never exports a/b measurements", async () => {
    await withMetricsExportFixture(async (f) => {
        await withCollidingMetricProjects(async (roots) => {
            assertEquals(encodeCwdForSessionDir(roots[0]), encodeCwdForSessionDir(roots[1]));
            for (const root of roots) {
                await fsMkdir(root, { recursive: true });
                await setCustomSetting("workflowMetrics", true, "project", root);
            }
            await f.grant("/accept", [roots[0]]);
            await f.record("model_usage", undefined, roots[1]);
            await f.record("model_usage", undefined, roots[0]);
            assert((await collectProcessOutput(startCycle(f))).success);
            assertEquals(f.requests.length, 1);
            assertEquals(
                f.requests[0].projectRef,
                await metricsExportReference(await readMetricsExportHostIdentity(), "project", roots[0]),
            );
        });
    });
});

test("R2-1: a busy legacy adopter defers export and restart retries without losing the grant boundary", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.record();
        const grant = await f.grant();
        await f.record();
        const path = getWorkflowMetricsFilePath(f.project);
        const bytes = await fsReadFile(path);
        const state = await fsReadFile(join(dirname(path), "state.json"));
        const legacy = join(f.home, ".wld", "workflow-metrics", encodeCwdForSessionDir(f.project));
        await fsRename(dirname(path), legacy);
        const guard = openNativeFileLock(join(legacy, ".journal.guard"));
        assert(guard.tryLockSync(true));
        try {
            for (let attempt = 0; attempt < 2; attempt++) {
                const result = await collectProcessOutput(startCycle(f));
                assert(result.success, new TextDecoder().decode(result.stderr));
            }
            assertEquals(f.requests, []);
            assertEquals([...readMetricsExportLedger("fixture").values()], []);
            assertEquals(await fsReadFile(join(legacy, "metrics.jsonl")), bytes);
        } finally {
            guard.close();
        }
        // Keep real competing adopters: the loser must defer safely or use the
        // published directory. Neither can reset the saved approval boundary.
        for (const result of await Promise.all([startCycle(f), startCycle(f)].map(collectProcessOutput))) {
            assert(result.success, new TextDecoder().decode(result.stderr));
        }
        assertEquals(f.requests.length, 1);
        assertEquals(await fsReadFile(path), bytes);
        assertEquals(await fsReadFile(join(dirname(path), "state.json")), state);
        assertEquals(readMetricsExportGrants()[0].projects, grant.projects);
        assert((await collectProcessOutput(startCycle(f))).success);
        assertEquals(f.requests.length, 1);
    });
});

test("R2-1: export still rejects a corrupt legacy adoption fence", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.grant();
        await f.record();
        const path = getWorkflowMetricsFilePath(f.project);
        await fsWriteFile(join(dirname(path), "legacy-adoption.json"), '{"partial":');
        const result = await collectProcessOutput(startCycle(f));
        assertEquals(result.success, false);
        assert(new TextDecoder().decode(result.stderr).includes("SyntaxError"));
        assertEquals(f.requests, []);
    });
});

test("R2-1: legacy rename retains the grant offset through restart without a duplicate", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.record();
        const grant = await f.grant();
        await f.record();
        await runMetricsExportCycle();
        assertEquals(f.requests.length, 1);
        const path = getWorkflowMetricsFilePath(f.project);
        const bytes = await fsReadFile(path);
        const state = await fsReadFile(join(dirname(path), "state.json"));
        const legacy = join(f.home, ".wld", "workflow-metrics", encodeCwdForSessionDir(f.project));
        assert(dirname(path) !== legacy, "canonical history must not retain its lossy directory name");
        await fsRename(dirname(path), legacy);
        for (const result of await Promise.all([startCycle(f), startCycle(f)].map(collectProcessOutput))) {
            assert(result.success, new TextDecoder().decode(result.stderr));
        }
        assertEquals(await fsReadFile(path), bytes);
        assertEquals(await fsReadFile(join(dirname(path), "state.json")), state);
        assertEquals(readMetricsExportGrants()[0].projects, grant.projects);
        assertEquals(
            new UsageReporter().query([f.project], { start: "2020-01-01", end: "2030-01-01" }, "UTC").totals.inputTokens
                .value,
            8,
        );
        assertEquals(f.requests.length, 1);
        await f.record();
        assert((await collectProcessOutput(startCycle(f))).success);
        assertEquals(f.requests.length, 2);
    });
});

test("R2-1: collided legacy grants exclude copied rows and export only fresh observations", async () => {
    await withMetricsExportFixture(async (f) => {
        await withCollidingMetricProjects(async (roots) => {
            assertEquals(encodeCwdForSessionDir(roots[0]), encodeCwdForSessionDir(roots[1]));
            for (const root of roots) {
                await fsMkdir(root, { recursive: true });
                await setCustomSetting("workflowMetrics", true, "project", root);
            }
            const grant = await f.grant("/accept", roots);
            const legacy = join(f.home, ".wld", "workflow-metrics", encodeCwdForSessionDir(roots[0]));
            for (const root of roots) {
                const directory = dirname(getWorkflowMetricsFilePath(root));
                if (directory !== legacy) await fsRm(directory, { recursive: true });
            }
            await fsMkdir(legacy, { recursive: true });
            const bytes =
                (
                    await Promise.all(
                        roots.map(async (root, index) =>
                            JSON.stringify({
                                v: 2,
                                category: "model_usage",
                                event: "model_usage",
                                eventId: `old-${index}`,
                                ts: new Date().toISOString(),
                                historyEpoch: "shared-history",
                                cwdHash: await hashMetricCwd(root),
                                inputTokens: index ? 9 : 4,
                                outputTokens: 0,
                                aggregationBasis: "turn",
                            }),
                        ),
                    )
                ).join("\n") + "\n";
            await fsWriteFile(join(legacy, "metrics.jsonl"), bytes);
            await setCustomSetting(
                "metricsExport",
                {
                    destinations: [
                        {
                            ...grant,
                            projects: roots.map((projectRoot) => ({
                                projectRoot,
                                historyEpoch: "shared-history",
                                offset: 0,
                            })),
                        },
                    ],
                },
                "global",
            );
            assert((await collectProcessOutput(startCycle(f))).success);
            assertEquals(f.requests, []);
            assertEquals(
                roots.map(
                    (root) =>
                        new UsageReporter().query([root], { start: "2020-01-01", end: "2030-01-01" }, "UTC").totals
                            .inputTokens.value,
                ),
                [4, 9],
            );
            for (const project of readMetricsExportGrants()[0].projects) {
                assertEquals(
                    project.offset,
                    (await fsReadFile(getWorkflowMetricsFilePath(project.projectRoot))).length,
                );
                assert(project.historyEpoch !== "shared-history");
            }
            await f.record("model_usage", undefined, roots[0]);
            await f.record("model_usage", undefined, roots[1]);
            assert((await collectProcessOutput(startCycle(f))).success);
            assertEquals(f.requests.length, 2);
            assertEquals(await fsReadFile(join(legacy, "metrics.jsonl"), "utf8"), bytes);
        });
    });
});

test("R2-1: clear finds live delivery evidence written with a legacy journal reference", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.grant();
        await f.record();
        f.hold();
        const child = startCycle(f);
        try {
            await f.waitForRequest();
            const identity = await readMetricsExportHostIdentity();
            const item = [...readMetricsExportLedger("fixture").values()][0];
            const alias = `${f.project}-alias`;
            await fsSymlink(f.project, alias, process.platform === "win32" ? "junction" : "dir");
            const legacy = join(f.home, ".wld", "workflow-metrics", encodeCwdForSessionDir(alias), "metrics.jsonl");
            await fsMkdir(dirname(legacy), { recursive: true });
            await fsWriteFile(legacy, await fsReadFile(getWorkflowMetricsFilePath(f.project)));
            appendMetricsExportLedger("fixture", {
                ...item,
                journalRef: await metricsExportReference(identity, "journal", legacy),
            });
            const cleared = await new UsageReporter().clear([f.project]);
            assertEquals(cleared[0].persisted, true);
            assertEquals(cleared[0].deliveryInFlight, true);
        } finally {
            f.release();
            assert((await collectProcessOutput(child)).success);
        }
    });
});

for (const method of ["deliver", "confirm"] as const) {
    test(`revoked ${method} process loss clears in-flight evidence and recovers without a grant`, async () => {
        await withMetricsExportFixture(async (f) => {
            await f.grant(method === "confirm" ? "/present" : "/accept");
            await f.record();
            if (method === "confirm") f.holdConfirmation();
            else f.hold();
            const child = startCycle(f);
            try {
                if (method === "confirm") await f.waitForConfirmation();
                else await f.waitForRequest();
                assertEquals(await metricsDeliveryInFlightForJournal(f.project), true);
                assertEquals(metricsDeliveryInFlight("fixture"), true);
                child.kill(process.platform === "win32" ? "SIGTERM" : "SIGKILL");
                await collectProcessOutput(child);
                assertEquals((await revokeMetricsExportDestination("fixture")).deliveryInFlight, false);
                f.release();
                assertEquals((await new UsageReporter().clear([f.project]))[0].deliveryInFlight, false);
                assertEquals(metricsDeliveryInFlight("fixture"), false);
                const abandoned = [...readMetricsExportLedger("fixture").values()][0];
                assert(method === "deliver" ? abandoned.state === "sending" : abandoned.confirming === true);
                await runMetricsExportCycle();
                const recovered = [...readMetricsExportLedger("fixture").values()][0];
                if (method === "deliver") {
                    assertEquals(recovered.state, "unconfirmed");
                    assertEquals(recovered.code, "process_lost");
                } else {
                    assertEquals(recovered.state, "accepted");
                    assertEquals(recovered.confirming, false);
                }
                assertEquals(f.requests.length, 1);
            } finally {
                f.release();
                try {
                    child.kill("SIGKILL");
                } catch {
                    /* Already exited. */
                }
                await collectProcessOutput(child);
            }
        });
    });
}

test("collision adoption fences H0 grants after a legacy clear and preserves later fresh grants", async () => {
    await withMetricsExportFixture(async (f) => {
        await withCollidingMetricProjects(async (roots) => {
            for (const root of roots) {
                await fsMkdir(root, { recursive: true });
                await setCustomSetting("workflowMetrics", true, "project", root);
            }
            await f.record("execution_started", "h0", roots[0]);
            const grant = await f.grant("/accept", [roots[0]]);
            const h0 = grant.projects[0].historyEpoch;
            assertEquals((await clearUsageHistory([roots[0]]))[0].persisted, true);
            await f.record("execution_started", "copied", roots[0]);
            await f.record("model_usage", "copied", roots[0]);
            const path = getWorkflowMetricsFilePath(roots[0]);
            const legacy = join(f.home, ".wld", "workflow-metrics", encodeCwdForSessionDir(roots[0]));
            await fsRename(dirname(path), legacy);
            await fsWriteFile(
                join(legacy, "metrics.jsonl"),
                JSON.stringify({
                    v: 2,
                    category: "model_usage",
                    event: "model_usage",
                    eventId: "other",
                    cwdHash: await hashMetricCwd(roots[1]),
                    historyEpoch: "h1",
                    ts: new Date().toISOString(),
                }) + "\n",
                { flag: "a" },
            );
            assert((await collectProcessOutput(startCycle(f))).success);
            assertEquals(f.requests, []);
            assert(readMetricsExportGrants()[0].projects[0].historyEpoch !== h0);
            await f.record("execution_started", "fresh", roots[0]);
            await f.record("model_usage", "fresh", roots[0]);
            assert((await collectProcessOutput(startCycle(f))).success);
            assertEquals(f.requests.length, 1);
            assertEquals((await clearUsageHistory([roots[0]]))[0].persisted, true);
            await f.record("execution_started", "before-new-grant", roots[0]);
            await f.record("model_usage", "before-new-grant", roots[0]);
            await revokeMetricsExportDestination("fixture");
            const freshGrant = await f.grant("/accept", [roots[0]]);
            assertEquals(readMetricsExportGrants()[0].projects, freshGrant.projects);
            assertEquals(freshGrant.projects[0].offset, (await fsReadFile(path)).length);
            assert((await collectProcessOutput(startCycle(f))).success);
            assertEquals(f.requests.length, 1);
            await f.record("execution_started", "after-new-grant", roots[0]);
            await f.record("model_usage", "after-new-grant", roots[0]);
            assert((await collectProcessOutput(startCycle(f))).success);
            assertEquals(f.requests.length, 2);
        });
    });
});
