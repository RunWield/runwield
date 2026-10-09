import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import {
    AGENT_DEFS_DIR,
    CATPPUCCIN_MOCHA_THEME_PATH,
    describeUnsandboxedTestRun,
    formatPlannedWorkLabel,
    getHomeDir,
    isTestModulePath,
    normalizeWorkKind,
    PROJECT_INTERNAL_RUNTIME_DIR_NAME,
    PROMPT_TEMPLATES_DIR,
    SKILLS_DIR,
    SNIP_FILTERS_DIR,
    SYSTEM_PROMPT_TEMPLATE_PATH,
} from "./constants.js";
import { getWorkflowMetricsFilePath } from "./shared/workflow/metrics.js";
import { withProcessGlobalTestLock } from "./testing/process-global-lock.ts";

Deno.test("bundled resource constants point to file-readable assets", async () => {
    assertStringIncludes(await Deno.readTextFile(CATPPUCCIN_MOCHA_THEME_PATH), "catppuccin-mocha");
    assertStringIncludes(await Deno.readTextFile(SYSTEM_PROMPT_TEMPLATE_PATH), "{{AGENT_PROMPT}}");

    for (const dir of [AGENT_DEFS_DIR, PROMPT_TEMPLATES_DIR, SKILLS_DIR, SNIP_FILTERS_DIR]) {
        const entries = [];
        for await (const entry of Deno.readDir(dir)) entries.push(entry.name);
        assert(entries.length > 0);
    }
});

// Regression: HOME used to be snapshotted into a `const HOME_DIR` at module
// load. Deno initializes each test module's realm at an arbitrary moment, so a
// realm that loaded before a test swapped HOME kept resolving to the real home
// — which is how test runs rewrote the developer's ~/.wld settings, sessions
// and workflow metrics. Home-derived paths must be resolved per call.

Deno.test("getHomeDir observes HOME changes made after module load", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = Deno.env.get("HOME");
        const tempHome = await Deno.makeTempDir({ prefix: "runwield-home-dir-" });
        try {
            Deno.env.set("HOME", tempHome);
            assertEquals(getHomeDir(), tempHome);
            assertNotEquals(getHomeDir(), originalHome);
        } finally {
            if (originalHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", originalHome);
            await Deno.remove(tempHome, { recursive: true });
        }
        assertEquals(getHomeDir(), originalHome ?? "");
    });
});

Deno.test("project internal runtime directory name stays below the project RunWield base", () => {
    assertEquals(PROJECT_INTERNAL_RUNTIME_DIR_NAME, "internal");
});

Deno.test("documentation Work Kind normalizes and labels planned documentation", () => {
    assertEquals(normalizeWorkKind("DOCUMENTATION"), "DOCUMENTATION");
    assertEquals(normalizeWorkKind("DOCS"), undefined);
    assertEquals(normalizeWorkKind(null), undefined);
    assertEquals(formatPlannedWorkLabel("DOCUMENTATION"), "Planned documentation");
});

Deno.test("test-module detection covers every convention deno test collects", () => {
    // A convention missing here is a test realm where the real-home guard is
    // inert. src/cmd/init/*_test.js slipped past an `.endsWith(".test.js")`
    // check and wrote into a real ~/.wld.
    for (
        const path of [
            "/repo/src/foo.test.js",
            "/repo/src/foo_test.js",
            "/repo/src/test.js",
            "/repo/src/foo.test.ts",
            "/repo/src/foo_test.tsx",
            "/repo/src/cmd/init/init-state_test.js",
        ]
    ) {
        assert(isTestModulePath(path), `Expected ${path} to be treated as a test module.`);
    }

    for (const path of ["/repo/src/constants.js", "/repo/src/testing.js", "/repo/src/latest.js", "/repo/src/cli.ts"]) {
        assertEquals(isTestModulePath(path), false, `Expected ${path} not to be treated as a test module.`);
    }
});

Deno.test("home resolution is refused only for an unsandboxed test run", () => {
    // Asserted as a pure rule: deleting WLD_TEST_SANDBOX_HOME for real would
    // make every concurrent test's getHomeDir() throw.
    const message = describeUnsandboxedTestRun({ isTestRealm: true, sandboxHome: "", homeDir: "/Users/someone" });
    assertStringIncludes(String(message), "during an unsandboxed test run");

    // Sandboxed run: any home is fine, including a fictional one used for path math.
    for (const homeDir of ["/tmp/sandbox-home", "/home/tester", "/Users/someone"]) {
        assertEquals(
            describeUnsandboxedTestRun({ isTestRealm: true, sandboxHome: "/tmp/sandbox-home", homeDir }),
            null,
        );
    }

    // Production (the wld binary) must never be gated by this.
    assertEquals(describeUnsandboxedTestRun({ isTestRealm: false, sandboxHome: "", homeDir: "/Users/someone" }), null);

    // And the suite it is running in really is sandboxed.
    assert(Deno.env.get("WLD_TEST_SANDBOX_HOME"), "Expected the suite itself to be sandboxed.");
    assertEquals(getHomeDir(), Deno.env.get("HOME"));
});

Deno.test("home-derived paths follow a swapped HOME rather than a stale snapshot", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = Deno.env.get("HOME");
        const tempHome = await Deno.makeTempDir({ prefix: "runwield-home-derived-" });
        try {
            Deno.env.set("HOME", tempHome);
            // Workflow metrics leaked into the real ~/.wld, so assert it concretely.
            const metricsPath = getWorkflowMetricsFilePath("/some/project");
            assertEquals(metricsPath.startsWith(tempHome), true, `Expected ${metricsPath} under ${tempHome}.`);
            if (originalHome) assertEquals(metricsPath.startsWith(originalHome), false);
        } finally {
            if (originalHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", originalHome);
            await Deno.remove(tempHome, { recursive: true });
        }
    });
});
