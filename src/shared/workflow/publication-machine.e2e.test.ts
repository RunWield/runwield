import { assertEquals } from "../../testing/assertions.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import { makeTempFile } from "../../testing/temp-file.ts";
import { test } from "node:test";
import { tmpdir } from "node:os";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { join } from "node:path";
import { addEntry, findById } from "../worktree-registry.js";
import { createTestWorktreeAttempt, git, makeRepo } from "../worktree-test-helpers.ts";
import { publicationRootForAttempt } from "./publication-machine.ts";

import { runDriver } from "./publication-machine-test-helpers.ts";

test("publication to main does not follow a different upstream branch", async () => {
    const projectRoot = await makeRepo();
    const remoteRoot = await fsMkdtemp(join(tmpdir(), "publication-target-remote-"));
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "publication-target-worktree-"));
    const configPath = await makeTempFile({ prefix: "publication-target-driver-", suffix: ".json" });
    try {
        await git(remoteRoot, ["init", "--bare"]);
        await git(projectRoot, ["remote", "add", "origin", remoteRoot]);
        await git(projectRoot, ["push", "origin", "main:main"]);
        await git(projectRoot, ["push", "origin", "main:epic/billing-api-integration"]);
        await git(projectRoot, ["config", "branch.main.remote", "origin"]);
        await git(projectRoot, ["config", "branch.main.merge", "refs/heads/epic/billing-api-integration"]);
        await git(projectRoot, ["switch", "-c", "epic/billing-api-integration"]);
        const originalEpic = await git(remoteRoot, ["rev-parse", "refs/heads/epic/billing-api-integration"]);
        const originalMain = await git(remoteRoot, ["rev-parse", "refs/heads/main"]);
        const worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "wrong-upstream",
            baseBranch: "main",
            baseRef: "refs/heads/main",
            worktreeRoot,
            attemptId: "attempt-1",
        });
        await fsWriteFile(`${worktree.path}/implementation.txt`, "published to main\n");
        await fsWriteFile(
            configPath,
            JSON.stringify({
                projectRoot,
                attemptId: "attempt-1",
                planName: "wrong-upstream",
                targetBranch: "main",
                executionBranch: worktree.branch,
                executionCwd: worktree.path,
            }),
        );
        assertEquals(await runDriver(configPath), 0);
        const main = await git(remoteRoot, ["rev-parse", "refs/heads/main"]);
        assert(main !== originalMain, "target main must advance");
        assertEquals(await git(remoteRoot, ["rev-parse", "refs/heads/epic/billing-api-integration"]), originalEpic);
        assertEquals(await git(remoteRoot, ["show", `${main}:implementation.txt`]), "published to main");
    } finally {
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
        await fsRm(remoteRoot, { recursive: true }).catch(() => {});
        await fsRm(worktreeRoot, { recursive: true }).catch(() => {});
        await fsRm(configPath).catch(() => {});
    }
});

test("remote publication invoked from a linked checkout stages below the primary internal root", async () => {
    const projectRoot = await makeRepo();
    const remoteRoot = await fsMkdtemp(join(tmpdir(), "publication-linked-remote-"));
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "publication-linked-worktree-"));
    const linkedParent = await fsMkdtemp(join(tmpdir(), "publication-linked-invocation-"));
    const linkedRoot = join(linkedParent, "linked");
    const configPath = await makeTempFile({ prefix: "publication-linked-driver-", suffix: ".json" });
    try {
        await git(remoteRoot, ["init", "--bare"]);
        await git(projectRoot, ["remote", "add", "origin", remoteRoot]);
        await git(projectRoot, ["push", "-u", "origin", "main"]);
        await git(projectRoot, ["worktree", "add", "-b", "linked-invocation", linkedRoot]);
        const worktree = await createTestWorktreeAttempt({ projectRoot, planName: "linked-publication", worktreeRoot });
        await fsWriteFile(`${worktree.path}/implementation.txt`, "linked publication\n");
        const targetHead = await git(projectRoot, ["rev-parse", "main"]);
        await addEntry(linkedRoot, {
            id: "attempt-1",
            planId: "plan-1",
            planName: "linked-publication",
            baseBranch: "main",
            baseRef: "refs/heads/main",
            baseCommit: targetHead,
            branch: worktree.branch,
            path: worktree.path,
            status: "completed",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });
        await fsWriteFile(
            configPath,
            JSON.stringify({
                projectRoot: linkedRoot,
                attemptId: "attempt-1",
                planName: "linked-publication",
                targetBranch: "main",
                executionBranch: worktree.branch,
                executionCwd: worktree.path,
            }),
        );

        assertEquals(await runDriver(configPath, "verification_receipt"), 86);
        const attempt = await findById(projectRoot, "attempt-1", { migrate: false });
        const publicationRoot = attempt?.publication?.publicationRoot;
        assert(publicationRoot);
        assertEquals(publicationRoot, publicationRootForAttempt(linkedRoot, "attempt-1"));
        assert(publicationRoot.includes(join(".wld", "internal", "plan-staging", "attempt-1")));
        assertEquals(publicationRoot.includes(linkedRoot), false);
        assertEquals(await fsStat(publicationRoot).then((stat) => stat.isDirectory()), true);
        assertEquals(await git(publicationRoot, ["show", "HEAD:implementation.txt"]), "linked publication");

        assertEquals(await runDriver(configPath), 0);
        const remoteHead = (await git(projectRoot, ["ls-remote", "origin", "refs/heads/main"])).split(/\s+/)[0];
        await git(projectRoot, ["fetch", "origin", "main"]);
        await git(projectRoot, ["merge-base", "--is-ancestor", targetHead, remoteHead]);
        assertEquals(await git(projectRoot, ["show", `${remoteHead}:implementation.txt`]), "linked publication");
        assertEquals(await findById(projectRoot, "attempt-1", { migrate: false }), null);
        assertEquals(
            await fsStat(publicationRoot)
                .then(() => true)
                .catch(() => false),
            false,
        );
    } finally {
        await captureForegroundProcess("git", {
            cwd: projectRoot,
            args: ["worktree", "remove", "--force", linkedRoot],
        }).catch(() => {});
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
        await fsRm(remoteRoot, { recursive: true }).catch(() => {});
        await fsRm(worktreeRoot, { recursive: true }).catch(() => {});
        await fsRm(linkedParent, { recursive: true }).catch(() => {});
        await fsRm(configPath).catch(() => {});
    }
});

test("publication cleanup saves a directory left after Git removed its worktree registration", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "publication-leftover-worktree-"));
    const configPath = await makeTempFile({ prefix: "publication-leftover-driver-", suffix: ".json" });
    try {
        const worktree = await createTestWorktreeAttempt({ projectRoot, planName: "leftover", worktreeRoot });
        await fsWriteFile(join(worktree.path, "implementation.txt"), "published\n");
        const targetHead = await git(projectRoot, ["rev-parse", "main"]);
        await addEntry(projectRoot, {
            id: "attempt-1",
            planId: "plan-1",
            planName: "leftover",
            baseBranch: "main",
            baseRef: "refs/heads/main",
            baseCommit: targetHead,
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
                planName: "leftover",
                targetBranch: "main",
                executionBranch: worktree.branch,
                executionCwd: worktree.path,
            }),
        );
        assertEquals(await runDriver(configPath, "verification_receipt"), 86);
        await git(projectRoot, ["worktree", "remove", worktree.path]);
        await fsMkdir(join(worktree.path, ".astro", "collections"), { recursive: true });
        await fsWriteFile(join(worktree.path, ".astro", "collections", "note.txt"), "keep this\n");
        assertEquals(await runDriver(configPath), 0);
        assertEquals(await findById(projectRoot, "attempt-1", { migrate: false }), null);
        assertEquals(
            await fsStat(worktree.path)
                .then(() => true)
                .catch(() => false),
            false,
        );
        assertEquals(
            await fsReadFile(join(`${worktree.path}.saved`, "files", ".astro", "collections", "note.txt"), "utf8"),
            "keep this\n",
        );
        assertEquals((await git(projectRoot, ["branch", "--list", worktree.branch])).trim(), "");
    } finally {
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
        await fsRm(worktreeRoot, { recursive: true }).catch(() => {});
        await fsRm(configPath).catch(() => {});
    }
});
