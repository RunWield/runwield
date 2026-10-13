import { test } from "node:test";
import { tmpdir } from "node:os";
import { getCwd } from "../../constants.js";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    realpath as fsRealpath,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { resolveInstalledWldExtensionResources } from "../../shared/extensions/wld-extension-manifest.js";
import { resolveInstalledPackagePromptResources } from "../../shared/package-resources.ts";
import { __resetSettingsForTests, getSettingsManager } from "../../shared/settings.js";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { getAvailableThemes, initRunWieldTheme } from "../../ui/theme/theme.js";
import { runInstallCommand } from "./index.ts";

type ExtensionKind = "none" | "compatible" | "incompatible";

interface InstallPackageFixtureOptions {
    extension: ExtensionKind;
    passiveResources?: boolean;
}

interface InstallCommandFixture {
    packageDir: string;
    projectRoot: string;
    source: string;
}

interface PiFixtureManifest {
    extensions?: string[];
    prompts?: string[];
    skills?: string[];
    themes?: string[];
    wld?: {
        compatible: boolean;
        extensionApi: number;
        kind: string;
    };
}

async function writeFixturePackage(packageDir: string, options: InstallPackageFixtureOptions): Promise<void> {
    const pi: PiFixtureManifest = {};
    if (options.passiveResources) {
        pi.prompts = ["prompts/*.md"];
        pi.skills = ["skills"];
        pi.themes = ["themes/*.json"];
        await Promise.all([
            fsMkdir(join(packageDir, "prompts"), { recursive: true }),
            fsMkdir(join(packageDir, "skills", "fixture-skill"), { recursive: true }),
            fsMkdir(join(packageDir, "themes"), { recursive: true }),
        ]);
        await Promise.all([
            fsWriteFile(join(packageDir, "prompts", "fixture.md"), "# Fixture prompt\n"),
            fsWriteFile(join(packageDir, "skills", "fixture-skill", "SKILL.md"), "# Fixture skill\n"),
            fsWriteFile(
                join(packageDir, "themes", "fixture-theme.json"),
                JSON.stringify({
                    name: "fixture-install-theme",
                    vars: { fixtureAccent: "#abcdef" },
                    colors: { accent: "fixtureAccent" },
                }),
            ),
        ]);
    }

    if (options.extension !== "none") {
        pi.extensions = ["extensions/index.js"];
        await fsMkdir(join(packageDir, "extensions"), { recursive: true });
        await fsWriteFile(join(packageDir, "extensions", "index.js"), "export default () => ({});\n");
        if (options.extension === "compatible") {
            pi.wld = {
                compatible: true,
                extensionApi: 1,
                kind: "code-extension",
            };
        }
    }

    await fsWriteFile(
        join(packageDir, "package.json"),
        JSON.stringify({ name: "fixture-install-package", version: "1.0.0", pi }),
    );
}

async function withInstallCommandFixture(
    options: InstallPackageFixtureOptions,
    run: (fixture: InstallCommandFixture) => Promise<void>,
): Promise<void> {
    await withProcessGlobalTestLock(async () => {
        const previousHome = process.env["HOME"];
        const previousSandboxHome = process.env["WLD_TEST_SANDBOX_HOME"];
        const previousCwd = getCwd();
        const previousExitCode = process.exitCode;
        const previousPrompt = globalThis.prompt;
        const fixtureRoot = await fsMkdtemp(join(tmpdir(), "runwield-install-command-"));
        const homeDir = join(fixtureRoot, "home");
        const packageDir = join(fixtureRoot, "fixture-package");
        const projectRoot = join(fixtureRoot, "project");
        await Promise.all([
            fsMkdir(homeDir, { recursive: true }),
            fsMkdir(packageDir, { recursive: true }),
            fsMkdir(projectRoot, { recursive: true }),
        ]);
        await writeFixturePackage(packageDir, options);
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
                packageDir: canonicalPackageDir,
                projectRoot: canonicalProjectRoot,
                source: canonicalPackageDir,
            });
        } finally {
            globalThis.prompt = previousPrompt;
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

test("runInstallCommand installs and reports real local package resources", async () => {
    await withInstallCommandFixture(
        { extension: "incompatible", passiveResources: true },
        async ({ packageDir, projectRoot, source }) => {
            const output = await captureConsole(() => runInstallCommand([source]));

            assertEquals(output.errors, []);
            assertEquals(output.logs, [
                `Installed ${source}`,
                "  Themes registered: 1",
                "  Prompt templates available: 1",
                "  Code extensions ignored: 1 (missing pi.wld compatibility marker)",
                "  Skills ignored: 1 (RunWield does not load Pi package skills)",
                `  Install skills separately with: npx skills add ${source}`,
                "  Use -a/--agent to choose the target agent when needed.",
            ]);
            assertEquals(getSettingsManager(projectRoot).getGlobalSettings().packages?.length, 1);
            assertEquals(
                (await resolveInstalledPackagePromptResources()).map((resource) => resource.path),
                [join(packageDir, "prompts", "fixture.md")],
            );
            assert(getAvailableThemes().includes("fixture-install-theme"));
            assertEquals(process.exitCode, 0);
        },
    );
});

test("runInstallCommand enables a compatible local extension after consent", async () => {
    await withInstallCommandFixture({ extension: "compatible" }, async ({ packageDir, source }) => {
        const prompts: string[] = [];
        globalThis.prompt = (message = "") => {
            prompts.push(message);
            return "yes";
        };

        const output = await captureConsole(() => runInstallCommand([source]));

        assertEquals(output.errors, []);
        assertEquals(prompts, [`Enable extensions from ${source} for loading? [y/N] `]);
        assert(output.logs.includes("  WLD-compatible code extensions enabled: 1"));
        const installed = await resolveInstalledWldExtensionResources();
        assertEquals(installed.map((resource) => resource.path), [join(packageDir, "extensions", "index.js")]);
    });
});

test("runInstallCommand disables a compatible local extension when consent is declined", async () => {
    await withInstallCommandFixture({ extension: "compatible" }, async ({ projectRoot, source }) => {
        globalThis.prompt = () => "";

        const output = await captureConsole(() => runInstallCommand([source]));

        assertEquals(output.errors, []);
        assert(output.logs.includes("  WLD-compatible code extensions skipped: 1"));
        assertEquals(await resolveInstalledWldExtensionResources(), []);
        const packages = getSettingsManager(projectRoot).getGlobalSettings().packages || [];
        assertEquals(packages.length, 1);
        const installedPackage = packages[0];
        assert(typeof installedPackage !== "string");
        assertEquals(installedPackage.extensions, []);
    });
});

test("runInstallCommand reports usage without terminating the test process", async () => {
    await withInstallCommandFixture({ extension: "none" }, async () => {
        const output = await captureConsole(() => runInstallCommand([]));

        assertEquals(output.logs, []);
        assertEquals(output.errors, [
            "Usage: wld install <source>",
            "Sources: npm:<spec>, git:<url>, local:<path>",
        ]);
        assertEquals(process.exitCode, 1);
    });
});

test("runInstallCommand reports a real missing local package", async () => {
    await withInstallCommandFixture({ extension: "none" }, async ({ projectRoot }) => {
        const missingSource = join(projectRoot, "missing-package");
        const output = await captureConsole(() => runInstallCommand([missingSource]));

        assertEquals(output.logs, []);
        assertEquals(output.errors.length, 1);
        assertStringIncludes(output.errors[0], `Installation failed: Path does not exist: ${missingSource}`);
        assertEquals(process.exitCode, 1);
    });
});
