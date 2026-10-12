import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { __resetSettingsForTests } from "../settings.js";
import { configureRemotePersonalResources } from "../remote/personal-resources.ts";
import { listInstalledMetricsExporters, resolveApprovedMetricsExporters } from "./metrics-exporter.ts";

Deno.test("remote exporter inventory reads only laptop-verified package roots", async () => {
    await withProcessGlobalTestLock(async () => {
        const root = await Deno.makeTempDir();
        const globalRoot = join(root, "mounted");
        const packageRoot = join(globalRoot, "installed");
        const unverified = join(root, "unverified");
        const projectRoot = join(root, "project");
        try {
            await Deno.mkdir(packageRoot, { recursive: true });
            await Deno.mkdir(unverified);
            await Deno.mkdir(projectRoot);
            const manifest = {
                name: "fixture-exporter",
                version: "1.0.0",
                wld: { metricsExporter: { contract: 1, id: "fixture", entry: "./exporter.js" } },
            };
            for (const pkg of [packageRoot, unverified]) {
                await Deno.writeTextFile(join(pkg, "package.json"), JSON.stringify(manifest));
                await Deno.writeTextFile(join(pkg, "exporter.js"), "throw new Error('must not import');\n");
            }
            const installedPath = await Deno.realPath(packageRoot);
            await Deno.writeTextFile(
                join(globalRoot, "settings.json"),
                JSON.stringify({
                    packages: ["npm:fixture-exporter", unverified],
                    metricsExporterApprovals: [{
                        id: "fixture",
                        source: "npm:fixture-exporter",
                        installedPath,
                        version: "1.0.0",
                        approvedAt: new Date().toISOString(),
                    }],
                }),
            );
            configureRemotePersonalResources({ globalRoot, packageRoots: { "npm:fixture-exporter": packageRoot } });
            __resetSettingsForTests();
            const exporters = await listInstalledMetricsExporters({ cwd: projectRoot });
            assertEquals(exporters.map((entry) => entry.source), ["npm:fixture-exporter"]);
            assertEquals(
                (await resolveApprovedMetricsExporters({ cwd: projectRoot })).map((entry) => entry.installedPath),
                [installedPath],
            );
        } finally {
            __resetSettingsForTests();
            await Deno.remove(root, { recursive: true });
        }
    });
});
