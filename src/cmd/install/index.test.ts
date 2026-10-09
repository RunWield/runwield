import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
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
            Deno.mkdir(join(packageDir, "prompts"), { recursive: true }),
            Deno.mkdir(join(packageDir, "skills", "fixture-skill"), { recursive: true }),
            Deno.mkdir(join(packageDir, "themes"), { recursive: true }),
        ]);
        await Promise.all([
            Deno.writeTextFile(join(packageDir, "prompts", "fixture.md"), "# Fixture prompt\n"),
            Deno.writeTextFile(join(packageDir, "skills", "fixture-skill", "SKILL.md"), "# Fixture skill\n"),
            Deno.writeTextFile(
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
        await Deno.mkdir(join(packageDir, "extensions"), { recursive: true });
        await Deno.writeTextFile(join(packageDir, "extensions", "index.js"), "export default () => ({});\n");
        if (options.extension === "compatible") {
            pi.wld = {
                compatible: true,
                extensionApi: 1,
                kind: "code-extension",
            };
        }
    }

    await Deno.writeTextFile(
        join(packageDir, "package.json"),
        JSON.stringify({ name: "fixture-install-package", version: "1.0.0", pi }),
    );
}

async function withInstallCommandFixture(
    options: InstallPackageFixtureOptions,
    run: (fixture: InstallCommandFixture) => Promise<void>,
): Promise<void> {
    await withProcessGlobalTestLock(async () => {
        const previousHome = Deno.env.get("HOME");
        const previousSandboxHome = Deno.env.get("WLD_TEST_SANDBOX_HOME");
        const previousCwd = Deno.cwd();
        const previousExitCode = Deno.exitCode;
        const previousPrompt = globalThis.prompt;
        const fixtureRoot = await Deno.makeTempDir({ prefix: "runwield-install-command-" });
        const homeDir = join(fixtureRoot, "home");
        const packageDir = join(fixtureRoot, "fixture-package");
        const projectRoot = join(fixtureRoot, "project");
        await Promise.all([
            Deno.mkdir(homeDir, { recursive: true }),
            Deno.mkdir(packageDir, { recursive: true }),
            Deno.mkdir(projectRoot, { recursive: true }),
        ]);
        await writeFixturePackage(packageDir, options);
        const canonicalPackageDir = await Deno.realPath(packageDir);
        const canonicalProjectRoot = await Deno.realPath(projectRoot);

        try {
            Deno.env.set("HOME", homeDir);
            Deno.env.set("WLD_TEST_SANDBOX_HOME", homeDir);
            Deno.chdir(canonicalProjectRoot);
            Deno.exitCode = 0;
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
            Deno.chdir(previousCwd);
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            if (previousSandboxHome === undefined) Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            else Deno.env.set("WLD_TEST_SANDBOX_HOME", previousSandboxHome);
            Deno.exitCode = previousExitCode;
            await Deno.remove(fixtureRoot, { recursive: true }).catch(() => {});
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

Deno.test("runInstallCommand installs and reports real local package resources", async () => {
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
            assertEquals(Deno.exitCode, 0);
        },
    );
});

Deno.test("runInstallCommand enables a compatible local extension after consent", async () => {
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

Deno.test("runInstallCommand disables a compatible local extension when consent is declined", async () => {
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

Deno.test("runInstallCommand reports usage without terminating the test process", async () => {
    await withInstallCommandFixture({ extension: "none" }, async () => {
        const output = await captureConsole(() => runInstallCommand([]));

        assertEquals(output.logs, []);
        assertEquals(output.errors, [
            "Usage: wld install <source>",
            "Sources: npm:<spec>, git:<url>, local:<path>",
        ]);
        assertEquals(Deno.exitCode, 1);
    });
});

Deno.test("runInstallCommand reports a real missing local package", async () => {
    await withInstallCommandFixture({ extension: "none" }, async ({ projectRoot }) => {
        const missingSource = join(projectRoot, "missing-package");
        const output = await captureConsole(() => runInstallCommand([missingSource]));

        assertEquals(output.logs, []);
        assertEquals(output.errors.length, 1);
        assertStringIncludes(output.errors[0], `Installation failed: Path does not exist: ${missingSource}`);
        assertEquals(Deno.exitCode, 1);
    });
});
