// @ts-nocheck: Deno test imports are checked by scripts/run-tests.js, not Astro check.
import { assertEquals, assertFalse, assertRejects, assertStringIncludes } from "@std/assert";
import { WorkspaceSessionContinuationService } from "./server/session-continuation.js";
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
    const result = await new Deno.Command("git", { cwd, args, stdout: "piped", stderr: "piped" }).output();
    if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
}

Deno.test("live Session Code Review replaces the Workspace shell with the shared review surface", async () => {
    const route = await Deno.readTextFile(ROUTE_PATH);

    assertStringIncludes(route, "ReviewLayout");
    assertStringIncludes(route, "CodeReviewSurface");
    assertFalse(route.includes('presentation="workspace"'));
    assertStringIncludes(route, "getLiveCodeReview");
    assertStringIncludes(route, 'artifactLabel: codeReview.planTitle || codeReview.planName || "Code changes"');
    assertFalse(route.includes("WorkspaceLayout"));
});

Deno.test("Workspace Session projects code-review interactions to one stable in-situ URL", async () => {
    const continuation = await Deno.readTextFile(SESSION_CONTINUATION_PATH);
    const sessionSurface = await Deno.readTextFile(SESSION_SURFACE_PATH);
    const timeline = await Deno.readTextFile(TIMELINE_PATH);
    const server = await Deno.readTextFile(SERVER_PATH);

    assertStringIncludes(continuation, 'request.type === "code_review"');
    assertStringIncludes(continuation, 'const planTitle = typeof meta.planTitle === "string" && meta.planTitle.trim()');
    assertStringIncludes(continuation, "/review/code?operation=${encodeURIComponent(operationId)}");
    assertStringIncludes(continuation, "getLiveCodeReview(options)");
    assertStringIncludes(sessionSurface, 'isCodeReview ? "code-review"');
    assertStringIncludes(timeline, 'item.kind === "code-review"');
    assertStringIncludes(timeline, "Review Code");
    assertStringIncludes(server, '"/projects/:projectId/sessions/:runwieldSessionId/review/code"');
});

Deno.test("Workspace Code Review keeps an empty patch reviewable with the repair conversation", async () => {
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
                    events: [{
                        type: "assistant_text_delta",
                        delta: "The repair is complete.",
                        messageId: "repair-reply",
                        agentName: "reviewer-feedback-engineer",
                    }],
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

Deno.test("Workspace Code Review live interaction keeps planTitle in its payload", async () => {
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

Deno.test("Workspace Code Review reload reads the latest proposed branch patch", async () => {
    const projectRoot = await Deno.makeTempDir({ prefix: "runwield-workspace-code-reload-" });
    const service = new WorkspaceSessionContinuationService({ store: {} });
    try {
        await runGit(projectRoot, ["init", "-b", "main"]);
        await runGit(projectRoot, ["config", "user.email", "runwield@example.com"]);
        await runGit(projectRoot, ["config", "user.name", "RunWield Test"]);
        await Deno.writeTextFile(`${projectRoot}/review.ts`, "export const label = 'base';\n");
        await runGit(projectRoot, ["add", "review.ts"]);
        await runGit(projectRoot, ["commit", "-m", "fixture base"]);
        await runGit(projectRoot, ["branch", "target"]);
        await runGit(projectRoot, ["switch", "-c", "execution"]);
        await Deno.writeTextFile(`${projectRoot}/review.ts`, "export const label = 'first';\n");
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
        await Deno.writeTextFile(`${projectRoot}/review.ts`, "export const label = 'second';\n");
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
        await Deno.rename(indexPath, savedIndexPath);
        await Deno.mkdir(indexPath);
        try {
            const fallbackReview = await service.getLiveCodeReview({
                projectId: "project-1",
                runwieldSessionId: "session-1",
                operationId: "operation-reload",
                interactionId: "interaction-reload",
            });
            assertEquals(fallbackReview?.request?.codeReview?.rawPatch, "stale patch");
        } finally {
            await Deno.remove(indexPath);
            await Deno.rename(savedIndexPath, indexPath);
        }

        const unrelatedRoot = await Deno.makeTempDir({ prefix: "runwield-unrelated-review-target-" });
        try {
            await runGit(unrelatedRoot, ["init", "-b", "target"]);
            await runGit(unrelatedRoot, ["config", "user.email", "runwield@example.com"]);
            await runGit(unrelatedRoot, ["config", "user.name", "RunWield Test"]);
            await Deno.writeTextFile(`${unrelatedRoot}/unrelated.ts`, "export const unrelated = true;\n");
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
            await Deno.remove(unrelatedRoot, { recursive: true });
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
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("Workspace Code Review returns decisions to its live Session interaction", async () => {
    const route = await Deno.readTextFile(ROUTE_PATH);
    const surface = await Deno.readTextFile(CODE_REVIEW_SURFACE_PATH);
    const continuation = await Deno.readTextFile(SESSION_CONTINUATION_PATH);

    assertStringIncludes(route, "interactionAnswerUrl");
    assertStringIncludes(surface, "initialPayload.interactionAnswerUrl");
    assertStringIncludes(surface, 'outcome: body.approved ? "accepted" : "selected"');
    assertStringIncludes(continuation, "operation.answer.resolve(runtimeResponse)");
});

Deno.test("TUI review routes keep the same shared bodies in the standalone shell", async () => {
    const planRoute = await Deno.readTextFile(new URL("./pages/review/plan.astro", import.meta.url));
    const codeRoute = await Deno.readTextFile(new URL("./pages/review/code.astro", import.meta.url));

    assertStringIncludes(planRoute, "ReviewLayout");
    assertStringIncludes(planRoute, "PlanReviewSurface");
    assertStringIncludes(planRoute, "escapeReviewPayloadJson(JSON.stringify(payload))");
    assertStringIncludes(codeRoute, "ReviewLayout");
    assertStringIncludes(codeRoute, "CodeReviewSurface");
    assertStringIncludes(codeRoute, "escapeReviewPayloadJson(JSON.stringify(payload))");
});
