import { readFile as fsReadFile } from "node:fs/promises";
import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    realpath as fsRealpath,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { getCwd } from "../../constants.js";
import process from "node:process";
import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import { ok as assert } from "node:assert/strict";
import { join } from "node:path";
import {
    approveMetricsExporter,
    listInstalledMetricsExporters,
    type MetricsExporterApproval,
} from "../../shared/extensions/metrics-exporter.ts";
import {
    __resetSettingsForTests,
    getCustomSetting,
    getSettingsDir,
    getSettingsManager,
} from "../../shared/settings.js";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { discoverAndRegisterThemes, getAvailableThemes, initRunWieldTheme, setTheme } from "../../ui/theme/theme.js";
import { runRemoveCommand } from "./index.ts";

interface RemoveCommandFixture {
    homeDir: string;
    packageDir: string;
    projectRoot: string;
    source: string;
}

async function withRemoveCommandFixture(run: (fixture: RemoveCommandFixture) => Promise<void>): Promise<void> {
    await withProcessGlobalTestLock(async () => {
        const previousHome = process.env["HOME"];
        const previousSandboxHome = process.env["WLD_TEST_SANDBOX_HOME"];
        const previousCwd = getCwd();
        const previousExitCode = process.exitCode;
        const fixtureRoot = await fsMkdtemp(join(tmpdir(), "runwield-remove-command-"));
        const homeDir = join(await fsRealpath(fixtureRoot), "home");
        const packageDir = join(fixtureRoot, "fixture-theme-package");
        const projectRoot = join(fixtureRoot, "project");
        await Promise.all([
            fsMkdir(homeDir, { recursive: true }),
            fsMkdir(join(packageDir, "themes"), { recursive: true }),
            fsMkdir(projectRoot, { recursive: true }),
        ]);
        await fsWriteFile(
            join(packageDir, "package.json"),
            JSON.stringify({
                name: "fixture-theme-package",
                version: "1.0.0",
                pi: { themes: ["themes/*.json"] },
            }),
        );
        await fsWriteFile(
            join(packageDir, "themes", "fixture-theme.json"),
            JSON.stringify({
                name: "fixture-theme",
                vars: { fixtureAccent: "#abcdef" },
                colors: { accent: "fixtureAccent" },
            }),
        );
        const canonicalPackageDir = await fsRealpath(packageDir);
        const canonicalProjectRoot = await fsRealpath(projectRoot);

        try {
            process.env["HOME"] = homeDir;
            process.env["WLD_TEST_SANDBOX_HOME"] = homeDir;
            process.chdir(canonicalProjectRoot);
            process.exitCode = 0;
            __resetSettingsForTests();
            initRunWieldTheme();
            await run({
                homeDir,
                packageDir: canonicalPackageDir,
                projectRoot: canonicalProjectRoot,
                source: canonicalPackageDir,
            });
        } finally {
            initRunWieldTheme();
            __resetSettingsForTests();
            process.chdir(previousCwd);
            if (previousHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = previousHome;
            if (previousSandboxHome === undefined) delete process.env["WLD_TEST_SANDBOX_HOME"];
            else process.env["WLD_TEST_SANDBOX_HOME"] = previousSandboxHome;
            process.exitCode = previousExitCode;
            await fsRm(fixtureRoot, { recursive: true }).catch(() => {});
        }
    });
}

async function captureConsole(run: () => Promise<void>): Promise<{ logs: string[]; errors: string[] }> {
    const originalLog = console.log;
    const originalError = console.error;
    const logs: string[] = [];
    const errors: string[] = [];
    console.log = (message = "") => logs.push(String(message));
    console.error = (message = "") => errors.push(String(message));
    try {
        await run();
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
    return { logs, errors };
}

async function installFixturePackage(projectRoot: string, source: string): Promise<void> {
    const settings = getSettingsManager(projectRoot);
    const packageManager = new DefaultPackageManager({
        cwd: projectRoot,
        agentDir: getSettingsDir("global", projectRoot),
        settingsManager: settings,
    });
    await packageManager.installAndPersist(source);
}

test("runRemoveCommand unregisters a real local package and resets its active theme", async () => {
    await withRemoveCommandFixture(async ({ packageDir, projectRoot, source }) => {
        await installFixturePackage(projectRoot, source);
        const settings = getSettingsManager(projectRoot);
        await discoverAndRegisterThemes();
        assert(getAvailableThemes().includes("fixture-theme"));
        assertEquals(setTheme("fixture-theme").success, true);
        settings.setTheme("fixture-theme");

        const output = await captureConsole(() => runRemoveCommand([source]));

        assertEquals(output.errors, []);
        assertEquals(output.logs, [
            'Active theme "fixture-theme" was provided by the removed package — reset to catppuccin-mocha.',
            `Successfully removed ${source}`,
        ]);
        assertEquals(settings.getGlobalSettings().packages, []);
        assertEquals(settings.getTheme(), "catppuccin-mocha");
        assertEquals(getAvailableThemes().includes("fixture-theme"), false);
        assert((await fsStat(join(packageDir, "themes", "fixture-theme.json"))).isFile());
        assertEquals(process.exitCode, 0);
    });
});

test("runRemoveCommand removes a cwd-relative local source saved relative to the settings directory", async () => {
    await withRemoveCommandFixture(async ({ projectRoot }) => {
        const source = "../fixture-theme-package";
        await installFixturePackage(projectRoot, source);
        const settings = getSettingsManager(projectRoot);
        await settings.flush();
        assertEquals(settings.getGlobalSettings().packages, ["../../fixture-theme-package"]);

        const output = await captureConsole(() => runRemoveCommand([source]));

        assertEquals(output.errors, []);
        assertEquals(output.logs, [`Successfully removed ${source}`]);
        assertEquals(settings.getGlobalSettings().packages, []);
    });
});

test("runRemoveCommand reports a real local package that is not installed", async () => {
    await withRemoveCommandFixture(async ({ source }) => {
        const output = await captureConsole(() => runRemoveCommand([source]));

        assertEquals(output.errors, []);
        assertEquals(output.logs, [`Package "${source}" is not currently installed — nothing to remove.`]);
        assertEquals(process.exitCode, 0);
    });
});

test("runRemoveCommand reports usage without terminating the test process", async () => {
    await withRemoveCommandFixture(async () => {
        const output = await captureConsole(() => runRemoveCommand([]));

        assertEquals(output.logs, []);
        assertEquals(output.errors, ["Usage: wld remove <source>"]);
        assertEquals(process.exitCode, 1);
    });
});

test("runRemoveCommand deletes only the removed source's exporter approvals", async () => {
    await withRemoveCommandFixture(async ({ packageDir, projectRoot, source }) => {
        const manifestPath = join(packageDir, "package.json");
        const manifest = JSON.parse(await fsReadFile(manifestPath, "utf8"));
        manifest.wld = { metricsExporter: { contract: 1, id: "fixture", entry: "./exporter.js" } };
        await fsWriteFile(manifestPath, JSON.stringify(manifest));
        await fsWriteFile(join(packageDir, "exporter.js"), "export default () => {};\n");
        await installFixturePackage(projectRoot, source);
        const other = join(projectRoot, "other-package");
        await fsMkdir(other);
        await fsWriteFile(join(other, "package.json"), JSON.stringify(manifest));
        await fsWriteFile(join(other, "exporter.js"), "export default () => {};\n");
        await installFixturePackage(projectRoot, other);
        await getSettingsManager().flush();
        for (const exporter of await listInstalledMetricsExporters()) await approveMetricsExporter(exporter);
        const before: MetricsExporterApproval[] = getCustomSetting("metricsExporterApprovals", "global");
        assertEquals(before.length, 2);
        const output = await captureConsole(() => runRemoveCommand([source]));
        assertEquals(output.errors, []);
        assertEquals(
            getCustomSetting("metricsExporterApprovals", "global"),
            before.filter((record) => record.installedPath === other),
        );
    });
});
