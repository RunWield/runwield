import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects } from "../testing/assertions.ts";
import { join } from "node:path";
import { publishExecutionWorktreeIsolated } from "./isolated-publication.ts";
import { createTestWorktreeAttempt, git, makeRepo } from "./worktree-test-helpers.ts";

for (const targetChange of ["advanced", "rewritten"] as const) {
    test(`publication verification handles a target ${targetChange} immediately after push`, async () => {
        const root = await makeRepo();
        const directory = await fsMkdtemp(join(tmpdir(), "publication-target-progress-"));
        const remote = join(directory, "remote.git");
        try {
            await fsMkdir(remote);
            await git(remote, ["init", "--bare"]);
            await git(root, ["remote", "add", "origin", remote]);
            await git(root, ["push", "-u", "origin", "main"]);
            const originalHead = await git(root, ["rev-parse", "HEAD"]);
            const tree = await createTestWorktreeAttempt({
                projectRoot: root,
                planName: "target-progress",
                worktreeRoot: directory,
            });
            await fsWriteFile(join(tree.path, "implementation.txt"), "published implementation\n");
            await git(tree.path, ["add", "implementation.txt"]);
            await git(tree.path, ["commit", "-m", "Implementation"]);
            const sealedCommit = await git(tree.path, ["rev-parse", "HEAD"]);
            await fsWriteFile(join(root, "README.md"), "Unsaved user work\n");
            const primaryStatus = await git(root, ["status", "--porcelain"]);
            let publishedCommit = "";
            let verified = false;
            const publish = () =>
                publishExecutionWorktreeIsolated({
                    projectRoot: root,
                    executionCwd: tree.path,
                    executionBranch: tree.branch,
                    targetBranch: "main",
                    planName: "target-progress",
                    sealedExecutionCommit: sealedCommit,
                    allowedPlanPaths: [],
                    onPublished: async (evidence) => {
                        publishedCommit = evidence.publishedCommit;
                        if (targetChange === "rewritten") {
                            await git(remote, ["update-ref", "refs/heads/main", originalHead]);
                            return;
                        }
                        // External actor, not a shortcut through RunWield's workflow.
                        const other = join(directory, "other");
                        await git(root, ["clone", "--branch", "main", remote, other]);
                        await git(other, ["config", "user.name", "Other developer"]);
                        await git(other, ["config", "user.email", "other@example.com"]);
                        await fsWriteFile(join(other, "later.txt"), "Later change\n");
                        await git(other, ["add", "later.txt"]);
                        await git(other, ["commit", "-m", "Later change"]);
                        await git(other, ["push", "origin", "main"]);
                    },
                    onVerified: () => {
                        verified = true;
                        return Promise.resolve();
                    },
                });
            if (targetChange === "advanced") {
                const result = await publish();
                assert(verified);
                assertEquals(result.publicationCommit, publishedCommit);
                assert(publishedCommit !== await git(remote, ["rev-parse", "main"]));
                await git(remote, ["merge-base", "--is-ancestor", publishedCommit, "main"]);
            } else {
                await assertRejects(publish, Error, "did not retain the completed publication");
                assertEquals(verified, false);
            }
            assertEquals(await git(root, ["rev-parse", "HEAD"]), originalHead);
            assertEquals(await git(root, ["status", "--porcelain"]), primaryStatus);
            assertEquals(await fsReadFile(join(root, "README.md"), "utf8"), "Unsaved user work\n");
        } finally {
            await fsRm(root, { recursive: true });
            await fsRm(directory, { recursive: true });
        }
    });
}
