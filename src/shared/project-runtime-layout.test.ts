import { assert, assertEquals, assertExists } from "@std/assert";
import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { getRunWieldRuntimeDir, PROJECT_INTERNAL_RUNTIME_DIR_NAME, RUNWIELD_DIR_NAME } from "../constants.js";
import { withProcessGlobalTestLock } from "../testing/process-global-lock.ts";
import { defineCommittedGitFixture, git } from "./git-test-fixture.ts";
import {
    enterProjectRuntime,
    migrateLegacyProjectRuntimeState,
    type ProjectRuntimeMigrationResult,
    resolveProjectRuntimeLayout,
} from "./project-runtime-layout.ts";
import { withWorktreeRegistryLock } from "./worktree-registry.js";
import {
    advancePublicationAttempt,
    createPublicationAttempt,
    recordPublicationFailure,
} from "./workflow/publication-attempt.ts";

const fixture = defineCommittedGitFixture({ "README.md": "# Runtime layout fixture\n" });
const REPO_ROOT = dirname(dirname(dirname(fromFileUrl(import.meta.url))));

Deno.test("project runtime layout resolves normal primary and selected internal roots", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalSandboxHome = Deno.env.get("WLD_TEST_SANDBOX_HOME");
        const primaryCheckout = await fixture.checkout({ prefix: "runwield-runtime-layout-primary-" });
        const selectedCheckout = await Deno.makeTempDir({ prefix: "runwield-runtime-layout-selected-" });
        try {
            Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            await git(primaryCheckout, [
                "worktree",
                "add",
                "-b",
                `runtime-layout-test-${crypto.randomUUID()}`,
                selectedCheckout,
            ]);

            const layout = resolveProjectRuntimeLayout(selectedCheckout);
            const resolvedPrimaryCheckout = await Deno.realPath(primaryCheckout);
            const resolvedSelectedCheckout = await Deno.realPath(selectedCheckout);
            const primaryInternalRoot = join(
                resolvedPrimaryCheckout,
                RUNWIELD_DIR_NAME,
                PROJECT_INTERNAL_RUNTIME_DIR_NAME,
            );
            const selectedInternalRoot = join(
                resolvedSelectedCheckout,
                RUNWIELD_DIR_NAME,
                PROJECT_INTERNAL_RUNTIME_DIR_NAME,
            );

            assertEquals(layout.primary.checkoutRoot, resolvedPrimaryCheckout);
            assertEquals(layout.primary.internalRoot, primaryInternalRoot);
            assertEquals(layout.primary.layoutMarkerPath, join(primaryInternalRoot, "layout.json"));
            assertEquals(layout.primary.layoutMigrationJournalPath, join(primaryInternalRoot, "layout-migration.json"));
            assertEquals(layout.primary.layoutMigrationLockPath, join(primaryInternalRoot, "layout-migration.lock"));
            assertEquals(layout.primary.controllerPlansDir, join(primaryInternalRoot, "controller", "plans"));
            assertEquals(layout.primary.worktreeRegistryPath, join(primaryInternalRoot, "worktrees.json"));
            assertEquals(layout.primary.worktreeRegistryLockPath, join(primaryInternalRoot, "worktrees.lock"));
            assertEquals(
                layout.primary.worktreeRegistryMigrationIssuesPath,
                join(primaryInternalRoot, "worktree-registry-migration-issues.json"),
            );
            assertEquals(layout.primary.publicationStagingRoot, join(primaryInternalRoot, "plan-staging"));
            assertEquals(
                layout.primary.projectSecretStorePath,
                join(primaryInternalRoot, "collaboration-secrets.json"),
            );
            assertEquals(layout.primary.fallbackWorktreesRoot, join(primaryInternalRoot, "worktrees"));
            assertEquals(layout.primary.debugRoot, join(primaryInternalRoot, "debug"));

            assertEquals(layout.selected.checkoutRoot, resolvedSelectedCheckout);
            assertEquals(layout.selected.internalRoot, selectedInternalRoot);
            assertEquals(layout.selected.planLocksDir, join(selectedInternalRoot, "plan-locks"));
            assertEquals(layout.selected.planCatalogLockPath, join(selectedInternalRoot, "plan-locks", "catalog.lock"));
            assertEquals(layout.selected.transitionJournalsDir, join(selectedInternalRoot, "plan-transitions"));
            assertEquals(layout.selected.planBackupsDir, join(selectedInternalRoot, "plan-backups"));
            assertEquals(
                layout.selected.workRecordSupersessionLockPath,
                join(selectedInternalRoot, "work-record-supersession.lock"),
            );
            assertEquals(
                layout.selected.workRecordSupersessionRecoveryLockPath,
                join(selectedInternalRoot, "work-record-supersession-recovery.lock"),
            );
        } finally {
            if (originalSandboxHome === undefined) Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            else Deno.env.set("WLD_TEST_SANDBOX_HOME", originalSandboxHome);
            await Deno.remove(selectedCheckout, { recursive: true }).catch(() => {});
            await Deno.remove(primaryCheckout, { recursive: true }).catch(() => {});
        }
    });
});

Deno.test("runtime migration retries one transient Git worktree listing failure", async () => {
    await withProcessGlobalTestLock(async () => {
        const primaryCheckout = await fixture.checkout({ prefix: "runwield-runtime-layout-retry-" });
        const binDir = await Deno.makeTempDir({ prefix: "runwield-runtime-layout-git-" });
        const failedListMarker = join(binDir, "worktree-list-failed");
        const originalPath = Deno.env.get("PATH") || "";
        try {
            const gitWrapper = join(binDir, "git");
            await Deno.writeTextFile(
                gitWrapper,
                [
                    "#!/bin/sh",
                    `if [ \"$1\" = \"worktree\" ] && [ \"$2\" = \"list\" ] && [ ! -e ${
                        JSON.stringify(failedListMarker)
                    } ]; then`,
                    `    touch ${JSON.stringify(failedListMarker)}`,
                    "    exit 1",
                    "fi",
                    `PATH=${JSON.stringify(originalPath)}`,
                    "export PATH",
                    'exec git "$@"',
                    "",
                ].join("\n"),
            );
            await Deno.chmod(gitWrapper, 0o700);
            Deno.env.set("PATH", `${binDir}:${originalPath}`);

            const layout = await enterProjectRuntime(primaryCheckout);

            assertExists(await Deno.stat(failedListMarker));
            assertEquals(layout.primary.checkoutRoot, await Deno.realPath(primaryCheckout));
        } finally {
            Deno.env.set("PATH", originalPath);
            await Deno.remove(binDir, { recursive: true }).catch(() => {});
            await Deno.remove(primaryCheckout, { recursive: true }).catch(() => {});
        }
    });
});

Deno.test("project runtime layout keeps sandboxed primary and selected lock namespaces separate", async () => {
    const primaryCheckout = await fixture.checkout({ prefix: "runwield-runtime-layout-sandbox-primary-" });
    const selectedCheckout = await Deno.makeTempDir({ prefix: "runwield-runtime-layout-sandbox-selected-" });
    try {
        await git(primaryCheckout, [
            "worktree",
            "add",
            "-b",
            `runtime-layout-sandbox-test-${crypto.randomUUID()}`,
            selectedCheckout,
        ]);

        const layout = resolveProjectRuntimeLayout(selectedCheckout);
        const resolvedPrimaryCheckout = await Deno.realPath(primaryCheckout);
        const resolvedSelectedCheckout = await Deno.realPath(selectedCheckout);
        const primaryInternalRoot = join(
            getRunWieldRuntimeDir(resolvedPrimaryCheckout),
            PROJECT_INTERNAL_RUNTIME_DIR_NAME,
        );
        const selectedInternalRoot = join(
            getRunWieldRuntimeDir(resolvedSelectedCheckout),
            PROJECT_INTERNAL_RUNTIME_DIR_NAME,
        );

        assertEquals(layout.primary.checkoutRoot, resolvedPrimaryCheckout);
        assertEquals(layout.selected.checkoutRoot, resolvedSelectedCheckout);
        assertEquals(layout.primary.internalRoot, primaryInternalRoot);
        assertEquals(layout.selected.internalRoot, selectedInternalRoot);
        assertEquals(dirname(layout.primary.controllerPlansDir), join(primaryInternalRoot, "controller"));
        assertEquals(dirname(layout.selected.planCatalogLockPath), join(selectedInternalRoot, "plan-locks"));
        assertEquals(layout.primary.worktreeRegistryPath, join(primaryInternalRoot, "worktrees.json"));
        assertEquals(layout.selected.transitionJournalsDir, join(selectedInternalRoot, "plan-transitions"));
    } finally {
        await Deno.remove(selectedCheckout, { recursive: true }).catch(() => {});
        await Deno.remove(primaryCheckout, { recursive: true }).catch(() => {});
    }
});

Deno.test("legacy migration adopts primary and selected runtime leaves once", async () => {
    const project = await makeMigrationProject();
    try {
        const primaryBase = getRunWieldRuntimeDir(project.primaryRoot);
        const selectedBase = getRunWieldRuntimeDir(project.selectedRoot);
        const controllerRoot = join(primaryBase, "controller");
        await writeText(join(controllerRoot, "plans", "plan.json"), "controller\n");
        await Deno.chmod(controllerRoot, 0o700).catch(() => {});
        await writeText(
            join(primaryBase, "worktrees.json"),
            JSON.stringify({ version: 1, entries: [project.registryEntry] }, null, 2),
        );
        await writeText(join(primaryBase, "worktree-registry-migration-issues.json"), "issues\n");
        await writeText(join(primaryBase, "debug", "trace.txt"), "debug\n");
        const secretPath = join(primaryBase, "collaboration-secrets.json");
        await writeText(
            secretPath,
            `${JSON.stringify({ schemaVersion: 1, records: {} })}\n`,
        );
        await Deno.chmod(secretPath, 0o600).catch(() => {});
        await writeText(join(selectedBase, "plan-transitions", "t.json"), "transition\n");
        await writeText(join(selectedBase, "plan-backups", "b.json"), "backup\n");

        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "ready") throw new Error(`Expected ready, got ${result.kind}`);
        assertEquals(result.migrated, true);
        assert(result.adoptedSelectedCheckoutRoots.includes(project.selectedRoot));

        const layout = resolveProjectRuntimeLayout(project.selectedRoot);
        assertEquals(
            await Deno.readTextFile(join(layout.primary.internalRoot, "controller", "plans", "plan.json")),
            "controller\n",
        );
        assertEquals(JSON.parse(await Deno.readTextFile(layout.primary.worktreeRegistryPath)), {
            version: 1,
            entries: [project.registryEntry],
        });
        assertEquals(await Deno.readTextFile(layout.primary.worktreeRegistryMigrationIssuesPath), "issues\n");
        assertEquals(await Deno.readTextFile(join(layout.primary.debugRoot, "trace.txt")), "debug\n");
        assertEquals(
            await Deno.readTextFile(layout.primary.projectSecretStorePath),
            `${JSON.stringify({ schemaVersion: 1, records: {} })}\n`,
        );
        assertEquals(((await Deno.lstat(join(layout.primary.internalRoot, "controller"))).mode ?? 0) & 0o777, 0o700);
        assertEquals(((await Deno.lstat(layout.primary.projectSecretStorePath)).mode ?? 0) & 0o777, 0o600);
        assertEquals(await Deno.readTextFile(join(layout.selected.transitionJournalsDir, "t.json")), "transition\n");
        assertEquals(await Deno.readTextFile(join(layout.selected.planBackupsDir, "b.json")), "backup\n");
        await assertMissing(join(primaryBase, "controller"));
        await assertMissing(join(selectedBase, "plan-transitions"));
        const marker = JSON.parse(await Deno.readTextFile(layout.primary.layoutMarkerPath));
        assertEquals(marker.version, 1);
        assertEquals(marker.primaryCheckoutRoot, project.primaryRoot);
        assertEquals(marker.adoptedSelectedCheckoutRoots, [project.primaryRoot, project.selectedRoot].sort());

        const before = await snapshotTree(layout.primary.internalRoot);
        const again = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (again.kind !== "ready") throw new Error(`Expected ready, got ${again.kind}`);
        assertEquals(again.migrated, false);
        assertEquals(await snapshotTree(layout.primary.internalRoot), before);
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration adopts primary selected state and a primary-only secret", async () => {
    const primaryRoot = await fixture.checkout({ prefix: "runwield-runtime-primary-selected-" });
    try {
        const resolvedPrimary = await Deno.realPath(primaryRoot);
        const legacyBase = getRunWieldRuntimeDir(resolvedPrimary);
        await writeText(join(legacyBase, "plan-transitions", "primary.json"), "primary transition\n");
        await writeText(join(legacyBase, "collaboration-secrets.json"), "primary secret\n");

        const result = await migrateLegacyProjectRuntimeState(resolvedPrimary);
        if (result.kind !== "ready") throw new Error(`Expected ready, got ${JSON.stringify(result)}`);
        assertEquals(result.adoptedSelectedCheckoutRoots, [resolvedPrimary]);
        assertEquals(await Deno.readTextFile(result.layout.primary.projectSecretStorePath), "primary secret\n");
        assertEquals(
            await Deno.readTextFile(join(result.layout.selected.transitionJournalsDir, "primary.json")),
            "primary transition\n",
        );
    } finally {
        await Deno.remove(primaryRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("legacy migration adopts a linked-only secret into the primary store", async () => {
    const project = await makeMigrationProject();
    try {
        const source = join(getRunWieldRuntimeDir(project.selectedRoot), "collaboration-secrets.json");
        await writeText(source, "linked secret\n");
        await Deno.chmod(source, 0o600).catch(() => {});
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "ready") throw new Error(`Expected ready, got ${JSON.stringify(result)}`);
        assertEquals(await Deno.readTextFile(result.layout.primary.projectSecretStorePath), "linked secret\n");
        if (Deno.build.os !== "windows") {
            assertEquals(((await Deno.lstat(result.layout.primary.projectSecretStorePath)).mode ?? 0) & 0o777, 0o600);
        }
        await assertMissing(source);
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration preserves conflicting secret sources", async () => {
    const project = await makeMigrationProject();
    try {
        const primarySource = join(getRunWieldRuntimeDir(project.primaryRoot), "collaboration-secrets.json");
        const linkedSource = join(getRunWieldRuntimeDir(project.selectedRoot), "collaboration-secrets.json");
        await writeText(primarySource, "primary bytes\n");
        await writeText(linkedSource, "linked bytes\n");
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
        assertEquals(result.reason, "authority_conflict");
        assertEquals(await Deno.readTextFile(primarySource), "primary bytes\n");
        assertEquals(await Deno.readTextFile(linkedSource), "linked bytes\n");
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration preserves a legacy secret when the current destination exists", async () => {
    const project = await makeMigrationProject();
    try {
        const layout = resolveProjectRuntimeLayout(project.selectedRoot);
        const source = join(getRunWieldRuntimeDir(project.selectedRoot), "collaboration-secrets.json");
        await writeText(source, "legacy bytes\n");
        await writeText(layout.primary.projectSecretStorePath, "current bytes\n");
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
        assertEquals(result.reason, "authority_conflict");
        assertEquals(await Deno.readTextFile(source), "legacy bytes\n");
        assertEquals(await Deno.readTextFile(layout.primary.projectSecretStorePath), "current bytes\n");
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration adopts a later selected secret after the first marker", async () => {
    const project = await makeMigrationProject();
    const laterCheckout = await Deno.makeTempDir({ prefix: "runwield-runtime-later-secret-" });
    try {
        const first = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (first.kind !== "ready") throw new Error(`Expected ready, got ${JSON.stringify(first)}`);
        await git(project.primaryRoot, [
            "worktree",
            "add",
            "-b",
            `runtime-later-secret-${crypto.randomUUID()}`,
            laterCheckout,
        ]);
        const laterRoot = await Deno.realPath(laterCheckout);
        const source = join(getRunWieldRuntimeDir(laterRoot), "collaboration-secrets.json");
        await writeText(source, "later secret\n");

        const result = await migrateLegacyProjectRuntimeState(laterRoot);
        if (result.kind !== "ready") throw new Error(`Expected ready, got ${JSON.stringify(result)}`);
        assertEquals(await Deno.readTextFile(result.layout.primary.projectSecretStorePath), "later secret\n");
        assertEquals(result.adoptedSelectedCheckoutRoots, [...result.adoptedSelectedCheckoutRoots].sort());
        assert(result.adoptedSelectedCheckoutRoots.includes(laterRoot));
    } finally {
        await git(project.primaryRoot, ["worktree", "remove", "--force", laterCheckout]).catch(() => {});
        await Deno.remove(laterCheckout, { recursive: true }).catch(() => {});
        await project.cleanup();
    }
});

Deno.test("legacy migration blocks malformed registry without creating internal state", async () => {
    const project = await makeMigrationProject();
    try {
        await writeText(join(getRunWieldRuntimeDir(project.primaryRoot), "worktrees.json"), "not json");
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
        assertEquals(result.reason, "malformed_registry");
        await assertMissing(resolveProjectRuntimeLayout(project.selectedRoot).primary.internalRoot);
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration blocks tracked project secrets with rotation guidance", async () => {
    const project = await makeMigrationProject();
    try {
        await writeText(join(project.primaryRoot, ".wld", "collaboration-secrets.json"), "secret\n");
        await git(project.primaryRoot, ["add", ".wld/collaboration-secrets.json"]);
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
        assertEquals(result.reason, "tracked_secret");
        assertExists(result.securityAction);
        assertEquals(result.securityAction.rotateCapabilities, true);
        await assertMissing(resolveProjectRuntimeLayout(project.selectedRoot).primary.internalRoot);
    } finally {
        await project.cleanup();
    }
});

Deno.test("runtime entry reuses Git answers only while repository evidence is unchanged", async () => {
    await withProcessGlobalTestLock(async () => {
        const project = await makeMigrationProject();
        const binDir = await Deno.makeTempDir({ prefix: "runwield-runtime-layout-git-log-" });
        const log = join(binDir, "git.log");
        const originalPath = Deno.env.get("PATH") || "";
        try {
            await writeGitLoggingWrapper(binDir, log, originalPath);
            Deno.env.set("PATH", `${binDir}:${originalPath}`);
            await settleGitEvidence();

            assertEquals((await migrateLegacyProjectRuntimeState(project.selectedRoot)).kind, "ready");
            await settleGitEvidence();
            await Deno.writeTextFile(log, "");
            assertEquals((await migrateLegacyProjectRuntimeState(project.selectedRoot)).kind, "ready");
            assertEquals(await readRuntimeGitReads(log), []);

            const secret = join(project.primaryRoot, ".wld", "collaboration-secrets.json");
            await writeText(secret, "secret\n");
            await git(project.primaryRoot, ["add", ".wld/collaboration-secrets.json"]);
            await settleGitEvidence();
            await Deno.writeTextFile(log, "");
            const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
            if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
            assertEquals(result.reason, "tracked_secret");
            assertEquals(result.paths, [secret]);
            assertEquals(await readRuntimeGitReads(log), ["ls-files"]);
        } finally {
            Deno.env.set("PATH", originalPath);
            await Deno.remove(binDir, { recursive: true }).catch(() => {});
            await project.cleanup();
        }
    });
});

Deno.test("runtime entry recognizes a worktree attached after a reused Git answer", async () => {
    const project = await makeMigrationProject();
    const laterCheckout = await Deno.makeTempDir({ prefix: "runwield-runtime-migration-later-" });
    try {
        await settleGitEvidence();
        assertEquals((await migrateLegacyProjectRuntimeState(project.primaryRoot)).kind, "ready");
        await settleGitEvidence();
        assertEquals((await migrateLegacyProjectRuntimeState(project.primaryRoot)).kind, "ready");

        await git(project.primaryRoot, ["worktree", "add", "-b", `later-${crypto.randomUUID()}`, laterCheckout]);
        await settleGitEvidence();
        const result = await migrateLegacyProjectRuntimeState(laterCheckout);
        assertEquals(result.kind, "ready");
    } finally {
        await git(project.primaryRoot, ["worktree", "remove", "--force", laterCheckout]).catch(() => {});
        await Deno.remove(laterCheckout, { recursive: true }).catch(() => {});
        await project.cleanup();
    }
});

Deno.test("legacy migration blocks symlinked authorities before adoption", async () => {
    const project = await makeMigrationProject();
    try {
        const primaryBase = getRunWieldRuntimeDir(project.primaryRoot);
        await Deno.mkdir(primaryBase, { recursive: true });
        await Deno.symlink(project.primaryRoot, join(primaryBase, "controller"));
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
        assertEquals(result.reason, "symlink");
        await assertMissing(resolveProjectRuntimeLayout(project.selectedRoot).primary.internalRoot);
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration refuses symlinked current runtime and publication checkout roots", async () => {
    for (const authority of ["internal-root", "publication-checkout"] as const) {
        const project = await makeMigrationProject();
        const externalRoot = await Deno.makeTempDir({ prefix: "runwield-runtime-symlink-sentinel-" });
        try {
            const layout = resolveProjectRuntimeLayout(project.selectedRoot);
            const sentinel = join(externalRoot, "sentinel.txt");
            await Deno.writeTextFile(sentinel, "unchanged\n");
            if (authority === "internal-root") {
                await Deno.mkdir(dirname(layout.primary.internalRoot), { recursive: true });
                await Deno.symlink(externalRoot, layout.primary.internalRoot);
            } else {
                await Deno.mkdir(layout.primary.publicationStagingRoot, { recursive: true });
                await Deno.symlink(externalRoot, join(layout.primary.publicationStagingRoot, "attempt-1"));
            }

            const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
            if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
            assertEquals(result.reason, "symlink");
            assertEquals(await Deno.readTextFile(sentinel), "unchanged\n");
        } finally {
            await Deno.remove(externalRoot, { recursive: true }).catch(() => {});
            await project.cleanup();
        }
    }
});

Deno.test("legacy migration resumes when a journaled rename already reached its destination", async () => {
    const project = await makeMigrationProject();
    try {
        const layout = resolveProjectRuntimeLayout(project.selectedRoot);
        const primaryBase = getRunWieldRuntimeDir(project.primaryRoot);
        await writeText(join(layout.primary.internalRoot, "controller", "plans", "plan.json"), "controller\n");
        await writeText(
            layout.primary.layoutMigrationJournalPath,
            `${
                JSON.stringify(
                    {
                        version: 1,
                        primaryCheckoutRoot: project.primaryRoot,
                        selectedCheckoutRoots: [project.primaryRoot, project.selectedRoot].sort(),
                        operations: [{
                            action: "rename",
                            source: join(primaryBase, "controller"),
                            destination: join(layout.primary.internalRoot, "controller"),
                            kind: "directory",
                            completed: false,
                        }],
                        updatedAt: "2026-01-01T00:00:00.000Z",
                    },
                    null,
                    2,
                )
            }\n`,
        );

        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "ready") throw new Error(`Expected ready, got ${result.kind}`);
        assertEquals(
            await Deno.readTextFile(join(layout.primary.internalRoot, "controller", "plans", "plan.json")),
            "controller\n",
        );
        await assertMissing(layout.primary.layoutMigrationJournalPath);
        const marker = JSON.parse(await Deno.readTextFile(layout.primary.layoutMarkerPath));
        assertEquals(marker.adoptedSelectedCheckoutRoots, [project.primaryRoot, project.selectedRoot].sort());
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration blocks when a completed journal receipt has two authorities", async () => {
    const project = await makeMigrationProject();
    try {
        const layout = resolveProjectRuntimeLayout(project.selectedRoot);
        const primaryBase = getRunWieldRuntimeDir(project.primaryRoot);
        await writeText(join(primaryBase, "controller", "plans", "legacy.json"), "legacy\n");
        await writeText(join(layout.primary.internalRoot, "controller", "plans", "internal.json"), "internal\n");
        await writeText(
            layout.primary.layoutMigrationJournalPath,
            `${
                JSON.stringify(
                    {
                        version: 1,
                        primaryCheckoutRoot: project.primaryRoot,
                        selectedCheckoutRoots: [project.primaryRoot, project.selectedRoot].sort(),
                        operations: [{
                            action: "rename",
                            source: join(primaryBase, "controller"),
                            destination: join(layout.primary.internalRoot, "controller"),
                            kind: "directory",
                            completed: true,
                        }],
                        updatedAt: "2026-01-01T00:00:00.000Z",
                    },
                    null,
                    2,
                )
            }\n`,
        );

        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
        assertEquals(result.reason, "authority_conflict");
        assertEquals(await Deno.readTextFile(join(primaryBase, "controller", "plans", "legacy.json")), "legacy\n");
        assertEquals(
            await Deno.readTextFile(join(layout.primary.internalRoot, "controller", "plans", "internal.json")),
            "internal\n",
        );
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration does not block on unrelated user symlinks under .wld", async () => {
    const project = await makeMigrationProject();
    try {
        const primaryBase = getRunWieldRuntimeDir(project.primaryRoot);
        await Deno.mkdir(primaryBase, { recursive: true });
        await Deno.symlink(project.primaryRoot, join(primaryBase, "user-owned-link"));
        await writeText(join(primaryBase, "controller", "plans", "plan.json"), "controller\n");

        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "ready") throw new Error(`Expected ready, got ${result.kind}`);
        assertEquals(
            await Deno.readTextFile(join(result.layout.primary.controllerPlansDir, "plan.json")),
            "controller\n",
        );
        assertEquals((await Deno.lstat(join(primaryBase, "user-owned-link"))).isSymlink, true);
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration preserves orphan publication staging without blocking entry", async () => {
    const project = await makeMigrationProject();
    try {
        const stagingPath = join(getRunWieldRuntimeDir(project.primaryRoot), "plan-staging", "orphan", "receipt.json");
        await writeText(stagingPath, "receipt\n");

        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "ready") throw new Error(`Expected ready, got ${result.kind}`);
        assertEquals(await Deno.readTextFile(stagingPath), "receipt\n");
        await assertMissing(resolveProjectRuntimeLayout(project.selectedRoot).primary.publicationStagingRoot);
        const repeated = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        assertEquals(repeated.kind, "ready");
        assertEquals(await Deno.readTextFile(stagingPath), "receipt\n");
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration blocks tracked secret temp files with rotation guidance", async () => {
    const project = await makeMigrationProject();
    try {
        await writeText(join(project.primaryRoot, ".wld", "collaboration-secrets.json.token.tmp"), "secret\n");
        await git(project.primaryRoot, ["add", ".wld/collaboration-secrets.json.token.tmp"]);
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
        assertEquals(result.reason, "tracked_secret");
        assertExists(result.securityAction);
        assertEquals(result.securityAction.removeFromRepositoryHistory, true);
        await assertMissing(resolveProjectRuntimeLayout(project.selectedRoot).primary.internalRoot);
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration classifies current secret files and temps as tracked secrets", async () => {
    for (
        const relativePath of [
            ".wld/internal/collaboration-secrets.json",
            ".wld/internal/collaboration-secrets.json.write.tmp",
        ]
    ) {
        const project = await makeMigrationProject();
        try {
            const path = join(project.primaryRoot, relativePath);
            await writeText(path, "current secret bytes\n");
            await git(project.primaryRoot, ["add", relativePath]);
            const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
            if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
            assertEquals(result.reason, "tracked_secret");
            assertEquals(result.paths, [path]);
            assertExists(result.securityAction);
            assertEquals(result.securityAction.rotateCapabilities, true);
            assertEquals(await Deno.readTextFile(path), "current secret bytes\n");
        } finally {
            await project.cleanup();
        }
    }
});

Deno.test("legacy migration preserves unfinished publication and repair receipts", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalSandboxHome = Deno.env.get("WLD_TEST_SANDBOX_HOME");
        try {
            Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            const unfinished = await makeMigrationProject();
            try {
                const candidate = createPublicationAttempt({
                    attemptId: unfinished.registryEntry.id,
                    planId: "plan-demo",
                    planName: unfinished.registryEntry.planName,
                    targetBranch: "main",
                    executionBranch: unfinished.registryEntry.branch,
                    executionCwd: unfinished.selectedRoot,
                    publicationRoot: join(
                        getRunWieldRuntimeDir(unfinished.primaryRoot),
                        "plan-staging",
                        unfinished.registryEntry.id,
                    ),
                    validatedCommit: unfinished.registryEntry.baseCommit,
                    targetHeadAtSeal: unfinished.registryEntry.baseCommit,
                });
                await writeText(
                    join(getRunWieldRuntimeDir(unfinished.primaryRoot), "worktrees.json"),
                    JSON.stringify({
                        version: 2,
                        entries: [{
                            ...unfinished.registryEntry,
                            planId: "plan-demo",
                            status: "validated",
                            publication: candidate,
                        }],
                    }),
                );

                const repaired = recordPublicationFailure(candidate, {
                    kind: "needs_repair",
                    message: "repair",
                    repairRoot: join(
                        getRunWieldRuntimeDir(unfinished.primaryRoot),
                        "plan-staging",
                        unfinished.registryEntry.id,
                    ),
                });
                await writeText(
                    join(getRunWieldRuntimeDir(unfinished.primaryRoot), "worktrees.json"),
                    JSON.stringify({
                        version: 2,
                        entries: [{
                            ...unfinished.registryEntry,
                            planId: "plan-demo",
                            status: "validated",
                            publication: repaired,
                        }],
                    }),
                );
                const repairFile = join(repaired.publicationRoot, "resolution.txt");
                await writeText(repairFile, "Keep the Engineer's resolution\n");
                const ready = await migrateLegacyProjectRuntimeState(unfinished.selectedRoot);
                if (ready.kind !== "ready") throw new Error(`Expected ready, got ${ready.kind}`);
                const migrated = JSON.parse(await Deno.readTextFile(ready.layout.primary.worktreeRegistryPath));
                assertEquals(migrated.entries[0].publication, repaired);
                assertEquals(await Deno.readTextFile(repairFile), "Keep the Engineer's resolution\n");
                await assertMissing(join(getRunWieldRuntimeDir(unfinished.primaryRoot), "worktrees.json"));
                assertEquals((await migrateLegacyProjectRuntimeState(unfinished.selectedRoot)).kind, "ready");
                assertEquals(
                    repaired.failure?.repairRoot,
                    join(getRunWieldRuntimeDir(unfinished.primaryRoot), "plan-staging", unfinished.registryEntry.id),
                );
            } finally {
                await unfinished.cleanup();
            }

            const complete = await makeMigrationProject();
            try {
                const candidate = createPublicationAttempt({
                    attemptId: complete.registryEntry.id,
                    planId: "plan-demo",
                    planName: complete.registryEntry.planName,
                    targetBranch: "main",
                    executionBranch: complete.registryEntry.branch,
                    executionCwd: complete.selectedRoot,
                    publicationRoot: join(
                        getRunWieldRuntimeDir(complete.primaryRoot),
                        "plan-staging",
                        complete.registryEntry.id,
                    ),
                    validatedCommit: complete.registryEntry.baseCommit,
                    targetHeadAtSeal: complete.registryEntry.baseCommit,
                });
                const artifacts = advancePublicationAttempt(candidate, "artifacts_committed", {
                    artifactCommit: complete.registryEntry.baseCommit,
                    planPaths: ["docs/plans/demo.md"],
                });
                const integrated = advancePublicationAttempt(artifacts, "target_integrated", {
                    targetBaseCommit: complete.registryEntry.baseCommit,
                    integrationCommit: complete.registryEntry.baseCommit,
                });
                const published = advancePublicationAttempt(integrated, "target_published", {
                    publicationMode: "local",
                    publishedCommit: complete.registryEntry.baseCommit,
                });
                const verified = advancePublicationAttempt(published, "publication_verified", {
                    verifiedAt: "2026-01-01T00:01:00.000Z",
                });
                const cleaned = advancePublicationAttempt(verified, "cleanup_complete", {
                    cleanedAt: "2026-01-01T00:02:00.000Z",
                });
                await writeText(
                    join(getRunWieldRuntimeDir(complete.primaryRoot), "worktrees.json"),
                    JSON.stringify({
                        version: 2,
                        entries: [{
                            ...complete.registryEntry,
                            planId: "plan-demo",
                            status: "validated",
                            publication: cleaned,
                        }],
                    }),
                );

                const result = await migrateLegacyProjectRuntimeState(complete.selectedRoot);
                if (result.kind !== "ready") throw new Error(`Expected ready, got ${result.kind}`);
                assertEquals(result.migrated, true);
            } finally {
                await complete.cleanup();
            }
        } finally {
            if (originalSandboxHome === undefined) Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            else Deno.env.set("WLD_TEST_SANDBOX_HOME", originalSandboxHome);
        }
    });
});

Deno.test("legacy migration treats a held controller inode lock as an active writer", async () => {
    const project = await makeMigrationProject();
    let child: Deno.ChildProcess | undefined;
    try {
        const controllerLock = join(
            getRunWieldRuntimeDir(project.primaryRoot),
            "controller",
            "plans",
            "driver.json.lock",
        );
        child = new Deno.Command(Deno.execPath(), {
            cwd: REPO_ROOT,
            args: [
                "run",
                "-A",
                "src/shared/testing/project-runtime-migration-process-driver.ts",
                "hold-controller-lock",
                project.primaryRoot,
                controllerLock,
            ],
            stdout: "piped",
            stderr: "piped",
        }).spawn();
        await readReadyLine(child.stdout);
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
        assertEquals(result.reason, "active_legacy_writer");
        assert(result.paths.includes(controllerLock));
    } finally {
        child?.kill("SIGKILL");
        await child?.status.catch(() => {});
        await project.cleanup();
    }
});

Deno.test("legacy migration rejects a journal that retires an unbounded lock path", async () => {
    const project = await makeMigrationProject();
    try {
        const layout = resolveProjectRuntimeLayout(project.selectedRoot);
        const externalLock = await Deno.makeTempFile({ prefix: "runwield-external-", suffix: ".lock" });
        await Deno.writeTextFile(externalLock, "external\n");
        const stat = await Deno.stat(externalLock);
        await writeText(
            layout.primary.layoutMigrationJournalPath,
            `${
                JSON.stringify(
                    {
                        version: 1,
                        primaryCheckoutRoot: project.primaryRoot,
                        selectedCheckoutRoots: [project.primaryRoot, project.selectedRoot].sort(),
                        operations: [{
                            action: "retire",
                            source: externalLock,
                            kind: "file",
                            proof: { text: "external\n", mtime: stat.mtime?.getTime() ?? Date.now(), size: stat.size },
                            completed: false,
                        }],
                        updatedAt: "2026-01-01T00:00:00.000Z",
                    },
                    null,
                    2,
                )
            }\n`,
        );

        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
        assertEquals(result.reason, "malformed_migration_evidence");
        assertEquals(await Deno.readTextFile(externalLock), "external\n");
        await Deno.remove(externalLock);
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration rejects an existing journal that omits required operations", async () => {
    const project = await makeMigrationProject();
    try {
        const layout = resolveProjectRuntimeLayout(project.selectedRoot);
        await writeText(join(getRunWieldRuntimeDir(project.primaryRoot), "controller", "plans", "plan.json"), "x\n");
        await writeText(
            layout.primary.layoutMigrationJournalPath,
            `${
                JSON.stringify(
                    {
                        version: 1,
                        primaryCheckoutRoot: project.primaryRoot,
                        selectedCheckoutRoots: [project.primaryRoot, project.selectedRoot].sort(),
                        operations: [],
                        updatedAt: "2026-01-01T00:00:00.000Z",
                    },
                    null,
                    2,
                )
            }\n`,
        );
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
        assertEquals(result.reason, "malformed_migration_evidence");
        await assertMissing(layout.primary.layoutMarkerPath);
        assertEquals(
            await Deno.readTextFile(
                join(getRunWieldRuntimeDir(project.primaryRoot), "controller", "plans", "plan.json"),
            ),
            "x\n",
        );
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration cleans completed journal and migration lock after marker replacement", async () => {
    const project = await makeMigrationProject();
    try {
        const layout = resolveProjectRuntimeLayout(project.selectedRoot);
        await writeText(
            layout.primary.layoutMarkerPath,
            `${
                JSON.stringify(
                    {
                        version: 1,
                        primaryCheckoutRoot: project.primaryRoot,
                        adoptedSelectedCheckoutRoots: [project.primaryRoot, project.selectedRoot].sort(),
                        completedAt: "2026-01-01T00:00:00.000Z",
                    },
                    null,
                    2,
                )
            }\n`,
        );
        await writeText(
            layout.primary.layoutMigrationJournalPath,
            `${
                JSON.stringify(
                    {
                        version: 1,
                        primaryCheckoutRoot: project.primaryRoot,
                        selectedCheckoutRoots: [project.primaryRoot, project.selectedRoot].sort(),
                        operations: [],
                        updatedAt: "2026-01-01T00:00:00.000Z",
                    },
                    null,
                    2,
                )
            }\n`,
        );
        await writeText(
            layout.primary.layoutMigrationLockPath,
            JSON.stringify({ pid: -1, createdAtMs: 0, updatedAtMs: 0 }),
        );
        // Zero timestamps fall back to the real file mtime. This fixture is stale
        // already; do not wait for a freshly written file to age for 30 seconds.
        await Deno.utime(layout.primary.layoutMigrationLockPath, 0, 0);
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "ready") throw new Error(`Expected ready, got ${result.kind}`);
        await assertMissing(layout.primary.layoutMigrationJournalPath);
        await assertMissing(layout.primary.layoutMigrationLockPath);
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration resumes selected-root adoption after the registry was already renamed", async () => {
    const project = await makeMigrationProject();
    const laterSelected = await Deno.makeTempDir({ prefix: "runwield-runtime-migration-later-selected-" });
    try {
        const laterBranch = `runtime-migration-later-${crypto.randomUUID()}`;
        await git(project.primaryRoot, ["worktree", "add", "-b", laterBranch, laterSelected]);
        const laterRoot = await Deno.realPath(laterSelected);
        const layout = resolveProjectRuntimeLayout(project.selectedRoot);
        await writeText(
            layout.primary.worktreeRegistryPath,
            JSON.stringify({ version: 1, entries: [project.registryEntry] }),
        );
        await writeText(join(getRunWieldRuntimeDir(project.selectedRoot), "plan-transitions", "first.json"), "first\n");
        await writeText(join(getRunWieldRuntimeDir(laterRoot), "plan-transitions", "later.json"), "later\n");
        await writeText(
            layout.primary.layoutMigrationJournalPath,
            `${
                JSON.stringify(
                    {
                        version: 1,
                        primaryCheckoutRoot: project.primaryRoot,
                        selectedCheckoutRoots: [project.primaryRoot, project.selectedRoot, laterRoot].sort(),
                        operations: [
                            {
                                action: "rename",
                                source: join(getRunWieldRuntimeDir(project.primaryRoot), "worktrees.json"),
                                destination: layout.primary.worktreeRegistryPath,
                                kind: "file",
                                completed: true,
                            },
                            {
                                action: "rename",
                                source: join(getRunWieldRuntimeDir(project.selectedRoot), "plan-transitions"),
                                destination: join(
                                    resolveProjectRuntimeLayout(project.selectedRoot).selected.internalRoot,
                                    "plan-transitions",
                                ),
                                kind: "directory",
                                completed: false,
                            },
                            {
                                action: "rename",
                                source: join(getRunWieldRuntimeDir(laterRoot), "plan-transitions"),
                                destination: join(
                                    resolveProjectRuntimeLayout(laterRoot).selected.internalRoot,
                                    "plan-transitions",
                                ),
                                kind: "directory",
                                completed: false,
                            },
                        ],
                        updatedAt: "2026-01-01T00:00:00.000Z",
                    },
                    null,
                    2,
                )
            }\n`,
        );
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "ready") throw new Error(`Expected ready, got ${JSON.stringify(result)}`);
        assertEquals(await Deno.readTextFile(join(layout.selected.transitionJournalsDir, "first.json")), "first\n");
        assertEquals(
            await Deno.readTextFile(
                join(resolveProjectRuntimeLayout(laterRoot).selected.transitionJournalsDir, "later.json"),
            ),
            "later\n",
        );
    } finally {
        await git(project.primaryRoot, ["worktree", "remove", "--force", laterSelected]).catch(() => {});
        await Deno.remove(laterSelected, { recursive: true }).catch(() => {});
        await project.cleanup();
    }
});

Deno.test("legacy migration rejects a stale lock retirement when the lock proof changed", async () => {
    const project = await makeMigrationProject();
    try {
        const layout = resolveProjectRuntimeLayout(project.selectedRoot);
        const lockPath = join(getRunWieldRuntimeDir(project.selectedRoot), "plan-locks", "demo.lock");
        await writeText(lockPath, "new stale lock\n");
        const old = new Date(0);
        await Deno.utime(lockPath, old, old);
        await writeText(
            layout.primary.layoutMigrationJournalPath,
            `${
                JSON.stringify(
                    {
                        version: 1,
                        primaryCheckoutRoot: project.primaryRoot,
                        selectedCheckoutRoots: [project.primaryRoot, project.selectedRoot].sort(),
                        operations: [{
                            action: "retire",
                            source: lockPath,
                            kind: "file",
                            proof: { text: "old stale lock\n", mtime: 0, size: "old stale lock\n".length },
                            completed: false,
                        }],
                        updatedAt: "2026-01-01T00:00:00.000Z",
                    },
                    null,
                    2,
                )
            }\n`,
        );
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
        assertEquals(result.reason, "malformed_migration_evidence");
        assertEquals(await Deno.readTextFile(lockPath), "new stale lock\n");
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration retires stale Plan locks before moving the Plan lock directory", async () => {
    const project = await makeMigrationProject();
    try {
        const selectedBase = getRunWieldRuntimeDir(project.selectedRoot);
        const staleLock = join(selectedBase, "plan-locks", "demo.lock");
        await writeText(staleLock, JSON.stringify({ pid: -1, hostname: "stale", updatedAtMs: 0 }));
        await writeText(join(selectedBase, "plan-locks", "durable.txt"), "durable\n");
        const old = new Date(0);
        await Deno.utime(staleLock, old, old);
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "ready") throw new Error(`Expected ready, got ${result.kind}`);
        const layout = resolveProjectRuntimeLayout(project.selectedRoot);
        await assertMissing(join(layout.selected.planLocksDir, "demo.lock"));
        assertEquals(await Deno.readTextFile(join(layout.selected.planLocksDir, "durable.txt")), "durable\n");
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration allows an empty destination directory during adoption", async () => {
    const project = await makeMigrationProject();
    try {
        const layout = resolveProjectRuntimeLayout(project.selectedRoot);
        await writeText(join(getRunWieldRuntimeDir(project.primaryRoot), "controller", "plans", "plan.json"), "x\n");
        await Deno.mkdir(join(layout.primary.internalRoot, "controller"), { recursive: true });
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "ready") throw new Error(`Expected ready, got ${result.kind}`);
        assertEquals(await Deno.readTextFile(join(layout.primary.controllerPlansDir, "plan.json")), "x\n");
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration refuses populated project-local worktrees without effects", async () => {
    const project = await makeMigrationProject();
    const fallbackRoot = join(getRunWieldRuntimeDir(project.primaryRoot), "worktrees");
    const fallbackCheckout = join(fallbackRoot, "legacy-attempt");
    try {
        await git(project.primaryRoot, [
            "worktree",
            "add",
            "-b",
            `legacy-fallback-${crypto.randomUUID()}`,
            fallbackCheckout,
        ]);
        await Deno.writeTextFile(join(fallbackCheckout, "README.md"), "dirty tracked work\n");
        await Deno.writeTextFile(join(fallbackCheckout, "untracked.txt"), "untracked work\n");
        const registryPath = join(getRunWieldRuntimeDir(project.primaryRoot), "worktrees.json");
        await writeText(
            registryPath,
            JSON.stringify({
                version: 1,
                entries: [{ ...project.registryEntry, id: "legacy-attempt", path: fallbackCheckout }],
            }),
        );
        const layout = resolveProjectRuntimeLayout(project.selectedRoot);
        const worktreesBefore = await git(project.primaryRoot, ["worktree", "list", "--porcelain"]);
        const statusBefore = await git(fallbackCheckout, ["status", "--short"]);
        const primaryStatusBefore = await git(project.primaryRoot, ["status", "--short"]);
        const indexBefore = await git(project.primaryRoot, ["diff", "--cached", "--binary"]);
        const registryBefore = await Deno.readTextFile(registryPath);

        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
        assertEquals(result.reason, "unsupported_filesystem_move");
        assertEquals(await git(project.primaryRoot, ["worktree", "list", "--porcelain"]), worktreesBefore);
        assertEquals(await git(fallbackCheckout, ["status", "--short"]), statusBefore);
        assertEquals(await git(project.primaryRoot, ["status", "--short"]), primaryStatusBefore);
        assertEquals(await git(project.primaryRoot, ["diff", "--cached", "--binary"]), indexBefore);
        assertEquals(await Deno.readTextFile(registryPath), registryBefore);
        assertEquals(await Deno.readTextFile(join(fallbackCheckout, "README.md")), "dirty tracked work\n");
        assertEquals(await Deno.readTextFile(join(fallbackCheckout, "untracked.txt")), "untracked work\n");
        await assertMissing(layout.primary.internalRoot);
    } finally {
        await git(project.primaryRoot, ["worktree", "remove", "--force", fallbackCheckout]).catch(() => {});
        await project.cleanup();
    }
});

Deno.test("legacy migration allows an empty project-local worktrees directory", async () => {
    const project = await makeMigrationProject();
    try {
        const fallbackRoot = join(getRunWieldRuntimeDir(project.primaryRoot), "worktrees");
        await Deno.mkdir(fallbackRoot, { recursive: true });
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "ready") throw new Error(`Expected ready, got ${JSON.stringify(result)}`);
        assertEquals((await Deno.lstat(fallbackRoot)).isDirectory, true);
        await assertMissing(result.layout.primary.fallbackWorktreesRoot);
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration rejects an old journaled project-local worktree rename", async () => {
    const project = await makeMigrationProject();
    try {
        const layout = resolveProjectRuntimeLayout(project.selectedRoot);
        const source = join(getRunWieldRuntimeDir(project.primaryRoot), "worktrees");
        const file = join(source, "preserve.txt");
        await writeText(file, "preserve\n");
        await writeText(
            layout.primary.layoutMigrationJournalPath,
            `${
                JSON.stringify(
                    {
                        version: 1,
                        primaryCheckoutRoot: project.primaryRoot,
                        selectedCheckoutRoots: [project.primaryRoot, project.selectedRoot].sort(),
                        operations: [{
                            action: "rename",
                            source,
                            destination: layout.primary.fallbackWorktreesRoot,
                            kind: "directory",
                            completed: false,
                        }],
                        updatedAt: "2026-01-01T00:00:00.000Z",
                    },
                    null,
                    2,
                )
            }\n`,
        );
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
        assertEquals(result.reason, "malformed_migration_evidence");
        assertEquals(await Deno.readTextFile(file), "preserve\n");
        await assertMissing(layout.primary.fallbackWorktreesRoot);
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration resumes RC.1 empty staging rename journals", async () => {
    const project = await makeMigrationProject();
    try {
        const layout = resolveProjectRuntimeLayout(project.selectedRoot);
        const source = join(getRunWieldRuntimeDir(project.primaryRoot), "plan-staging");
        await Deno.mkdir(source, { recursive: true });
        await writeText(
            layout.primary.layoutMigrationJournalPath,
            JSON.stringify({
                version: 1,
                primaryCheckoutRoot: project.primaryRoot,
                selectedCheckoutRoots: [project.primaryRoot, project.selectedRoot].sort(),
                operations: [{
                    action: "rename",
                    source,
                    destination: layout.primary.publicationStagingRoot,
                    kind: "directory",
                    completed: false,
                }],
                updatedAt: "2026-01-01T00:00:00.000Z",
            }),
        );
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        assertEquals(result.kind, "ready");
        await Deno.stat(layout.primary.publicationStagingRoot);
        await assertMissing(source);
        await assertMissing(layout.primary.layoutMigrationJournalPath);
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration preserves hidden publication staging entries", async () => {
    const project = await makeMigrationProject();
    try {
        await writeText(join(getRunWieldRuntimeDir(project.primaryRoot), "plan-staging", ".hidden"), "x\n");
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "ready") throw new Error(`Expected ready, got ${result.kind}`);
        assertEquals(
            await Deno.readTextFile(join(getRunWieldRuntimeDir(project.primaryRoot), "plan-staging", ".hidden")),
            "x\n",
        );
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration rejects selected runtime base symlinks", async () => {
    const project = await makeMigrationProject();
    try {
        const selectedBase = getRunWieldRuntimeDir(project.selectedRoot);
        await Deno.mkdir(dirname(selectedBase), { recursive: true });
        const target = await Deno.makeTempDir({ prefix: "runwield-runtime-symlink-target-" });
        await Deno.symlink(target, selectedBase);
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
        assertEquals(result.reason, "symlink");
        await Deno.remove(target, { recursive: true }).catch(() => {});
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration rejects special-file descendants", async () => {
    const project = await makeMigrationProject();
    try {
        const fifo = join(getRunWieldRuntimeDir(project.primaryRoot), "controller", "plans", "events.fifo");
        await Deno.mkdir(dirname(fifo), { recursive: true });
        const output = await new Deno.Command("mkfifo", { args: [fifo], stderr: "piped" }).output();
        if (output.code !== 0) throw new Error(new TextDecoder().decode(output.stderr));
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
        assertEquals(result.reason, "malformed_migration_evidence");
        assert(result.paths.includes(fifo));
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration rejects malformed publication records during registry inspection", async () => {
    const project = await makeMigrationProject();
    try {
        await writeText(
            join(getRunWieldRuntimeDir(project.primaryRoot), "worktrees.json"),
            `${JSON.stringify({ version: 1, entries: [{ ...project.registryEntry, publication: null }] }, null, 2)}\n`,
        );
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
        assertEquals(result.reason, "malformed_registry");
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration rejects malformed selected roots in a completed marker", async () => {
    const project = await makeMigrationProject();
    try {
        const layout = resolveProjectRuntimeLayout(project.selectedRoot);
        await writeText(
            layout.primary.layoutMarkerPath,
            `${
                JSON.stringify(
                    {
                        version: 1,
                        primaryCheckoutRoot: project.primaryRoot,
                        adoptedSelectedCheckoutRoots: [project.selectedRoot, project.selectedRoot],
                        completedAt: "2026-01-01T00:00:00.000Z",
                    },
                    null,
                    2,
                )
            }\n`,
        );
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
        assertEquals(result.reason, "malformed_migration_evidence");
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration rejects a newer completed marker version", async () => {
    const project = await makeMigrationProject();
    try {
        const layout = resolveProjectRuntimeLayout(project.selectedRoot);
        await writeText(
            layout.primary.layoutMarkerPath,
            `${
                JSON.stringify(
                    {
                        version: 2,
                        primaryCheckoutRoot: project.primaryRoot,
                        adoptedSelectedCheckoutRoots: [project.primaryRoot, project.selectedRoot].sort(),
                        completedAt: "2026-01-01T00:00:00.000Z",
                    },
                    null,
                    2,
                )
            }\n`,
        );
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
        assertEquals(result.reason, "newer_layout");
        assertEquals(result.paths, [layout.primary.layoutMarkerPath]);
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration ignores completed retire receipts and rejects normalized lock path escapes", async () => {
    const project = await makeMigrationProject();
    const selectedBase = getRunWieldRuntimeDir(project.selectedRoot);
    const craftedSource = `${join(selectedBase, "plan-locks")}/../victim.lock`;
    const victim = resolve(craftedSource);
    try {
        const layout = resolveProjectRuntimeLayout(project.selectedRoot);
        await Deno.mkdir(dirname(victim), { recursive: true });
        await Deno.writeTextFile(victim, "victim\n");
        const stat = await Deno.stat(victim);
        await writeText(
            layout.primary.layoutMigrationJournalPath,
            `${
                JSON.stringify(
                    {
                        version: 1,
                        primaryCheckoutRoot: project.primaryRoot,
                        selectedCheckoutRoots: [project.primaryRoot, project.selectedRoot].sort(),
                        operations: [{
                            action: "retire",
                            source: craftedSource,
                            kind: "file",
                            proof: { text: "victim\n", mtime: stat.mtime?.getTime() ?? Date.now(), size: stat.size },
                            completed: true,
                        }],
                        updatedAt: "2026-01-01T00:00:00.000Z",
                    },
                    null,
                    2,
                )
            }\n`,
        );
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
        assertEquals(result.reason, "malformed_migration_evidence");
        assertEquals(await Deno.readTextFile(victim), "victim\n");
    } finally {
        await Deno.remove(victim).catch(() => {});
        await project.cleanup();
    }
});

Deno.test("legacy migration blocks active Work Record supersession and recovery locks", async () => {
    const supersession = await makeMigrationProject();
    let supersessionChild: Deno.ChildProcess | undefined;
    try {
        const lockPath = join(getRunWieldRuntimeDir(supersession.selectedRoot), "work-record-supersession.lock");
        supersessionChild = spawnDriver("hold-work-record-lock", supersession.selectedRoot);
        await readReadyLine(supersessionChild.stdout);
        assertEquals(typeof JSON.parse(await Deno.readTextFile(lockPath)).token, "string");
        const result = await migrateLegacyProjectRuntimeState(supersession.selectedRoot);
        if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
        assertEquals(result.reason, "active_legacy_writer");
        assert(result.paths.includes(lockPath));
    } finally {
        supersessionChild?.kill("SIGKILL");
        await supersessionChild?.status.catch(() => {});
        await supersession.cleanup();
    }

    const recovery = await makeMigrationProject();
    let recoveryChild: Deno.ChildProcess | undefined;
    try {
        const lockPath = join(getRunWieldRuntimeDir(recovery.selectedRoot), "work-record-supersession-recovery.lock");
        recoveryChild = spawnDriver("hold-work-record-recovery-lock", recovery.selectedRoot);
        await readReadyLine(recoveryChild.stdout);
        assertEquals(typeof JSON.parse(await Deno.readTextFile(lockPath)).token, "string");
        const result = await migrateLegacyProjectRuntimeState(recovery.selectedRoot);
        if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
        assertEquals(result.reason, "active_legacy_writer");
        assert(result.paths.includes(lockPath));
    } finally {
        recoveryChild?.kill("SIGKILL");
        await recoveryChild?.status.catch(() => {});
        await recovery.cleanup();
    }
});

Deno.test("legacy migration blocks primary Work Record locks when entry starts linked", async () => {
    for (
        const lock of [
            { mode: "hold-work-record-lock", name: "work-record-supersession.lock" },
            { mode: "hold-work-record-recovery-lock", name: "work-record-supersession-recovery.lock" },
        ] as const
    ) {
        const project = await makeMigrationProject();
        let child: Deno.ChildProcess | undefined;
        try {
            const lockPath = join(getRunWieldRuntimeDir(project.primaryRoot), lock.name);
            child = spawnDriver(lock.mode, project.primaryRoot);
            await readReadyLine(child.stdout);
            const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
            if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
            assertEquals(result.reason, "active_legacy_writer");
            assert(result.paths.includes(lockPath));
            child.kill("SIGKILL");
            await child.status;
            child = undefined;
            await Deno.remove(lockPath);
            const retry = await migrateLegacyProjectRuntimeState(project.selectedRoot);
            if (retry.kind !== "ready") throw new Error(`Expected ready, got ${JSON.stringify(retry)}`);
            assertEquals(retry.adoptedSelectedCheckoutRoots, [project.primaryRoot, project.selectedRoot].sort());
        } finally {
            child?.kill("SIGKILL");
            await child?.status.catch(() => {});
            await project.cleanup();
        }
    }
});

Deno.test("legacy migration retires stale Work Record supersession under the recovery protocol", async () => {
    const project = await makeMigrationProject();
    try {
        const lockPath = join(getRunWieldRuntimeDir(project.selectedRoot), "work-record-supersession.lock");
        await writeText(lockPath, JSON.stringify({ token: "stale", createdAt: 0, updatedAt: 0 }));
        const old = new Date(0);
        await Deno.utime(lockPath, old, old);
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "ready") throw new Error(`Expected ready, got ${result.kind}`);
        await assertMissing(lockPath);
        await assertMissing(
            join(getRunWieldRuntimeDir(project.selectedRoot), "work-record-supersession-recovery.lock"),
        );
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration blocks active Plan locks held by a subprocess", async () => {
    const project = await makeMigrationProject();
    let child: Deno.ChildProcess | undefined;
    try {
        const lockPath = join(getRunWieldRuntimeDir(project.selectedRoot), "plan-locks", "demo.lock");
        child = spawnDriver("hold-plan-lock", project.selectedRoot, "demo");
        await readReadyLine(child.stdout);
        assertEquals(typeof JSON.parse(await Deno.readTextFile(lockPath)).pid, "number");
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
        assertEquals(result.reason, "active_legacy_writer");
        assert(result.paths.includes(lockPath));
    } finally {
        child?.kill("SIGKILL");
        await child?.status.catch(() => {});
        await project.cleanup();
    }
});

Deno.test("legacy migration blocks active Plan locks in the primary checkout when entry starts linked", async () => {
    const project = await makeMigrationProject();
    let child: Deno.ChildProcess | undefined;
    try {
        const lockPath = join(getRunWieldRuntimeDir(project.primaryRoot), "plan-locks", "primary.lock");
        child = spawnDriver("hold-plan-lock", project.primaryRoot, "primary");
        await readReadyLine(child.stdout);
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
        assertEquals(result.reason, "active_legacy_writer");
        assert(result.paths.includes(lockPath));
        child.kill("SIGKILL");
        await child.status;
        child = undefined;
        const retry = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (retry.kind !== "ready") throw new Error(`Expected ready, got ${retry.kind}`);
        assertEquals(retry.adoptedSelectedCheckoutRoots, [project.primaryRoot, project.selectedRoot].sort());
    } finally {
        child?.kill("SIGKILL");
        await child?.status.catch(() => {});
        await project.cleanup();
    }
});

Deno.test("legacy migration rechecks registry after waiting for the legacy registry lock", async () => {
    const project = await makeMigrationProject();
    let lockHolder: Deno.ChildProcess | undefined;
    try {
        const registryPath = join(getRunWieldRuntimeDir(project.primaryRoot), "worktrees.json");
        await writeText(registryPath, JSON.stringify({ version: 1, entries: [project.registryEntry] }));
        lockHolder = spawnDriver("hold-registry-lock", project.primaryRoot);
        await readReadyLine(lockHolder.stdout);
        const migration = spawnDriver("migrate", project.selectedRoot);
        const migrationLockPath = resolveProjectRuntimeLayout(project.selectedRoot).primary.layoutMigrationLockPath;
        const deadline = Date.now() + 10_000;
        while (!(await Deno.lstat(migrationLockPath).catch(() => null))) {
            assert(Date.now() < deadline, "migration should reach the held registry lock");
            await new Promise((resolveTimer) => setTimeout(resolveTimer, 5));
        }
        await Deno.writeTextFile(registryPath, "not json\n");
        lockHolder.kill("SIGKILL");
        await lockHolder.status.catch(() => {});
        lockHolder = undefined;
        const result = JSON.parse(await readChildStdout(migration)) as ProjectRuntimeMigrationResult;
        if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
        assertEquals(result.reason, "malformed_registry");
    } finally {
        lockHolder?.kill("SIGKILL");
        await lockHolder?.status.catch(() => {});
        await project.cleanup();
    }
});

Deno.test("legacy migration waits while another migration initializes its lock records", async () => {
    const project = await makeMigrationProject();
    let lockHolder: Deno.ChildProcess | undefined;
    try {
        const layout = resolveProjectRuntimeLayout(project.selectedRoot);
        const signalPath = join(project.primaryRoot, ".migration-lock-test-started");
        await writeText(join(getRunWieldRuntimeDir(project.primaryRoot), "controller", "plans", "plan.json"), "x\n");
        lockHolder = spawnDriver("hold-initializing-migration-locks", project.primaryRoot, signalPath);
        await readReadyLine(lockHolder.stdout);
        await writeText(signalPath, "start\n");
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "ready") throw new Error(JSON.stringify(result));
        assertEquals(await Deno.readTextFile(join(layout.primary.controllerPlansDir, "plan.json")), "x\n");
        await lockHolder.status;
        lockHolder = undefined;
    } finally {
        lockHolder?.kill("SIGKILL");
        await lockHolder?.status.catch(() => {});
        await project.cleanup();
    }
});

Deno.test("legacy migration lock serializes concurrent stale-lock recovery", async () => {
    const project = await makeMigrationProject();
    try {
        const layout = resolveProjectRuntimeLayout(project.selectedRoot);
        await writeText(join(getRunWieldRuntimeDir(project.primaryRoot), "controller", "plans", "plan.json"), "x\n");
        await writeText(
            layout.primary.layoutMigrationLockPath,
            JSON.stringify({ token: "stale", pid: -1, hostname: "", createdAtMs: 0, updatedAtMs: 0 }),
        );
        await Deno.utime(layout.primary.layoutMigrationLockPath, 0, 0);
        const first = spawnDriver("migrate", project.selectedRoot);
        const second = spawnDriver("migrate", project.selectedRoot);
        const firstResult = JSON.parse(await readChildStdout(first)) as ProjectRuntimeMigrationResult;
        const secondResult = JSON.parse(await readChildStdout(second)) as ProjectRuntimeMigrationResult;
        if (firstResult.kind !== "ready") throw new Error(JSON.stringify(firstResult));
        if (secondResult.kind !== "ready") throw new Error(JSON.stringify(secondResult));
        const migratedCount = [firstResult, secondResult].filter((result) => result.kind === "ready" && result.migrated)
            .length;
        assertEquals(migratedCount, 1);
        assertEquals(await Deno.readTextFile(join(layout.primary.controllerPlansDir, "plan.json")), "x\n");
    } finally {
        await project.cleanup();
    }
});

Deno.test("legacy migration resumes after a subprocess stops at each effect boundary", async () => {
    for (const effect of MIGRATION_INTERRUPTION_EFFECTS) {
        const project = await makeMigrationProject();
        try {
            await arrangeInterruptedMigrationEffect(project, effect);
            const child = spawnDriver("migrate-exit-after-effect", project.selectedRoot, effect);
            const [status, stdout, stderr] = await Promise.all([
                child.status,
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
            ]);
            if (status.code !== 86) {
                throw new Error(`Expected ${effect} driver to exit with 86, got ${status.code}: ${stdout}${stderr}`);
            }
            await assertInterruptedMigrationEffect(project, effect);
            const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
            if (result.kind !== "ready") throw new Error(`Expected ready after ${effect}: ${JSON.stringify(result)}`);
            await assertCompletedMigrationEffect(project, effect);
        } finally {
            await project.cleanup();
        }
    }
});

Deno.test("registry operation does not reenter recovery while holding its current lock", async () => {
    const project = await makeMigrationProject();
    try {
        const legacy = join(getRunWieldRuntimeDir(project.primaryRoot), "worktrees.json");
        await withWorktreeRegistryLock(project.primaryRoot, async () => {
            // An old writer flushes after the current operation has entered and locked.
            await writeText(legacy, '{"version":2,"entries":[]}');
            await enterProjectRuntime(project.primaryRoot);
            assertEquals(await Deno.readTextFile(legacy), '{"version":2,"entries":[]}');
        });
        await enterProjectRuntime(project.primaryRoot);
        await assertMissing(legacy);
    } finally {
        await project.cleanup();
    }
});

for (const stale of ["empty", "older attempt"] as const) {
    Deno.test(`adopted runtime recovers a returning ${stale} registry without reverting attempts`, async () => {
        const project = await makeMigrationProject();
        try {
            const legacy = join(getRunWieldRuntimeDir(project.primaryRoot), "worktrees.json");
            const current = { version: 2, entries: [{ ...project.registryEntry, status: "completed" }] };
            await writeText(legacy, JSON.stringify(current));
            assertEquals((await migrateLegacyProjectRuntimeState(project.selectedRoot)).kind, "ready");
            const layout = resolveProjectRuntimeLayout(project.selectedRoot);
            const before = await Deno.readTextFile(layout.primary.worktreeRegistryPath);
            const returned = JSON.stringify({ version: 2, entries: stale === "empty" ? [] : [project.registryEntry] });
            await writeText(legacy, returned);
            const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
            assertEquals(result.kind, "ready", JSON.stringify(result));
            assertEquals(await Deno.readTextFile(layout.primary.worktreeRegistryPath), before);
            await assertMissing(legacy);
            assert((await snapshotTree(join(layout.primary.internalRoot, "legacy-recovery"))).includes(returned));
            const repeated = await migrateLegacyProjectRuntimeState(project.selectedRoot);
            assert(repeated.kind === "ready");
            assertEquals(repeated.migrated, false);
        } finally {
            await project.cleanup();
        }
    });
}

for (const interruption of [null, "recovery-backup", "recovery-registry", "recovery-registry-retirement"] as const) {
    Deno.test(`adopted runtime imports a distinct returning attempt with interruption ${interruption}`, async () => {
        const project = await makeMigrationProject();
        try {
            assertEquals((await migrateLegacyProjectRuntimeState(project.selectedRoot)).kind, "ready");
            const layout = resolveProjectRuntimeLayout(project.selectedRoot);
            const legacy = join(getRunWieldRuntimeDir(project.primaryRoot), "worktrees.json");
            const attempt = { ...project.registryEntry, planId: "returning-plan", status: "active" };
            const returning = JSON.stringify({ version: 2, entries: [attempt] });
            await writeText(legacy, returning);
            if (interruption) {
                const child = spawnDriver("migrate-exit-after-effect", project.selectedRoot, interruption);
                const [status, output, errors] = await Promise.all([
                    child.status,
                    new Response(child.stdout).text(),
                    new Response(child.stderr).text(),
                ]);
                assertEquals(status.code, 86, `${output}${errors}`);
            }
            const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
            assertEquals(result.kind, "ready", JSON.stringify(result));
            assertEquals(JSON.parse(await Deno.readTextFile(layout.primary.worktreeRegistryPath)), {
                version: 2,
                entries: [attempt],
            });
            await assertMissing(legacy);
            await assertMissing(layout.primary.layoutMigrationJournalPath);
            assert((await snapshotTree(join(layout.primary.internalRoot, "legacy-recovery"))).includes(returning));
        } finally {
            await project.cleanup();
        }
    });
}

Deno.test("adopted runtime reconciles every returning non-secret data location", async () => {
    const project = await makeMigrationProject();
    try {
        assertEquals((await migrateLegacyProjectRuntimeState(project.selectedRoot)).kind, "ready");
        const locations = [
            [project.primaryRoot, "controller/plans/returning.json"],
            [project.primaryRoot, "debug/returning.log"],
            [project.primaryRoot, "worktree-registry-migration-issues.json"],
            [project.primaryRoot, "plan-backups/returning.md"],
            [project.primaryRoot, "plan-transitions/returning.json"],
            [project.selectedRoot, "plan-backups/returning.md"],
            [project.selectedRoot, "plan-transitions/returning.json"],
        ];
        for (const [root, relative] of locations) {
            await writeText(join(getRunWieldRuntimeDir(root), relative), `preserved ${relative}\n`);
            await Deno.mkdir(join(getRunWieldRuntimeDir(root), "plan-locks"), { recursive: true });
        }
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        assertEquals(result.kind, "ready", JSON.stringify(result));
        for (const [root, relative] of locations) {
            assertEquals(
                await Deno.readTextFile(join(getRunWieldRuntimeDir(root), "internal", relative)),
                `preserved ${relative}\n`,
            );
            await assertMissing(join(getRunWieldRuntimeDir(root), relative));
        }
    } finally {
        await project.cleanup();
    }
});

Deno.test("adopted runtime keeps both registries when distinct attempts collide", async () => {
    const project = await makeMigrationProject();
    try {
        const legacy = join(getRunWieldRuntimeDir(project.primaryRoot), "worktrees.json");
        const current = JSON.stringify({ version: 2, entries: [project.registryEntry] });
        await writeText(legacy, current);
        assertEquals((await migrateLegacyProjectRuntimeState(project.selectedRoot)).kind, "ready");
        const returning = JSON.stringify({ version: 2, entries: [{ ...project.registryEntry, id: "other-attempt" }] });
        await writeText(legacy, returning);
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        assertEquals(result.kind, "blocked");
        assertEquals(await Deno.readTextFile(legacy), returning);
        assertEquals(
            await Deno.readTextFile(resolveProjectRuntimeLayout(project.selectedRoot).primary.worktreeRegistryPath),
            current,
        );
    } finally {
        await project.cleanup();
    }
});

Deno.test("adopted runtime recovers returning old writes without reverting current decisions", async () => {
    const project = await makeMigrationProject();
    try {
        const legacyPath = join(getRunWieldRuntimeDir(project.primaryRoot), "controller", "plans", "plan.json");
        const current = {
            version: 1,
            revision: 5,
            planId: "plan",
            planName: "demo",
            state: {
                documentWorktreeId: "attempt-1",
                executionMode: "worktree",
                validationCiAttempts: 2,
                humanReviewDecision: "approved",
            },
        };
        await writeText(legacyPath, JSON.stringify(current));
        assertEquals((await migrateLegacyProjectRuntimeState(project.selectedRoot)).kind, "ready");
        const layout = resolveProjectRuntimeLayout(project.selectedRoot);
        const old = {
            ...current,
            revision: 1,
            state: { validationCiAttempts: 0, humanReviewDecision: null, executionReport: "Implementation completed." },
        };
        await writeText(legacyPath, JSON.stringify(old));
        await writeText(join(dirname(legacyPath), "other.json"), "new legacy record\n");
        const legacySelected = getRunWieldRuntimeDir(project.selectedRoot);
        await Deno.mkdir(join(legacySelected, "plan-locks"), { recursive: true });
        await writeText(join(legacySelected, "plan-transitions", "receipt.json"), "interrupted completion\n");
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        assertEquals(result.kind, "ready");
        assertEquals(JSON.parse(await Deno.readTextFile(join(layout.primary.controllerPlansDir, "plan.json"))), {
            ...current,
            revision: 6,
            state: { ...current.state, executionReport: "Implementation completed." },
        });
        assertEquals(
            await Deno.readTextFile(join(layout.primary.controllerPlansDir, "other.json")),
            "new legacy record\n",
        );
        assertEquals(
            await Deno.readTextFile(join(layout.selected.transitionJournalsDir, "receipt.json")),
            "interrupted completion\n",
        );
        const archive = await snapshotTree(join(layout.primary.internalRoot, "legacy-recovery"));
        assert(archive.includes(JSON.stringify(old)), "The original old record must remain recoverable");
        assert(archive.includes(JSON.stringify(current)), "The original current record must remain recoverable");
        await assertMissing(legacyPath);
        // A second old flush cannot reset counters, decisions or manufacture a new revision.
        await writeText(legacyPath, JSON.stringify(old));
        assertEquals((await migrateLegacyProjectRuntimeState(project.selectedRoot)).kind, "ready");
        assertEquals(
            JSON.parse(await Deno.readTextFile(join(layout.primary.controllerPlansDir, "plan.json"))).revision,
            6,
        );
        assertEquals(await snapshotTree(join(layout.primary.internalRoot, "legacy-recovery")), archive);
        const repeated = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        assert(repeated.kind === "ready");
        assertEquals(repeated.migrated, false);
    } finally {
        await project.cleanup();
    }
});

Deno.test("adopted runtime does not recover directories authorized only by old marker history", async () => {
    const project = await makeMigrationProject();
    const other = await Deno.realPath(await Deno.makeTempDir({ prefix: "unregistered-runtime-root-" }));
    try {
        assertEquals((await migrateLegacyProjectRuntimeState(project.selectedRoot)).kind, "ready");
        const layout = resolveProjectRuntimeLayout(project.selectedRoot);
        const marker = JSON.parse(await Deno.readTextFile(layout.primary.layoutMarkerPath));
        marker.adoptedSelectedCheckoutRoots.push(other);
        marker.adoptedSelectedCheckoutRoots.sort();
        await Deno.writeTextFile(layout.primary.layoutMarkerPath, JSON.stringify(marker));
        const oldPath = join(getRunWieldRuntimeDir(other), "plan-backups", "keep.md");
        await writeText(oldPath, "Do not move this unrelated checkout's files.\n");
        assertEquals((await migrateLegacyProjectRuntimeState(project.selectedRoot)).kind, "ready");
        assertEquals(await Deno.readTextFile(oldPath), "Do not move this unrelated checkout's files.\n");
    } finally {
        await project.cleanup();
        await Deno.remove(other, { recursive: true });
    }
});

Deno.test("adopted runtime resumes recovery after process death at each durable boundary", async () => {
    for (const effect of ["recovery-backup", "recovery-controller", "recovery-retirement"]) {
        const project = await makeMigrationProject();
        try {
            const path = join(getRunWieldRuntimeDir(project.primaryRoot), "controller", "plans", "plan.json");
            const current = { version: 1, revision: 5, planName: "demo", state: { documentWorktreeId: "attempt-1" } };
            await writeText(path, JSON.stringify(current));
            assertEquals((await migrateLegacyProjectRuntimeState(project.selectedRoot)).kind, "ready");
            const old = { ...current, revision: 1, state: { executionReport: "Completed before disconnect." } };
            await writeText(path, JSON.stringify(old));
            const child = spawnDriver("migrate-exit-after-effect", project.selectedRoot, effect);
            const [status, output, errors] = await Promise.all([
                child.status,
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
            ]);
            assertEquals(status.code, 86, `${effect}: ${output}${errors}`);
            assertEquals((await migrateLegacyProjectRuntimeState(project.selectedRoot)).kind, "ready");
            const layout = resolveProjectRuntimeLayout(project.selectedRoot);
            assertEquals(JSON.parse(await Deno.readTextFile(join(layout.primary.controllerPlansDir, "plan.json"))), {
                ...current,
                revision: 6,
                state: { ...current.state, ...old.state },
            });
            assert(
                (await snapshotTree(join(layout.primary.internalRoot, "legacy-recovery"))).includes(
                    JSON.stringify(old),
                ),
            );
            await assertMissing(path);
            await assertMissing(layout.primary.layoutMigrationJournalPath);
            assertEquals((await migrateLegacyProjectRuntimeState(project.selectedRoot)).kind, "ready");
        } finally {
            await project.cleanup();
        }
    }
});

Deno.test("legacy migration reports EXDEV without retiring the source authority", async () => {
    const project = await makeMigrationProject();
    const originalRename = Deno.rename;
    try {
        const source = join(getRunWieldRuntimeDir(project.primaryRoot), "controller");
        await writeText(join(source, "plans", "plan.json"), "x\n");
        Object.defineProperty(Deno, "rename", {
            configurable: true,
            value: async (from: string, to: string): Promise<void> => {
                if (from === source) {
                    const error = new Error("cross-device rename");
                    Object.defineProperty(error, "code", { value: "EXDEV" });
                    throw error;
                }
                await originalRename(from, to);
            },
        });
        const result = await migrateLegacyProjectRuntimeState(project.selectedRoot);
        if (result.kind !== "blocked") throw new Error(`Expected blocked, got ${result.kind}`);
        assertEquals(result.reason, "unsupported_filesystem_move");
        assertEquals(await Deno.readTextFile(join(source, "plans", "plan.json")), "x\n");
    } finally {
        Object.defineProperty(Deno, "rename", { configurable: true, value: originalRename });
        await project.cleanup();
    }
});

type MigrationInterruptionEffect =
    | "journal-commit"
    | "primary-rename"
    | "secret-rename"
    | "selected-rename"
    | "stale-lock-retirement"
    | "marker-replacement"
    | "journal-cleanup";

const MIGRATION_INTERRUPTION_EFFECTS: MigrationInterruptionEffect[] = [
    "journal-commit",
    "primary-rename",
    "secret-rename",
    "selected-rename",
    "stale-lock-retirement",
    "marker-replacement",
    "journal-cleanup",
];

type MigrationProject = {
    primaryRoot: string;
    selectedRoot: string;
    registryEntry: {
        id: string;
        planName: string;
        baseBranch: string;
        baseRef: string;
        baseCommit: string;
        branch: string;
        path: string;
        status: string;
        createdAt: string;
        updatedAt: string;
    };
    cleanup: () => Promise<void>;
};

async function makeMigrationProject(): Promise<MigrationProject> {
    const primaryCheckout = await fixture.checkout({ prefix: "runwield-runtime-migration-primary-" });
    const selectedCheckout = await Deno.makeTempDir({ prefix: "runwield-runtime-migration-selected-" });
    const branch = `runtime-migration-${crypto.randomUUID()}`;
    await git(primaryCheckout, ["worktree", "add", "-b", branch, selectedCheckout]);
    const primaryRoot = await Deno.realPath(primaryCheckout);
    const selectedRoot = await Deno.realPath(selectedCheckout);
    const baseCommit = await git(primaryRoot, ["rev-parse", "HEAD"]);
    const now = "2026-01-01T00:00:00.000Z";
    return {
        primaryRoot,
        selectedRoot,
        registryEntry: {
            id: "attempt-1",
            planName: "demo",
            baseBranch: "main",
            baseRef: "refs/heads/main",
            baseCommit,
            branch,
            path: selectedRoot,
            status: "abandoned",
            createdAt: now,
            updatedAt: now,
        },
        cleanup: async () => {
            await git(primaryRoot, ["worktree", "remove", "--force", selectedRoot]).catch(() => {});
            await Deno.remove(primaryRoot, { recursive: true }).catch(() => {});
            await Deno.remove(selectedRoot, { recursive: true }).catch(() => {});
        },
    };
}

async function arrangeInterruptedMigrationEffect(
    project: MigrationProject,
    effect: MigrationInterruptionEffect,
): Promise<void> {
    const primaryBase = getRunWieldRuntimeDir(project.primaryRoot);
    const selectedBase = getRunWieldRuntimeDir(project.selectedRoot);
    if (effect === "secret-rename") {
        await writeText(join(selectedBase, "collaboration-secrets.json"), "linked secret\n");
        return;
    }
    if (effect === "selected-rename") {
        await writeText(join(selectedBase, "plan-transitions", "selected.json"), "selected\n");
        return;
    }
    if (effect === "stale-lock-retirement") {
        const staleLock = join(selectedBase, "plan-locks", "demo.lock");
        await writeText(staleLock, JSON.stringify({ pid: -1, hostname: "stale", updatedAtMs: 0 }));
        await writeText(join(selectedBase, "plan-locks", "durable.txt"), "durable\n");
        const old = new Date(0);
        await Deno.utime(staleLock, old, old);
        return;
    }
    await writeText(join(primaryBase, "controller", "plans", "plan.json"), `${effect}\n`);
}

async function assertInterruptedMigrationEffect(
    project: MigrationProject,
    effect: MigrationInterruptionEffect,
): Promise<void> {
    const layout = resolveProjectRuntimeLayout(project.selectedRoot);
    const primaryBase = getRunWieldRuntimeDir(project.primaryRoot);
    const selectedBase = getRunWieldRuntimeDir(project.selectedRoot);
    if (effect === "journal-commit") {
        await Deno.lstat(layout.primary.layoutMigrationJournalPath);
        await assertMissing(layout.primary.layoutMarkerPath);
    } else if (effect === "primary-rename") {
        await Deno.lstat(join(layout.primary.internalRoot, "controller", "plans", "plan.json"));
        await assertMissing(join(primaryBase, "controller"));
        await assertMissing(layout.primary.layoutMarkerPath);
    } else if (effect === "secret-rename") {
        assertEquals(await Deno.readTextFile(layout.primary.projectSecretStorePath), "linked secret\n");
        await assertMissing(join(selectedBase, "collaboration-secrets.json"));
        const journal = JSON.parse(await Deno.readTextFile(layout.primary.layoutMigrationJournalPath));
        assert(
            journal.operations.some((operation: { source: string }) =>
                operation.source === join(selectedBase, "collaboration-secrets.json")
            ),
        );
        await assertMissing(layout.primary.layoutMarkerPath);
    } else if (effect === "selected-rename") {
        await Deno.lstat(join(layout.selected.transitionJournalsDir, "selected.json"));
        await assertMissing(join(selectedBase, "plan-transitions"));
        await assertMissing(layout.primary.layoutMarkerPath);
    } else if (effect === "stale-lock-retirement") {
        await assertMissing(join(selectedBase, "plan-locks", "demo.lock"));
        await assertMissing(layout.primary.layoutMarkerPath);
    } else if (effect === "marker-replacement") {
        await Deno.lstat(layout.primary.layoutMarkerPath);
        await Deno.lstat(layout.primary.layoutMigrationJournalPath);
    } else {
        await Deno.lstat(layout.primary.layoutMarkerPath);
        await assertMissing(layout.primary.layoutMigrationJournalPath);
    }
}

async function assertCompletedMigrationEffect(
    project: MigrationProject,
    effect: MigrationInterruptionEffect,
): Promise<void> {
    const layout = resolveProjectRuntimeLayout(project.selectedRoot);
    await Deno.lstat(layout.primary.layoutMarkerPath);
    await assertMissing(layout.primary.layoutMigrationJournalPath);
    await assertMissing(layout.primary.layoutMigrationLockPath);
    await assertMissing(join(getRunWieldRuntimeDir(project.primaryRoot), "worktrees.lock"));
    if (effect === "secret-rename") {
        assertEquals(await Deno.readTextFile(layout.primary.projectSecretStorePath), "linked secret\n");
        return;
    }
    if (effect === "selected-rename") {
        assertEquals(
            await Deno.readTextFile(join(layout.selected.transitionJournalsDir, "selected.json")),
            "selected\n",
        );
        return;
    }
    if (effect === "stale-lock-retirement") {
        await assertMissing(join(layout.selected.planLocksDir, "demo.lock"));
        assertEquals(await Deno.readTextFile(join(layout.selected.planLocksDir, "durable.txt")), "durable\n");
        return;
    }
    assertEquals(await Deno.readTextFile(join(layout.primary.controllerPlansDir, "plan.json")), `${effect}\n`);
    await assertMissing(join(getRunWieldRuntimeDir(project.primaryRoot), "controller"));
}

/** Let repository metadata age past the window in which Git answers are never reused. */
async function settleGitEvidence(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 150));
}

async function writeGitLoggingWrapper(binDir: string, log: string, originalPath: string): Promise<void> {
    const wrapper = join(binDir, "git");
    await Deno.writeTextFile(
        wrapper,
        [
            "#!/bin/sh",
            `echo "$1 $2" >> ${JSON.stringify(log)}`,
            `PATH=${JSON.stringify(originalPath)}`,
            "export PATH",
            'exec git "$@"',
            "",
        ].join("\n"),
    );
    await Deno.chmod(wrapper, 0o700);
}

/** The runtime-entry Git reads a log recorded, in order. */
async function readRuntimeGitReads(log: string): Promise<string[]> {
    const lines = (await Deno.readTextFile(log)).split("\n").filter(Boolean);
    return lines.flatMap((line) =>
        line === "worktree list" ? ["worktree list"] : line.startsWith("ls-files ") ? ["ls-files"] : []
    );
}

async function writeText(path: string, contents: string): Promise<void> {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, contents);
}

async function assertMissing(path: string): Promise<void> {
    try {
        await Deno.lstat(path);
        throw new Error(`Expected ${path} to be absent.`);
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return;
        throw error;
    }
}

async function snapshotTree(root: string): Promise<string> {
    const lines: string[] = [];
    await collectSnapshot(root, root, lines);
    return lines.sort().join("\n");
}

async function collectSnapshot(root: string, path: string, lines: string[]): Promise<void> {
    const info = await Deno.lstat(path);
    const relativePath = path === root ? "." : path.slice(root.length + 1);
    lines.push(`${relativePath}:${info.mode ?? 0}:${info.size}:${info.isDirectory ? "dir" : "file"}`);
    if (!info.isDirectory) {
        lines.push(await Deno.readTextFile(path).catch(() => "<binary>"));
        return;
    }
    for await (const entry of Deno.readDir(path)) await collectSnapshot(root, join(path, entry.name), lines);
}

function spawnDriver(command: string, checkoutRoot: string, extra?: string): Deno.ChildProcess {
    return new Deno.Command(Deno.execPath(), {
        cwd: REPO_ROOT,
        args: [
            "run",
            "-A",
            "src/shared/testing/project-runtime-migration-process-driver.ts",
            command,
            checkoutRoot,
            ...(extra ? [extra] : []),
        ],
        stdout: "piped",
        stderr: "piped",
    }).spawn();
}

async function readReadyLine(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("ready")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Driver exited before it held the lock.");
        text += decoder.decode(chunk.value);
    }
    reader.releaseLock();
}

async function readChildStdout(child: Deno.ChildProcess): Promise<string> {
    const [status, stdout, stderr] = await Promise.all([
        child.status,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    if (!status.success) throw new Error(`Driver failed: ${stderr}`);
    return stdout.trim();
}
