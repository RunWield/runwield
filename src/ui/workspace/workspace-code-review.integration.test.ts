import { rmdir as fsRmdir } from "node:fs/promises";
// @ts-nocheck: test fixture types are checked by scripts/run-tests.js, not Astro check.
// @ts-nocheck: test fixture types are checked by scripts/run-tests.js, not Astro check.
import { captureForegroundProcess } from "../../shared/captured-process.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    rename as fsRename,
    writeFile as fsWriteFile,
    rm as fsRm,
} from "node:fs/promises";
import { assertEquals, assertFalse, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { withLiveWorkspaceInteraction } from "./testing/live-interaction-fixture.ts";
import { defineGitFixture, git } from "../../shared/git-test-fixture.ts";
import { getWorktreeReviewDiff } from "../../shared/workflow/git-snapshot.ts";

async function runGit(cwd: string, args: string[]): Promise<string> {
    const result = await captureForegroundProcess("git", { cwd, args });
    if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
}

test("Workspace Code Review keeps an empty patch reviewable with the repair conversation", async () => {
    await withLiveWorkspaceInteraction(
        {
            id: "interaction-empty",
            type: "code_review",
            prompt: "Review the code changes.",
            _meta: {
                diffText: "",
                planName: "empty-review",
                reviewConversation: {
                    id: "review-conversation",
                    agentLabel: "Reviewer Feedback Engineer",
                    revision: 1,
                    events: [
                        {
                            type: "assistant_text_delta",
                            delta: "The repair is complete.",
                            messageId: "repair-reply",
                            agentName: "reviewer-feedback-engineer",
                        },
                    ],
                },
            },
        },
        async ({ service, reference }) => {
            const liveReview = await service.getLiveCodeReview(reference);

            assertEquals(liveReview?.request?.codeReview?.rawPatch, "");
            assertEquals(liveReview?.request?.codeReview?.conversationEvents?.[0]?.delta, "The repair is complete.");
            assertStringIncludes(String(liveReview?.request?.reviewUrl), "/review/code?");
        },
    );
});

test("Workspace Code Review live interaction keeps planTitle in its payload", async () => {
    await withLiveWorkspaceInteraction(
        {
            id: "interaction-1",
            type: "code_review",
            prompt: "Review the code changes.",
            _meta: {
                diffText: "diff --git a/change.ts b/change.ts\n+change",
                planName: "show-plan-title",
                planTitle: "Readable Plan Title",
            },
        },
        async ({ service, reference }) => {
            const liveReview = await service.getLiveCodeReview(reference);

            assertEquals(liveReview?.request?.codeReview?.planTitle, "Readable Plan Title");
            assertEquals(liveReview?.request?.codeReview?.planName, "show-plan-title");
        },
    );
});

test("Workspace Code Review reload reads the latest proposed branch patch", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-workspace-code-reload-"));
    try {
        await runGit(projectRoot, ["init", "-b", "main"]);
        await runGit(projectRoot, ["config", "user.email", "runwield@example.com"]);
        await runGit(projectRoot, ["config", "user.name", "RunWield Test"]);
        await fsWriteFile(`${projectRoot}/review.ts`, "export const label = 'base';\n");
        await runGit(projectRoot, ["add", "review.ts"]);
        await runGit(projectRoot, ["commit", "-m", "fixture base"]);
        await runGit(projectRoot, ["branch", "target"]);
        await runGit(projectRoot, ["switch", "-c", "execution"]);
        await fsWriteFile(`${projectRoot}/review.ts`, "export const label = 'first';\n");
        await withLiveWorkspaceInteraction(
            {
                id: "interaction-reload",
                type: "code_review",
                prompt: "Review the code changes.",
                _meta: {
                    diffText: "stale patch",
                    planName: "reload-code-review",
                    executionCwd: projectRoot,
                    targetBranch: "target",
                },
            },
            async ({ service, reference }) => {
                await runGit(projectRoot, ["add", "review.ts"]);
                await runGit(projectRoot, ["commit", "-m", "advance target"]);
                await runGit(projectRoot, ["update-ref", "refs/heads/target", "HEAD"]);
                await fsWriteFile(`${projectRoot}/review.ts`, "export const label = 'second';\n");
                const expectedPatch = await getWorktreeReviewDiff(projectRoot, "target");
                const liveReview = await service.getLiveCodeReview(reference);

                assertEquals(liveReview?.request?.codeReview?.rawPatch, expectedPatch);
                assertStringIncludes(
                    String(liveReview?.request?.codeReview?.rawPatch),
                    "-export const label = 'first';",
                );
                assertStringIncludes(
                    String(liveReview?.request?.codeReview?.rawPatch),
                    "+export const label = 'second';",
                );
                assertFalse(String(liveReview?.request?.codeReview?.rawPatch).includes("label = 'base'"));
                assertFalse(JSON.stringify(liveReview).includes(projectRoot));

                const indexPath = `${projectRoot}/.git/index`;
                const savedIndexPath = `${projectRoot}/.git/index.saved`;
                await fsRename(indexPath, savedIndexPath);
                await fsMkdir(indexPath);
                try {
                    const fallbackReview = await service.getLiveCodeReview(reference);
                    assertEquals(fallbackReview?.request?.codeReview?.rawPatch, "stale patch");
                } finally {
                    await fsRmdir(indexPath);
                    await fsRename(savedIndexPath, indexPath);
                }

                const unrelatedRoot = await fsMkdtemp(join(tmpdir(), "runwield-unrelated-review-target-"));
                try {
                    await runGit(unrelatedRoot, ["init", "-b", "target"]);
                    await runGit(unrelatedRoot, ["config", "user.email", "runwield@example.com"]);
                    await runGit(unrelatedRoot, ["config", "user.name", "RunWield Test"]);
                    await fsWriteFile(`${unrelatedRoot}/unrelated.ts`, "export const unrelated = true;\n");
                    await runGit(unrelatedRoot, ["add", "unrelated.ts"]);
                    await runGit(unrelatedRoot, ["commit", "-m", "unrelated target"]);
                    await runGit(projectRoot, ["fetch", unrelatedRoot, "+target:refs/heads/target"]);
                    await assertRejects(() => service.getLiveCodeReview(reference), Error, "no common ancestor");
                } finally {
                    await fsRm(unrelatedRoot, { recursive: true });
                }

                await runGit(projectRoot, ["update-ref", "-d", "refs/heads/target"]);
                await assertRejects(() => service.getLiveCodeReview(reference), Error, "refs/heads/target");
            },
            projectRoot,
        );
    } finally {
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
    }
});

const fileCheckoutFixture = defineGitFixture(async (cwd) => {
    await fsWriteFile(`${cwd}/review.ts`, "merge base text\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "base"]);
});

test("Workspace live Code Review reads execution worktree files and merge-base before text", async () => {
    const root = await fileCheckoutFixture.checkout();
    const execution = `${root}/execution`;
    try {
        await git(root, ["worktree", "add", "-b", "execution", execution, "main"]);
        await fsWriteFile(`${root}/review.ts`, "primary checkout text\n");
        await fsWriteFile(`${execution}/review.ts`, "execution worktree text\n");
        await fsWriteFile(`${execution}/added.ts`, "added execution text\n");
        await withLiveWorkspaceInteraction(
            {
                type: "code_review",
                prompt: "Review code.",
                _meta: {
                    diffText: "stale patch",
                    executionCwd: execution,
                    targetBranch: "main",
                    planTitle: "Worktree review",
                },
            },
            async ({ app, service, reference, origin, cookie, settle }) => {
                const review = await service.getLiveCodeReview(reference);
                const referer = new URL(review.request.reviewUrl, origin).href;
                const handler = app.handler();
                const page = await handler(new Request(referer, { headers: { cookie } }));
                assertEquals(page.status, 200);
                assertEquals(page.headers.get("referrer-policy"), "same-origin");
                const html = await page.text();
                assertStringIncludes(html, "data-astro-review-shell");
                assertFalse(html.includes('class="workspace-sidebar"'));
                assertStringIncludes(html, "Worktree review");
                const response = await handler(
                    new Request(`${origin}/api/file-content?path=review.ts`, { headers: { cookie, referer } }),
                );
                assertEquals(response.status, 200);
                const body = await response.json();
                assertEquals(body.newContent, "execution worktree text\n");
                assertEquals(body.oldContent, "merge base text\n");
                assertFalse(JSON.stringify(body).includes(execution));
                const added = await handler(
                    new Request(`${origin}/api/file-content?path=added.ts`, { headers: { cookie, referer } }),
                );
                assertEquals((await added.json()).oldContent, "");
                for (const fallbackReferer of [
                    `${origin}/projects/${reference.projectId}/sessions/${reference.runwieldSessionId}`,
                    referer.replace(reference.interactionId, "stale-interaction"),
                    referer.replace(reference.runwieldSessionId, "other-session"),
                ]) {
                    const fallback = await handler(
                        new Request(`${origin}/api/file-content?path=review.ts`, {
                            headers: { cookie, referer: fallbackReferer },
                        }),
                    );
                    const fallbackBody = await fallback.json();
                    assertEquals(fallbackBody.newContent, "primary checkout text\n");
                    assertEquals(fallbackBody.oldContent, null);
                }
                await settle();
                assertEquals(await service.getLiveCodeReview(reference), null);
                assertEquals(await service.getLiveCodeReviewCheckout(reference), null);
            },
            root,
        );
    } finally {
        await fsRm(root, { recursive: true, force: true });
    }
});

test("live Code Review checkout rejects foreign identity and expired interactions", async () => {
    const cwd = await fileCheckoutFixture.checkout();
    try {
        await withLiveWorkspaceInteraction(
            {
                type: "code_review",
                prompt: "Review code.",
                _meta: { diffText: "patch", executionCwd: cwd, targetBranch: "main" },
            },
            async ({ service, reference, settle }) => {
                assertEquals(await service.getLiveCodeReviewCheckout(reference), { cwd, targetBranch: "main" });
                for (const invalid of [
                    { ...reference, projectId: "other" },
                    { ...reference, runwieldSessionId: "other" },
                    { ...reference, interactionId: "other" },
                ]) {
                    assertEquals(await service.getLiveCodeReviewCheckout(invalid), null);
                    assertEquals(await service.getLiveCodeReview(invalid), null);
                }
                await settle();
                assertEquals(await service.getLiveCodeReviewCheckout(reference), null);
                assertEquals(await service.getLiveCodeReview(reference), null);
            },
            cwd,
        );
    } finally {
        await fsRm(cwd, { recursive: true, force: true });
    }
});

for (const type of ["text", "code_review"]) {
    test(`an interaction without execution context cannot expose a checkout (${type})`, async () => {
        await withLiveWorkspaceInteraction(
            { type, prompt: "Review code.", _meta: { diffText: "patch" } },
            async ({ service, reference }) => {
                assertEquals(await service.getLiveCodeReviewCheckout(reference), null);
                const review = await service.getLiveCodeReview(reference);
                if (type === "code_review") assertEquals(review.request.codeReview.rawPatch, "patch");
                else assertEquals(review, null);
            },
        );
    });
}
