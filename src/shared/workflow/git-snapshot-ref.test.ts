import { readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { getReviewDiff, WorktreeReviewComparisonError } from "./git-snapshot.ts";

const fixture = defineGitFixture(async (cwd) => {
    await writeFile(`${cwd}/shared.txt`, "base\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "base"]);
    await git(cwd, ["switch", "-c", "proposed"]);
    await writeFile(`${cwd}/proposed.txt`, "branch change\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "proposed"]);
    await git(cwd, ["switch", "main"]);
    await writeFile(`${cwd}/target.txt`, "target only\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "target"]);
});

test("ref review shows only proposed commits and leaves the checkout and index intact", async () => {
    const cwd = await fixture.checkout();
    try {
        await writeFile(`${cwd}/shared.txt`, "local edit\n");
        await git(cwd, ["add", "shared.txt"]);
        await writeFile(`${cwd}/untracked.txt`, "local addition\n");
        const status = await git(cwd, ["status", "--porcelain"]);
        const index = await readFile(`${cwd}/.git/index`);
        const head = await git(cwd, ["rev-parse", "HEAD"]);
        const worktrees = await git(cwd, ["worktree", "list", "--porcelain"]);
        const patch = await getReviewDiff(cwd, { baseRef: "main", head: { kind: "ref", ref: "proposed" } });
        assertStringIncludes(patch, "+branch change");
        assertEquals(patch.includes("target.txt"), false);
        assertEquals(patch.includes("shared.txt"), false);
        assertEquals(patch.includes("untracked.txt"), false);
        assertEquals(await readFile(`${cwd}/.git/index`), index);
        assertEquals(await git(cwd, ["status", "--porcelain"]), status);
        assertEquals(await git(cwd, ["rev-parse", "HEAD"]), head);
        assertEquals(await git(cwd, ["worktree", "list", "--porcelain"]), worktrees);
    } finally {
        await rm(cwd, { recursive: true });
    }
});

test("HEAD review includes staged, unstaged, and untracked changes", async () => {
    const cwd = await fixture.checkout();
    try {
        await writeFile(`${cwd}/staged.txt`, "staged change\n");
        await git(cwd, ["add", "staged.txt"]);
        await writeFile(`${cwd}/shared.txt`, "unstaged change\n");
        await writeFile(`${cwd}/untracked.txt`, "untracked change\n");
        const patch = await getReviewDiff(cwd, { baseRef: "HEAD", head: { kind: "worktree" } });
        assertStringIncludes(patch, "+staged change");
        assertStringIncludes(patch, "+unstaged change");
        assertStringIncludes(patch, "+untracked change");
        assertEquals(patch.includes("target.txt"), false);
    } finally {
        await rm(cwd, { recursive: true });
    }
});

test("ref review refuses an unavailable head", async () => {
    const cwd = await fixture.checkout();
    try {
        await assertRejects(
            () => getReviewDiff(cwd, { baseRef: "main", head: { kind: "ref", ref: "missing" } }),
            WorktreeReviewComparisonError,
            "missing is unavailable",
        );
    } finally {
        await rm(cwd, { recursive: true });
    }
});
