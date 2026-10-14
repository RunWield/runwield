import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { spawnNativeProcess } from "../../shared/foreground-process.ts";
import { readFileSync, chmodSync } from "node:fs";
import { stat as fsStat, chmod as fsChmod, readFile as fsReadFile, rename as fsRename } from "node:fs/promises";
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
import { join, relative } from "node:path";
import { DefaultResourceLoader, type PackageSource } from "@earendil-works/pi-coding-agent";
import {
    listInstalledMetricsExporters,
    resolveApprovedMetricsExporters,
} from "../../shared/extensions/metrics-exporter.ts";
import { runRemoveCommand } from "../remove/index.ts";
import { resolveInstalledWldExtensionResources } from "../../shared/extensions/wld-extension-manifest.js";
import {
    resolveConfiguredUserPackageSource,
    resolveInstalledPackagePromptResources,
} from "../../shared/package-resources.ts";
import { __resetSettingsForTests, getSettingsDir, getSettingsManager } from "../../shared/settings.js";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { discoverAndRegisterThemes, getAvailableThemes, initRunWieldTheme } from "../../ui/theme/theme.js";
import { runInstallCommand } from "./index.ts";

type ExtensionKind = "none" | "compatible" | "incompatible";

interface InstallPackageFixtureOptions {
    extension: ExtensionKind;
    passiveResources?: boolean;
    exporter?: boolean;
}

interface InstallCommandFixture {
    homeDir: string;
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
        await fsWriteFile(
            join(packageDir, "extensions", "index.js"),
            `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(
                join(packageDir, "loaded"),
            )}, "loaded");\nexport default () => {};\n`,
        );
        if (options.extension === "compatible") {
            pi.wld = {
                compatible: true,
                extensionApi: 1,
                kind: "code-extension",
            };
        }
    }

    if (options.exporter) {
        await fsWriteFile(
            join(packageDir, "exporter.js"),
            `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(
                join(packageDir, "exporter-loaded"),
            )}, "loaded");\nexport default () => {};\n`,
        );
    }

    await fsWriteFile(
        join(packageDir, "package.json"),
        JSON.stringify({
            name: "fixture-install-package",
            version: "1.0.0",
            pi,
            ...(options.exporter
                ? { wld: { metricsExporter: { contract: 1, id: "fixture", entry: "./exporter.js" } } }
                : {}),
        }),
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
                homeDir,
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
            const saved = JSON.parse(readFileSync(join(getSettingsDir("global"), "settings.json"), "utf8"));
            assertEquals(saved.packages[0].extensions, []);
            prompts.push(message);
            return "yes";
        };

        const output = await captureConsole(() => runInstallCommand([source]));

        assertEquals(output.errors, []);
        assertEquals(prompts, [`Enable extensions from ${source} for loading? [y/N] `]);
        assert(output.logs.includes("  WLD-compatible code extensions enabled: 1"));
        const installed = await resolveInstalledWldExtensionResources();
        assertEquals(
            installed.map((resource) => resource.path),
            [join(packageDir, "extensions", "index.js")],
        );
        assertEquals(await markerExists(join(packageDir, "loaded")), false);
        await freshSessionLoader();
        assertEquals(await markerExists(join(packageDir, "loaded")), true);
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
        assertEquals(output.errors, ["Usage: wld install <source>", "Sources: npm:<spec>, git:<url>, <path>"]);
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

async function markerExists(path: string): Promise<boolean> {
    try {
        return (await fsStat(path)).isFile();
    } catch {
        return false;
    }
}

// Match Session startup: Pi autoloading off, only RunWield-approved resource paths supplied.
async function freshSessionLoader(): Promise<DefaultResourceLoader> {
    __resetSettingsForTests();
    const extensions = await resolveInstalledWldExtensionResources();
    const prompts = await resolveInstalledPackagePromptResources();
    const loader = new DefaultResourceLoader({
        cwd: getCwd(),
        agentDir: getSettingsDir("global"),
        settingsManager: getSettingsManager(),
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        additionalExtensionPaths: extensions.map((resource) => resource.path),
        additionalPromptTemplatePaths: prompts.map((resource) => resource.path),
    });
    await loader.reload();
    await discoverAndRegisterThemes();
    assertEquals(loader.getExtensions().errors, []);
    assertEquals(loader.getSkills().skills, []);
    return loader;
}

for (const outcome of ["n", "true", "", null, "throw"] as const) {
    test(`install keeps code disabled and exporter unapproved after ${String(outcome)}`, async () => {
        await withInstallCommandFixture(
            { extension: "compatible", passiveResources: true, exporter: true },
            async ({ packageDir }) => {
                globalThis.prompt = () => {
                    if (outcome === "throw") throw new Error("input interrupted");
                    return outcome;
                };
                const output = await captureConsole(() => runInstallCommand([packageDir]));
                assertEquals(output.errors, []);
                const loader = await freshSessionLoader();
                assertEquals(await markerExists(join(packageDir, "loaded")), false);
                assertEquals(await markerExists(join(packageDir, "exporter-loaded")), false);
                assertEquals(
                    loader.getPrompts().prompts.map((prompt) => prompt.name),
                    ["fixture"],
                );
                assert(getAvailableThemes().includes("fixture-install-theme"));
                assertEquals(
                    (await listInstalledMetricsExporters()).map((exporter) => exporter.approved),
                    [false],
                );
                assertEquals(await resolveApprovedMetricsExporters(), []);
            },
        );
    });
}

for (const answers of [
    ["yes", "n"],
    ["n", "yes"],
    ["yes", "yes"],
]) {
    test(`extension/exporter consent is separate: ${answers.join("/")}`, async () => {
        await withInstallCommandFixture({ extension: "compatible", exporter: true }, async ({ packageDir }) => {
            const remaining = [...answers];
            globalThis.prompt = () => remaining.shift() || "";
            const output = await captureConsole(() => runInstallCommand([packageDir]));
            assertEquals(output.errors, []);
            assertEquals(remaining, []);
            await freshSessionLoader();
            assertEquals(await markerExists(join(packageDir, "loaded")), answers[0] === "yes");
            assertEquals((await resolveApprovedMetricsExporters()).length, answers[1] === "yes" ? 1 : 0);
            assertEquals(await markerExists(join(packageDir, "exporter-loaded")), false);
        });
    });
}

for (const choice of ["enabled", "disabled", "filtered"] as const) {
    test(`reinstall preserves ${choice} choices for relative and absolute input`, async () => {
        await withInstallCommandFixture(
            { extension: "compatible", passiveResources: true },
            async ({ source, projectRoot }) => {
                const settings = getSettingsManager();
                const entry: PackageSource =
                    choice === "enabled"
                        ? source
                        : {
                              source,
                              extensions: choice === "disabled" ? [] : ["extensions/index.js"],
                              themes: ["themes/*.json"],
                              prompts: [],
                              skills: [],
                          };
                const unrelated = { source: join(projectRoot, "unrelated"), extensions: [], themes: [] };
                await fsMkdir(unrelated.source);
                await fsWriteFile(join(unrelated.source, "package.json"), "{}");
                settings.setPackages([entry, unrelated]);
                settings.setTheme("catppuccin-mocha");
                await settings.flush();
                const before = settings.getGlobalSettings();
                let prompts = 0;
                globalThis.prompt = () => {
                    prompts++;
                    return "yes";
                };
                for (const input of [source, relative(projectRoot, source)]) {
                    const output = await captureConsole(() => runInstallCommand([input]));
                    assertEquals(output.errors, []);
                    if (choice !== "enabled") assert(output.logs.includes("  Prompt templates available: 0"));
                    assertEquals(settings.getGlobalSettings(), before);
                    assertEquals(prompts, 0);
                }
            },
        );
    });
}

test("failed physical install creates no package registration", async () => {
    await withInstallCommandFixture({ extension: "none" }, async ({ projectRoot }) => {
        await captureConsole(() => runInstallCommand([join(projectRoot, "missing")]));
        __resetSettingsForTests();
        assertEquals(getSettingsManager().getGlobalSettings().packages || [], []);
    });
});

test("read-only settings fail installation without reporting executable success", async () => {
    if ((process.platform === "win32" ? "windows" : process.platform) === "windows") return;
    await withInstallCommandFixture({ extension: "compatible", exporter: true }, async ({ packageDir }) => {
        const dir = getSettingsDir("global");
        await fsMkdir(dir, { recursive: true });
        await fsWriteFile(join(dir, "settings.json"), "{}");
        getSettingsManager();
        await fsChmod(dir, 0o555);
        try {
            let prompts = 0;
            globalThis.prompt = () => {
                prompts++;
                return "yes";
            };
            const output = await captureConsole(() => runInstallCommand([packageDir]));
            assertEquals(prompts, 0);
            assertEquals(process.exitCode, 1);
            assert(output.errors.some((line) => line.startsWith("Installation failed:")));
            assertEquals(
                output.logs.some((line) => /enabled:|approved:/.test(line)),
                false,
            );
        } finally {
            await fsChmod(dir, 0o755);
        }
    });
});

test("exporter version change and removal require a new approval", async () => {
    await withInstallCommandFixture({ extension: "none", exporter: true }, async ({ packageDir, projectRoot }) => {
        let promptCount = 0;
        globalThis.prompt = () => {
            promptCount++;
            return "yes";
        };
        await runInstallCommand([packageDir]);
        assertEquals((await resolveApprovedMetricsExporters()).length, 1);
        await runInstallCommand([packageDir]);
        assertEquals(promptCount, 1);
        const path = join(packageDir, "package.json");
        const manifest = JSON.parse(await fsReadFile(path, "utf8"));
        manifest.version = "2.0.0";
        await fsWriteFile(path, JSON.stringify(manifest));
        assertEquals((await listInstalledMetricsExporters())[0].approved, false);
        await runInstallCommand([packageDir]);
        assertEquals(promptCount, 2);
        assertEquals((await resolveApprovedMetricsExporters())[0].version, "2.0.0");
        await runRemoveCommand([relative(projectRoot, packageDir)]);
        assertEquals(await resolveApprovedMetricsExporters(), []);
        await runInstallCommand([packageDir]);
        assertEquals(promptCount, 3);
    });
});

async function interruptInstallAtPrompt(
    packageDir: string,
    homeDir: string,
    projectRoot: string,
    exporterPrompt: boolean,
) {
    const script = join(projectRoot, "interrupt-install.ts");
    const installUrl = new URL("./index.ts", import.meta.url).href;
    await fsWriteFile(
        script,
        `
        import { runInstallCommand } from ${JSON.stringify(installUrl)};
        globalThis.prompt = (question) => {
            if (${exporterPrompt} && question.startsWith("Enable")) return "n";
            console.log("INSTALL_PROMPT_REACHED");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
            return "n";
        };
        await runInstallCommand([${JSON.stringify(packageDir)}]);
    `,
    );
    const child = spawnNativeProcess(process.execPath, {
        args: runtimeSourceArgs([
            "run",
            "-A",
            "--config",
            new URL("../../../deno.json", import.meta.url).pathname,
            script,
        ]),
        cwd: projectRoot,
        env: { HOME: homeDir, WLD_TEST_SANDBOX_HOME: homeDir },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
    });
    const reader = child.stdout.getReader();
    const stderr = new Response(child.stderr).text();
    const timeout = setTimeout(() => {
        try {
            child.kill("SIGKILL");
        } catch {
            /* already exited */
        }
    }, 20000);
    let text = "";
    try {
        while (!text.includes("INSTALL_PROMPT_REACHED")) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error(`Install exited before prompt: ${text}\n${await stderr}`);
            text += new TextDecoder().decode(chunk.value);
        }
    } finally {
        clearTimeout(timeout);
        try {
            child.kill("SIGKILL");
        } catch {
            /* already exited */
        }
        while (!(await reader.read()).done) {
            /* drain */
        }
        reader.releaseLock();
        await child.status;
        await stderr;
    }
}

for (const exporterPrompt of [false, true]) {
    test(`killing install at the ${exporterPrompt ? "exporter" : "extension"} prompt keeps code disabled`, async () => {
        await withInstallCommandFixture(
            { extension: "compatible", passiveResources: true, exporter: true },
            async ({ packageDir, homeDir, projectRoot }) => {
                await interruptInstallAtPrompt(packageDir, homeDir, projectRoot, exporterPrompt);
                const loader = await freshSessionLoader();
                assertEquals(await markerExists(join(packageDir, "loaded")), false);
                assertEquals(await markerExists(join(packageDir, "exporter-loaded")), false);
                assertEquals(
                    loader.getPrompts().prompts.map((prompt) => prompt.name),
                    ["fixture"],
                );
                assert(getAvailableThemes().includes("fixture-install-theme"));
                assertEquals(
                    (await listInstalledMetricsExporters()).map((entry) => entry.approved),
                    [false],
                );
            },
        );
    });
}

test("Session loader ignores exporter-only code in a Pi auto-discovered extensions directory", async () => {
    await withInstallCommandFixture({ extension: "none", exporter: true }, async ({ packageDir }) => {
        await fsMkdir(join(packageDir, "extensions"));
        await fsRename(join(packageDir, "exporter.js"), join(packageDir, "extensions", "exporter.js"));
        const manifestPath = join(packageDir, "package.json");
        const manifest = JSON.parse(await fsReadFile(manifestPath, "utf8"));
        delete manifest.pi;
        manifest.wld.metricsExporter.entry = "./extensions/exporter.js";
        await fsWriteFile(manifestPath, JSON.stringify(manifest));
        let prompts = 0;
        globalThis.prompt = () => {
            prompts++;
            return "yes";
        };
        await runInstallCommand([packageDir]);
        assertEquals(prompts, 0);
        assertEquals(await resolveInstalledWldExtensionResources(), []);
        await freshSessionLoader();
        assertEquals(await markerExists(join(packageDir, "exporter-loaded")), false);
    });
});

test("acceptance saves only compatible candidate paths", async () => {
    await withInstallCommandFixture({ extension: "compatible" }, async ({ packageDir }) => {
        const incompatibleRoot = join(packageDir, "extensions");
        await fsWriteFile(join(incompatibleRoot, "untrusted.js"), "throw new Error('must not load');\n");
        const manifestPath = join(packageDir, "package.json");
        const manifest = JSON.parse(await fsReadFile(manifestPath, "utf8"));
        manifest.pi.extensions = ["extensions/*.js", "!extensions/untrusted.js"];
        await fsWriteFile(manifestPath, JSON.stringify(manifest));
        globalThis.prompt = () => "yes";
        const output = await captureConsole(() => runInstallCommand([packageDir]));
        assertEquals(output.errors, []);
        const entry = getSettingsManager().getGlobalSettings().packages![0];
        assert(typeof entry !== "string");
        assertEquals(entry.extensions, ["extensions/index.js"]);
        await freshSessionLoader();
        assertEquals(await markerExists(join(packageDir, "loaded")), true);
    });
});

for (const failurePrompt of ["extension", "exporter"] as const) {
    test(`failed ${failurePrompt} approval write reports failure and saves no executable grant`, async () => {
        if ((process.platform === "win32" ? "windows" : process.platform) === "windows") return;
        await withInstallCommandFixture({ extension: "compatible", exporter: true }, async ({ packageDir }) => {
            const dir = getSettingsDir("global");
            globalThis.prompt = (question = "") => {
                if (failurePrompt === "exporter" && question.startsWith("Enable")) return "n";
                chmodSync(dir, 0o555);
                return "yes";
            };
            try {
                const output = await captureConsole(() => runInstallCommand([packageDir]));
                assertEquals(process.exitCode, 1);
                assert(output.errors.some((line) => line.startsWith("Installation failed:")));
                assertEquals(
                    output.logs.some((line) => /enabled:|approved:/.test(line)),
                    false,
                );
            } finally {
                await fsChmod(dir, 0o755);
            }
            await freshSessionLoader();
            assertEquals(await markerExists(join(packageDir, "loaded")), false);
            assertEquals(await resolveApprovedMetricsExporters(), []);
        });
    });
}

test("exporter approval accepts a trimmed single-letter yes", async () => {
    await withInstallCommandFixture({ extension: "none", exporter: true }, async ({ packageDir }) => {
        globalThis.prompt = () => " Y ";
        const output = await captureConsole(() => runInstallCommand([packageDir]));
        assertEquals(output.errors, []);
        assert(output.logs.includes("  Metrics exporter approved: fixture"));
        __resetSettingsForTests();
        assertEquals((await resolveApprovedMetricsExporters()).length, 1);
    });
});

test("package matching keeps saved npm choices even when its installed directory is absent", async () => {
    await withInstallCommandFixture({ extension: "none" }, async () => {
        const settings = getSettingsManager();
        const entry = { source: "npm:fixture-not-installed@1.0.0", extensions: [], prompts: ["prompts/*.md"] };
        settings.setPackages([entry]);
        await settings.flush();
        assertEquals(resolveConfiguredUserPackageSource("npm:fixture-not-installed@2.0.0"), entry.source);
        assertEquals(settings.getGlobalSettings().packages, [entry]);
    });
});
