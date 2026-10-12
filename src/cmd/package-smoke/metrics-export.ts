/** Execute real exporter code from outside the compiled module graph. */
import { join } from "@std/path";
import { __resetSettingsForTests, setCustomSetting } from "../../shared/settings.js";
import { approveMetricsExporter, listInstalledMetricsExporters } from "../../shared/extensions/metrics-exporter.ts";
import { grantMetricsExportDestination } from "../../shared/workflow/metrics-export-grants.ts";
import { recordWorkflowMetric } from "../../shared/workflow/metrics.js";
import { readMetricsExportStatus, runMetricsExportCycle } from "../../shared/workflow/metrics-export-scheduler.ts";

export async function checkPackagedMetricsExport(): Promise<void> {
    const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "wld-export-smoke-" }));
    const home = join(root, "home");
    const project = join(root, "project");
    const pkg = join(root, "package");
    for (const directory of [home, project, pkg]) await Deno.mkdir(directory);
    const previous = Deno.env.get("HOME");
    Deno.env.set("HOME", home);
    __resetSettingsForTests();
    let requests = 0;
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
        const body = await request.json();
        if (body.contract !== 1 || body.kind !== "model_usage") throw new Error("Invalid smoke observation");
        requests++;
        return new Response("accepted");
    });
    try {
        await Deno.writeTextFile(
            join(pkg, "package.json"),
            JSON.stringify({
                name: "smoke-exporter",
                version: "1",
                wld: { metricsExporter: { contract: 1, id: "smoke", entry: "exporter.js" } },
            }),
        );
        await Deno.writeTextFile(
            join(pkg, "exporter.js"),
            `export async function deliver(o,c) {
            if (new URL(c.endpoint).pathname === '/exit') Deno.exit(17);
            await fetch(c.endpoint, {method:'POST', body:JSON.stringify(o)}).then(r=>r.text());
            return {outcome:'accepted'};
        }`,
        );
        await setCustomSetting("packages", [pkg], "global", project);
        await setCustomSetting("workflowMetrics", true, "project", project);
        await approveMetricsExporter((await listInstalledMetricsExporters())[0]);
        const input = {
            destinationId: "smoke",
            exporterId: "smoke",
            exporterSource: pkg,
            externalProject: "smoke",
            allowInsecureLocalEndpoint: true,
            projectRoots: [project],
        };
        const base = `http://127.0.0.1:${server.addr.port}`;
        await grantMetricsExportDestination({ ...input, endpoint: `${base}/accept` });
        const record = async (seq: number) => {
            const result = await recordWorkflowMetric({
                v: 2,
                event: "model_usage",
                category: "model_usage",
                recorderId: "smoke",
                seq,
                inputTokens: 1,
            }, project);
            if (!result.persisted) throw new Error("Packaged Core cannot record usage");
        };
        await record(0);
        await runMetricsExportCycle({ deadlineMs: 2000 });
        if (requests !== 1 || (await readMetricsExportStatus())[0].counts.accepted !== 1) {
            throw new Error("Packaged Worker did not load installed exporter");
        }
        await grantMetricsExportDestination({ ...input, endpoint: `${base}/exit` });
        await record(1);
        await runMetricsExportCycle({ deadlineMs: 1000 });
        if ((await readMetricsExportStatus())[0].counts.unconfirmed !== 1) {
            throw new Error("Packaged Worker exit was not isolated");
        }
        await record(2);
        if ((await readMetricsExportStatus())[0].counts.pending !== 1) {
            throw new Error("Packaged host cannot continue after exporter exit");
        }
    } finally {
        await server.shutdown();
        __resetSettingsForTests();
        if (previous === undefined) Deno.env.delete("HOME");
        else Deno.env.set("HOME", previous);
        await Deno.remove(root, { recursive: true });
    }
}
