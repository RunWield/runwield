import { assertEquals, assertNotStrictEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { join } from "@std/path";
import { getRunWieldRuntimeDir } from "../constants.js";
import { listPlans, loadPlan, savePlan } from "../plan-store.js";
import { withProcessGlobalTestLock } from "../testing/process-global-lock.ts";
import { defineCommittedGitFixture, git } from "./git-test-fixture.ts";
import {
    enterProjectRuntime,
    ProjectRuntimeEntryRefusedError,
    withProjectRuntimeReadScope,
} from "./project-runtime-layout.ts";
import { writeControllerState } from "./workflow/controller-registry.ts";
import { listEntries } from "./worktree-registry.js";

const fixture = defineCommittedGitFixture({ "README.md": "# Runtime read scope\n" });

Deno.test("runtime read scope shares checkout verification but rechecks changed evidence on the next read", async () => {
    const root = await fixture.checkout({ prefix: "runwield-runtime-read-scope-" });
    try {
        const layout = await withProjectRuntimeReadScope(async () => {
            const first = enterProjectRuntime(root);
            assertStrictEquals(enterProjectRuntime(root), first);
            const verified = await first;
            assertStrictEquals(await enterProjectRuntime(root), verified);
            return await withProjectRuntimeReadScope(() => enterProjectRuntime(root));
        });
        const marker = await Deno.readTextFile(layout.primary.layoutMarkerPath);
        await Deno.writeTextFile(layout.primary.layoutMarkerPath, "{invalid");
        await assertRejects(
            () => withProjectRuntimeReadScope(() => enterProjectRuntime(root)),
            ProjectRuntimeEntryRefusedError,
        );
        await Deno.writeTextFile(layout.primary.layoutMarkerPath, marker);
        const refreshed = await withProjectRuntimeReadScope(() => enterProjectRuntime(root));
        assertNotStrictEquals(refreshed, layout);
        assertEquals(refreshed.primary.checkoutRoot, layout.primary.checkoutRoot);
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("runtime read scope verifies different checkouts independently", async () => {
    const first = await fixture.checkout({ prefix: "runwield-runtime-read-first-" });
    const second = await fixture.checkout({ prefix: "runwield-runtime-read-second-" });
    try {
        await withProjectRuntimeReadScope(async () => {
            const layouts = await Promise.all([enterProjectRuntime(first), enterProjectRuntime(second)]);
            assertNotStrictEquals(layouts[0], layouts[1]);
            assertEquals(layouts[0].primary.checkoutRoot, await Deno.realPath(first));
            assertEquals(layouts[1].primary.checkoutRoot, await Deno.realPath(second));
        });
    } finally {
        await Deno.remove(first, { recursive: true });
        await Deno.remove(second, { recursive: true });
    }
});

interface GitTraceEvent {
    event: string;
    argv?: string[];
}

interface TracedProject {
    root: string;
    listings: () => Promise<number>;
}

async function withTracedProject(run: (project: TracedProject) => Promise<void>) {
    await withProcessGlobalTestLock(async () => {
        const root = await fixture.checkout();
        const trace = await Deno.makeTempFile({ prefix: "runwield-runtime-git-trace-" });
        const previous = Deno.env.get("GIT_TRACE2_EVENT");
        try {
            await enterProjectRuntime(root);
            Deno.env.set("GIT_TRACE2_EVENT", trace);
            await run({
                root,
                listings: async () => {
                    const lines = (await Deno.readTextFile(trace)).trim().split("\n").filter(Boolean);
                    const events: GitTraceEvent[] = lines.map((line) => JSON.parse(line));
                    return events.filter((event) =>
                        event.event === "start" && event.argv?.slice(-3).join(" ") === "worktree list --porcelain"
                    ).length;
                },
            });
        } finally {
            if (previous === undefined) Deno.env.delete("GIT_TRACE2_EVENT");
            else Deno.env.set("GIT_TRACE2_EVENT", previous);
            await Deno.remove(trace);
            await Deno.remove(root, { recursive: true });
        }
    });
}

async function recreateLegacyDebug(root: string, name: string) {
    const directory = join(getRunWieldRuntimeDir(root), "debug");
    await Deno.mkdir(directory, { recursive: true });
    await Deno.writeTextFile(join(directory, name), name);
}

Deno.test("bounded runtime reads share real Git inspection and refresh after settlement", async () => {
    await withTracedProject(async ({ root, listings }) => {
        await withProjectRuntimeReadScope(async () => {
            await Promise.all([enterProjectRuntime(root), enterProjectRuntime(root)]);
            await withProjectRuntimeReadScope(() => enterProjectRuntime(root));
        });
        assertEquals(await listings(), 1);
        await withProjectRuntimeReadScope(() => enterProjectRuntime(root));
        assertEquals(await listings(), 2);
        await enterProjectRuntime(root);
        assertEquals(await listings(), 3);
    });
});

Deno.test("Plan lists share validation without caching Plan or controller contents", async () => {
    await withTracedProject(async ({ root, listings }) => {
        for (const name of ["first", "second", "third"]) {
            await savePlan(root, name, `# ${name}\n`, { planId: name, status: "draft" });
        }
        const before = await listings();
        assertEquals((await listPlans(root)).length, 3);
        assertEquals(await listings() - before, 1);
        const first = await loadPlan(root, "first");
        await writeControllerState(root, { planName: "first", planId: first?.attrs.planId }, {
            validationCiAttempts: 2,
        });
        assertEquals((await loadPlan(root, "first"))?.attrs.validationCiAttempts, 2);
        const runtimeFile = join(root, ".wld", "debug", "tracked.txt");
        await Deno.mkdir(join(root, ".wld", "debug"), { recursive: true });
        await Deno.writeTextFile(runtimeFile, "must be detected after the previous read\n");
        await git(root, ["add", "-f", ".wld/debug/tracked.txt"]);
        await assertRejects(() => listPlans(root), ProjectRuntimeEntryRefusedError);
    });
});

Deno.test("registry lists share inspection within a read and reject newly staged runtime on the next read", async () => {
    await withTracedProject(async ({ root, listings }) => {
        assertEquals(await listEntries(root), []);
        assertEquals(await listings(), 1);
        assertEquals(await listEntries(root), []);
        assertEquals(await listings(), 2);
        const runtimeFile = join(root, ".wld", "debug", "tracked.txt");
        await Deno.mkdir(join(root, ".wld", "debug"), { recursive: true });
        await Deno.writeTextFile(runtimeFile, "newly staged runtime must be detected\n");
        await git(root, ["add", "-f", ".wld/debug/tracked.txt"]);
        await assertRejects(() => listEntries(root), ProjectRuntimeEntryRefusedError);
        await git(root, ["reset", "--", ".wld/debug/tracked.txt"]);
        assertEquals(await listEntries(root), []);
    });
});

Deno.test("controller writes revalidate and invalidate surrounding runtime reads", async () => {
    await withTracedProject(async ({ root }) => {
        await withProjectRuntimeReadScope(async () => {
            const layout = await enterProjectRuntime(root);
            await recreateLegacyDebug(root, "before-write.txt");
            await writeControllerState(root, { planId: "test", planName: "test" }, { validationCiAttempts: 1 });
            assertEquals(
                await Deno.readTextFile(join(layout.primary.debugRoot, "before-write.txt")),
                "before-write.txt",
            );
            await recreateLegacyDebug(root, "after-write.txt");
            await enterProjectRuntime(root);
            assertEquals(await Deno.readTextFile(join(layout.primary.debugRoot, "after-write.txt")), "after-write.txt");
        });
    });
});

Deno.test("detached async reads cannot retain a completed runtime validation scope", async () => {
    await withTracedProject(async ({ root }) => {
        const resume = Promise.withResolvers<void>();
        const continuation = { result: Promise.resolve() };
        await withProjectRuntimeReadScope(async () => {
            await enterProjectRuntime(root);
            continuation.result = (async () => {
                await resume.promise;
                const layout = await withProjectRuntimeReadScope(() => enterProjectRuntime(root));
                assertEquals(await Deno.readTextFile(join(layout.primary.debugRoot, "later.txt")), "later.txt");
            })();
        });
        await recreateLegacyDebug(root, "later.txt");
        resume.resolve();
        await continuation.result;
    });
});

Deno.test("failed runtime read scopes expire before an inherited continuation resumes", async () => {
    await withTracedProject(async ({ root }) => {
        const resume = Promise.withResolvers<void>();
        const continuation = { result: Promise.resolve() };
        await assertRejects(
            () =>
                withProjectRuntimeReadScope(async () => {
                    await enterProjectRuntime(root);
                    continuation.result = (async () => {
                        await resume.promise;
                        const layout = await enterProjectRuntime(root);
                        assertEquals(await Deno.readTextFile(join(layout.primary.debugRoot, "retry.txt")), "retry.txt");
                    })();
                    throw new Error("read failed");
                }),
            Error,
            "read failed",
        );
        await recreateLegacyDebug(root, "retry.txt");
        resume.resolve();
        await continuation.result;
    });
});

Deno.test("runtime read scope retries failed validation after the evidence is repaired", async () => {
    await withTracedProject(async ({ root }) => {
        const layout = await enterProjectRuntime(root);
        const marker = await Deno.readTextFile(layout.primary.layoutMarkerPath);
        await withProjectRuntimeReadScope(async () => {
            await Deno.writeTextFile(layout.primary.layoutMarkerPath, "{invalid");
            await assertRejects(() => enterProjectRuntime(root), ProjectRuntimeEntryRefusedError);
            await Deno.writeTextFile(layout.primary.layoutMarkerPath, marker);
            assertEquals((await enterProjectRuntime(root)).primary.checkoutRoot, layout.primary.checkoutRoot);
        });
    });
});
