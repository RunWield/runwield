import { test } from "node:test";
import { writeFile, rename, rm } from "node:fs/promises";
import { assertEquals } from "../../../../testing/assertions.ts";
import { defineGitFixture, git } from "../../../../shared/git-test-fixture.ts";
import { reviewFileContentApi } from "./review-file-handlers.ts";

const fixture = defineGitFixture(async (cwd) => {
    await writeFile(`${cwd}/modified.ts`, "base text\n");
    await writeFile(`${cwd}/old.ts`, "rename base\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "base"]);
    await git(cwd, ["switch", "-c", "execution"]);
    await writeFile(`${cwd}/modified.ts`, "worktree text\n");
    await rename(`${cwd}/old.ts`, `${cwd}/renamed.ts`);
    await writeFile(`${cwd}/added.ts`, "added text\n");
});

async function content(path: string, targetBranch?: string) {
    const cwd = await fixture.checkout();
    try {
        return await reviewFileContentApi(new Request(`http://localhost/api/file-content?${path}`), {
            cwd,
            targetBranch,
        });
    } finally {
        await rm(cwd, { recursive: true });
    }
}

test("review file content returns distinct merge-base before text for modified files", async () => {
    const response = await content("path=modified.ts", "main");
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.oldContent, "base text\n");
    assertEquals(body.newContent, "worktree text\n");
});

test("review file content uses the old path for renames", async () => {
    const body = await (await content("path=renamed.ts&oldPath=old.ts:1", "main")).json();
    assertEquals(body.oldContent, "rename base\n");
});

test("review file content supplies an empty before text for additions", async () => {
    const body = await (await content("path=added.ts", "main")).json();
    assertEquals(body.oldContent, "");
    assertEquals(body.newContent, "added text\n");
});

test("review file content preserves after text when the target is unavailable", async () => {
    const body = await (await content("path=modified.ts", "missing")).json();
    assertEquals(body.oldContent, null);
    assertEquals(body.newContent, "worktree text\n");
});

test("review file content without a target leaves before text unavailable", async () => {
    const body = await (await content("path=modified.ts")).json();
    assertEquals(body.oldContent, null);
});

test("review file content rejects traversal in the current path", async () => {
    assertEquals((await content("path=../outside.ts", "main")).status, 403);
});

test("review file content rejects traversal in the rename base path", async () => {
    assertEquals((await content("path=renamed.ts&oldPath=../outside.ts", "main")).status, 403);
});

test("review file content keeps absent before and after files unavailable", async () => {
    const body = await (await content("path=missing.ts", "main")).json();
    assertEquals(body.oldContent, null);
    assertEquals(body.newContent, null);
});

test("review file content preserves after text when branches have no common ancestor", async () => {
    const cwd = await fixture.checkout();
    try {
        await git(cwd, ["checkout", "--orphan", "unrelated"]);
        await git(cwd, ["add", "."]);
        await git(cwd, ["commit", "-m", "unrelated"]);
        const response = await reviewFileContentApi(new Request("http://localhost/api/file-content?path=modified.ts"), {
            cwd,
            targetBranch: "main",
        });
        const body = await response.json();
        assertEquals(body.oldContent, null);
        assertEquals(body.newContent, "worktree text\n");
    } finally {
        await rm(cwd, { recursive: true });
    }
});
