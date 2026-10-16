import { rejects } from "node:assert/strict";
import { test } from "node:test";
import {
    lstat as fsLstat,
    mkdir as fsMkdir,
    readFile as fsReadFile,
    realpath as fsRealpath,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { env } from "node:process";
import { assertEquals, assertRejects, assertStringIncludes } from "../testing/assertions.ts";
import { dirname, join } from "node:path";
import { withProcessGlobalTestLock } from "../testing/process-global-lock.ts";
import { defineCommittedGitFixture } from "./git-test-fixture.ts";
import {
    enterProjectRuntime,
    ProjectRuntimeEntryRefusedError,
    resolveProjectRuntimeLayout,
} from "./project-runtime-layout.ts";
import { listEntries } from "./worktree-registry.js";

const fixture = defineCommittedGitFixture({ "README.md": "# runtime entry\n" });

test("Project Runtime Entry adopts legacy registry before normal registry reads", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalSandboxHome = env.WLD_TEST_SANDBOX_HOME;
        const projectRoot = await fixture.checkout({ prefix: "runwield-runtime-entry-adopt-" });
        try {
            delete env.WLD_TEST_SANDBOX_HOME;
            const legacyPath = join(projectRoot, ".wld", "worktrees.json");
            await fsMkdir(dirname(legacyPath), { recursive: true });
            await fsWriteFile(
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
            const markerBefore = await fsReadFile(layout.primary.layoutMarkerPath, "utf8");
            await enterProjectRuntime(projectRoot);
            const markerAfter = await fsReadFile(layout.primary.layoutMarkerPath, "utf8");

            assertEquals(entries.map((entry) => entry.id), ["entry-1"]);
            assertEquals(markerAfter, markerBefore);
            await rejects(() => fsLstat(legacyPath), { code: "ENOENT" });
        } finally {
            if (originalSandboxHome === undefined) delete env.WLD_TEST_SANDBOX_HOME;
            else env.WLD_TEST_SANDBOX_HOME = originalSandboxHome;
            await fsRm(projectRoot, { recursive: true }).catch(() => {});
        }
    });
});

test("Project Runtime Entry reconciles gitignore and reports broad wld rules", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalSandboxHome = env.WLD_TEST_SANDBOX_HOME;
        const projectRoot = await fixture.checkout({ prefix: "runwield-runtime-entry-gitignore-" });
        const originalWarn = console.warn;
        const warnings: string[] = [];
        try {
            delete env.WLD_TEST_SANDBOX_HOME;
            console.warn = (message) => warnings.push(String(message));
            await fsWriteFile(join(projectRoot, ".gitignore"), ".wld/\n.wld/plan-locks\n");

            await enterProjectRuntime(projectRoot);
            const first = await fsReadFile(join(projectRoot, ".gitignore"), "utf8");
            await enterProjectRuntime(projectRoot);
            const second = await fsReadFile(join(projectRoot, ".gitignore"), "utf8");

            assertEquals(
                first,
                ".wld/\n# BEGIN RunWield owned runtime state\n.wld/internal/\n# END RunWield owned runtime state\n",
            );
            assertEquals(second, first);
            assertStringIncludes(warnings[0], ".wld/settings.json");
            assertStringIncludes(warnings[0], join(await fsRealpath(projectRoot), ".gitignore"));
            await Promise.all([enterProjectRuntime(projectRoot), enterProjectRuntime(projectRoot)]);
            await fsWriteFile(join(projectRoot, ".gitignore"), `${first}# Unrelated edit\n`);
            await enterProjectRuntime(projectRoot);
            assertEquals(warnings.length, 1);
        } finally {
            console.warn = originalWarn;
            if (originalSandboxHome === undefined) delete env.WLD_TEST_SANDBOX_HOME;
            else env.WLD_TEST_SANDBOX_HOME = originalSandboxHome;
            await fsRm(projectRoot, { recursive: true }).catch(() => {});
        }
    });
});

test("Project Runtime Entry reports changed warnings independently per project", async () => {
    await withProcessGlobalTestLock(async () => {
        const firstRoot = await fixture.checkout({ prefix: "runwield-ignore-warning-first-" });
        const secondRoot = await fixture.checkout({ prefix: "runwield-ignore-warning-second-" });
        const originalWarn = console.warn;
        const warnings: string[] = [];
        try {
            console.warn = (message) => warnings.push(String(message));
            for (const root of [firstRoot, secondRoot]) {
                await fsWriteFile(join(root, ".gitignore"), ".wld/\n");
                await enterProjectRuntime(root);
            }
            assertEquals(warnings.length, 2);
            assertStringIncludes(warnings[0], join(await fsRealpath(firstRoot), ".gitignore"));
            assertStringIncludes(warnings[1], join(await fsRealpath(secondRoot), ".gitignore"));

            await fsWriteFile(join(firstRoot, ".gitignore"), "/.wld/\n");
            await enterProjectRuntime(firstRoot);
            assertEquals(warnings.length, 3);
            assertStringIncludes(warnings[2], "rule /.wld/");

            await fsWriteFile(join(firstRoot, ".gitignore"), "");
            await enterProjectRuntime(firstRoot);
            assertEquals(warnings.length, 3);
            await fsWriteFile(join(firstRoot, ".gitignore"), "/.wld/\n");
            await enterProjectRuntime(firstRoot);
            await enterProjectRuntime(secondRoot);
            assertEquals(warnings.length, 4);
            assertStringIncludes(warnings[3], "rule /.wld/");
        } finally {
            console.warn = originalWarn;
            await fsRm(firstRoot, { recursive: true });
            await fsRm(secondRoot, { recursive: true });
        }
    });
});

test("Project Runtime Entry refusal stops direct normal registry access", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalSandboxHome = env.WLD_TEST_SANDBOX_HOME;
        const projectRoot = await fixture.checkout({ prefix: "runwield-runtime-entry-refuse-" });
        try {
            delete env.WLD_TEST_SANDBOX_HOME;
            const legacyPath = join(projectRoot, ".wld", "worktrees.json");
            await fsMkdir(dirname(legacyPath), { recursive: true });
            await fsWriteFile(legacyPath, "null\n");

            const refusal = await assertRejects(
                () => listEntries(projectRoot, { migrate: false }),
                ProjectRuntimeEntryRefusedError,
            );
            const layout = resolveProjectRuntimeLayout(projectRoot);

            assertEquals(refusal.reason, "malformed_registry");
            assertEquals(refusal.paths, [join(await fsRealpath(projectRoot), ".wld", "worktrees.json")]);
            await rejects(() => fsLstat(layout.primary.worktreeRegistryPath), { code: "ENOENT" });
            await rejects(() => fsLstat(layout.primary.layoutMarkerPath), { code: "ENOENT" });
        } finally {
            if (originalSandboxHome === undefined) delete env.WLD_TEST_SANDBOX_HOME;
            else env.WLD_TEST_SANDBOX_HOME = originalSandboxHome;
            await fsRm(projectRoot, { recursive: true }).catch(() => {});
        }
    });
});
