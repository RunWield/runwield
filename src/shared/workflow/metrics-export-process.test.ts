import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { type MetricsExportFixture, withMetricsExportFixture } from "../../testing/metrics-export-fixture.ts";
import { setCustomSetting } from "../settings.js";
import { getWorkflowMetricsFilePath } from "./metrics.js";
import { withWorkflowMetricJournalLock } from "./metrics-journal.ts";
import { readMetricsExportLedger } from "./metrics-export-ledger.ts";
import {
    readMetricsExportStatus,
    runMetricsExportCycle,
    startMetricsExportScheduler,
} from "./metrics-export-scheduler.ts";
import { exportDestinationDirectory, tryExportLock } from "./metrics-export-storage.ts";

function startCycle(f: MetricsExportFixture, clockAdvance = 0) {
    const module = new URL("./metrics-export-scheduler.ts", import.meta.url).href;
    return new Deno.Command(Deno.execPath(), {
        args: [
            "eval",
            "--no-check",
            "--config",
            fromFileUrl(new URL("../../../deno.json", import.meta.url)),
            `import { runMetricsExportCycle } from ${JSON.stringify(module)};
             const now = Date.now; Date.now = () => now() + ${clockAdvance};
             await runMetricsExportCycle();`,
        ],
        cwd: f.project,
        env: { HOME: f.home, WLD_TEST_SANDBOX_HOME: f.home },
        stdout: "piped",
        stderr: "piped",
    }).spawn();
}
Deno.test("two host processes send each observation exactly once", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.grant();
        for (let i = 0; i < 4; i++) await f.record();
        const children = [startCycle(f), startCycle(f)];
        for (const result of await Promise.all(children.map((c) => c.output()))) {
            assert(result.success, new TextDecoder().decode(result.stderr));
        }
        assertEquals(f.requests.length, 4);
        assertEquals(new Set(f.requests.map((o) => o.observationId)).size, 4);
    });
});
Deno.test("process loss becomes unconfirmed and restart never duplicates the request", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.grant();
        await f.record();
        f.hold();
        const child = startCycle(f);
        await f.waitForRequest();
        child.kill(Deno.build.os === "windows" ? "SIGTERM" : "SIGKILL");
        await child.output();
        f.release();
        assertEquals([...readMetricsExportLedger("fixture").values()][0].state, "sending");
        await runMetricsExportCycle();
        const item = [...readMetricsExportLedger("fixture").values()][0];
        assertEquals(item.state, "unconfirmed");
        assertEquals(item.code, "process_lost");
        await f.record();
        const restarted = await startCycle(f).output();
        assert(restarted.success);
        assertEquals(f.requests.length, 2);
    });
});
Deno.test("cross-Project discovery does not depend on cwd or Workspace registration", async () => {
    await withMetricsExportFixture(async (f) => {
        const other = join(f.project, "unregistered");
        await Deno.mkdir(other);
        await setCustomSetting("workflowMetrics", true, "project", other);
        await f.grant("/accept", [other]);
        await f.record("model_usage", undefined, other);
        const result = await startCycle(f).output();
        assert(result.success, new TextDecoder().decode(result.stderr));
        assertEquals(f.requests.length, 1);
    });
});
Deno.test("held journal guard prevents authorization and releases without network work", async () => {
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
Deno.test("torn ledger tails retain accepted fences through restart", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.grant();
        await f.record();
        await runMetricsExportCycle();
        await Deno.writeTextFile(
            join(f.home, ".wld", "metrics-export", "destinations", "fixture", "ledger.jsonl"),
            '{"partial":',
            { append: true },
        );
        await f.record();
        assert((await startCycle(f).output()).success);
        assertEquals(f.requests.length, 2);
        assertEquals((await readMetricsExportStatus())[0].counts.accepted, 2);
    });
});

Deno.test("retryable payload survives restart and resumes only after its saved backoff", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.grant("/503");
        await f.record();
        await runMetricsExportCycle();
        assert((await startCycle(f).output()).success);
        assertEquals(f.requests.length, 1);
        const item = [...readMetricsExportLedger("fixture").values()][0];
        const advance = item.nextAttemptAt! - Date.now() + 1000;
        assert((await startCycle(f, advance).output()).success);
        assertEquals(f.requests.length, 2);
        assertEquals(f.requests[0], f.requests[1]);
        assertEquals([...readMetricsExportLedger("fixture").values()][0].attempts, 2);
    });
});
Deno.test("restart retains eligible open executions across incremental journal scans", async () => {
    await withMetricsExportFixture(async (f) => {
        await f.record();
        await f.grant();
        await f.record("execution_started", "open");
        assert((await startCycle(f).output()).success);
        await f.record("model_usage", "open");
        assert((await startCycle(f).output()).success);
        await f.record("execution_finished", "open");
        assert((await startCycle(f).output()).success);
        assertEquals(f.requests.map((o) => o.kind), ["model_usage", "execution_finished"]);
    });
});

Deno.test({
    name: "shutdown cancels stalled package inventory and releases destination ownership",
    ignore: Deno.build.os === "windows",
    async fn() {
        await withMetricsExportFixture(async (f) => {
            await f.grant();
            await f.record();
            const manifest = join(f.packageRoot, "package.json");
            const original = manifest + ".original";
            const contents = await Deno.readTextFile(manifest);
            await Deno.rename(manifest, original);
            assert((await new Deno.Command("mkfifo", { args: [manifest] }).output()).success);
            const stop = startMetricsExportScheduler();
            // Opening the writer proves that inventory opened the reader. Keep it
            // open without bytes or EOF so the real package read cannot complete.
            const writer = await Deno.open(manifest, { write: true });
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
                await Deno.remove(manifest);
                await Deno.rename(original, manifest);
                writer.writeSync(new TextEncoder().encode(contents));
                writer.close();
                // Let the canceled, read-only inventory finish against the restored package.
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        });
    },
});
