import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { withMetricsExportFixture } from "../../testing/metrics-export-fixture.ts";
import { getCustomSetting, setCustomSetting } from "../settings.js";
import {
    approveMetricsExporter,
    listInstalledMetricsExporters,
    metricsExporterStillApproved,
    removeMetricsExporterApprovals,
} from "../extensions/metrics-exporter.ts";
import {
    grantMetricsExportDestination,
    readMetricsExportGrants,
    revokeMetricsExportDestination,
    setMetricsExportCredentials,
    updateMetricsExportProjects,
} from "./metrics-export-grants.ts";
import { readMetricsExportStatus, runMetricsExportCycle } from "./metrics-export-scheduler.ts";
import { clearUsageHistory } from "./usage-reporting.ts";
import { withExportConfigurationLock } from "./metrics-export-storage.ts";

Deno.test("no exporter authority means no network delivery", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.record();
        await runMetricsExportCycle(); // approved, no grant
        await f.grant("/accept", []);
        await f.record();
        await runMetricsExportCycle(); // empty allowlist
        await f.grant();
        await f.record();
        await removeMetricsExporterApprovals(f.packageRoot);
        await runMetricsExportCycle(); // approval removed
        await setCustomSetting("packages", [], "global");
        await runMetricsExportCycle(); // not installed
        assertEquals(f.requests, []);
        await setCustomSetting("packages", [f.packageRoot], "global");
        await approveMetricsExporter((await listInstalledMetricsExporters())[0]);
        const manifest = join(f.packageRoot, "package.json");
        const saved = JSON.parse(await Deno.readTextFile(manifest));
        saved.version = "2.0.0";
        await Deno.writeTextFile(manifest, JSON.stringify(saved));
        await approveMetricsExporter((await listInstalledMetricsExporters())[0]);
        await runMetricsExportCycle(); // new identity approved, old grant still cannot send
        assertEquals(f.requests, []);
    });
});
Deno.test("start boundaries exclude old operations and include only explicitly granted Projects", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.record();
        await f.record("execution_started", "old");
        await f.grant();
        await f.record("execution_finished", "old");
        await f.record("model_usage", "old");
        await f.record("execution_started", "new");
        await f.record("model_usage", "new");
        await f.record("execution_finished", "new");
        const other = join(f.project, "other");
        await Deno.mkdir(other);
        await setCustomSetting("workflowMetrics", true, "project", other);
        await f.record("model_usage", undefined, other);
        await runMetricsExportCycle();
        assertEquals(f.requests.map((o) => o.kind), ["model_usage", "execution_finished"]);
        await setCustomSetting("workflowMetrics", false, "project", f.project);
        // A disabled interval has no journal payload to export.
        const { recordWorkflowMetric } = await import("./metrics.js");
        assertEquals(
            (await recordWorkflowMetric({
                v: 2,
                recorderId: "off",
                seq: 0,
                event: "model_usage",
                category: "model_usage",
            }, f.project)).persisted,
            false,
        );
        await updateMetricsExportProjects("fixture", [f.project, other]);
        await f.record("model_usage", undefined, other);
        await runMetricsExportCycle();
        assertEquals(f.requests.length, 3);
    });
});
Deno.test("endpoint and re-enable reset consent; credential rotation preserves it", async () => {
    await withMetricsExportFixture(async (f) => {
        const grant = await f.grant("/503");
        await f.record();
        await runMetricsExportCycle();
        await setMetricsExportCredentials("fixture", { secretKey: "credential-secret" });
        assertEquals(readMetricsExportGrants()[0].grantId, grant.grantId);
        const changed = await f.grant("/accept");
        assert(changed.grantId !== grant.grantId);
        await runMetricsExportCycle();
        assertEquals(f.requests.length, 1);
        await f.record();
        await revokeMetricsExportDestination("fixture");
        const reenabled = await f.grant();
        assert(reenabled.grantId !== changed.grantId);
        await runMetricsExportCycle();
        assertEquals(f.requests.length, 1);
        await f.record();
        await runMetricsExportCycle();
        assertEquals(f.requests.length, 2);
    });
});
Deno.test("grant refuses non-HTTPS destinations except explicit loopback and ignores Project settings", async () => {
    await withMetricsExportFixture(async (f) => {
        for (const endpoint of ["http://example.com", "ftp://localhost", "https://user:secret@example.com"]) {
            await assertRejects(() =>
                grantMetricsExportDestination({
                    exporterId: "fixture",
                    exporterSource: f.packageRoot,
                    endpoint,
                    externalProject: "x",
                    projectRoots: [],
                    allowInsecureLocalEndpoint: true,
                })
            );
        }
        await assertRejects(() =>
            grantMetricsExportDestination({
                exporterId: "fixture",
                exporterSource: f.packageRoot,
                endpoint: f.endpoint(),
                externalProject: "x",
                projectRoots: [],
            })
        );
        await f.grant();
        const saved = getCustomSetting("metricsExport", "global");
        await revokeMetricsExportDestination("fixture");
        await setCustomSetting("metricsExport", saved, "project", f.project);
        await f.record();
        await runMetricsExportCycle();
        assertEquals(await readMetricsExportStatus(), []);
        assertEquals(f.requests, []);
    });
});
Deno.test("clear before authorization removes pending payloads and later history starts fresh", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.grant();
        await f.record();
        assertEquals((await readMetricsExportStatus())[0].counts.pending, 1);
        assert((await clearUsageHistory([f.project]))[0].persisted);
        await runMetricsExportCycle();
        assertEquals(f.requests, []);
        await f.record();
        await runMetricsExportCycle();
        assertEquals(f.requests.length, 1);
    });
});

Deno.test("current history after clear is eligible even without a retained execution start", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.grant();
        await f.record("execution_started", "spans-clear");
        await clearUsageHistory([f.project]);
        await f.record("model_usage", "spans-clear");
        await runMetricsExportCycle();
        assertEquals(f.requests.length, 1);
    });
});

Deno.test("queued Project edit cannot restore a revoked destination", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.grant();
        let revoke: Promise<{ deliveryInFlight: boolean }> | undefined;
        let update: Promise<boolean> | undefined;
        await withExportConfigurationLock(async () => {
            revoke = revokeMetricsExportDestination("fixture");
            update = updateMetricsExportProjects("fixture", [f.project]).then(() => true, () => false);
            await new Promise((resolve) => setTimeout(resolve, 10));
        });
        await revoke;
        assertEquals(await update, false);
        assertEquals(readMetricsExportGrants(), []);
    });
});
Deno.test("queued Project edit uses the current destination rather than overwriting an endpoint change", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.grant();
        let change: ReturnType<typeof f.grant> | undefined;
        let update: ReturnType<typeof updateMetricsExportProjects> | undefined;
        await withExportConfigurationLock(async () => {
            change = f.grant("/present");
            update = updateMetricsExportProjects("fixture", [f.project]);
            await new Promise((resolve) => setTimeout(resolve, 10));
        });
        await change;
        assertEquals((await update)?.endpoint, f.endpoint("/present"));
        assertEquals(readMetricsExportGrants()[0].endpoint, f.endpoint("/present"));
    });
});

Deno.test("post-grant usage without a recorded execution start is pending and exported", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.record("model_usage", "auxiliary-before-grant");
        await f.grant();
        await f.record("model_usage", "vision-fallback");
        assertEquals((await readMetricsExportStatus())[0].counts.pending, 1);
        await runMetricsExportCycle();
        assertEquals(f.requests.map((o) => o.kind), ["model_usage"]);
        await f.record("model_usage", "external-guided-review");
        assertEquals((await readMetricsExportStatus())[0].counts.pending, 1);
        await runMetricsExportCycle();
        assertEquals(f.requests.map((o) => o.kind), ["model_usage", "model_usage"]);
        assertEquals((await readMetricsExportStatus())[0].counts.pending, 0);
    });
});

Deno.test("recorded pre-grant execution starts remain excluded across export cycles", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.record("execution_started", "old");
        await f.grant();
        await runMetricsExportCycle();
        await f.record("model_usage", "old");
        await f.record("execution_finished", "old");
        assertEquals((await readMetricsExportStatus())[0].counts.pending, 0);
        await runMetricsExportCycle();
        assertEquals(f.requests, []);
    });
});

Deno.test("final authorization refuses a cached exporter identity after approval removal", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.grant();
        const cached = (await listInstalledMetricsExporters())[0];
        assert(metricsExporterStillApproved(cached));
        await removeMetricsExporterApprovals(f.packageRoot);
        assertEquals(metricsExporterStillApproved(cached), false);
        await f.record();
        await runMetricsExportCycle();
        assertEquals(f.requests, []);
    });
});
