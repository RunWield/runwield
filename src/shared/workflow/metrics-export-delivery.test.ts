import { test } from "node:test";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import process from "node:process";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import { join } from "node:path";
import { withMetricsExportFixture } from "../../testing/metrics-export-fixture.ts";
import {
    revokeMetricsExportDestination,
    setMetricsExportCredentials,
    readMetricsExportHostIdentity,
    readMetricsExportCredentials,
} from "./metrics-export-grants.ts";
import {
    type MetricsDeliveryItem,
    appendMetricsExportLedger,
    readMetricsExportLedger,
} from "./metrics-export-ledger.ts";
import {
    authorizeAndDispatchMetricsExport,
    PreparedMetricsExportRequest,
    readMetricsExportStatus,
    runMetricsExportCycle,
    startMetricsExportScheduler,
} from "./metrics-export-scheduler.ts";
import { getWorkflowMetricsFilePath } from "./metrics.js";
import { withWorkflowMetricJournalLock } from "./metrics-journal.ts";
import { listInstalledMetricsExporters } from "../extensions/metrics-exporter.ts";
import {
    buildMetricsExportObservation,
    metricsExportReference,
    type MetricsJournalRow,
} from "./metrics-export-record.ts";
import { tryExportLock, withExportConfigurationLock } from "./metrics-export-storage.ts";
import { clearUsageHistory, queryUsageReport } from "./usage-reporting.ts";

for (const [path, expected] of [
    ["/accept", "accepted"],
    ["/400", "rejected"],
    ["/401", "rejected"],
    ["/503", "pending"],
] as const) {
    test(`delivery ${path} has ${expected} status without blocking later observations`, async () => {
        await withMetricsExportFixture(async (f) => {
            await f.grant(path);
            await f.record();
            await f.record();
            await runMetricsExportCycle();
            assertEquals(f.requests.length, 2);
            assertEquals((await readMetricsExportStatus())[0].counts[expected], 2);
            if (path === "/503") {
                assert(
                    [...readMetricsExportLedger("fixture").values()].every((i) => (i.nextAttemptAt ?? 0) > Date.now()),
                );
            }
            await runMetricsExportCycle();
            assertEquals(f.requests.length, 2);
        });
    });
}
test("only needs-correction rejections resume on credential revision", async () => {
    await withMetricsExportFixture(async (f) => {
        const grant = await f.grant("/401");
        await f.record();
        await runMetricsExportCycle();
        await setMetricsExportCredentials("fixture", { secretKey: "new-secret" });
        assertEquals((await readMetricsExportStatus())[0].counts.pending, 1);
        await runMetricsExportCycle();
        assertEquals(f.requests.length, 2);
        assertEquals((await readMetricsExportStatus())[0].grantId, grant.grantId);
        assertEquals(f.headers.at(-1), "new-secret");
    });
});
test("lost responses are never resent and do not block later rows", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.grant("/drop");
        await f.record();
        await runMetricsExportCycle();
        assertEquals((await readMetricsExportStatus())[0].counts.unconfirmed, 1);
        await runMetricsExportCycle();
        await f.record();
        await runMetricsExportCycle();
        assertEquals(f.requests.length, 2);
        assertEquals(new Set(f.requests.map((o) => o.observationId)).size, 2);
    });
});
for (const path of ["/present", "/drop-present", "/accept", "/mismatch"]) {
    test(`read-back ${path} confirms only proven remote presence and is capped`, async () => {
        await withMetricsExportFixture(async (f) => {
            await f.grant(path);
            await f.record();
            for (let cycle = 0; cycle < 5; cycle++) await runMetricsExportCycle();
            const counts = (await readMetricsExportStatus())[0].counts;
            assertEquals(counts.confirmed, path.includes("present") ? 1 : 0);
            assertEquals(f.requests.length, 1);
            assertEquals(f.confirmations.length, path.includes("present") ? 1 : 3);
        });
    });
}
for (const path of ["/throw", "/hang", "/exit", "/malformed"]) {
    test(`worker ${path} leaves Core running and records an unconfirmed delivery`, async () => {
        await withMetricsExportFixture(async (f) => {
            await f.grant(path);
            await f.record();
            await runMetricsExportCycle({ deadlineMs: 500 });
            assertEquals((await readMetricsExportStatus())[0].counts.unconfirmed, 1);
            await f.record();
            assertEquals((await readMetricsExportStatus())[0].counts.pending, 1);
            assert(!JSON.stringify(await readMetricsExportStatus()).includes("credential-secret"));
        });
    });
}
test("clear during delivery reports in-flight work and settlement restores no measurements", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.grant();
        await f.record();
        f.hold();
        const cycle = runMetricsExportCycle();
        await f.waitForRequest();
        const cleared = await clearUsageHistory([f.project]);
        assertEquals(cleared[0].deliveryInFlight, true);
        f.release();
        await cycle;
        assertEquals((await readMetricsExportStatus())[0].counts.accepted, 0);
        assertEquals(
            queryUsageReport([f.project], { start: "2020-01-01", end: "2100-01-01" }, "America/New_York").totals.tokens
                .value,
            0,
        );
        assertEquals([...readMetricsExportLedger("fixture").values()][0].state, "accepted");
    });
});
test("revoke during delivery reports in-flight work and prevents further authorization", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.grant();
        await f.record();
        await f.record();
        f.hold();
        const cycle = runMetricsExportCycle();
        await f.waitForRequest();
        assertEquals((await revokeMetricsExportDestination("fixture")).deliveryInFlight, true);
        f.release();
        await cycle;
        assertEquals(f.requests.length, 1);
        assertEquals(await readMetricsExportStatus(), []);
    });
});
test("scheduler shutdown is bounded and releases delivery ownership", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.grant();
        await f.record();
        f.hold();
        const stop = startMetricsExportScheduler();
        await f.waitForRequest();
        const start = Date.now();
        await stop();
        assert(Date.now() - start < 2200);
        f.release();
        await runMetricsExportCycle();
        assertEquals(f.requests.length, 1);
        assertEquals((await readMetricsExportStatus())[0].counts.unconfirmed, 1);
    });
});
test("transport context alone contains credentials; observations and local fences are content-free", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.grant();
        await setMetricsExportCredentials("fixture", { secretKey: "credential-secret" });
        await f.record();
        await runMetricsExportCycle();
        const wire = JSON.stringify(f.requests);
        for (const forbidden of [f.project, "cwdHash", "raw-plan-id", "raw-session-id", "credential-secret", "prompt"])
            assert(!wire.includes(forbidden), forbidden);
        assertEquals(f.headers, ["credential-secret"]);
        const status = JSON.stringify(await readMetricsExportStatus());
        const settings = await fsReadFile(join(f.home, ".wld", "settings.json"), "utf8");
        const ledger = await fsReadFile(
            join(f.home, ".wld", "metrics-export", "destinations", "fixture", "ledger.jsonl"),
            "utf8",
        );
        for (const local of [status, settings, ledger]) assert(!local.includes("credential-secret"));
        for (const file of ["credentials.json", "host.json"]) {
            if ((process.platform === "win32" ? "windows" : process.platform) !== "windows") {
                assertEquals((await fsStat(join(f.home, ".wld", "metrics-export", file))).mode! & 0o777, 0o600);
            }
        }
    });
});

for (const action of ["clear", "revoke"] as const) {
    test(`${action} during confirmation reports in-flight read-back without restoring history`, async () => {
        await withMetricsExportFixture(async (f) => {
            await f.grant("/present");
            await f.record();
            f.holdConfirmation();
            const cycle = runMetricsExportCycle();
            await f.waitForConfirmation();
            const result =
                action === "clear"
                    ? (await clearUsageHistory([f.project]))[0]
                    : await revokeMetricsExportDestination("fixture");
            assertEquals(result.deliveryInFlight, true);
            f.release();
            await cycle;
            await runMetricsExportCycle();
            assertEquals(f.requests.length, 1);
            assertEquals(f.confirmations.length, 1);
            if (action === "clear") assertEquals((await readMetricsExportStatus())[0].counts.confirmed, 0);
            else assertEquals(await readMetricsExportStatus(), []);
        });
    });
}
test("permanent rejection stays final after credential rotation", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.grant("/400");
        await f.record();
        await runMetricsExportCycle();
        await setMetricsExportCredentials("fixture", { secretKey: "changed" });
        await runMetricsExportCycle();
        assertEquals(f.requests.length, 1);
        assertEquals((await readMetricsExportStatus())[0].counts.rejected, 1);
    });
});

test("exporter response codes cannot retain free text or credential-shaped content", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.grant("/unsafe-code");
        await setMetricsExportCredentials("fixture", { secretKey: "credential-secret/path" });
        await f.record();
        await runMetricsExportCycle();
        const status = (await readMetricsExportStatus())[0];
        assertEquals(status.counts.accepted, 1);
        assertEquals(status.latestCodes, ["unrecognized"]);
        assert(!JSON.stringify([...readMetricsExportLedger("fixture").values()]).includes("credential-secret"));
        if ((process.platform === "win32" ? "windows" : process.platform) !== "windows") {
            assertEquals((await fsStat(join(f.home, ".wld", "metrics-export"))).mode! & 0o777, 0o700);
        }
    });
});

for (const method of ["deliver", "confirm"] as const) {
    for (const boundary of ["clear", "revoke", "abort", "none"] as const) {
        test(`locked ${method} dispatch ${boundary === "none" ? "reaches the exporter before lock release" : `rejects a committed ${boundary}`}`, async () => {
            await withMetricsExportFixture(async (f) => {
                const grant = await f.grant("/present");
                await f.record();
                // Build the wire observation and spawn the worker before authorization, as the cycle does.
                const path = getWorkflowMetricsFilePath(f.project);
                const bytes = await fsReadFile(path, "utf8");
                const lines = bytes.trimEnd().split("\n");
                const row: MetricsJournalRow = JSON.parse(lines.at(-1)!);
                const offset = Buffer.byteLength(lines.slice(0, -1).join("\n") + (lines.length > 1 ? "\n" : ""));
                const identity = await readMetricsExportHostIdentity();
                const journalRef = await metricsExportReference(identity, "journal", path);
                const observation = await buildMetricsExportObservation(row, f.project, identity);
                assert(observation);
                const exporter = (await listInstalledMetricsExporters())[0];
                const controller = new AbortController();
                const prepared = new PreparedMetricsExportRequest(
                    exporter,
                    method,
                    row,
                    observation,
                    controller.signal,
                );
                const previous: MetricsDeliveryItem | undefined =
                    method === "confirm"
                        ? {
                              eventId: row.eventId,
                              attemptId: crypto.randomUUID(),
                              grantId: grant.grantId,
                              projectRef: observation.projectRef,
                              journalRef,
                              historyEpoch: row.historyEpoch,
                              offset,
                              state: "accepted",
                              at: new Date().toISOString(),
                              credentialsRevision: readMetricsExportCredentials("fixture").revision,
                              attempts: 1,
                              confirmations: 0,
                          }
                        : undefined;
                if (previous) appendMetricsExportLedger("fixture", previous);
                try {
                    if (boundary === "clear") await clearUsageHistory([f.project]);
                    if (boundary === "revoke") await revokeMetricsExportDestination("fixture");
                    if (boundary === "abort") controller.abort();
                    const result = await withExportConfigurationLock(() =>
                        withWorkflowMetricJournalLock(path, async (epoch) => {
                            const dispatched = authorizeAndDispatchMetricsExport(
                                {
                                    prepared,
                                    grant,
                                    project: grant.projects[0],
                                    path,
                                    position: { offset, eventId: row.eventId },
                                    historyEpoch: row.historyEpoch,
                                    projectRef: observation.projectRef,
                                    journalRef,
                                    previous,
                                    signal: controller.signal,
                                },
                                epoch,
                            );
                            if (boundary === "none") {
                                assert(dispatched);
                                // Deliberately keep both real guards held until receipt. No deferred dispatch can pass.
                                await Promise.race([
                                    method === "deliver" ? f.waitForRequest() : f.waitForConfirmation(),
                                    new Promise<never>((_, reject) =>
                                        setTimeout(() => reject(new Error("dispatch did not occur under locks")), 1500),
                                    ),
                                ]);
                                assertEquals(
                                    tryExportLock(join(f.home, ".wld", "metrics-export", ".config.lock")),
                                    null,
                                );
                            } else assertEquals(dispatched, null);
                            return dispatched;
                        }),
                    );
                    if (result) await result.pending;
                    assertEquals(f.requests.length, boundary === "none" && method === "deliver" ? 1 : 0);
                    assertEquals(f.confirmations.length, boundary === "none" && method === "confirm" ? 1 : 0);
                    assertEquals(readMetricsExportLedger("fixture").size, boundary === "none" || previous ? 1 : 0);
                } finally {
                    prepared.cancel();
                }
            });
        });
    }
}
