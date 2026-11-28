import { projects, type ProjectLaunchContext } from "@runwield/projects";
import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { createHash } from "node:crypto";
import { defineCommittedGitFixture, git } from "./git-test-fixture.ts";
import { captureForegroundProcess } from "@runwield/resources/process";
import { enterProjectRuntime } from "@runwield/project-runtime/layout";
import { getRunWieldSessionDir } from "./session/root-session.ts";
import { locateAttachedWorkflows } from "./attached/record-store.ts";
import { getHomeDir } from "../constants.ts";
import { withProcessGlobalTestLock } from "../testing/process-global-lock.ts";
const fixture = defineCommittedGitFixture();
function localContext(home: string): ProjectLaunchContext {
    return { executionAccountHome: home, personalOwner: { kind: "execution-account", identity: home } };
}

test("real runtime entry preserves independently pinned runtime and legacy Session locators", async () => {
    await withProcessGlobalTestLock(async () => {
        const root = await fixture.checkout();
        const home = await mkdtemp(join(tmpdir(), "identity-entry-"));
        const originalHome = process.env.HOME;
        const originalSandboxHome = process.env.WLD_TEST_SANDBOX_HOME;
        try {
            process.env.HOME = home;
            delete process.env.WLD_TEST_SANDBOX_HOME;
            const context = localContext(home);
            const canonicalRoot = await realpath(root);
            // These legacy values are fixed independently of the encoder under test.
            equal(projects.directory.sessionKey("/legacy/runwield project"), "--legacy-runwield project--");
            equal(projects.directory.sessionKey("C:\\legacy\\runwield project"), "--C--legacy-runwield project--");
            const readableKey = `--${canonicalRoot.split(/[\\/]/).filter(Boolean).join("-").replace(/:/g, "-")}--`;
            const legacyKey =
                readableKey.length <= 120
                    ? readableKey
                    : `--${basename(canonicalRoot).slice(0, 40)}-${createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 32)}--`;
            const layout = await enterProjectRuntime(root, { context });
            const binding = projects.checkout.inspect(root, { context });
            ok(binding.kind === "existing");
            const { projectId, repositoryId, checkoutId, personalOwner } = binding.identity;
            const owner = createHash("sha256").update(`${personalOwner.kind}\0${personalOwner.identity}`).digest("hex");
            const project = join(home, ".wld", "projects", projectId);
            const internal = join(project, "internal", "legacy", repositoryId, owner);
            const execution = join(project, "execution", repositoryId, owner);
            const selected = join(execution, "checkouts", checkoutId);
            const locks = join(project, "execution-locks", repositoryId, owner);
            deepEqual(layout, {
                primary: {
                    checkoutRoot: canonicalRoot,
                    internalRoot: internal,
                    layoutMarkerPath: join(internal, "layout.json"),
                    layoutMigrationJournalPath: join(internal, "layout-migration.json"),
                    layoutMigrationLockPath: join(locks, "runtime-adoption.lock"),
                    controllerPlansDir: join(internal, "controller", "plans"),
                    worktreeRegistryPath: join(execution, "worktrees.json"),
                    worktreeRegistryLockPath: join(locks, "worktrees.lock"),
                    worktreeRegistryMigrationIssuesPath: join(execution, "worktree-registry-migration-issues.json"),
                    publicationStagingRoot: join(execution, "plan-staging"),
                    deliveryEvidenceRoot: join(execution, "delivery-evidence"),
                    projectSecretStorePath: join(project, "internal", owner, "collaboration-secrets.json"),
                    fallbackWorktreesRoot: join(execution, "worktrees"),
                    debugRoot: join(execution, "debug"),
                    workRecordIndexDatabasePath: join(project, "internal", owner, "work-records.sqlite3"),
                },
                selected: {
                    checkoutRoot: canonicalRoot,
                    internalRoot: selected,
                    validationLogsDir: join(selected, "validation-logs"),
                    planLocksDir: join(selected, "plan-locks"),
                    planCatalogLockPath: join(selected, "plan-locks", "catalog.lock"),
                    transitionJournalsDir: join(selected, "plan-transitions"),
                    planBackupsDir: join(selected, "plan-backups"),
                    workRecordSupersessionLockPath: join(selected, "work-record-supersession.lock"),
                    workRecordSupersessionRecoveryLockPath: join(selected, "work-record-supersession-recovery.lock"),
                },
            });
            equal(getRunWieldSessionDir(root), join(getHomeDir(), ".wld", "sessions", legacyKey));
            equal(
                locateAttachedWorkflows(root).workflowsDir,
                join(getHomeDir(), ".wld", "attached", legacyKey, "workflows"),
            );
            equal(projects.checkout.inspect(root, { context }).kind, "existing");
        } finally {
            if (originalHome === undefined) delete process.env.HOME;
            else process.env.HOME = originalHome;
            if (originalSandboxHome === undefined) delete process.env.WLD_TEST_SANDBOX_HOME;
            else process.env.WLD_TEST_SANDBOX_HOME = originalSandboxHome;
            await rm(home, { recursive: true, force: true });
            await rm(root, { recursive: true, force: true });
        }
    });
});

test("ordinary CLI presents unavailable clone choice as pending and saves no decline", async () => {
    const { fileURLToPath } = await import("node:url");
    const home = await mkdtemp(join(tmpdir(), "identity-cli-"));
    const source = await fixture.checkout();
    try {
        const one = join(home, "one");
        const two = join(home, "two");
        for (const root of [one, two]) await git(source, ["clone", source, root]);
        equal((await projects.checkout.admit(one, { context: localContext(home) })).kind, "existing");
        const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
        const result = await captureForegroundProcess(process.execPath, {
            cwd: two,
            args: ["--no-env-file", "--no-install", cli, "Establish this Project"],
            env: { HOME: home, WLD_TEST_SANDBOX_HOME: home },
            stdinText: "",
        });
        equal(result.code, 1);
        ok(new TextDecoder().decode(result.stderr).includes("Project clone-link choice required"));
        equal(projects.checkout.inspect(two, { context: localContext(home) }).kind, "pending");
        ok(!(await readdir(join(two, ".git"))).includes(".runwield-project.lock"));
    } finally {
        await rm(home, { recursive: true, force: true });
        await rm(source, { recursive: true, force: true });
    }
});
