import { projects } from "@runwield/projects";
import { readSecretStore } from "../collaboration/secrets.ts";
import { test } from "node:test";
import { equal, ok, rejects } from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, stat, symlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getHomeDir, getRunWieldRuntimeDir } from "../../constants.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { defineCommittedGitFixture } from "../git-test-fixture.ts";
import { stageManagedPersonalRuntime, retireManagedPersonalRuntime } from "../project-runtime-managed.ts";
import { receiveManagedRuntimeTransfer, acknowledgeManagedRuntimeRetirement } from "../../plan-store/index.ts";
import { openNativeFileLock } from "../native-file-lock.ts";
import { DatabaseSync } from "../sqlite.ts";

const secretText =
    JSON.stringify({
        schemaVersion: 1,
        records: {
            legacy: {
                planId: "legacy",
                contentKey: "fixture-key",
                updatedAt: "2026-01-01T00:00:00Z",
                maintainerCapability: "retained-secret",
            },
        },
    }) + "\n";
const gitFixture = defineCommittedGitFixture({
    "README.md": "Legacy execution\n",
    "docs/plans/legacy.md": "# Repository Plan stays separate\n",
});
async function fixture() {
    const root = await gitFixture.checkout();
    const remoteHome = await mkdtemp(join(tmpdir(), "managed-adoption-"));
    const context = {
        executionAccountHome: remoteHome,
        personalOwner: { kind: "managed-remote" as const, identity: getHomeDir() },
    };
    const result = await projects.checkout.admit(root, { context });
    if (result.kind !== "existing") throw new Error("Fixture identity was not admitted.");
    const owner = await projects.home.register({
        projectId: result.identity.projectId,
        repositoryId: result.identity.repositoryId,
        displayName: "Legacy remote",
    });
    const prior = process.env.WLD_TEST_SANDBOX_HOME;
    process.env.WLD_TEST_SANDBOX_HOME = remoteHome;
    const runtime = join(getRunWieldRuntimeDir(root), "internal");
    await mkdir(join(runtime, "controller", "plans"), { recursive: true });
    await writeFile(join(runtime, "controller", "plans", "legacy.json"), '{"status":"in_progress"}\n');
    await writeFile(join(runtime, "collaboration-secrets.json"), secretText);
    return {
        root,
        remoteHome,
        runtime,
        identity: result.identity,
        owner,
        close() {
            if (prior === undefined) delete process.env.WLD_TEST_SANDBOX_HOME;
            else process.env.WLD_TEST_SANDBOX_HOME = prior;
        },
    };
}

test("managed personal runtime stages and resumes after source retirement without importing repository documents", async () => {
    await withProcessGlobalTestLock(async () => {
        const f = await fixture();
        try {
            const database = new DatabaseSync(join(f.runtime, "work-records.sqlite3"));
            database.exec("CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES ('retained record')");
            database.close();
            const transfer = await stageManagedPersonalRuntime(f.identity);
            ok(transfer.files.some((file) => file.name === "work-records.sqlite3"));
            ok((await stat(join(f.runtime, "collaboration-secrets.json"))).isFile());
            await receiveManagedRuntimeTransfer(f.owner, transfer);
            const destination = join(
                f.owner.executionAccountHome,
                ".wld",
                "projects",
                f.owner.projectId,
                "internal",
                "managed-adoption",
                f.owner.repositoryId,
                transfer.transferId,
            );
            const secret = transfer.files.find((file) => file.name === "collaboration-secrets.json")!;
            equal(
                await readFile(join(destination, "runtime", secret.checkoutId, secret.layout, secret.name), "utf8"),
                secretText,
            );
            await retireManagedPersonalRuntime(f.identity, transfer.transferId);
            // Reconnect after source retirement but before the laptop receives its acknowledgement.
            await receiveManagedRuntimeTransfer(f.owner, transfer);
            await retireManagedPersonalRuntime(f.identity, transfer.transferId);
            await acknowledgeManagedRuntimeRetirement(f.owner, transfer);
            await rejects(stat(join(f.runtime, "collaboration-secrets.json")), { code: "ENOENT" });
            await rejects(
                stat(join(f.owner.executionAccountHome, ".wld", "projects", f.owner.projectId, "plans", "legacy")),
                { code: "ENOENT" },
            );
            equal(await readFile(join(f.root, "docs/plans/legacy.md"), "utf8"), "# Repository Plan stays separate\n");
            const receipt: { phase: string } = JSON.parse(await readFile(join(destination, "transfer.json"), "utf8"));
            equal(receipt.phase, "retired");
            const activeSecrets = await readSecretStore({ owner: "home-project", homeOwner: f.owner, path: "" });
            equal(activeSecrets.records.legacy.maintainerCapability, "retained-secret");
        } finally {
            f.close();
        }
    });
});

test("managed runtime refuses live writers, changed staging, and source symlinks", async () => {
    await withProcessGlobalTestLock(async () => {
        const f = await fixture();
        try {
            await mkdir(join(f.runtime, "plan-locks"));
            const held = openNativeFileLock(join(f.runtime, "plan-locks", "legacy.lock"));
            await held.lock(true);
            try {
                await rejects(stageManagedPersonalRuntime(f.identity), /writer is active/);
            } finally {
                held.close();
            }
            const staged = await stageManagedPersonalRuntime(f.identity);
            await receiveManagedRuntimeTransfer(f.owner, staged);
            await writeFile(
                join(f.runtime, "collaboration-secrets.json"),
                secretText.replace("retained-secret", "new-secret"),
            );
            await rejects(retireManagedPersonalRuntime(f.identity, staged.transferId), /changed before retirement/);
            const refreshed = await stageManagedPersonalRuntime(f.identity);
            ok(refreshed.transferId !== staged.transferId);
            await receiveManagedRuntimeTransfer(f.owner, refreshed);
            await retireManagedPersonalRuntime(f.identity, refreshed.transferId);
            await acknowledgeManagedRuntimeRetirement(f.owner, refreshed);
            await mkdir(f.runtime, { recursive: true });
            await symlink(join(f.root, "README.md"), join(f.runtime, "collaboration-secrets.json"));
            await rejects(stageManagedPersonalRuntime(f.identity), /symbolic link/);
        } finally {
            f.close();
        }
    });
});

test("managed personal adoption refuses corrupt and busy SQLite before retiring source", async () => {
    await withProcessGlobalTestLock(async () => {
        const f = await fixture();
        try {
            const path = join(f.runtime, "work-records.sqlite3");
            await writeFile(path, "corrupt index");
            await rejects(stageManagedPersonalRuntime(f.identity));
            ok((await stat(join(f.runtime, "collaboration-secrets.json"))).isFile());
            const { rm } = await import("node:fs/promises");
            await rm(path);
            const database = new DatabaseSync(path);
            database.exec("CREATE TABLE evidence (value TEXT); BEGIN EXCLUSIVE; INSERT INTO evidence VALUES ('busy')");
            try {
                await rejects(stageManagedPersonalRuntime(f.identity));
            } finally {
                database.exec("ROLLBACK");
                database.close();
            }
            const transfer = await stageManagedPersonalRuntime(f.identity);
            await receiveManagedRuntimeTransfer(f.owner, transfer);
            await retireManagedPersonalRuntime(f.identity, transfer.transferId);
            await acknowledgeManagedRuntimeRetirement(f.owner, transfer);
        } finally {
            f.close();
        }
    });
});

test("managed adoption activates the original registered controller and refuses changed execution evidence", async () => {
    await withProcessGlobalTestLock(async () => {
        const f = await fixture();
        try {
            const { rm, rename } = await import("node:fs/promises");
            const { withRetainedPlanFixture } = await import("../testing/retained-plan-fixture.ts");
            const { createTestWorktreeAttempt } = await import("../worktree-test-helpers.ts");
            const { seedPlanController, planFixtureControllerPath } = await import("../testing/plan-state-fixture.ts");
            const { resolveProjectRuntimeLayout } = await import("../project-runtime-layout.ts");
            const { readRetainedManagedExecution } = await import("../../plan-store/index.ts");
            await rm(join(f.runtime, "controller"), { recursive: true });
            await rm(join(f.runtime, "collaboration-secrets.json"));
            const planId = crypto.randomUUID();
            const attempt = await projects.launch.withContext(
                { executionAccountHome: f.remoteHome, personalOwner: f.identity.personalOwner },
                () =>
                    withRetainedPlanFixture(f.root, async () => {
                        const created = await createTestWorktreeAttempt({
                            projectRoot: f.root,
                            planName: "legacy",
                            planId,
                            attemptId: crypto.randomUUID(),
                        });
                        await seedPlanController(
                            f.root,
                            { planName: "legacy", planId },
                            { documentWorktreeId: created.id, executionReport: "Original work survives adoption." },
                        );
                        const controllerPath = planFixtureControllerPath(f.root, { planName: "legacy", planId });
                        const registryPath = resolveProjectRuntimeLayout(f.root).primary.worktreeRegistryPath;
                        await mkdir(join(f.runtime, "controller", "plans"), { recursive: true });
                        await rename(controllerPath, join(f.runtime, "controller", "plans", `${planId}.json`));
                        await rename(registryPath, join(f.runtime, "worktrees.json"));
                        return created;
                    }),
            );
            const transfer = await stageManagedPersonalRuntime(f.identity);
            equal(transfer.attempts.length, 1);
            equal(transfer.attempts[0].entry.id, attempt.id);
            await receiveManagedRuntimeTransfer(f.owner, transfer);
            const registryPath = join(f.runtime, "worktrees.json");
            const original = await readFile(registryPath, "utf8");
            await writeFile(
                registryPath,
                JSON.stringify({ version: 2, entries: [{ ...attempt, branch: "changed-owner" }] }),
            );
            await rejects(retireManagedPersonalRuntime(f.identity, transfer.transferId), /execution changed/);
            ok(await stat(join(f.runtime, "controller", "plans", `${planId}.json`)));
            await writeFile(registryPath, original);
            await retireManagedPersonalRuntime(f.identity, transfer.transferId);
            await acknowledgeManagedRuntimeRetirement(f.owner, transfer);
            const retained = await readRetainedManagedExecution(f.owner, planId, attempt.id);
            equal(retained?.attempt.path, attempt.path);
            equal(retained?.attempt.branch, attempt.branch);
            equal(retained?.attempt.baseCommit, attempt.baseCommit);
            equal(retained?.controller.state.executionReport, "Original work survives adoption.");
            await acknowledgeManagedRuntimeRetirement(f.owner, transfer);
            equal(
                (await readRetainedManagedExecution(f.owner, "legacy", attempt.id))?.controller.revision,
                retained?.controller.revision,
            );
            const retainedRoot = join(
                f.owner.executionAccountHome,
                ".wld",
                "projects",
                f.owner.projectId,
                "internal",
                "retained-executions",
                f.owner.repositoryId,
            );
            const retainedDirectory = join(
                retainedRoot,
                (await readdir(retainedRoot)).find((name) => /^[a-f0-9]{64}$/.test(name))!,
            );
            const bindingPath = join(retainedDirectory, "binding.json");
            const bindingText = await readFile(bindingPath, "utf8");
            const binding: { attempt: typeof attempt } = JSON.parse(bindingText);
            await writeFile(
                bindingPath,
                JSON.stringify({ ...binding, attempt: { ...binding.attempt, baseCommit: "b".repeat(40) } }),
            );
            await rejects(
                receiveManagedRuntimeTransfer(f.owner, transfer),
                /ownership changed before source retirement/,
            );
            await writeFile(bindingPath, bindingText);
            const cleanupPath = join(retainedDirectory, "cleanup.json");
            await writeFile(cleanupPath, "{}\n");
            await rejects(readRetainedManagedExecution(f.owner, planId, attempt.id), /Unsupported publication attempt/);
            await rm(cleanupPath);
            await symlink(bindingPath, cleanupPath);
            await rejects(readRetainedManagedExecution(f.owner, planId, attempt.id), /symbolic link/);
            await rm(cleanupPath);

            await rejects(
                stat(join(f.owner.executionAccountHome, ".wld", "projects", f.owner.projectId, "plans", "legacy")),
                { code: "ENOENT" },
            );
        } finally {
            f.close();
        }
    });
});
