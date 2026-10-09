import { join } from "@std/path";
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
        const previousHome = Deno.env.get("HOME");
        const previousSandboxHome = Deno.env.get("WLD_TEST_SANDBOX_HOME");
        const previousCwd = Deno.cwd();
        const fixtureRoot = await Deno.makeTempDir({ prefix });
        const homeDir = join(fixtureRoot, "home");
        const projectRoot = join(fixtureRoot, "project");
        await Promise.all([
            Deno.mkdir(homeDir, { recursive: true }),
            Deno.mkdir(projectRoot, { recursive: true }),
        ]);

        try {
            Deno.env.set("HOME", homeDir);
            Deno.env.set("WLD_TEST_SANDBOX_HOME", homeDir);
            Deno.chdir(await Deno.realPath(projectRoot));
            await run({ homeDir, projectRoot: Deno.cwd() });
        } finally {
            Deno.chdir(previousCwd);
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            if (previousSandboxHome === undefined) Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            else Deno.env.set("WLD_TEST_SANDBOX_HOME", previousSandboxHome);
            await Deno.remove(fixtureRoot, { recursive: true }).catch(() => {});
        }
    });
}
