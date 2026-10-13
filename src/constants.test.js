import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { mkdtemp as fsMkdtemp, readdir as fsReaddir, readFile as fsReadFile, rm as fsRm } from "node:fs/promises";
import process from "node:process";
import { ok as assert, notDeepStrictEqual as assertNotEquals } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "./testing/assertions.ts";
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

test("bundled resource constants point to file-readable assets", async () => {
    assertStringIncludes(await fsReadFile(CATPPUCCIN_MOCHA_THEME_PATH, "utf8"), "catppuccin-mocha");
    assertStringIncludes(await fsReadFile(SYSTEM_PROMPT_TEMPLATE_PATH, "utf8"), "{{AGENT_PROMPT}}");

    for (const dir of [AGENT_DEFS_DIR, PROMPT_TEMPLATES_DIR, SKILLS_DIR, SNIP_FILTERS_DIR]) {
        const entries = [];
        for await (const entry of await fsReaddir(dir, { withFileTypes: true })) entries.push(entry.name);
        assert(entries.length > 0);
    }
});

// Regression: HOME used to be snapshotted into a `const HOME_DIR` at module
// load. Deno initializes each test module's realm at an arbitrary moment, so a
// realm that loaded before a test swapped HOME kept resolving to the real home
// — which is how test runs rewrote the developer's ~/.wld settings, sessions
// and workflow metrics. Home-derived paths must be resolved per call.

test("getHomeDir observes HOME changes made after module load", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-home-dir-"));
        try {
            process.env["HOME"] = tempHome;
            assertEquals(getHomeDir(), tempHome);
            assertNotEquals(getHomeDir(), originalHome);
        } finally {
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            await fsRm(tempHome, { recursive: true });
        }
        assertEquals(getHomeDir(), originalHome ?? "");
    });
});

test("project internal runtime directory name stays below the project RunWield base", () => {
    assertEquals(PROJECT_INTERNAL_RUNTIME_DIR_NAME, "internal");
});

test("documentation Work Kind normalizes and labels planned documentation", () => {
    assertEquals(normalizeWorkKind("DOCUMENTATION"), "DOCUMENTATION");
    assertEquals(normalizeWorkKind("DOCS"), undefined);
    assertEquals(normalizeWorkKind(null), undefined);
    assertEquals(formatPlannedWorkLabel("DOCUMENTATION"), "Planned documentation");
});

test("test-module detection covers every convention deno test collects", () => {
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

test("home resolution is refused only for an unsandboxed test run", () => {
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
    assert(process.env["WLD_TEST_SANDBOX_HOME"], "Expected the suite itself to be sandboxed.");
    assertEquals(getHomeDir(), process.env["HOME"]);
});

test("home-derived paths follow a swapped HOME rather than a stale snapshot", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-home-derived-"));
        try {
            process.env["HOME"] = tempHome;
            // Workflow metrics leaked into the real ~/.wld, so assert it concretely.
            const metricsPath = getWorkflowMetricsFilePath("/some/project");
            assertEquals(metricsPath.startsWith(tempHome), true, `Expected ${metricsPath} under ${tempHome}.`);
            if (originalHome) assertEquals(metricsPath.startsWith(join(originalHome, ".wld")), false);
        } finally {
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            await fsRm(tempHome, { recursive: true });
        }
    });
});
