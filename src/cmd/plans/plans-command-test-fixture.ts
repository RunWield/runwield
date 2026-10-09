import { getCwd } from "../../constants.js";
import { mkdtemp as fsMkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { mkdir as fsMkdir, realpath as fsRealpath, rm as fsRm } from "node:fs/promises";
import { join } from "node:path";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";

export interface PlanCommandFixture {
    homeDir: string;
    projectRoot: string;
}

export async function withPlanCommandFixture(
    prefix: string,
    run: (fixture: PlanCommandFixture) => Promise<void>,
): Promise<void> {
    await withProcessGlobalTestLock(async () => {
        const previousHome = process.env["HOME"];
        const previousSandboxHome = process.env["WLD_TEST_SANDBOX_HOME"];
        const previousCwd = getCwd();
        const fixtureRoot = await fsMkdtemp(join(tmpdir(), prefix));
        const homeDir = join(fixtureRoot, "home");
        const projectRoot = join(fixtureRoot, "project");
        await Promise.all([
            fsMkdir(homeDir, { recursive: true }),
            fsMkdir(projectRoot, { recursive: true }),
        ]);

        try {
            process.env["HOME"] = homeDir;
            process.env["WLD_TEST_SANDBOX_HOME"] = homeDir;
            process.chdir(await fsRealpath(projectRoot));
            await run({ homeDir, projectRoot: getCwd() });
        } finally {
            process.chdir(previousCwd);
            if (previousHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = previousHome;
            if (previousSandboxHome === undefined) delete process.env["WLD_TEST_SANDBOX_HOME"];
            else process.env["WLD_TEST_SANDBOX_HOME"] = previousSandboxHome;
            await fsRm(fixtureRoot, { recursive: true }).catch(() => {});
        }
    });
}
