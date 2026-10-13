import { rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { assertEquals } from "../../../../testing/assertions.ts";
import { defineGitFixture, git } from "../../../../shared/git-test-fixture.ts";
import { reviewFileContentApi } from "./review-file-handlers.ts";

const fixture = defineGitFixture(async (cwd) => {
    await writeFile(`${cwd}/file.txt`, "selected\n\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "selected"]);
    await git(cwd, ["branch", "selected"]);
    await writeFile(`${cwd}/checkout-only.txt`, "not reviewed\n");
    await writeFile(`${cwd}/file.txt`, "checkout\n");
});

test("selected ref file content preserves newlines and does not fall back to checkout files", async () => {
    const cwd = await fixture.checkout();
    try {
        for (const [path, expected] of [
            ["file.txt", "selected\n\n"],
            ["checkout-only.txt", null],
        ]) {
            const response = await reviewFileContentApi(new Request(`http://localhost/api/file-content?path=${path}`), {
                cwd,
                headRef: "selected",
            });
            assertEquals(response.status, 200);
            assertEquals((await response.json()).newContent, expected);
        }
    } finally {
        await rm(cwd, { recursive: true });
    }
});

test("selected ref rejects file content paths outside the review workspace", async () => {
    const cwd = await fixture.checkout();
    try {
        const response = await reviewFileContentApi(new Request("http://localhost/api/file-content?path=../outside"), {
            cwd,
            headRef: "selected",
        });
        assertEquals(response.status, 403);
        await response.text();
    } finally {
        await rm(cwd, { recursive: true });
    }
});
