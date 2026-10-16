import { rmdir as fsRmdir } from "node:fs/promises";
// @ts-nocheck: test fixture types are checked by scripts/run-tests.js, not Astro check.
import { captureForegroundProcess } from "../../shared/captured-process.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rename as fsRename,
    writeFile as fsWriteFile,
    rm as fsRm,
} from "node:fs/promises";
import { assertEquals, assertFalse, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { WorkspaceSessionContinuationService } from "./server/session-continuation.js";
import { defineGitFixture, git } from "../../shared/git-test-fixture.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { createOwnerWorkspaceApp } from "./server.js";
import { getWorktreeReviewDiff } from "../../shared/workflow/git-snapshot.ts";

const ROUTE_PATH = new URL(
    "./pages/projects/[projectId]/sessions/[runwieldSessionId]/review/code.astro",
    import.meta.url,
);
const SESSION_CONTINUATION_PATH = new URL("./server/session-continuation.js", import.meta.url);
const SESSION_SURFACE_PATH = new URL("./islands/SessionSurface.jsx", import.meta.url);
const TIMELINE_PATH = new URL("./components/SessionTimeline.jsx", import.meta.url);
const CODE_REVIEW_SURFACE_PATH = new URL("./react/CodeReviewSurface.tsx", import.meta.url);
const SERVER_PATH = new URL("./server.js", import.meta.url);

async function runGit(cwd: string, args: string[]): Promise<string> {
    const result = await captureForegroundProcess("git", { cwd, args });
    if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
}

test("live Session Code Review replaces the Workspace shell with the shared review surface", async () => {
    const route = await fsReadFile(ROUTE_PATH, "utf8");

    assertStringIncludes(route, "ReviewLayout");
    assertStringIncludes(route, "CodeReviewSurface");
    assertFalse(route.includes('presentation="workspace"'));
    assertStringIncludes(route, "getLiveCodeReview");
    assertStringIncludes(route, 'artifactLabel: codeReview.planTitle || codeReview.planName || "Code changes"');
    assertFalse(route.includes("WorkspaceLayout"));
});

test("Workspace Session projects code-review interactions to one stable in-situ URL", async () => {
    const continuation = await fsReadFile(SESSION_CONTINUATION_PATH, "utf8");
    const sessionSurface = await fsReadFile(SESSION_SURFACE_PATH, "utf8");
    const timeline = await fsReadFile(TIMELINE_PATH, "utf8");
    const server = await fsReadFile(SERVER_PATH, "utf8");

    assertStringIncludes(continuation, 'request.type === "code_review"');
    assertStringIncludes(continuation, 'const planTitle = typeof meta.planTitle === "string" && meta.planTitle.trim()');
    assertStringIncludes(continuation, "/review/code?operation=${encodeURIComponent(operationId)}");
    assertStringIncludes(continuation, "getLiveCodeReview(options)");
    assertStringIncludes(sessionSurface, 'isCodeReview ? "code-review"');
    assertStringIncludes(timeline, 'item.kind === "code-review"');
    assertStringIncludes(timeline, "Review Code");
    assertStringIncludes(server, '"/projects/:projectId/sessions/:runwieldSessionId/review/code"');
});

test("Workspace Code Review keeps an empty patch reviewable with the repair conversation", async () => {
    const service = new WorkspaceSessionContinuationService({ store: {} });
    try {
        service.operations.set("operation-empty", {
            status: "running",
            projectId: "project-1",
            runwieldSessionId: "session-1",
            events: [],
        });
        const interaction = service.createInteractionAdapter({ operationId: "operation-empty" }).requestInteraction({
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
        });
        const liveReview = await service.getLiveCodeReview({
            projectId: "project-1",
            runwieldSessionId: "session-1",
            operationId: "operation-empty",
            interactionId: "interaction-empty",
        });

        assertEquals(liveReview?.request?.codeReview?.rawPatch, "");
        assertEquals(liveReview?.request?.codeReview?.conversationEvents?.[0]?.delta, "The repair is complete.");
        assertStringIncludes(String(liveReview?.request?.reviewUrl), "/review/code?");
        service.operations.get("operation-empty")?.answer?.resolve({ outcome: "canceled" });
        await interaction;
    } finally {
        service.close();
    }
});

test("Workspace Code Review live interaction keeps planTitle in its payload", async () => {
    const service = new WorkspaceSessionContinuationService({ store: {} });
    try {
        service.operations.set("operation-1", {
            status: "running",
            projectId: "project-1",
            runwieldSessionId: "session-1",
            events: [],
        });
        const interaction = service.createInteractionAdapter({ operationId: "operation-1" }).requestInteraction({
            id: "interaction-1",
            type: "code_review",
            prompt: "Review the code changes.",
            _meta: {
                diffText: "diff --git a/change.ts b/change.ts\n+change",
                planName: "show-plan-title",
                planTitle: "Readable Plan Title",
            },
        });
        const liveReview = await service.getLiveCodeReview({
            projectId: "project-1",
            runwieldSessionId: "session-1",
            operationId: "operation-1",
            interactionId: "interaction-1",
        });

        assertEquals(liveReview?.request?.codeReview?.planTitle, "Readable Plan Title");
        assertEquals(liveReview?.request?.codeReview?.planName, "show-plan-title");
        service.operations.get("operation-1")?.answer?.resolve({ outcome: "canceled" });
        await interaction;
    } finally {
        service.close();
    }
});

test("Workspace Code Review reload reads the latest proposed branch patch", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-workspace-code-reload-"));
    const service = new WorkspaceSessionContinuationService({ store: {} });
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
        service.operations.set("operation-reload", {
            status: "running",
            projectId: "project-1",
            runwieldSessionId: "session-1",
            events: [],
        });
        const interaction = service.createInteractionAdapter({ operationId: "operation-reload" }).requestInteraction({
            id: "interaction-reload",
            type: "code_review",
            prompt: "Review the code changes.",
            _meta: {
                diffText: "stale patch",
                planName: "reload-code-review",
                executionCwd: projectRoot,
                targetBranch: "target",
            },
        });

        await runGit(projectRoot, ["add", "review.ts"]);
        await runGit(projectRoot, ["commit", "-m", "advance target"]);
        await runGit(projectRoot, ["update-ref", "refs/heads/target", "HEAD"]);
        await fsWriteFile(`${projectRoot}/review.ts`, "export const label = 'second';\n");
        const expectedPatch = await getWorktreeReviewDiff(projectRoot, "target");
        const liveReview = await service.getLiveCodeReview({
            projectId: "project-1",
            runwieldSessionId: "session-1",
            operationId: "operation-reload",
            interactionId: "interaction-reload",
        });

        assertEquals(liveReview?.request?.codeReview?.rawPatch, expectedPatch);
        assertStringIncludes(String(liveReview?.request?.codeReview?.rawPatch), "-export const label = 'first';");
        assertStringIncludes(String(liveReview?.request?.codeReview?.rawPatch), "+export const label = 'second';");
        assertFalse(String(liveReview?.request?.codeReview?.rawPatch).includes("label = 'base'"));
        assertFalse(JSON.stringify(liveReview).includes(projectRoot));

        const indexPath = `${projectRoot}/.git/index`;
        const savedIndexPath = `${projectRoot}/.git/index.saved`;
        await fsRename(indexPath, savedIndexPath);
        await fsMkdir(indexPath);
        try {
            const fallbackReview = await service.getLiveCodeReview({
                projectId: "project-1",
                runwieldSessionId: "session-1",
                operationId: "operation-reload",
                interactionId: "interaction-reload",
            });
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
            await assertRejects(
                () =>
                    service.getLiveCodeReview({
                        projectId: "project-1",
                        runwieldSessionId: "session-1",
                        operationId: "operation-reload",
                        interactionId: "interaction-reload",
                    }),
                Error,
                "no common ancestor",
            );
        } finally {
            await fsRm(unrelatedRoot, { recursive: true });
        }

        await runGit(projectRoot, ["update-ref", "-d", "refs/heads/target"]);
        await assertRejects(
            () =>
                service.getLiveCodeReview({
                    projectId: "project-1",
                    runwieldSessionId: "session-1",
                    operationId: "operation-reload",
                    interactionId: "interaction-reload",
                }),
            Error,
            "refs/heads/target",
        );
        service.operations.get("operation-reload")?.answer?.resolve({ outcome: "canceled" });
        await interaction;
    } finally {
        service.close();
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
    }
});

test("Workspace Code Review returns decisions to its live Session interaction", async () => {
    const route = await fsReadFile(ROUTE_PATH, "utf8");
    const surface = await fsReadFile(CODE_REVIEW_SURFACE_PATH, "utf8");
    const continuation = await fsReadFile(SESSION_CONTINUATION_PATH, "utf8");

    assertStringIncludes(route, "interactionAnswerUrl");
    assertStringIncludes(surface, "initialPayload.interactionAnswerUrl");
    assertStringIncludes(surface, 'outcome: body.approved ? "accepted" : "selected"');
    assertStringIncludes(continuation, "operation.answer.resolve(runtimeResponse)");
});

test("TUI review routes keep the same shared bodies in the standalone shell", async () => {
    const planRoute = await fsReadFile(new URL("./pages/review/plan.astro", import.meta.url), "utf8");
    const codeRoute = await fsReadFile(new URL("./pages/review/code.astro", import.meta.url), "utf8");

    assertStringIncludes(planRoute, "ReviewLayout");
    assertStringIncludes(planRoute, "PlanReviewSurface");
    assertStringIncludes(planRoute, "escapeReviewPayloadJson(JSON.stringify(payload))");
    assertStringIncludes(codeRoute, "ReviewLayout");
    assertStringIncludes(codeRoute, "CodeReviewSurface");
    assertStringIncludes(codeRoute, "escapeReviewPayloadJson(JSON.stringify(payload))");
});

const fileCheckoutFixture = defineGitFixture(async (cwd) => {
    await fsWriteFile(`${cwd}/review.ts`, "merge base text\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "base"]);
});

test("Workspace live Code Review reads execution worktree files and merge-base before text", async () => {
    const root = await fileCheckoutFixture.checkout();
    const execution = `${root}/execution`;
    const store = openOwnerCoordinationStore({ dbPath: `${root}/owner.sqlite3` });
    const project = store.registerProject({ root });
    const origin = "http://127.0.0.1:8787";
    const app = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: origin, store });
    const service = app.sessionContinuation;
    let interaction;
    try {
        await git(root, ["worktree", "add", "-b", "execution", execution, "main"]);
        await fsWriteFile(`${root}/review.ts`, "primary checkout text\n");
        await fsWriteFile(`${execution}/review.ts`, "execution worktree text\n");
        await fsWriteFile(`${execution}/added.ts`, "added execution text\n");
        const pairing = store.createPairingRequest({ codeFactory: () => "REV123", proofFactory: () => "review-proof" });
        store.approvePairingRequest(pairing.code);
        const claimed = store.claimPairingRequest(pairing.proof);
        const cookie = `rw_owner_device=${encodeURIComponent(claimed.credential)}`;
        service.operations.set("operation-files", {
            status: "running",
            projectId: project.projectId,
            runwieldSessionId: "session-files",
            events: [],
        });
        interaction = service.createInteractionAdapter({ operationId: "operation-files" }).requestInteraction({
            id: "interaction-files",
            type: "code_review",
            prompt: "Review code.",
            _meta: { diffText: "stale patch", executionCwd: execution, targetBranch: "main" },
        });
        const referer = `${origin}/projects/${project.projectId}/sessions/session-files/review/code?operation=operation-files&interaction=interaction-files`;
        const handler = app.handler();
        const page = await handler(new Request(referer, { headers: { cookie } }));
        assertEquals(page.headers.get("referrer-policy"), "same-origin");
        await page.body?.cancel();
        const response = await handler(
            new Request(`${origin}/api/file-content?path=review.ts`, {
                headers: { cookie, referer },
            }),
        );
        assertEquals(response.status, 200);
        const body = await response.json();
        assertEquals(body.newContent, "execution worktree text\n");
        assertEquals(body.oldContent, "merge base text\n");
        assertFalse(JSON.stringify(body).includes(execution));
        const added = await handler(
            new Request(`${origin}/api/file-content?path=added.ts`, {
                headers: { cookie, referer },
            }),
        );
        assertEquals((await added.json()).oldContent, "");

        for (const fallbackReferer of [
            `${origin}/projects/${project.projectId}/sessions/session-files`,
            referer.replace("interaction-files", "stale-interaction"),
            referer.replace("session-files", "other-session"),
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
    } finally {
        service.operations.get("operation-files")?.answer?.resolve({ outcome: "canceled" });
        await interaction;
        await app.close();
        store.close();
        await fsRm(root, { recursive: true, force: true });
    }
});

test("live Code Review checkout shares review liveness and requires stored execution context", async () => {
    const cwd = await fileCheckoutFixture.checkout();
    const store = openOwnerCoordinationStore({ dbPath: `${cwd}/owner.sqlite3` });
    const service = new WorkspaceSessionContinuationService({ store });
    let interaction;
    try {
        service.operations.set("operation-checkout", {
            status: "running",
            projectId: "project",
            runwieldSessionId: "session",
            events: [],
        });
        interaction = service.createInteractionAdapter({ operationId: "operation-checkout" }).requestInteraction({
            id: "interaction-checkout",
            type: "code_review",
            prompt: "Review code.",
            _meta: { diffText: "patch", executionCwd: cwd, targetBranch: "main" },
        });
        const options = {
            projectId: "project",
            runwieldSessionId: "session",
            operationId: "operation-checkout",
            interactionId: "interaction-checkout",
        };
        assertEquals(await service.getLiveCodeReviewCheckout(options), { cwd, targetBranch: "main" });
        for (const invalid of [
            { ...options, projectId: "other" },
            { ...options, runwieldSessionId: "other" },
            { ...options, interactionId: "other" },
        ]) {
            assertEquals(await service.getLiveCodeReviewCheckout(invalid), null);
            assertEquals(await service.getLiveCodeReview(invalid), null);
        }
        const operation = service.operations.get(options.operationId);
        operation.status = "completed";
        assertEquals(await service.getLiveCodeReviewCheckout(options), null);
        assertEquals(await service.getLiveCodeReview(options), null);
        operation.status = "running";
        const request = operation.liveInteraction.request;
        request.type = "question";
        assertEquals(await service.getLiveCodeReviewCheckout(options), null);
        assertEquals(await service.getLiveCodeReview(options), null);
        request.type = "code_review";
        service.codeReviewRefreshContexts.delete("operation-checkout:interaction-checkout");
        assertEquals(await service.getLiveCodeReviewCheckout(options), null);
        assertEquals((await service.getLiveCodeReview(options))?.request.codeReview.rawPatch, "patch");
    } finally {
        service.operations.get("operation-checkout")?.answer?.resolve({ outcome: "canceled" });
        await interaction;
        await service.close();
        store.close();
        await fsRm(cwd, { recursive: true, force: true });
    }
});
