import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { __resetSettingsForTests, getSettingsDir, getSettingsManager } from "../../shared/settings.js";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { DEFAULT_THEME_NAME, getAvailableThemes, initRunWieldTheme, setTheme, theme } from "../../ui/theme/theme.js";
import { runThemeCommand } from "./index.ts";

const FIXTURE_THEME_NAME = "fixture-command-theme";

interface ThemeCommandFixture {
    projectRoot: string;
    source: string;
}

interface CapturedConsole {
    logs: string[];
    errors: string[];
}

interface SelectionItem {
    value: string;
    label: string;
    description?: string;
}

interface SelectionHooks {
    onSelectionChange(value: string): void;
}

async function withThemeCommandFixture(run: (fixture: ThemeCommandFixture) => Promise<void>): Promise<void> {
    await withProcessGlobalTestLock(async () => {
        const previousHome = Deno.env.get("HOME");
        const previousSandboxHome = Deno.env.get("WLD_TEST_SANDBOX_HOME");
        const previousCwd = Deno.cwd();
        const previousExitCode = Deno.exitCode;
        const fixtureRoot = await Deno.makeTempDir({ prefix: "runwield-theme-command-" });
        const homeDir = join(fixtureRoot, "home");
        const packageDir = join(fixtureRoot, "fixture-theme-package");
        const projectRoot = join(fixtureRoot, "project");
        await Promise.all([
            Deno.mkdir(homeDir, { recursive: true }),
            Deno.mkdir(join(packageDir, "themes"), { recursive: true }),
            Deno.mkdir(projectRoot, { recursive: true }),
        ]);
        await Deno.writeTextFile(
            join(packageDir, "package.json"),
            JSON.stringify({
                name: "fixture-theme-command-package",
                version: "1.0.0",
                pi: { themes: ["themes/*.json"] },
            }),
        );
        await Deno.writeTextFile(
            join(packageDir, "themes", "fixture-theme.json"),
            JSON.stringify({
                name: FIXTURE_THEME_NAME,
                vars: { fixtureAccent: "#abcdef" },
                colors: { accent: "fixtureAccent" },
            }),
        );
        const canonicalPackageDir = await Deno.realPath(packageDir);
        const canonicalProjectRoot = await Deno.realPath(projectRoot);

        try {
            Deno.env.set("HOME", homeDir);
            Deno.env.set("WLD_TEST_SANDBOX_HOME", homeDir);
            Deno.chdir(canonicalProjectRoot);
            Deno.exitCode = 0;
            __resetSettingsForTests();
            initRunWieldTheme();
            await run({ projectRoot: canonicalProjectRoot, source: canonicalPackageDir });
        } finally {
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

async function installFixtureTheme(projectRoot: string, source: string): Promise<void> {
    const settings = getSettingsManager(projectRoot);
    const packageManager = new DefaultPackageManager({
        cwd: projectRoot,
        agentDir: getSettingsDir("global", projectRoot),
        settingsManager: settings,
    });
    await packageManager.installAndPersist(source);
}

async function captureConsole(run: () => Promise<void>): Promise<CapturedConsole> {
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

Deno.test("runThemeCommand prints real command help", async () => {
    await withThemeCommandFixture(async () => {
        const output = await captureConsole(() => runThemeCommand(["help"]));

        assertEquals(output.errors, []);
        assertEquals(output.logs.length, 1);
        assertStringIncludes(output.logs[0], "Usage (theme):");
        assertStringIncludes(output.logs[0], "wld theme --list");
    });
});

Deno.test("runThemeCommand lists a theme from a real local package", async () => {
    await withThemeCommandFixture(async ({ projectRoot, source }) => {
        await installFixtureTheme(projectRoot, source);

        const output = await captureConsole(() => runThemeCommand(["--list"]));

        assertEquals(output.errors, []);
        assertEquals(output.logs[0], "Available themes:");
        assert(output.logs.includes(` - ${DEFAULT_THEME_NAME}`));
        assert(output.logs.includes(` - ${FIXTURE_THEME_NAME}`));
        assert(getAvailableThemes().includes(FIXTURE_THEME_NAME));
    });
});

Deno.test("runThemeCommand switches to and persists a real installed theme", async () => {
    await withThemeCommandFixture(async ({ projectRoot, source }) => {
        await installFixtureTheme(projectRoot, source);

        const output = await captureConsole(() => runThemeCommand([FIXTURE_THEME_NAME]));

        assertEquals(output.errors, []);
        assertEquals(output.logs, [`Theme switched to ${FIXTURE_THEME_NAME}`]);
        assertEquals(getSettingsManager(projectRoot).getTheme(), FIXTURE_THEME_NAME);
        assertEquals(setTheme(FIXTURE_THEME_NAME).success, true);
        assertEquals(Deno.exitCode, 0);
    });
});

Deno.test("runThemeCommand rejects a theme that is not installed", async () => {
    await withThemeCommandFixture(async ({ projectRoot }) => {
        const output = await captureConsole(() => runThemeCommand(["missing-theme"]));

        assertEquals(output.logs, []);
        assertEquals(output.errors, [
            "Theme \"missing-theme\" not found. Run 'wld theme --list' to see available themes.",
        ]);
        assertEquals(getSettingsManager(projectRoot).getTheme(), undefined);
        assertEquals(Deno.exitCode, 1);
    });
});

Deno.test("runThemeCommand persists the theme selected through the user interaction port", async () => {
    await withThemeCommandFixture(async ({ projectRoot, source }) => {
        await installFixtureTheme(projectRoot, source);
        let offeredFixtureTheme = false;

        await runThemeCommand([], {
            uiAPI: {
                promptSelect: (_title: string, items: SelectionItem[], hooks: SelectionHooks) => {
                    offeredFixtureTheme = items.some((item) => item.value === FIXTURE_THEME_NAME);
                    hooks.onSelectionChange(FIXTURE_THEME_NAME);
                    return Promise.resolve(FIXTURE_THEME_NAME);
                },
            },
        });

        assert(offeredFixtureTheme);
        assertEquals(getSettingsManager(projectRoot).getTheme(), FIXTURE_THEME_NAME);
    });
});

Deno.test("runThemeCommand restores the persisted theme when selection is cancelled", async () => {
    await withThemeCommandFixture(async ({ projectRoot, source }) => {
        await installFixtureTheme(projectRoot, source);
        const settings = getSettingsManager(projectRoot);
        await captureConsole(() => runThemeCommand([FIXTURE_THEME_NAME]));
        const fixtureAccent = theme.fg("accent", "fixture");

        await runThemeCommand([], {
            uiAPI: {
                promptSelect: (_title: string, _items: SelectionItem[], hooks: SelectionHooks) => {
                    hooks.onSelectionChange(DEFAULT_THEME_NAME);
                    return Promise.resolve(null);
                },
            },
        });

        assertEquals(settings.getTheme(), FIXTURE_THEME_NAME);
        assertEquals(theme.fg("accent", "fixture"), fixtureAccent);
    });
});

Deno.test("runThemeCommand without arguments outside the TUI prints CLI guidance", async () => {
    await withThemeCommandFixture(async () => {
        const output = await captureConsole(() => runThemeCommand([]));

        assertEquals(output.errors, []);
        assertEquals(output.logs, ["Use 'wld theme <name>' or 'wld theme --list'"]);
    });
});
