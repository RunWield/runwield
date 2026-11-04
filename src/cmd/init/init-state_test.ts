import { test } from "node:test";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { getCwd } from "../../constants.js";
import { assertEquals } from "../../testing/assertions.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import {
    getCwdInitState,
    isInitDone,
    isInitOffered,
    recordInitDone,
    recordInitOffered,
    recordSnipMissingWarningShown,
    shouldShowSnipMissingWarning,
} from "./init-state.ts";

interface ProjectFixture {
    first: string;
    second: string;
}
async function withProjects(run: (fixture: ProjectFixture) => Promise<void>) {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env.HOME;
        const originalCwd = getCwd();
        const home = await realpath(await mkdtemp(join(tmpdir(), "init-state-contract-")));
        const first = join(home, "first");
        const second = join(home, "second");
        await Promise.all([mkdir(first), mkdir(second)]);
        try {
            process.env.HOME = home;
            process.chdir(first);
            await run({ first, second });
        } finally {
            process.chdir(originalCwd);
            if (originalHome === undefined) delete process.env.HOME;
            else process.env.HOME = originalHome;
            await rm(home, { recursive: true, force: true });
        }
    });
}

test("initialization offer and completion survive reads without confusing separate projects", async () => {
    await withProjects(async ({ first, second }) => {
        assertEquals(await getCwdInitState(), undefined);
        assertEquals(await isInitOffered(), false);
        assertEquals(await isInitDone(), false);
        await recordInitOffered();
        assertEquals(await isInitOffered(), true);
        assertEquals(await isInitDone(), false);
        const offered = await getCwdInitState();
        assertEquals(typeof offered?.offeredAt, "string");
        assertEquals(offered?.doneAt, null);
        await recordInitDone();
        const completed = await getCwdInitState();
        assertEquals(completed?.path, first);
        assertEquals(completed?.offeredAt, offered?.offeredAt);
        assertEquals(typeof completed?.doneAt, "string");
        process.chdir(second);
        assertEquals(await getCwdInitState(), undefined);
        await recordInitOffered();
        assertEquals(await isInitDone(), false);
        process.chdir(first);
        assertEquals(await getCwdInitState(), completed);
        assertEquals(await isInitDone(), true);
    });
});

test("completing initialization also records an offer when none was previously made", async () => {
    await withProjects(async () => {
        await recordInitDone();
        assertEquals(await isInitOffered(), true);
        assertEquals(await isInitDone(), true);
        const state = await getCwdInitState();
        assertEquals(typeof state?.offeredAt, "string");
        assertEquals(typeof state?.doneAt, "string");
    });
});

test("missing Snip warnings stop at the limit without initializing the project or affecting another project", async () => {
    await withProjects(async ({ second }) => {
        assertEquals(await shouldShowSnipMissingWarning(2), true);
        await recordSnipMissingWarningShown();
        assertEquals(await shouldShowSnipMissingWarning(2), true);
        await recordSnipMissingWarningShown();
        assertEquals(await shouldShowSnipMissingWarning(2), false);
        assertEquals(await isInitOffered(), false);
        assertEquals(await isInitDone(), false);
        process.chdir(second);
        assertEquals(await shouldShowSnipMissingWarning(2), true);
    });
});
