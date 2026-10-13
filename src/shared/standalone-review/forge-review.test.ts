import { rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import type { PRRuntime } from "@plannotator/shared/pr-types.ts";
import { mapReviewAnnotations, postForgeReview } from "./forge-review.ts";
import { type PRReviewTarget, resolveReviewTargetWithForge } from "./review-target.ts";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { makeForgeFixture } from "./forge-test-fixture.ts";
const fixture = defineGitFixture(async (cwd) => {
    await writeFile(`${cwd}/base.txt`, "base\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "base"]);
    await git(cwd, ["switch", "-c", "topic"]);
    await writeFile(`${cwd}/change.txt`, "change\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "topic"]);
    await git(cwd, ["switch", "main"]);
});
async function reviewFixture(cwd: string) {
    const forge = await makeForgeFixture(cwd);
    const target = await resolveReviewTargetWithForge(
        cwd,
        "https://github.com/org/repo/pull/1",
        forge.runtime,
        () => forge.runtime,
    );
    if (target.mode !== "pr") throw new Error("Expected PR target.");
    return { ...forge, target };
}
test("annotations preserve ranges, sides, file scope, and global body", () => {
    const result = mapReviewAnnotations("feedback", [
        { filePath: "a.ts", lineStart: 2, lineEnd: 4, side: "old", text: "range" },
        { filePath: "b.ts", lineStart: 5, lineEnd: 5, side: "new", text: "line" },
        { scope: "file", filePath: "c.ts", lineStart: 1, lineEnd: 1, text: "file" },
        { scope: "general", filePath: "unused", lineEnd: 1, text: "global" },
    ]);
    assertEquals(result, {
        body: "feedback\n\nglobal",
        fileComments: [
            { path: "a.ts", line: 4, start_line: 2, start_side: "LEFT", side: "LEFT", body: "range" },
            {
                path: "b.ts",
                line: 5,
                side: "RIGHT",
                body: "line",
            },
        ],
        fileLevelComments: [{ path: "c.ts", body: "file" }],
    });
});

for (const action of ["comment", "approve"] as const) {
    test(`${action} submits its matching Forge action`, async () => {
        const cwd = await fixture.checkout();
        try {
            const { target, submissions } = await reviewFixture(cwd);
            const result = await postForgeReview(target, { action, feedback: "notes", annotations: [] });
            assertEquals(result.status, "posted");
            assertStringIncludes(submissions[0], action === "comment" ? '"event":"COMMENT"' : '"event":"APPROVE"');
            assertStringIncludes(submissions[0], `"commit_id":"${target.metadata.headSha}"`);
        } finally {
            await rm(cwd, { recursive: true });
        }
    });
}
test("changed PR head refuses posting", async () => {
    const cwd = await fixture.checkout();
    try {
        const { target, submissions, moveHead } = await reviewFixture(cwd);
        moveHead(await git(cwd, ["rev-parse", "main"]));
        const result = await postForgeReview(target, { action: "approve", feedback: "", annotations: [] });
        assertEquals(result.status, "refused");
        assertStringIncludes(result.message, "head changed");
        assertEquals(submissions, []);
    } finally {
        await rm(cwd, { recursive: true });
    }
});
test("GitLab partial review retains failed comment text", async () => {
    const cwd = await fixture.checkout();
    try {
        const { target } = await reviewFixture(cwd);
        const head = target.metadata.headSha;
        const base = target.metadata.baseSha;
        const runtime: PRRuntime = {
            runCommand: (_cmd, args) =>
                Promise.resolve({
                    exitCode: 0,
                    stderr: "",
                    stdout: args[1].endsWith("raw_diffs")
                        ? "patch"
                        : JSON.stringify({
                              title: "MR",
                              author: { username: "user" },
                              target_branch: "main",
                              source_branch: "topic",
                              diff_refs: { base_sha: base, start_sha: base, head_sha: head },
                              sha: head,
                              web_url: "https://gitlab.com/org/repo/-/merge_requests/1",
                          }),
                }),
            runCommandWithInput: (_cmd, args) =>
                Promise.resolve({
                    exitCode: args[1].endsWith("discussions") ? 1 : 0,
                    stderr: "discussion refused",
                    stdout: "{}",
                }),
        };
        const glTarget: PRReviewTarget = {
            ...target,
            runtime,
            ref: { platform: "gitlab", host: "gitlab.com", projectPath: "org/repo", iid: 1 },
            metadata: {
                platform: "gitlab",
                host: "gitlab.com",
                projectPath: "org/repo",
                iid: 1,
                title: "MR",
                author: "user",
                baseBranch: "main",
                headBranch: "topic",
                baseSha: base,
                headSha: head,
                url: "https://gitlab.com/org/repo/-/merge_requests/1",
            },
        };
        const result = await postForgeReview(glTarget, {
            action: "comment",
            feedback: "body posted",
            annotations: [{ filePath: "a.ts", lineEnd: 2, text: "Do not lose this text" }],
        });
        assertEquals(result.status, "partial");
        assertStringIncludes(result.message, "Do not lose this text");
        assertStringIncludes(result.message, "discussion refused");
    } finally {
        await rm(cwd, { recursive: true });
    }
});
test("local PR worktree edits prevent Forge posting even when remote head is unchanged", async () => {
    const cwd = await fixture.checkout();
    try {
        const { target, submissions } = await reviewFixture(cwd);
        await git(cwd, ["switch", "topic"]);
        const { ensureReviewWorktree } = await import("./review-worktree.ts");
        // A branch target reuses this real checkout. PR posting then checks its Git facts.
        const branchTarget = { ...target, mode: "branch" as const, branch: "topic", worktree: undefined };
        target.worktree = await ensureReviewWorktree(branchTarget);
        await writeFile(`${cwd}/change.txt`, "local Engineer edit\n");
        const result = await postForgeReview(target, { action: "comment", feedback: "notes", annotations: [] });
        assertEquals(result.status, "refused");
        assertStringIncludes(result.message, "Push the Engineer changes");
        assertEquals(submissions, []);
    } finally {
        await rm(cwd, { recursive: true });
    }
});

test("cancel during metadata lookup prevents Forge submission", async () => {
    const cwd = await fixture.checkout();
    try {
        const { target, submissions } = await reviewFixture(cwd);
        const controller = new AbortController();
        const original = target.runtime;
        target.runtime = {
            ...original,
            runCommand: async (cmd, args) => {
                const result = await original.runCommand(cmd, args);
                controller.abort();
                return result;
            },
        };
        const { assertRejects } = await import("../../testing/assertions.ts");
        await assertRejects(() =>
            postForgeReview(target, {
                action: "approve",
                feedback: "",
                annotations: [],
                signal: controller.signal,
            }),
        );
        assertEquals(submissions, []);
    } finally {
        await rm(cwd, { recursive: true });
    }
});
