import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { runSnipFiltersCommand } from "./index.ts";

interface SnipFiltersFixture {
    homeDir: string;
    projectRoot: string;
}

async function withSnipFiltersFixture(run: (fixture: SnipFiltersFixture) => Promise<void>): Promise<void> {
    await withProcessGlobalTestLock(async () => {
        const previousHome = Deno.env.get("HOME");
        const previousSandboxHome = Deno.env.get("WLD_TEST_SANDBOX_HOME");
        const previousCwd = Deno.cwd();
        const previousExitCode = Deno.exitCode;
        const fixtureRoot = await Deno.makeTempDir({ prefix: "runwield-snip-filters-command-" });
        const homeDir = join(fixtureRoot, "home");
        const projectRoot = join(fixtureRoot, "project");
        await Promise.all([
            Deno.mkdir(homeDir, { recursive: true }),
            Deno.mkdir(projectRoot, { recursive: true }),
        ]);

        try {
            Deno.env.set("HOME", homeDir);
            Deno.env.set("WLD_TEST_SANDBOX_HOME", homeDir);
            Deno.chdir(projectRoot);
            Deno.exitCode = 0;
            await run({ homeDir, projectRoot });
        } finally {
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

async function captureConsole(run: () => Promise<void>): Promise<{ logs: string; errors: string }> {
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
    return { logs: logs.join("\n"), errors: errors.join("\n") };
}

Deno.test("runSnipFiltersCommand installs, reports, and cleans up real filters in a fixture home", async () => {
    await withSnipFiltersFixture(async ({ homeDir, projectRoot }) => {
        assertEquals(await Deno.realPath(Deno.cwd()), await Deno.realPath(projectRoot));
        const filtersDir = join(homeDir, ".config", "snip", "filters");
        const conflictPath = join(filtersDir, "deno-lint.yaml");
        const managedPath = join(filtersDir, "deno-test.yaml");
        await Deno.mkdir(filtersDir, { recursive: true });
        await Deno.writeTextFile(conflictPath, "name: user-deno-lint\n");

        const installOutput = await captureConsole(() => runSnipFiltersCommand(["install"]));
        assertEquals(installOutput.errors, "");
        assertStringIncludes(installOutput.logs, `Installed RunWield Snip filters into ${filtersDir}`);
        assertStringIncludes(installOutput.logs, managedPath);
        assertStringIncludes(installOutput.logs, `${conflictPath} (existing non-RunWield filter)`);
        assertStringIncludes(await Deno.readTextFile(managedPath), "# Managed by RunWield");
        assertEquals(await Deno.readTextFile(conflictPath), "name: user-deno-lint\n");

        const statusOutput = await captureConsole(() => runSnipFiltersCommand([]));
        assertEquals(statusOutput.errors, "");
        assertStringIncludes(statusOutput.logs, `RunWield Snip filter status in ${filtersDir}`);
        assertStringIncludes(statusOutput.logs, `Conflicts:\n- ${conflictPath}`);
        assertStringIncludes(statusOutput.logs, "Missing:\nnone");

        const cleanupOutput = await captureConsole(() => runSnipFiltersCommand(["cleanup"]));
        assertEquals(cleanupOutput.errors, "");
        assertStringIncludes(cleanupOutput.logs, `Cleaned up RunWield Snip filters from ${filtersDir}`);
        assertStringIncludes(cleanupOutput.logs, managedPath);
        await assertRejects(() => Deno.stat(managedPath), Deno.errors.NotFound);
        assertEquals(await Deno.readTextFile(conflictPath), "name: user-deno-lint\n");
        assertEquals(Deno.exitCode, 0);
    });
});

Deno.test("runSnipFiltersCommand reports an unknown action without terminating the test process", async () => {
    await withSnipFiltersFixture(async () => {
        const output = await captureConsole(() => runSnipFiltersCommand(["wat"]));

        assertEquals(output.logs, "");
        assertEquals(output.errors, "Usage: wld snip-filters [install|cleanup|status]");
        assertEquals(Deno.exitCode, 1);
    });
});
