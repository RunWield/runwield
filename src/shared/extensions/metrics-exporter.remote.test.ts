import { test } from "node:test";
import { tmpdir } from "node:os";
import {
    mkdtemp as fsMkdtemp,
    mkdir as fsMkdir,
    writeFile as fsWriteFile,
    realpath as fsRealpath,
    rm as fsRm,
} from "node:fs/promises";
import { join } from "node:path";
import { assertEquals } from "../../testing/assertions.ts";

import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { __resetSettingsForTests } from "../settings.js";
import { configureRemotePersonalResources } from "../remote/personal-resources.ts";
import { listInstalledMetricsExporters, resolveApprovedMetricsExporters } from "./metrics-exporter.ts";

test("remote exporter inventory reads only laptop-verified package roots", async () => {
    await withProcessGlobalTestLock(async () => {
        const root = await fsMkdtemp(join(tmpdir(), "runwield-"));
        const globalRoot = join(root, "mounted");
        const packageRoot = join(globalRoot, "installed");
        const unverified = join(root, "unverified");
        const projectRoot = join(root, "project");
        try {
            await fsMkdir(packageRoot, { recursive: true });
            await fsMkdir(unverified);
            await fsMkdir(projectRoot);
            const manifest = {
                name: "fixture-exporter",
                version: "1.0.0",
                wld: { metricsExporter: { contract: 1, id: "fixture", entry: "./exporter.js" } },
            };
            for (const pkg of [packageRoot, unverified]) {
                await fsWriteFile(join(pkg, "package.json"), JSON.stringify(manifest));
                await fsWriteFile(join(pkg, "exporter.js"), "throw new Error('must not import');\n");
            }
            const installedPath = await fsRealpath(packageRoot);
            await fsWriteFile(
                join(globalRoot, "settings.json"),
                JSON.stringify({
                    packages: ["npm:fixture-exporter", unverified],
                    metricsExporterApprovals: [
                        {
                            id: "fixture",
                            source: "npm:fixture-exporter",
                            installedPath,
                            version: "1.0.0",
                            approvedAt: new Date().toISOString(),
                        },
                    ],
                }),
            );
            configureRemotePersonalResources({ globalRoot, packageRoots: { "npm:fixture-exporter": packageRoot } });
            __resetSettingsForTests();
            const exporters = await listInstalledMetricsExporters({ cwd: projectRoot });
            assertEquals(
                exporters.map((entry) => entry.source),
                ["npm:fixture-exporter"],
            );
            assertEquals(
                (await resolveApprovedMetricsExporters({ cwd: projectRoot })).map((entry) => entry.installedPath),
                [installedPath],
            );
        } finally {
            __resetSettingsForTests();
            await fsRm(root, { recursive: true });
        }
    });
});
