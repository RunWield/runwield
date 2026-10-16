import { rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../testing/assertions.ts";
import { createGitPort } from "./git-port.ts";
import { defineGitFixture, git } from "./git-test-fixture.ts";

// main, plus a side branch carrying work that never reached it.
const repo = defineGitFixture(async (repoPath) => {
    await fsWriteFile(`${repoPath}/file.txt`, "base\n");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "base"]);
    await git(repoPath, ["checkout", "-b", "side"]);
    await fsWriteFile(`${repoPath}/file.txt`, "side\n");
    await git(repoPath, ["commit", "-am", "side work"]);
    await git(repoPath, ["checkout", "main"]);
});

// The contract tests for the Git boundary. Everything else in the codebase may fake
// this port; these run real Git so the fake has something true to imitate. A fake
// cannot verify our understanding of a Git command, because it is written from the
// same understanding.
test("GitPort.isAncestor answers Git's reachability question in the right direction", async () => {
    const cwd = await repo.checkout();
    try {
        const port = createGitPort();
        const mainHead = await git(cwd, ["rev-parse", "main"]);
        const sideHead = await git(cwd, ["rev-parse", "side"]);

        // main's commit is reachable from side (side was branched from it).
        assertEquals(await port.isAncestor(cwd, mainHead, "side"), true);
        // side's commit never reached main. Reversing the arguments would flip both of
        // these, which is exactly the mistake a fake cannot catch.
        assertEquals(await port.isAncestor(cwd, sideHead, "main"), false);
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("GitPort.branchHead resolves a local branch to its commit", async () => {
    const cwd = await repo.checkout();
    try {
        const port = createGitPort();
        assertEquals(await port.branchHead(cwd, "main"), await git(cwd, ["rev-parse", "main"]));
        assertEquals(await port.branchHead(cwd, "side"), await git(cwd, ["rev-parse", "side"]));
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("GitPort.captureTree includes untracked work and diffAgainstTree reports it", async () => {
    const cwd = await repo.checkout();
    try {
        const port = createGitPort();
        const baseline = await port.captureTree(cwd);
        await fsWriteFile(`${cwd}/added.txt`, "new work\n");

        // A baseline that missed untracked files would report an empty diff here, and
        // validation would conclude no work was done.
        const diff = await port.diffAgainstTree(cwd, baseline);
        assertStringIncludes(diff, "added.txt");
        assertStringIncludes(diff, "new work");

        const after = await port.captureTree(cwd);
        assertEquals(after === baseline, false, "the tree changes once there is new work");
        assertStringIncludes(await port.diffTrees(cwd, baseline, after), "added.txt");
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});
