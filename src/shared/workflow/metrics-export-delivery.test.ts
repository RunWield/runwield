import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { withMetricsExportFixture } from "../../testing/metrics-export-fixture.ts";
import { revokeMetricsExportDestination, setMetricsExportCredentials } from "./metrics-export-grants.ts";
import { readMetricsExportLedger } from "./metrics-export-ledger.ts";
import {
    readMetricsExportStatus,
    runMetricsExportCycle,
    startMetricsExportScheduler,
} from "./metrics-export-scheduler.ts";
import { clearUsageHistory, queryUsageReport } from "./usage-reporting.ts";

for (
    const [path, expected] of [["/accept", "accepted"], ["/400", "rejected"], ["/401", "rejected"], [
        "/503",
        "pending",
    ]] as const
) {
    Deno.test(`delivery ${path} has ${expected} status without blocking later observations`, async () => {
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
Deno.test("only needs-correction rejections resume on credential revision", async () => {
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
Deno.test("lost responses are never resent and do not block later rows", async () => {
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
    Deno.test(`read-back ${path} confirms only proven remote presence and is capped`, async () => {
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
    Deno.test(`worker ${path} leaves Core running and records an unconfirmed delivery`, async () => {
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
Deno.test("clear during delivery reports in-flight work and settlement restores no measurements", async () => {
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
Deno.test("revoke during delivery reports in-flight work and prevents further authorization", async () => {
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
Deno.test("scheduler shutdown is bounded and releases delivery ownership", async () => {
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
Deno.test("transport context alone contains credentials; observations and local fences are content-free", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.grant();
        await setMetricsExportCredentials("fixture", { secretKey: "credential-secret" });
        await f.record();
        await runMetricsExportCycle();
        const wire = JSON.stringify(f.requests);
        for (
            const forbidden of [f.project, "cwdHash", "raw-plan-id", "raw-session-id", "credential-secret", "prompt"]
        ) assert(!wire.includes(forbidden), forbidden);
        assertEquals(f.headers, ["credential-secret"]);
        const status = JSON.stringify(await readMetricsExportStatus());
        const settings = await Deno.readTextFile(join(f.home, ".wld", "settings.json"));
        const ledger = await Deno.readTextFile(
            join(f.home, ".wld", "metrics-export", "destinations", "fixture", "ledger.jsonl"),
        );
        for (const local of [status, settings, ledger]) assert(!local.includes("credential-secret"));
        for (const file of ["credentials.json", "host.json"]) {
            if (Deno.build.os !== "windows") {
                assertEquals((await Deno.stat(join(f.home, ".wld", "metrics-export", file))).mode! & 0o777, 0o600);
            }
        }
    });
});

for (const action of ["clear", "revoke"] as const) {
    Deno.test(`${action} during confirmation reports in-flight read-back without restoring history`, async () => {
        await withMetricsExportFixture(async (f) => {
            await f.grant("/present");
            await f.record();
            f.holdConfirmation();
            const cycle = runMetricsExportCycle();
            await f.waitForConfirmation();
            const result = action === "clear"
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
Deno.test("permanent rejection stays final after credential rotation", async () => {
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

Deno.test("exporter response codes cannot retain free text or credential-shaped content", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.grant("/unsafe-code");
        await setMetricsExportCredentials("fixture", { secretKey: "credential-secret/path" });
        await f.record();
        await runMetricsExportCycle();
        const status = (await readMetricsExportStatus())[0];
        assertEquals(status.counts.accepted, 1);
        assertEquals(status.latestCodes, ["unrecognized"]);
        assert(!JSON.stringify([...readMetricsExportLedger("fixture").values()]).includes("credential-secret"));
        if (Deno.build.os !== "windows") {
            assertEquals((await Deno.stat(join(f.home, ".wld", "metrics-export"))).mode! & 0o777, 0o700);
        }
    });
});
