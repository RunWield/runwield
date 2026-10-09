import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { withProcessGlobalTestLock } from "../testing/process-global-lock.ts";
import { defineCommittedGitFixture } from "./git-test-fixture.ts";
import {
    enterProjectRuntime,
    ProjectRuntimeEntryRefusedError,
    resolveProjectRuntimeLayout,
} from "./project-runtime-layout.ts";
import { listEntries } from "./worktree-registry.js";

const fixture = defineCommittedGitFixture({ "README.md": "# runtime entry\n" });

Deno.test("Project Runtime Entry adopts legacy registry before normal registry reads", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalSandboxHome = Deno.env.get("WLD_TEST_SANDBOX_HOME");
        const projectRoot = await fixture.checkout({ prefix: "runwield-runtime-entry-adopt-" });
        try {
            Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            const legacyPath = join(projectRoot, ".wld", "worktrees.json");
            await Deno.mkdir(dirname(legacyPath), { recursive: true });
            await Deno.writeTextFile(
                legacyPath,
                `${
                    JSON.stringify(
                        {
                            version: 2,
                            entries: [{
                                id: "entry-1",
                                planName: "demo-plan",
                                planId: "plan-demo",
                                baseBranch: "main",
                                baseRef: "HEAD",
                                baseCommit: "abc123",
                                branch: "runwield/worktree/demo-plan-entry-1",
                                path: projectRoot,
                                status: "active",
                                createdAt: "2026-01-01T00:00:00.000Z",
                                updatedAt: "2026-01-01T00:00:00.000Z",
                            }],
                        },
                        null,
                        2,
                    )
                }\n`,
            );

            const entries = await listEntries(projectRoot, { migrate: false });
            const layout = resolveProjectRuntimeLayout(projectRoot);
            const markerBefore = await Deno.readTextFile(layout.primary.layoutMarkerPath);
            await enterProjectRuntime(projectRoot);
            const markerAfter = await Deno.readTextFile(layout.primary.layoutMarkerPath);

            assertEquals(entries.map((entry) => entry.id), ["entry-1"]);
            assertEquals(markerAfter, markerBefore);
            await assertRejects(() => Deno.lstat(legacyPath), Deno.errors.NotFound);
        } finally {
            if (originalSandboxHome === undefined) Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            else Deno.env.set("WLD_TEST_SANDBOX_HOME", originalSandboxHome);
            await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
        }
    });
});

Deno.test("Project Runtime Entry reconciles gitignore and reports broad wld rules", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalSandboxHome = Deno.env.get("WLD_TEST_SANDBOX_HOME");
        const projectRoot = await fixture.checkout({ prefix: "runwield-runtime-entry-gitignore-" });
        const originalWarn = console.warn;
        const warnings: string[] = [];
        try {
            Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            console.warn = (message) => warnings.push(String(message));
            await Deno.writeTextFile(join(projectRoot, ".gitignore"), ".wld/\n.wld/plan-locks\n");

            await enterProjectRuntime(projectRoot);
            const first = await Deno.readTextFile(join(projectRoot, ".gitignore"));
            await enterProjectRuntime(projectRoot);
            const second = await Deno.readTextFile(join(projectRoot, ".gitignore"));

            assertEquals(
                first,
                ".wld/\n# BEGIN RunWield owned runtime state\n.wld/internal/\n# END RunWield owned runtime state\n",
            );
            assertEquals(second, first);
            assertStringIncludes(warnings[0], ".wld/settings.json");
            assertStringIncludes(warnings[0], join(await Deno.realPath(projectRoot), ".gitignore"));
            await Promise.all([enterProjectRuntime(projectRoot), enterProjectRuntime(projectRoot)]);
            await Deno.writeTextFile(join(projectRoot, ".gitignore"), `${first}# Unrelated edit\n`);
            await enterProjectRuntime(projectRoot);
            assertEquals(warnings.length, 1);
        } finally {
            console.warn = originalWarn;
            if (originalSandboxHome === undefined) Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            else Deno.env.set("WLD_TEST_SANDBOX_HOME", originalSandboxHome);
            await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
        }
    });
});

Deno.test("Project Runtime Entry reports changed warnings independently per project", async () => {
    await withProcessGlobalTestLock(async () => {
        const firstRoot = await fixture.checkout({ prefix: "runwield-ignore-warning-first-" });
        const secondRoot = await fixture.checkout({ prefix: "runwield-ignore-warning-second-" });
        const originalWarn = console.warn;
        const warnings: string[] = [];
        try {
            console.warn = (message) => warnings.push(String(message));
            for (const root of [firstRoot, secondRoot]) {
                await Deno.writeTextFile(join(root, ".gitignore"), ".wld/\n");
                await enterProjectRuntime(root);
            }
            assertEquals(warnings.length, 2);
            assertStringIncludes(warnings[0], join(await Deno.realPath(firstRoot), ".gitignore"));
            assertStringIncludes(warnings[1], join(await Deno.realPath(secondRoot), ".gitignore"));

            await Deno.writeTextFile(join(firstRoot, ".gitignore"), "/.wld/\n");
            await enterProjectRuntime(firstRoot);
            assertEquals(warnings.length, 3);
            assertStringIncludes(warnings[2], "rule /.wld/");

            await Deno.writeTextFile(join(firstRoot, ".gitignore"), "");
            await enterProjectRuntime(firstRoot);
            assertEquals(warnings.length, 3);
            await Deno.writeTextFile(join(firstRoot, ".gitignore"), "/.wld/\n");
            await enterProjectRuntime(firstRoot);
            await enterProjectRuntime(secondRoot);
            assertEquals(warnings.length, 4);
            assertStringIncludes(warnings[3], "rule /.wld/");
        } finally {
            console.warn = originalWarn;
            await Deno.remove(firstRoot, { recursive: true });
            await Deno.remove(secondRoot, { recursive: true });
        }
    });
});

Deno.test("Project Runtime Entry refusal stops direct normal registry access", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalSandboxHome = Deno.env.get("WLD_TEST_SANDBOX_HOME");
        const projectRoot = await fixture.checkout({ prefix: "runwield-runtime-entry-refuse-" });
        try {
            Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            const legacyPath = join(projectRoot, ".wld", "worktrees.json");
            await Deno.mkdir(dirname(legacyPath), { recursive: true });
            await Deno.writeTextFile(legacyPath, "null\n");

            const refusal = await assertRejects(
                () => listEntries(projectRoot, { migrate: false }),
                ProjectRuntimeEntryRefusedError,
            );
            const layout = resolveProjectRuntimeLayout(projectRoot);

            assertEquals(refusal.reason, "malformed_registry");
            assertEquals(refusal.paths, [join(await Deno.realPath(projectRoot), ".wld", "worktrees.json")]);
            await assertRejects(() => Deno.lstat(layout.primary.worktreeRegistryPath), Deno.errors.NotFound);
            await assertRejects(() => Deno.lstat(layout.primary.layoutMarkerPath), Deno.errors.NotFound);
        } finally {
            if (originalSandboxHome === undefined) Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            else Deno.env.set("WLD_TEST_SANDBOX_HOME", originalSandboxHome);
            await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
        }
    });
});
