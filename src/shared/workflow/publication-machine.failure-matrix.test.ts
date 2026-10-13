import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import { getCwd } from "../../constants.js";
import { makeTempFile } from "../../testing/temp-file.ts";
import { test } from "node:test";
import { tmpdir } from "node:os";
import {
    chmod as fsChmod,
    lstat as fsLstat,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    realpath as fsRealpath,
    rm as fsRm,
    stat as fsStat,
    symlink as fsSymlink,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertExists } from "../../testing/assertions.ts";
import { dirname, join } from "node:path";
import { fileURLToPath as fromFileUrl } from "node:url";
import { getRunWieldRuntimeDir, PLAN_STAGING_DIR_NAME } from "../../constants.js";
import { resolveProjectRuntimeLayout } from "../project-runtime-layout.ts";
import { addEntry, findById, updatePublication } from "../worktree-registry.js";
import { createTestWorktreeAttempt, git, makeRepo } from "../worktree-test-helpers.ts";
import { createPublicationAttempt } from "./publication-attempt.ts";
import { loadPublicationAttempt, publicationRootForAttempt } from "./publication-machine.ts";

const DRIVER = join(dirname(fromFileUrl(import.meta.url)), "testing/publication-process-driver.ts");

type Fixture = {
    projectRoot: string;
    remoteRoot: string;
    worktreeRoot: string;
    configPath: string;
    planName: string;
    worktree: Awaited<ReturnType<typeof createTestWorktreeAttempt>>;
    initialTarget: string;
};

type DriverResult = { code: number; stdout: string; stderr: string };
type RawPublicationFailure = { repairRoot?: string };
type RawPublication = { failure?: RawPublicationFailure };
type RawRegistryEntry = { id: string; publication?: RawPublication };
type RawRegistry = { version: number; entries: RawRegistryEntry[] };

async function runDriver(configPath: string, crashAfter?: string): Promise<DriverResult> {
    const config = JSON.parse(await fsReadFile(configPath, "utf8")) as Record<string, string>;
    if (crashAfter) config.crashAfter = crashAfter;
    else delete config.crashAfter;
    await fsWriteFile(configPath, JSON.stringify(config));
    const output = await captureForegroundProcess(process.execPath, {
        args: runtimeSourceArgs(["run", "-A", DRIVER, configPath]),
        cwd: getCwd(),
    });
    return {
        code: output.code,
        stdout: new TextDecoder().decode(output.stdout),
        stderr: new TextDecoder().decode(output.stderr),
    };
}

async function makeFixture(planName: string, remote = true): Promise<Fixture> {
    const projectRoot = await makeRepo();
    const remoteRoot = await fsMkdtemp(join(tmpdir(), "publication-failure-remote-"));
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "publication-failure-worktree-"));
    const configPath = await makeTempFile({ prefix: "publication-failure-driver-", suffix: ".json" });
    if (remote) {
        await git(remoteRoot, ["init", "--bare"]);
        await git(projectRoot, ["remote", "add", "origin", remoteRoot]);
        await git(projectRoot, ["push", "-u", "origin", "main"]);
    }
    const worktree = await createTestWorktreeAttempt({ projectRoot, planName, worktreeRoot });
    await fsWriteFile(`${worktree.path}/implementation.txt`, `${planName}\n`);
    const initialTarget = await git(projectRoot, ["rev-parse", "main"]);
    await addEntry(projectRoot, {
        id: "attempt-1",
        planId: "plan-1",
        planName,
        baseBranch: "main",
        baseRef: "refs/heads/main",
        baseCommit: initialTarget,
        branch: worktree.branch,
        path: worktree.path,
        status: "completed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });
    await fsWriteFile(
        configPath,
        JSON.stringify({
            projectRoot,
            attemptId: "attempt-1",
            planName,
            targetBranch: "main",
            executionBranch: worktree.branch,
            executionCwd: worktree.path,
        }),
    );
    return { projectRoot, remoteRoot, worktreeRoot, configPath, planName, worktree, initialTarget };
}

async function dispose(fixture: Fixture): Promise<void> {
    await captureForegroundProcess("git", {
        cwd: fixture.projectRoot,
        args: ["worktree", "remove", "--force", fixture.worktree.path],
    }).catch(() => {});
    await fsRm(fixture.projectRoot, { recursive: true }).catch(() => {});
    await fsRm(fixture.remoteRoot, { recursive: true }).catch(() => {});
    await fsRm(fixture.worktreeRoot, { recursive: true }).catch(() => {});
    await fsRm(fixture.configPath).catch(() => {});
}

async function assertRecoverable(fixture: Fixture, kind: string): Promise<void> {
    const attempt = await loadPublicationAttempt(fixture.projectRoot, "attempt-1");
    assertExists(attempt);
    assertEquals(attempt.failure?.kind, kind);
    assert((await fsStat(fixture.worktree.path)).isDirectory());
    assert((await git(fixture.projectRoot, ["branch", "--list", fixture.worktree.branch])).trim());
    assertExists(await findById(fixture.projectRoot, "attempt-1", { migrate: false }));
}

async function assertPublishedOnce(fixture: Fixture): Promise<void> {
    const remoteHead = (await git(fixture.projectRoot, ["ls-remote", "origin", "refs/heads/main"]))
        .split(/\s+/)[0];
    assertEquals(await git(fixture.projectRoot, ["show", `${remoteHead}:implementation.txt`]), fixture.planName);
    await git(fixture.projectRoot, ["fetch", "origin", "main"]);
    const messages = await git(fixture.projectRoot, ["log", "--all", "--format=%B"]);
    assertEquals(messages.split("RunWield-Publication-Attempt: attempt-1").length - 1, 1);
    assertEquals(await findById(fixture.projectRoot, "attempt-1", { migrate: false }), null);
}

async function writeRejectingHook(remoteRoot: string, message: string): Promise<string> {
    const hookPath = `${remoteRoot}/hooks/pre-receive`;
    await fsWriteFile(hookPath, `#!/bin/sh\necho '${message}' >&2\nexit 1\n`);
    await fsChmod(hookPath, 0o755);
    return hookPath;
}

test("publication failure and recovery matrix uses real Git and fresh processes", async (test) => {
    await test.test("unavailable remote preserves evidence and resumes without rebuilding artifacts", async () => {
        const fixture = await makeFixture("remote-unavailable");
        try {
            await git(fixture.projectRoot, ["remote", "set-url", "origin", `${fixture.remoteRoot}-missing`]);
            assertEquals((await runDriver(fixture.configPath)).code, 1);
            await assertRecoverable(fixture, "remote_unavailable");
            await git(fixture.projectRoot, ["remote", "set-url", "origin", fixture.remoteRoot]);
            assertEquals((await runDriver(fixture.configPath)).code, 0);
            await assertPublishedOnce(fixture);
        } finally {
            await dispose(fixture);
        }
    });

    await test.test("a repository symlink survives publication retry", async () => {
        const fixture = await makeFixture("repository-symlink");
        try {
            await fsWriteFile(`${fixture.projectRoot}/AGENTS.md`, "repository guidance\n");
            await fsMkdir(`${fixture.projectRoot}/docs`);
            await fsWriteFile(`${fixture.projectRoot}/docs/guide.md`, "guide\n");
            await fsSymlink("AGENTS.md", `${fixture.projectRoot}/CLAUDE.md`);
            await fsSymlink("docs", `${fixture.projectRoot}/docs-link`);
            await git(fixture.projectRoot, ["add", "AGENTS.md", "CLAUDE.md", "docs", "docs-link"]);
            await git(fixture.projectRoot, ["commit", "-m", "Add repository guidance symlink"]);
            await git(fixture.projectRoot, ["push", "origin", "main"]);
            await git(fixture.worktree.path, ["merge", "main"]);

            const interrupted = await runDriver(fixture.configPath, "verification_receipt");
            assertEquals(interrupted.code, 86, `${interrupted.stdout}\n${interrupted.stderr}`);
            const publicationRoot = publicationRootForAttempt(fixture.projectRoot, "attempt-1");
            assert((await fsLstat(`${publicationRoot}/CLAUDE.md`)).isSymbolicLink());

            assertEquals((await runDriver(fixture.configPath)).code, 0);
            await assertPublishedOnce(fixture);
            const remoteHead = (await git(fixture.projectRoot, ["ls-remote", "origin", "refs/heads/main"]))
                .split(/\s+/)[0];
            assertEquals(await git(fixture.projectRoot, ["show", `${remoteHead}:AGENTS.md`]), "repository guidance");
            assertEquals(await git(fixture.projectRoot, ["show", `${remoteHead}:CLAUDE.md`]), "AGENTS.md");
            assertEquals(await git(fixture.projectRoot, ["show", `${remoteHead}:docs-link`]), "docs");
            assertEquals(
                (await git(fixture.projectRoot, ["ls-tree", remoteHead, "CLAUDE.md"])).split(/\s+/)[0],
                "120000",
            );
            await fsLstat(publicationRoot).then(
                () => assert(false, "publication checkout was not removed"),
                (error) => assert(error instanceof Error && "code" in error && error.code === "ENOENT"),
            );
        } finally {
            await dispose(fixture);
        }
    });

    for (
        const rejection of [
            {
                name: "remote policy rejection",
                message: "protected branch policy: pre-receive hook declined",
                kind: "policy_violation",
            },
            {
                name: "remote permission rejection",
                message: "permission denied: you are not allowed to update this branch",
                kind: "permission_denied",
            },
            { name: "target reference race", message: "stale info: target moved", kind: "target_reference_race" },
        ]
    ) {
        await test.test(`${rejection.name} is durable and succeeds after the cause is removed`, async () => {
            const fixture = await makeFixture(rejection.kind);
            try {
                const hookPath = await writeRejectingHook(fixture.remoteRoot, rejection.message);
                assertEquals((await runDriver(fixture.configPath)).code, 1);
                await assertRecoverable(fixture, rejection.kind);
                await fsRm(hookPath);
                assertEquals((await runDriver(fixture.configPath)).code, 0);
                await assertPublishedOnce(fixture);
            } finally {
                await dispose(fixture);
            }
        });
    }

    await test.test("a real target advance refreshes an integration receipt before publication", async () => {
        const fixture = await makeFixture("target-advance-after-integration");
        try {
            assertEquals((await runDriver(fixture.configPath, "integration_receipt")).code, 86);
            const firstIntegration = await loadPublicationAttempt(fixture.projectRoot, "attempt-1");
            assertEquals(firstIntegration?.phase, "target_integrated");

            await fsWriteFile(`${fixture.projectRoot}/arrived-after-integration.txt`, "preserved\n");
            await git(fixture.projectRoot, ["add", "arrived-after-integration.txt"]);
            await git(fixture.projectRoot, ["commit", "-m", "Advance target after integration receipt"]);
            await git(fixture.projectRoot, ["push", "origin", "main"]);
            const advancedTarget = await git(fixture.projectRoot, ["rev-parse", "HEAD"]);

            assertEquals((await runDriver(fixture.configPath)).code, 0);
            await assertPublishedOnce(fixture);
            const remoteHead = (await git(fixture.projectRoot, ["ls-remote", "origin", "refs/heads/main"]))
                .split(/\s+/)[0];
            await git(fixture.projectRoot, ["fetch", "origin", "main"]);
            await git(fixture.projectRoot, ["merge-base", "--is-ancestor", advancedTarget, remoteHead]);
            assertEquals(
                await git(fixture.projectRoot, ["show", `${remoteHead}:arrived-after-integration.txt`]),
                "preserved",
            );
        } finally {
            await dispose(fixture);
        }
    });

    await test.test("a real content conflict can be repaired in the saved publication copy and resumed", async () => {
        const fixture = await makeFixture("content-conflict");
        try {
            await fsWriteFile(`${fixture.projectRoot}/conflict.txt`, "base\n");
            await git(fixture.projectRoot, ["add", "conflict.txt"]);
            await git(fixture.projectRoot, ["commit", "-m", "Add conflict base"]);
            await git(fixture.projectRoot, ["push", "origin", "main"]);
            await git(fixture.worktree.path, ["merge", "main"]);
            await fsWriteFile(`${fixture.worktree.path}/conflict.txt`, "execution\n");
            await git(fixture.worktree.path, ["add", "conflict.txt"]);
            await git(fixture.worktree.path, ["commit", "-m", "Change conflict in execution"]);
            const executionCommit = await git(fixture.worktree.path, ["rev-parse", "HEAD"]);
            await fsWriteFile(`${fixture.projectRoot}/conflict.txt`, "target\n");
            await git(fixture.projectRoot, ["add", "conflict.txt"]);
            await git(fixture.projectRoot, ["commit", "-m", "Change conflict on target"]);
            await git(fixture.projectRoot, ["push", "origin", "main"]);

            assertEquals((await runDriver(fixture.configPath)).code, 1);
            await assertRecoverable(fixture, "isolated_publication_conflict");
            const repairRoot = publicationRootForAttempt(fixture.projectRoot, "attempt-1");
            assert((await fsStat(repairRoot)).isDirectory());
            await fsWriteFile(`${repairRoot}/conflict.txt`, "resolved\n");
            await git(repairRoot, ["add", "conflict.txt"]);
            await git(repairRoot, ["commit", "--no-edit"]);

            await fsWriteFile(`${fixture.projectRoot}/arrived-during-repair.txt`, "preserved\n");
            await git(fixture.projectRoot, ["add", "arrived-during-repair.txt"]);
            await git(fixture.projectRoot, ["commit", "-m", "Advance target during publication repair"]);
            await git(fixture.projectRoot, ["push", "origin", "main"]);
            const advancedTarget = await git(fixture.projectRoot, ["rev-parse", "HEAD"]);

            assertEquals((await runDriver(fixture.configPath, "integration_effect")).code, 86);
            assertEquals(
                (await loadPublicationAttempt(fixture.projectRoot, "attempt-1"))?.phase,
                "artifacts_committed",
            );
            assertEquals((await runDriver(fixture.configPath)).code, 0);
            await assertPublishedOnce(fixture);
            const remoteHead = (await git(fixture.projectRoot, ["ls-remote", "origin", "refs/heads/main"]))
                .split(/\s+/)[0];
            await git(fixture.projectRoot, ["fetch", "origin", "main"]);
            await git(fixture.projectRoot, ["merge-base", "--is-ancestor", advancedTarget, remoteHead]);
            await git(fixture.projectRoot, ["merge-base", "--is-ancestor", executionCommit, remoteHead]);
            assertEquals(await git(fixture.projectRoot, ["show", `${remoteHead}:conflict.txt`]), "resolved");
            assertEquals(
                await git(fixture.projectRoot, ["show", `${remoteHead}:arrived-during-repair.txt`]),
                "preserved",
            );
            assertEquals(await fsStat(repairRoot).then(() => true).catch(() => false), false);
        } finally {
            await dispose(fixture);
        }
    });

    await test.test("a saved legacy publication checkout resumes after runtime migration", async () => {
        const fixture = await makeFixture("legacy-saved-repair");
        try {
            await fsWriteFile(`${fixture.projectRoot}/conflict.txt`, "base\n");
            await git(fixture.projectRoot, ["add", "conflict.txt"]);
            await git(fixture.projectRoot, ["commit", "-m", "Add legacy conflict base"]);
            await git(fixture.projectRoot, ["push", "origin", "main"]);
            await git(fixture.worktree.path, ["merge", "main"]);
            await fsWriteFile(`${fixture.worktree.path}/conflict.txt`, "execution\n");
            await git(fixture.worktree.path, ["add", "conflict.txt"]);
            await git(fixture.worktree.path, ["commit", "-m", "Change legacy conflict in execution"]);
            const executionCommit = await git(fixture.worktree.path, ["rev-parse", "HEAD"]);
            await fsWriteFile(`${fixture.projectRoot}/conflict.txt`, "target\n");
            await git(fixture.projectRoot, ["add", "conflict.txt"]);
            await git(fixture.projectRoot, ["commit", "-m", "Change legacy conflict on target"]);
            await git(fixture.projectRoot, ["push", "origin", "main"]);
            const targetHeadAtSeal = await git(fixture.projectRoot, ["rev-parse", "HEAD"]);
            const primaryRoot = await fsRealpath(fixture.projectRoot);
            const legacyRoot = join(getRunWieldRuntimeDir(primaryRoot), PLAN_STAGING_DIR_NAME, "attempt-1");
            const internalRoot = publicationRootForAttempt(fixture.projectRoot, "attempt-1");
            await updatePublication(
                fixture.projectRoot,
                "attempt-1",
                null,
                createPublicationAttempt({
                    attemptId: "attempt-1",
                    planId: "plan-1",
                    planName: fixture.planName,
                    targetBranch: "main",
                    executionBranch: fixture.worktree.branch,
                    executionCwd: fixture.worktree.path,
                    publicationRoot: legacyRoot,
                    validatedCommit: executionCommit,
                    targetHeadAtSeal,
                }),
            );

            assertEquals((await runDriver(fixture.configPath)).code, 1);
            assert((await fsStat(legacyRoot)).isDirectory());
            assertEquals(await fsStat(internalRoot).then(() => true).catch(() => false), false);
            await fsWriteFile(`${legacyRoot}/conflict.txt`, "resolved legacy\n");
            await git(legacyRoot, ["add", "conflict.txt"]);
            await git(legacyRoot, ["commit", "--no-edit"]);

            const layout = resolveProjectRuntimeLayout(fixture.projectRoot);
            const registry = JSON.parse(await fsReadFile(layout.primary.worktreeRegistryPath, "utf8")) as RawRegistry;
            const entry = registry.entries.find((candidate) => candidate.id === "attempt-1");
            assertExists(entry);
            const publication = entry.publication;
            assertExists(publication);
            publication.failure = publication.failure || {};
            publication.failure.repairRoot = legacyRoot;
            const legacyRegistryPath = join(getRunWieldRuntimeDir(primaryRoot), "worktrees.json");
            await fsMkdir(dirname(legacyRegistryPath), { recursive: true });
            await fsWriteFile(legacyRegistryPath, `${JSON.stringify(registry, null, 2)}\n`);
            await fsRm(layout.primary.internalRoot, { recursive: true });

            const retry = await runDriver(fixture.configPath);
            assertEquals(retry.code, 0, retry.stderr);
            await assertPublishedOnce(fixture);
            assertEquals(
                await git(fixture.projectRoot, ["show", "origin/main:conflict.txt"]),
                "resolved legacy",
            );
            await git(fixture.projectRoot, ["merge-base", "--is-ancestor", executionCommit, "origin/main"]);
            assertEquals(await fsStat(internalRoot).then(() => true).catch(() => false), false);
            assertEquals(await fsStat(legacyRoot).then(() => true).catch(() => false), false);
            assertEquals(await fsStat(legacyRegistryPath).then(() => true).catch(() => false), false);
        } finally {
            await dispose(fixture);
        }
    });

    await test.test("dirty tracked local target blocks safely and resumes after the checkout is clean", async () => {
        const fixture = await makeFixture("local-dirty", false);
        try {
            await fsWriteFile(`${fixture.projectRoot}/README.md`, "unsaved user edit\n");
            assertEquals((await runDriver(fixture.configPath)).code, 1);
            await assertRecoverable(fixture, "primary_checkout_dirty");
            assertEquals(await fsReadFile(`${fixture.projectRoot}/README.md`, "utf8"), "unsaved user edit\n");
            await git(fixture.projectRoot, ["restore", "README.md"]);
            assertEquals((await runDriver(fixture.configPath)).code, 0);
            assertEquals(await findById(fixture.projectRoot, "attempt-1", { migrate: false }), null);
            assertEquals(await git(fixture.projectRoot, ["show", "main:implementation.txt"]), fixture.planName);
        } finally {
            await dispose(fixture);
        }
    });

    for (const mode of ["remote", "local"] as const) {
        await test.test(`${mode} target rewrite after verification prevents cleanup until exact target is restored`, async () => {
            const fixture = await makeFixture(`${mode}-rewrite`, mode === "remote");
            try {
                assertEquals((await runDriver(fixture.configPath, "verification_receipt")).code, 86);
                const attempt = await loadPublicationAttempt(fixture.projectRoot, "attempt-1");
                assertExists(attempt?.publishedCommit);
                if (mode === "remote") {
                    await git(fixture.projectRoot, ["fetch", "origin", "main"]);
                    await git(fixture.projectRoot, [
                        "push",
                        "--force",
                        "origin",
                        `${fixture.initialTarget}:refs/heads/main`,
                    ]);
                } else {
                    await git(fixture.projectRoot, ["reset", "--hard", fixture.initialTarget]);
                }
                assertEquals((await runDriver(fixture.configPath)).code, 1);
                assertExists(await findById(fixture.projectRoot, "attempt-1", { migrate: false }));
                assert((await fsStat(fixture.worktree.path)).isDirectory());
                if (mode === "remote") {
                    await git(fixture.projectRoot, [
                        "push",
                        "--force",
                        "origin",
                        `${attempt.publishedCommit}:refs/heads/main`,
                    ]);
                } else {
                    await git(fixture.projectRoot, ["reset", "--hard", attempt.publishedCommit]);
                }
                assertEquals((await runDriver(fixture.configPath)).code, 0);
                assertEquals(await findById(fixture.projectRoot, "attempt-1", { migrate: false }), null);
            } finally {
                await dispose(fixture);
            }
        });
    }

    await test.test("cleanup preserves a late user file and resumes after it is removed", async () => {
        const fixture = await makeFixture("cleanup-incomplete");
        try {
            assertEquals((await runDriver(fixture.configPath, "verification_receipt")).code, 86);
            const latePath = `${fixture.worktree.path}/late-user-file.txt`;
            await fsWriteFile(latePath, "do not delete me\n");
            assertEquals((await runDriver(fixture.configPath)).code, 1);
            assertEquals(await fsReadFile(latePath, "utf8"), "do not delete me\n");
            assertExists(await findById(fixture.projectRoot, "attempt-1", { migrate: false }));
            assert((await fsStat(fixture.worktree.path)).isDirectory());
            await fsRm(latePath);
            assertEquals((await runDriver(fixture.configPath)).code, 0);
            assertEquals(await findById(fixture.projectRoot, "attempt-1", { migrate: false }), null);
        } finally {
            await dispose(fixture);
        }
    });

    await test.test("concurrent publishers converge through registry CAS without duplicate artifacts", async () => {
        const fixture = await makeFixture("concurrent-cas");
        try {
            assertEquals((await runDriver(fixture.configPath, "artifact_receipt")).code, 86);
            const command = () =>
                captureForegroundProcess(process.execPath, {
                    args: runtimeSourceArgs(["run", "-A", DRIVER, fixture.configPath]),
                    cwd: getCwd(),
                });
            await Promise.all([command(), command()]);
            const settle = await runDriver(fixture.configPath);
            if (settle.code !== 0) {
                const attempt = await loadPublicationAttempt(fixture.projectRoot, "attempt-1");
                const branchHead = await git(fixture.projectRoot, ["rev-parse", fixture.worktree.branch]).catch(
                    (error) => String(error),
                );
                const remoteHead = await git(fixture.projectRoot, ["ls-remote", "origin", "refs/heads/main"]);
                const graph = await git(fixture.projectRoot, ["log", "--all", "--graph", "--oneline", "--decorate"]);
                throw new Error(
                    `${settle.stderr || settle.stdout}\nattempt=${
                        JSON.stringify(attempt)
                    }\nbranch=${branchHead}\nremote=${remoteHead}\n${graph}`,
                );
            }
            await assertPublishedOnce(fixture);
        } finally {
            await dispose(fixture);
        }
    });
});
