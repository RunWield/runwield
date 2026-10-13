import { test } from "node:test";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    realpath as fsRealpath,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { getCwd } from "../../constants.js";
import process from "node:process";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { runSnipFiltersCommand } from "./index.ts";

interface SnipFiltersFixture {
    homeDir: string;
    projectRoot: string;
}

async function withSnipFiltersFixture(run: (fixture: SnipFiltersFixture) => Promise<void>): Promise<void> {
    await withProcessGlobalTestLock(async () => {
        const previousHome = process.env["HOME"];
        const previousSandboxHome = process.env["WLD_TEST_SANDBOX_HOME"];
        const previousCwd = getCwd();
        const previousExitCode = process.exitCode;
        const fixtureRoot = await fsMkdtemp(join(tmpdir(), "runwield-snip-filters-command-"));
        const homeDir = join(fixtureRoot, "home");
        const projectRoot = join(fixtureRoot, "project");
        await Promise.all([
            fsMkdir(homeDir, { recursive: true }),
            fsMkdir(projectRoot, { recursive: true }),
        ]);

        try {
            process.env["HOME"] = homeDir;
            process.env["WLD_TEST_SANDBOX_HOME"] = homeDir;
            process.chdir(projectRoot);
            process.exitCode = 0;
            await run({ homeDir, projectRoot });
        } finally {
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

test("runSnipFiltersCommand installs, reports, and cleans up real filters in a fixture home", async () => {
    await withSnipFiltersFixture(async ({ homeDir, projectRoot }) => {
        assertEquals(await fsRealpath(getCwd()), await fsRealpath(projectRoot));
        const filtersDir = join(homeDir, ".config", "snip", "filters");
        const conflictPath = join(filtersDir, "deno-lint.yaml");
        const managedPath = join(filtersDir, "deno-test.yaml");
        await fsMkdir(filtersDir, { recursive: true });
        await fsWriteFile(conflictPath, "name: user-deno-lint\n");

        const installOutput = await captureConsole(() => runSnipFiltersCommand(["install"]));
        assertEquals(installOutput.errors, "");
        assertStringIncludes(installOutput.logs, `Installed RunWield Snip filters into ${filtersDir}`);
        assertStringIncludes(installOutput.logs, managedPath);
        assertStringIncludes(installOutput.logs, `${conflictPath} (existing non-RunWield filter)`);
        assertStringIncludes(await fsReadFile(managedPath, "utf8"), "# Managed by RunWield");
        assertEquals(await fsReadFile(conflictPath, "utf8"), "name: user-deno-lint\n");

        const statusOutput = await captureConsole(() => runSnipFiltersCommand([]));
        assertEquals(statusOutput.errors, "");
        assertStringIncludes(statusOutput.logs, `RunWield Snip filter status in ${filtersDir}`);
        assertStringIncludes(statusOutput.logs, `Conflicts:\n- ${conflictPath}`);
        assertStringIncludes(statusOutput.logs, "Missing:\nnone");

        const cleanupOutput = await captureConsole(() => runSnipFiltersCommand(["cleanup"]));
        assertEquals(cleanupOutput.errors, "");
        assertStringIncludes(cleanupOutput.logs, `Cleaned up RunWield Snip filters from ${filtersDir}`);
        assertStringIncludes(cleanupOutput.logs, managedPath);
        await assertRejects(() => fsStat(managedPath), Error, "ENOENT");
        assertEquals(await fsReadFile(conflictPath, "utf8"), "name: user-deno-lint\n");
        assertEquals(process.exitCode, 0);
    });
});

test("runSnipFiltersCommand reports an unknown action without terminating the test process", async () => {
    await withSnipFiltersFixture(async () => {
        const output = await captureConsole(() => runSnipFiltersCommand(["wat"]));

        assertEquals(output.logs, "");
        assertEquals(output.errors, "Usage: wld snip-filters [install|cleanup|status]");
        assertEquals(process.exitCode, 1);
    });
});
