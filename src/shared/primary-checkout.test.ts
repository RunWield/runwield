import { assertEquals } from "../testing/assertions.ts";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolvePrimaryCheckoutRoot } from "./primary-checkout.ts";
import { defineGitFixture, git } from "./git-test-fixture.ts";

const repo = defineGitFixture(async (repoPath) => {
    await writeFile(join(repoPath, "README.md"), "base\n");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "base"]);
});

test("resolvePrimaryCheckoutRoot redirects a linked worktree to the primary checkout", async () => {
    const cwd = await repo.checkout();
    const worktreePath = `${cwd}-linked`;
    try {
        await git(cwd, ["worktree", "add", "-b", "side", worktreePath, "main"]);
        assertEquals(resolvePrimaryCheckoutRoot(worktreePath), await realpath(cwd));
    } finally {
        await git(cwd, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
        await rm(cwd, { recursive: true }).catch(() => {});
    }
});

test("resolvePrimaryCheckoutRoot leaves primary, subdirectory, and non-git roots unchanged", async () => {
    const cwd = await repo.checkout();
    const subdir = join(cwd, "subdir");
    const nonGit = await mkdtemp(join(tmpdir(), "rw-test-"));
    try {
        await mkdir(subdir);
        assertEquals(resolvePrimaryCheckoutRoot(cwd), cwd);
        assertEquals(resolvePrimaryCheckoutRoot(subdir), subdir);
        assertEquals(resolvePrimaryCheckoutRoot(nonGit), nonGit);
    } finally {
        await rm(cwd, { recursive: true }).catch(() => {});
        await rm(nonGit, { recursive: true }).catch(() => {});
    }
});
