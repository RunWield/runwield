import { readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { makeTempDirectory } from "../../testing/temp-file.ts";
import { test } from "node:test";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { normalize } from "node:path";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { resolveReviewTarget, resolveReviewTargetWithForge } from "./review-target.ts";
import { ensureReviewWorktree, settleReviewWorktree } from "./review-worktree.ts";
const fixture = defineGitFixture(async (cwd) => {
    await writeFile(`${cwd}/base.txt`, "base\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "base"]);
    await git(cwd, ["branch", "topic"]);
    await git(cwd, ["branch", "--set-upstream-to=main", "topic"]);
});
for (const state of ["clean", "dirty", "unpushed"]) {
    test(`settle ${state} review checkout protects work`, async () => {
        const cwd = await fixture.checkout();
        let path = "";
        try {
            const target = await resolveReviewTarget(cwd, "topic");
            assertEquals((await git(cwd, ["worktree", "list", "--porcelain"])).match(/worktree /g)?.length, 1);
            const worktree = await ensureReviewWorktree(target);
            path = worktree.path;
            assertEquals(await ensureReviewWorktree(target), worktree);
            if (state !== "clean") await writeFile(`${path}/edit.txt`, "engineer work\n");
            if (state === "unpushed") {
                await git(path, ["add", "."]);
                await git(path, ["commit", "-m", "work"]);
            }
            const head = await git(path, ["rev-parse", "HEAD"]);
            const canonicalPath = normalize(await realpath(path));
            const result = await settleReviewWorktree(worktree);
            assertEquals(result.removed, state === "clean");
            if (state !== "clean") {
                assertStringIncludes(result.message, path);
                assertStringIncludes(result.message, "topic");
                assertEquals((await stat(path)).isDirectory(), true);
                assertEquals(await readFile(`${path}/base.txt`, "utf8"), "base\n");
                assertEquals(await readFile(`${path}/edit.txt`, "utf8"), "engineer work\n");
                assertEquals(await git(path, ["rev-parse", "HEAD"]), head);
                if (state === "unpushed") {
                    assertEquals(await git(path, ["rev-list", "--count", "@{u}..HEAD"]), "1");
                    assertEquals(await git(path, ["show", "HEAD:edit.txt"]), "engineer work");
                }
            } else {
                await assertRejects(() => stat(path), Error, "ENOENT");
            }
            const worktreePaths = (await git(cwd, ["worktree", "list", "--porcelain", "-z"]))
                .split("\0")
                .filter((field) => field.startsWith("worktree "))
                .map((field) => normalize(field.slice("worktree ".length)));
            assertEquals(worktreePaths.includes(canonicalPath), state !== "clean");
        } finally {
            if (path) await rm(path, { recursive: true }).catch(() => {});
            await rm(cwd, { recursive: true });
        }
    });
}
test("existing branch checkout is reused and never removed", async () => {
    const cwd = await fixture.checkout();
    const path = await makeTempDirectory();
    try {
        await git(cwd, ["worktree", "add", path, "topic"]);
        const worktree = await ensureReviewWorktree(await resolveReviewTarget(cwd, "topic"));
        assertEquals(worktree.created, false);
        assertEquals(await realpath(worktree.path), await realpath(path));
        assertEquals((await settleReviewWorktree(worktree)).removed, false);
        assertEquals((await stat(path)).isDirectory(), true);
    } finally {
        await rm(path, { recursive: true });
        await rm(cwd, { recursive: true });
    }
});

import { makeForgeFixture } from "./forge-test-fixture.ts";
test("PR worktree checkout retries an occupied branch and removes its clean checkout", async () => {
    const cwd = await fixture.checkout();
    let path = "";
    const commands: string[][] = [];
    try {
        const forge = await makeForgeFixture(cwd);
        const target = await resolveReviewTargetWithForge(
            cwd,
            "https://github.com/org/repo/pull/1",
            forge.runtime,
            (worktreePath) => ({
                runCommand: async (cmd, args) => {
                    commands.push([cmd, ...args]);
                    if (!args.includes("--branch")) {
                        return { exitCode: 1, stdout: "", stderr: "branch already checked out" };
                    }
                    const branch = args[args.indexOf("--branch") + 1];
                    await git(worktreePath, ["switch", "-c", branch]);
                    await git(worktreePath, ["branch", "--set-upstream-to=topic"]);
                    return { exitCode: 0, stdout: "", stderr: "" };
                },
            }),
        );
        assertEquals(target.worktree, undefined);
        const worktree = await ensureReviewWorktree(target);
        path = worktree.path;
        assertEquals(commands[0], ["gh", "pr", "checkout", "1", "--repo", "github.com/org/repo"]);
        assertStringIncludes(commands[1].join(" "), "--branch wld-review/github-1-");
        assertEquals(await git(path, ["rev-parse", "HEAD"]), await git(cwd, ["rev-parse", "topic"]));
        assertEquals((await settleReviewWorktree(worktree)).removed, true);
    } finally {
        if (path) await rm(path, { recursive: true }).catch(() => {});
        await rm(cwd, { recursive: true });
    }
});

for (const changed of [false, true]) {
    test(`failed Forge checkout ${changed ? "preserves edits and blocks Engineer" : "removes unused tree and retries setup"}`, async () => {
        const cwd = await fixture.checkout();
        let path = "";
        let failing = true;
        try {
            const forge = await makeForgeFixture(cwd);
            const target = await resolveReviewTargetWithForge(
                cwd,
                "https://github.com/org/repo/pull/1",
                forge.runtime,
                (worktreePath) => ({
                    runCommand: async () => {
                        path = worktreePath;
                        if (failing) {
                            if (changed) await writeFile(`${path}/keep.txt`, "local work");
                            return { exitCode: 1, stdout: "", stderr: "checkout failed" };
                        }
                        await git(path, ["switch", "-c", "review-ready"]);
                        return { exitCode: 0, stdout: "", stderr: "" };
                    },
                }),
            );
            const { assertRejects } = await import("../../testing/assertions.ts");
            await assertRejects(() => ensureReviewWorktree(target), Error, "checkout failed");
            failing = false;
            if (changed) {
                await assertRejects(() => ensureReviewWorktree(target), Error, "Local work is preserved");
                assertEquals(await readFile(`${path}/keep.txt`, "utf8"), "local work");
            } else {
                assertEquals(target.worktree, undefined);
                const ready = await ensureReviewWorktree(target);
                assertEquals(ready.branch, "review-ready");
            }
        } finally {
            if (path) await rm(path, { recursive: true }).catch(() => {});
            await rm(cwd, { recursive: true });
        }
    });
}
