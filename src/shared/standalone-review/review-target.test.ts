import { rm, writeFile } from "node:fs/promises";
import { makeTempDirectory } from "../../testing/temp-file.ts";
import { test } from "node:test";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { resolveReviewTarget, resolveReviewTargetWithForge } from "./review-target.ts";
const fixture = defineGitFixture(async (cwd) => {
    await writeFile(`${cwd}/base.txt`, "base\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "base"]);
    await git(cwd, ["switch", "-c", "topic"]);
    await writeFile(`${cwd}/topic.txt`, "topic change\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "topic"]);
    await git(cwd, ["switch", "main"]);
    await writeFile(`${cwd}/later.txt`, "later target change\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "later"]);
});
test("uncommitted review includes staged, unstaged, and untracked files", async () => {
    const cwd = await fixture.checkout();
    try {
        await writeFile(`${cwd}/staged.txt`, "staged\n");
        await git(cwd, ["add", "."]);
        await writeFile(`${cwd}/base.txt`, "unstaged\n");
        await writeFile(`${cwd}/new.txt`, "untracked\n");
        const target = await resolveReviewTarget(cwd);
        const diff = await target.computeDiff();
        for (const text of ["+staged", "+unstaged", "+untracked"]) assertStringIncludes(diff, text);
        assertEquals(target.mode, "uncommitted");
    } finally {
        await rm(cwd, { recursive: true });
    }
});
test("branch review excludes later target commits and creates no worktree", async () => {
    const cwd = await fixture.checkout();
    try {
        const before = await git(cwd, ["worktree", "list", "--porcelain"]);
        const target = await resolveReviewTarget(cwd, "topic");
        const diff = await target.computeDiff();
        assertStringIncludes(diff, "+topic change");
        assertEquals(diff.includes("later.txt"), false);
        assertEquals(target.gitRef, "refs/heads/topic");
        assertEquals(await git(cwd, ["worktree", "list", "--porcelain"]), before);
    } finally {
        await rm(cwd, { recursive: true });
    }
});
for (const [arg, message] of [
    ["missing", "does not exist"],
    ["main", "Use wld review"],
    ["https://github.com/foreign/repo/pull/1", "must match a remote"],
    ["https://github.com/org/repo", "Expected a PR"],
    [undefined, "no uncommitted changes"],
]) {
    test(`invalid target ${arg} has no repository side effects`, async () => {
        const cwd = await fixture.checkout();
        try {
            const before = await git(cwd, ["show-ref"]);
            const status = await git(cwd, ["status", "--porcelain"]);
            await assertRejects(() => resolveReviewTarget(cwd, arg), Error, message);
            assertEquals(await git(cwd, ["show-ref"]), before);
            assertEquals(await git(cwd, ["status", "--porcelain"]), status);
        } finally {
            await rm(cwd, { recursive: true });
        }
    });
}
test("non-repository is rejected", async () => {
    const cwd = await makeTempDirectory();
    try {
        await assertRejects(() => resolveReviewTarget(cwd), Error, "requires a Git repository");
    } finally {
        await rm(cwd, { recursive: true });
    }
});

import { makeForgeFixture } from "./forge-test-fixture.ts";
test("PR resolver fetches real head refs and computes a local merge-base diff without worktree", async () => {
    const cwd = await fixture.checkout();
    try {
        const { runtime } = await makeForgeFixture(cwd);
        const before = await git(cwd, ["worktree", "list", "--porcelain"]);
        const target = await resolveReviewTargetWithForge(
            cwd,
            "https://github.com/org/repo/pull/1",
            runtime,
            () => runtime,
        );
        assertEquals(target.mode, "pr");
        const diff = await target.computeDiff();
        assertStringIncludes(diff, "+topic change");
        assertEquals(diff.includes("later.txt"), false);
        assertStringIncludes(target.reviewContext || "", "Review body");
        assertEquals(await git(cwd, ["worktree", "list", "--porcelain"]), before);
    } finally {
        await rm(cwd, { recursive: true });
    }
});
for (const cli of ["gh", "glab"]) {
    test(`missing or signed-out ${cli} names its sign-in command`, async () => {
        const cwd = await fixture.checkout();
        try {
            const host = cli === "gh" ? "github.com" : "gitlab.com";
            await git(cwd, ["remote", "add", "origin", `https://${host}/org/repo.git`]);
            const arg =
                cli === "gh" ? `https://${host}/org/repo/pull/1` : `https://${host}/org/repo/-/merge_requests/1`;
            const before = await git(cwd, ["show-ref"]);
            await assertRejects(
                () =>
                    resolveReviewTargetWithForge(
                        cwd,
                        arg,
                        {
                            runCommand: () => Promise.resolve({ exitCode: 127, stdout: "", stderr: "missing" }),
                        },
                        () => ({ runCommand: () => Promise.resolve({ exitCode: 127, stdout: "", stderr: "missing" }) }),
                    ),
                Error,
                `${cli} auth login`,
            );
            assertEquals(await git(cwd, ["show-ref"]), before);
        } finally {
            await rm(cwd, { recursive: true });
        }
    });
}
