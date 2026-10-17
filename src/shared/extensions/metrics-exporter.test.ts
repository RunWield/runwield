import {
    mkdir as fsMkdir,
    writeFile as fsWriteFile,
    mkdtemp as fsMkdtemp,
    rm as fsRm,
    readFile as fsReadFile,
    symlink as fsSymlink,
    rename as fsRename,
    realpath as fsRealpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { getCwd } from "../../constants.js";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";

import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import {
    __resetSettingsForTests,
    getCustomSetting,
    getSettingsDir,
    getSettingsManager,
    setCustomSetting,
} from "../settings.js";
import {
    approveMetricsExporter,
    listInstalledMetricsExporters,
    readMetricsExporterDeclaration,
    removeMetricsExporterApprovals,
    resolveApprovedMetricsExporters,
} from "./metrics-exporter.ts";

interface ExporterFixture {
    root: string;
    packageRoot: string;
    projectRoot: string;
}

async function writeExporter(root: string, entry = "./exporter.js") {
    await fsMkdir(root, { recursive: true });
    await fsWriteFile(
        join(root, "package.json"),
        JSON.stringify({
            name: "fixture-exporter",
            version: "1.0.0",
            wld: { metricsExporter: { contract: 1, id: "fixture", entry } },
        }),
    );
    await fsWriteFile(join(root, "exporter.js"), "throw new Error('inventory must not import code');\n");
}

async function withExporterFixture(run: (fixture: ExporterFixture) => Promise<void>) {
    await withProcessGlobalTestLock(async () => {
        const root = await fsMkdtemp(join(tmpdir(), "metrics-exporter-"));
        const previousHome = process.env["HOME"];
        const previousSandbox = process.env["WLD_TEST_SANDBOX_HOME"];
        const previousCwd = getCwd();
        const home = join(root, "home");
        const packageRoot = join(root, "package");
        const projectRoot = join(root, "project");
        await fsMkdir(home);
        await fsMkdir(projectRoot);
        await writeExporter(packageRoot);
        process.env["HOME"] = home;
        process.env["WLD_TEST_SANDBOX_HOME"] = home;
        process.chdir(projectRoot);
        __resetSettingsForTests();
        try {
            await run({ root, packageRoot, projectRoot });
        } finally {
            __resetSettingsForTests();
            process.chdir(previousCwd);
            if (previousHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = previousHome;
            if (previousSandbox === undefined) delete process.env["WLD_TEST_SANDBOX_HOME"];
            else process.env["WLD_TEST_SANDBOX_HOME"] = previousSandbox;
            await fsRm(root, { recursive: true });
        }
    });
}

for (const defect of [
    "contract",
    "id",
    "absolute",
    "escape",
    "symlink",
    "pi-resource",
    "pi-glob",
    "auto-discovery",
] as const) {
    test(`exporter declaration rejects ${defect}`, async () => {
        const root = await fsMkdtemp(join(tmpdir(), "runwield-"));
        const pkg = join(root, "pkg");
        try {
            await writeExporter(pkg);
            const path = join(pkg, "package.json");
            const manifest = JSON.parse(await fsReadFile(path, "utf8"));
            const declaration = manifest.wld.metricsExporter;
            if (defect === "contract") declaration.contract = 2;
            if (defect === "id") declaration.id = "  ";
            if (defect === "absolute") {
                declaration.entry = join(pkg, "exporter.js");
                // A joined absolute entry must still be rejected if that nested path happens to exist.
                const nested = join(pkg, declaration.entry);
                await fsMkdir(join(nested, ".."), { recursive: true });
                await fsWriteFile(nested, "export default () => {};\n");
            }
            if (defect === "escape" || defect === "symlink") {
                await fsWriteFile(join(root, "outside.js"), "export default () => {};\n");
                if (defect === "escape") declaration.entry = "../outside.js";
                else {
                    await fsSymlink(join(root, "outside.js"), join(pkg, "link.js"));
                    declaration.entry = "./link.js";
                }
            }
            if (defect === "pi-resource" || defect === "pi-glob") {
                manifest.pi = { extensions: [defect === "pi-resource" ? "./exporter.js" : "./*.js"] };
            }
            if (defect === "auto-discovery") {
                await fsMkdir(join(pkg, "extensions"));
                await fsRename(join(pkg, "exporter.js"), join(pkg, "extensions", "exporter.js"));
                declaration.entry = "./extensions/exporter.js";
            }
            await fsWriteFile(path, JSON.stringify(manifest));
            assertEquals(await readMetricsExporterDeclaration(pkg), null);
        } finally {
            await fsRm(root, { recursive: true });
        }
    });
}

test("exporter inventory exposes absent, unapproved, approved, and invalid states without importing code", async () => {
    await withExporterFixture(async ({ packageRoot }) => {
        assertEquals(await listInstalledMetricsExporters(), []);
        assertEquals(await resolveApprovedMetricsExporters(), []);
        const settings = getSettingsManager();
        settings.setPackages([{ source: packageRoot, extensions: [] }]);
        await settings.flush();
        const [exporter] = await listInstalledMetricsExporters();
        assertEquals(exporter.approved, false);
        assertEquals(await resolveApprovedMetricsExporters(), []);
        await approveMetricsExporter(exporter);
        __resetSettingsForTests();
        assertEquals((await listInstalledMetricsExporters())[0].approved, true);
        assertEquals(
            (await resolveApprovedMetricsExporters())[0].entryPath,
            await fsRealpath(join(packageRoot, "exporter.js")),
        );
        await removeMetricsExporterApprovals(packageRoot);
        assertEquals(await resolveApprovedMetricsExporters(), []);
        await fsWriteFile(join(packageRoot, "package.json"), "{}");
        assertEquals(await listInstalledMetricsExporters(), []);
        assertEquals(await resolveApprovedMetricsExporters(), []);
    });
});

for (const identity of ["id", "source", "installedPath", "version"] as const) {
    test(`exporter approval is invalidated by a changed ${identity}`, async () => {
        await withExporterFixture(async ({ root, packageRoot }) => {
            const settings = getSettingsManager();
            settings.setPackages([packageRoot]);
            await settings.flush();
            await approveMetricsExporter((await listInstalledMetricsExporters())[0]);
            const saved = getCustomSetting("metricsExporterApprovals", "global");
            if (identity === "source") {
                settings.setPackages([join(packageRoot, ".") + "/."]);
                await settings.flush();
            } else if (identity === "installedPath") {
                // Keep the configured source stable while moving its real installed target.
                const moved = join(root, "moved");
                await fsRename(packageRoot, moved);
                await fsSymlink(moved, packageRoot);
            } else {
                const path = join(packageRoot, "package.json");
                const manifest = JSON.parse(await fsReadFile(path, "utf8"));
                if (identity === "version") manifest.version = "2.0.0";
                else manifest.wld.metricsExporter.id = "other";
                await fsWriteFile(path, JSON.stringify(manifest));
            }
            assertEquals((await listInstalledMetricsExporters())[0].approved, false);
            assertEquals(await resolveApprovedMetricsExporters(), []);
            assertEquals(getCustomSetting("metricsExporterApprovals", "global"), saved);
        });
    });
}

test("Project packages and Project approval records cannot replace or approve the user's exporter", async () => {
    await withExporterFixture(async ({ projectRoot }) => {
        const userPackage = join(getSettingsDir("global"), "npm", "node_modules", "fixture-exporter");
        const projectPackage = join(projectRoot, ".pi", "npm", "node_modules", "fixture-exporter");
        await writeExporter(userPackage);
        await writeExporter(projectPackage, "./project.js");
        await fsWriteFile(join(projectPackage, "project.js"), "throw new Error('project code');\n");
        const settings = getSettingsManager();
        settings.setPackages(["npm:fixture-exporter"]);
        settings.setProjectTrusted(true);
        settings.setProjectPackages(["npm:fixture-exporter"]);
        await settings.flush();
        const exporters = await listInstalledMetricsExporters();
        assertEquals(
            exporters.map((entry) => entry.entryPath),
            [await fsRealpath(join(userPackage, "exporter.js"))],
        );
        const [exporter] = exporters;
        await setCustomSetting(
            "metricsExporterApprovals",
            [{ ...exporter, approvedAt: new Date().toISOString() }],
            "project",
        );
        assertEquals(await resolveApprovedMetricsExporters(), []);
        await approveMetricsExporter(exporter);
        assertEquals((await resolveApprovedMetricsExporters())[0].entryPath, exporter.entryPath);
        assertEquals((await resolveApprovedMetricsExporters()).length, 1);
    });
});

test("missing version binds approval to an empty version and local file edits keep it", async () => {
    await withExporterFixture(async ({ packageRoot }) => {
        const path = join(packageRoot, "package.json");
        const manifest = JSON.parse(await fsReadFile(path, "utf8"));
        delete manifest.version;
        await fsWriteFile(path, JSON.stringify(manifest));
        const settings = getSettingsManager();
        settings.setPackages([packageRoot]);
        await settings.flush();
        const [exporter] = await listInstalledMetricsExporters();
        assertEquals(exporter.version, "");
        await approveMetricsExporter(exporter);
        await fsWriteFile(join(packageRoot, "exporter.js"), "throw new Error('changed local code');\n");
        assertEquals((await resolveApprovedMetricsExporters()).length, 1);
        const saved = getCustomSetting("metricsExporterApprovals", "global");
        assert(typeof saved[0].approvedAt === "string");
    });
});
