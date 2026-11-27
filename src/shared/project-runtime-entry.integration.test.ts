import { enter, ProjectRuntimeEntryRefusedError } from "@runwield/project-runtime";
import { projects, type ProjectLaunchContext } from "@runwield/projects";
import { notEqual, ok, rejects } from "node:assert/strict";
import { test } from "node:test";
import {
    lstat as fsLstat,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    realpath as fsRealpath,
    rename as fsRename,
    rm as fsRm,
    symlink as fsSymlink,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { env } from "node:process";
import { assertEquals, assertRejects, assertStringIncludes } from "../testing/assertions.ts";
import { dirname, join } from "node:path";
import { withProcessGlobalTestLock } from "../testing/process-global-lock.ts";
import { defineCommittedGitFixture, git } from "./git-test-fixture.ts";
import { enterProjectRuntime } from "./project-runtime-layout.ts";
import { resolveProjectRuntimeLayout } from "@runwield/project-runtime/layout";
import { listEntries, prepareWorktreeRegistry } from "./worktree-registry.ts";
import { packageFixture } from "./testing/plan-package-fixture.ts";

const fixture = defineCommittedGitFixture({ "README.md": "# runtime entry\n" });

test("package runtime entry prepares only the supplied admitted checkout", async () => {
    const selected = await packageFixture();
    const foreign = await packageFixture();
    const moved = `${selected.root}-moved`;
    try {
        const expected = resolveProjectRuntimeLayout(selected.root);
        const other = resolveProjectRuntimeLayout(foreign.root);
        await rejects(
            enter({ ...selected.identity, cwd: foreign.identity.cwd, checkoutRoot: foreign.identity.checkoutRoot }),
            { name: "ProjectRuntimeEntryRefusedError", reason: "invalid_registered_checkout" },
        );
        await rejects(fsLstat(expected.primary.layoutMigrationLockPath), { code: "ENOENT" });
        await rejects(fsLstat(other.primary.layoutMigrationLockPath), { code: "ENOENT" });

        await fsRename(selected.root, moved);
        await rejects(enter(selected.identity), {
            name: "ProjectRuntimeEntryRefusedError",
            reason: "invalid_registered_checkout",
        });
        await rejects(fsLstat(expected.primary.layoutMigrationLockPath), { code: "ENOENT" });

        await fsRename(moved, selected.root);
        assertEquals(await enter(selected.identity), expected);
        assertStringIncludes(await fsReadFile(join(selected.root, ".gitignore"), "utf8"), ".wld/internal/");
        assertEquals((await fsLstat(expected.primary.layoutMarkerPath)).isFile(), true);
        await rejects(fsLstat(other.primary.layoutMarkerPath), { code: "ENOENT" });
    } finally {
        await Promise.all([selected.cleanup(), foreign.cleanup(), fsRm(moved, { recursive: true, force: true })]);
    }
});

test("package runtime entry uses the admitted launch outside that launch's context", async () => {
    const root = await fsRealpath(await fixture.checkout());
    const separateHome = await fsRealpath(await fsMkdtemp(join(tmpdir(), "runtime-separate-home-")));
    const context: ProjectLaunchContext = {
        executionAccountHome: separateHome,
        personalOwner: { kind: "execution-account", identity: separateHome },
    };
    try {
        const ambient = projects.launch.current();
        notEqual(ambient.executionAccountHome, separateHome);
        const admission = await projects.checkout.admit(root, { context });
        ok(admission.kind === "existing");
        const checkout = admission.identity;
        const layout = resolveProjectRuntimeLayout(root, { context });
        const ambientLayout = resolveProjectRuntimeLayout(root);

        await rejects(
            enter({
                ...checkout,
                executionAccountHome: ambient.executionAccountHome,
                personalOwner: ambient.personalOwner,
                configuredExecutionAccountHome: undefined,
                accountHomeDirectory: undefined,
            }),
            { name: "ProjectRuntimeEntryRefusedError", reason: "invalid_registered_checkout" },
        );
        await rejects(fsLstat(ambientLayout.primary.layoutMigrationLockPath), { code: "ENOENT" });
        await rejects(fsLstat(layout.primary.layoutMigrationLockPath), { code: "ENOENT" });

        assertEquals(await enter(checkout), layout);
        assertEquals((await fsLstat(layout.primary.layoutMarkerPath)).isFile(), true);
        await rejects(fsLstat(ambientLayout.primary.layoutMigrationLockPath), { code: "ENOENT" });
    } finally {
        await Promise.all([
            fsRm(root, { recursive: true, force: true }),
            fsRm(separateHome, { recursive: true, force: true }),
        ]);
    }
});

test("package runtime entry uses a managed owner only within its trusted launch", async () => {
    const root = await fsRealpath(await fixture.checkout());
    const separateHome = await fsRealpath(await fsMkdtemp(join(tmpdir(), "runtime-managed-home-")));
    const context: ProjectLaunchContext = {
        executionAccountHome: separateHome,
        personalOwner: { kind: "managed-remote", identity: "verified-laptop-account" },
    };
    try {
        const admission = await projects.checkout.admit(root, { context });
        ok(admission.kind === "existing");
        const checkout = admission.identity;
        const layout = resolveProjectRuntimeLayout(root, { context });
        await rejects(enter(checkout), {
            name: "ProjectRuntimeEntryRefusedError",
            reason: "invalid_registered_checkout",
        });
        await projects.launch.withContext(context, async () => {
            await rejects(
                enter({ ...checkout, personalOwner: { kind: "managed-remote", identity: "different-laptop" } }),
                { name: "ProjectRuntimeEntryRefusedError", reason: "invalid_registered_checkout" },
            );
            await rejects(fsLstat(join(separateHome, ".wld", "projects")), { code: "ENOENT" });
            assertEquals(await enter(checkout), layout);
        });
        assertEquals((await fsLstat(layout.primary.layoutMarkerPath)).isFile(), true);
    } finally {
        await Promise.all([root, separateHome].map((path) => fsRm(path, { recursive: true, force: true })));
    }
});

test(
    "package runtime entry refuses an admitted account home alias after retargeting",
    {
        skip: process.platform === "win32",
    },
    async () => {
        const root = await fsRealpath(await fixture.checkout());
        const homes = await fsRealpath(await fsMkdtemp(join(tmpdir(), "runtime-home-alias-")));
        const original = join(homes, "original");
        const replacement = join(homes, "replacement");
        const alias = join(homes, "alias");
        try {
            await Promise.all([fsMkdir(original), fsMkdir(replacement)]);
            await fsSymlink(original, alias);
            const context: ProjectLaunchContext = {
                executionAccountHome: alias,
                personalOwner: { kind: "execution-account", identity: alias },
            };
            const admission = await projects.checkout.admit(root, { context });
            ok(admission.kind === "existing");
            assertEquals(admission.identity.executionAccountHome, original);
            const layout = resolveProjectRuntimeLayout(root, { context });
            await fsRm(alias);
            await fsSymlink(replacement, alias);
            await rejects(enter(admission.identity), /execution account home changed/);
            await rejects(fsLstat(layout.primary.layoutMigrationLockPath), { code: "ENOENT" });
            await rejects(fsLstat(join(replacement, ".wld")), { code: "ENOENT" });
        } finally {
            await Promise.all([root, homes].map((path) => fsRm(path, { recursive: true, force: true })));
        }
    },
);

test("package runtime entry rejects a checkout ID from a linked checkout in the same Project", async () => {
    const root = await fsRealpath(await fixture.checkout());
    const linked = await fsRealpath(await fsMkdtemp(join(tmpdir(), "runtime-linked-identity-")));
    try {
        await git(root, ["worktree", "add", "-b", "runtime-linked-identity", linked]);
        const selected = await projects.checkout.admit(root);
        const other = await projects.checkout.admit(linked);
        ok(selected.kind === "existing" && other.kind === "existing");
        assertEquals(selected.identity.projectId, other.identity.projectId);
        assertEquals(selected.identity.repositoryId, other.identity.repositoryId);
        notEqual(selected.identity.checkoutId, other.identity.checkoutId);
        const selectedLayout = resolveProjectRuntimeLayout(root);
        const linkedLayout = resolveProjectRuntimeLayout(linked);
        await rejects(enter({ ...selected.identity, checkoutId: other.identity.checkoutId }), {
            name: "ProjectRuntimeEntryRefusedError",
            reason: "invalid_registered_checkout",
        });
        for (const layout of [selectedLayout, linkedLayout]) {
            await rejects(fsLstat(layout.primary.layoutMigrationLockPath), { code: "ENOENT" });
            await rejects(fsLstat(layout.selected.internalRoot), { code: "ENOENT" });
        }
        await rejects(fsLstat(join(root, ".gitignore")), { code: "ENOENT" });
        await rejects(fsLstat(join(linked, ".gitignore")), { code: "ENOENT" });
        assertEquals(await enter(other.identity), linkedLayout);
    } finally {
        await Promise.all([root, linked].map((path) => fsRm(path, { recursive: true, force: true })));
    }
});

test("Project Runtime Entry adopts legacy registry before normal registry reads", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalSandboxHome = env.WLD_TEST_SANDBOX_HOME;
        const originalHome = env.HOME;
        const personalHome = await fsMkdtemp(join(tmpdir(), "runtime-entry-home-"));
        const projectRoot = await fixture.checkout({ prefix: "runwield-runtime-entry-adopt-" });
        try {
            env.HOME = personalHome;
            delete env.WLD_TEST_SANDBOX_HOME;
            const legacyPath = join(projectRoot, ".wld", "worktrees.json");
            await fsMkdir(dirname(legacyPath), { recursive: true });
            await fsWriteFile(
                legacyPath,
                `${JSON.stringify(
                    {
                        version: 2,
                        entries: [
                            {
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
                            },
                        ],
                    },
                    null,
                    2,
                )}\n`,
            );

            await assertRejects(() => listEntries(projectRoot), Error, "Workflow details pending");
            const entries = await prepareWorktreeRegistry(projectRoot);
            const layout = resolveProjectRuntimeLayout(projectRoot);
            const markerBefore = await fsReadFile(layout.primary.layoutMarkerPath, "utf8");
            await enterProjectRuntime(projectRoot);
            const markerAfter = await fsReadFile(layout.primary.layoutMarkerPath, "utf8");

            assertEquals(
                entries.map((entry) => entry.id),
                ["entry-1"],
            );
            assertEquals(markerAfter, markerBefore);
            await rejects(() => fsLstat(legacyPath), { code: "ENOENT" });
        } finally {
            if (originalHome === undefined) delete env.HOME;
            else env.HOME = originalHome;
            await fsRm(personalHome, { recursive: true, force: true });
            if (originalSandboxHome === undefined) delete env.WLD_TEST_SANDBOX_HOME;
            else env.WLD_TEST_SANDBOX_HOME = originalSandboxHome;
            await fsRm(projectRoot, { recursive: true }).catch(() => {});
        }
    });
});

test("Project Runtime Entry reconciles gitignore and reports broad wld rules", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalSandboxHome = env.WLD_TEST_SANDBOX_HOME;
        const originalHome = env.HOME;
        const personalHome = await fsMkdtemp(join(tmpdir(), "runtime-entry-home-"));
        const projectRoot = await fixture.checkout({ prefix: "runwield-runtime-entry-gitignore-" });
        const originalWarn = console.warn;
        const warnings: string[] = [];
        try {
            env.HOME = personalHome;
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
            if (originalHome === undefined) delete env.HOME;
            else env.HOME = originalHome;
            await fsRm(personalHome, { recursive: true, force: true });
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
        const originalHome = env.HOME;
        const personalHome = await fsMkdtemp(join(tmpdir(), "runtime-entry-home-"));
        const projectRoot = await fixture.checkout({ prefix: "runwield-runtime-entry-refuse-" });
        try {
            env.HOME = personalHome;
            delete env.WLD_TEST_SANDBOX_HOME;
            const legacyPath = join(projectRoot, ".wld", "worktrees.json");
            await fsMkdir(dirname(legacyPath), { recursive: true });
            await fsWriteFile(legacyPath, "null\n");

            const refusal = await assertRejects(() => listEntries(projectRoot), ProjectRuntimeEntryRefusedError);
            const layout = resolveProjectRuntimeLayout(projectRoot);

            assertEquals(refusal.reason, "malformed_registry");
            assertEquals(refusal.paths, [join(await fsRealpath(projectRoot), ".wld", "worktrees.json")]);
            await rejects(() => fsLstat(layout.primary.worktreeRegistryPath), { code: "ENOENT" });
            await rejects(() => fsLstat(layout.primary.layoutMarkerPath), { code: "ENOENT" });
        } finally {
            if (originalHome === undefined) delete env.HOME;
            else env.HOME = originalHome;
            await fsRm(personalHome, { recursive: true, force: true });
            if (originalSandboxHome === undefined) delete env.WLD_TEST_SANDBOX_HOME;
            else env.WLD_TEST_SANDBOX_HOME = originalSandboxHome;
            await fsRm(projectRoot, { recursive: true }).catch(() => {});
        }
    });
});
