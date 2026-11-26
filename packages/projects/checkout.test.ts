import { deepEqual } from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projects } from "@runwield/projects";
import { defineCommittedGitFixture, git } from "../../test-support/git-test-fixture.ts";

const repo = defineCommittedGitFixture({ "README.md": "base\n" });

test("resolvePrimaryCheckoutRoot redirects a linked worktree to the primary checkout", async () => {
    const cwd = await repo.checkout();
    const worktreePath = `${cwd}-linked`;
    try {
        await git(cwd, ["worktree", "add", "-b", "side", worktreePath, "main"]);
        deepEqual(projects.checkout.primaryRoot(worktreePath), await realpath(cwd));
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
        deepEqual(projects.checkout.primaryRoot(cwd), cwd);
        deepEqual(projects.checkout.primaryRoot(subdir), subdir);
        deepEqual(projects.checkout.primaryRoot(nonGit), nonGit);
    } finally {
        await rm(cwd, { recursive: true }).catch(() => {});
        await rm(nonGit, { recursive: true }).catch(() => {});
    }
});
