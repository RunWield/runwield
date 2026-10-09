import { assertEquals, assertStringIncludes } from "@std/assert";
import type { BrowserPort } from "../../shared/browser-port.ts";
import { HostedSession } from "../../shared/session/hosted-session.js";
import { defineCommittedGitFixture } from "../../shared/git-test-fixture.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { createTuiInteractionAdapter } from "../tui/runtime-interaction-adapter.js";
import { getWorktreeReviewDiff } from "../../shared/workflow/git-snapshot.ts";
import {
    type ReviewDecisionValue,
    type ReviewServerOutput,
    startArtifactReadSurface,
    startCodeReviewSurface,
    startPlanReviewSurface,
    stopActiveReviewSurfaces,
} from "./review-launcher.ts";

interface PlanDecision {
    [key: string]: ReviewDecisionValue;
    approved: boolean;
    feedback: string;
    exit: boolean;
    canceled: boolean;
}

interface CodeDecision extends PlanDecision {
    annotations: ReviewDecisionValue[];
}

const codeReviewGitFixture = defineCommittedGitFixture();

function recordingBrowser(opened: boolean): BrowserPort & { urls: string[] } {
    const urls: string[] = [];
    return {
        urls,
        open(url) {
            urls.push(url);
            return Promise.resolve(opened);
        },
    };
}

function reviewLauncherTest(name: string, run: (projectRoot: string) => Promise<void>): void {
    Deno.test(name, () =>
        withProcessGlobalTestLock(async () => {
            const previous = Deno.env.get("WLD_WORKSPACE_DISABLE_BUILT_SERVER");
            const projectRoot = await Deno.makeTempDir({ prefix: "runwield-review-launcher-" });
            Deno.env.set("WLD_WORKSPACE_DISABLE_BUILT_SERVER", "1");
            try {
                await run(projectRoot);
            } finally {
                await stopActiveReviewSurfaces();
                await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
                if (previous === undefined) Deno.env.delete("WLD_WORKSPACE_DISABLE_BUILT_SERVER");
                else Deno.env.set("WLD_WORKSPACE_DISABLE_BUILT_SERVER", previous);
            }
        }));
}

async function runGit(cwd: string, args: string[]): Promise<string> {
    const result = await new Deno.Command("git", { cwd, args, stdout: "piped", stderr: "piped" }).output();
    if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
}

reviewLauncherTest("Plan Review reports its real Workspace URL before opening the browser", async (projectRoot) => {
    const surfaces: Array<{ url: string; opened: boolean }> = [];
    let browserCalls = 0;
    const browser: BrowserPort = {
        open(url) {
            browserCalls += 1;
            assertEquals(surfaces, [{ url, opened: false }]);
            return Promise.resolve(true);
        },
    };
    const server = await startPlanReviewSurface<PlanDecision>({
        cwd: projectRoot,
        plan: "# Plan",
        planPath: "docs/plans/example.md",
        browser,
        onSurfaceReady: (surface) => surfaces.push(surface),
    });
    const decision = server.waitForDecision();
    await server.stop();

    assertEquals(surfaces, [{ url: server.url, opened: false }]);
    assertEquals(browserCalls, 1);
    assertEquals(server.opened, true);
    assertEquals(await decision, { approved: false, feedback: "", exit: true, canceled: true });
});

reviewLauncherTest("artifact reads run the real Workspace server without launching a browser", async (projectRoot) => {
    const browser = recordingBrowser(false);
    const server = await startArtifactReadSurface<PlanDecision>({
        cwd: projectRoot,
        markdown: "# Read Me",
        artifactKind: "work-record",
        title: "Read Me",
        path: "docs/work-records/read-me.md",
        notices: ["NOTICE: maintenance"],
        browser,
    });

    const html = await (await fetch(server.url)).text();
    const decision = server.waitForDecision();
    await server.stop();

    assertEquals(server.opened, false);
    assertEquals(browser.urls, [server.url]);
    assertStringIncludes(html, "artifact-read");
    assertStringIncludes(html, "Read Me");
    assertEquals(await decision, { approved: false, feedback: "", exit: true, canceled: true });
});

reviewLauncherTest(
    "Plan Review exposes trusted execution policy through the real Workspace payload",
    async (projectRoot) => {
        const server = await startPlanReviewSurface<PlanDecision>({
            cwd: projectRoot,
            plan: `---
classification: FEATURE
executionAgent: frontend-engineer
collaborationRecommendation: pair
---
# Plan
`,
            planPath: "docs/plans/policy.md",
            browser: recordingBrowser(false),
        });
        const html = await (await fetch(server.url)).text();
        const decision = server.waitForDecision();
        await server.stop();

        assertStringIncludes(html, '"classification":"PLANNED_CHANGE"');
        assertStringIncludes(html, '"executionAgent":"frontend-engineer"');
        assertStringIncludes(html, '"collaborationRecommendation":"pair"');
        assertEquals(await decision, { approved: false, feedback: "", exit: true, canceled: true });
    },
);

reviewLauncherTest("revised Plan Review exposes its initial Plan baseline", async (projectRoot) => {
    const server = await startPlanReviewSurface<PlanDecision>({
        cwd: projectRoot,
        plan: "# Revised Plan\n\nNew approach\n",
        previousPlan: "# Initial Plan\n\nOld approach\n",
        planVersions: [
            { plan: "# Initial Plan\n\nOld approach\n", timestamp: "2026-08-23T01:00:00.000Z" },
            { plan: "# Revised Plan\n\nNew approach\n", timestamp: "2026-08-23T02:00:00.000Z" },
        ],
        browser: recordingBrowser(false),
    });
    const html = await (await fetch(server.url)).text();
    const decision = server.waitForDecision();
    await server.stop();

    assertStringIncludes(html, '"previousPlan":"# Initial Plan\\n\\nOld approach\\n"');
    assertStringIncludes(html, '"planVersions":[{"plan":"# Initial Plan');
    assertEquals(await decision, { approved: false, feedback: "", exit: true, canceled: true });
});

reviewLauncherTest("standalone Plan conversation reuses one token page across agent revisions", async (projectRoot) => {
    const browser = recordingBrowser(true);
    const conversation = {
        id: "conversation-fixture",
        agentLabel: "Architect",
        revision: 0,
        events: [] as Array<{
            type: "assistant_text_delta";
            delta: string;
            messageId: string;
            agentName: string;
        }>,
    };
    const first = await startPlanReviewSurface<PlanDecision>({
        cwd: projectRoot,
        plan: "# Initial Plan\n",
        reviewConversation: conversation,
        agentLabel: "Architect",
        browser,
    });
    const token = new URL(first.url).searchParams.get("token") || "";
    const firstDecision = first.waitForDecision();
    const response = await fetch(`${new URL(first.url).origin}/api/review/deny?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-runwield-review-token": token },
        body: JSON.stringify({
            approved: false,
            conversationTurn: true,
            feedback: "Clarify the delivery boundary.",
        }),
    });
    assertEquals(response.status, 200);
    const expectedDecision: Partial<PlanDecision> = {
        approved: false,
        conversationTurn: true,
        feedback: "Clarify the delivery boundary.",
        annotations: [],
        plan: undefined,
        savedPath: undefined,
    };
    assertEquals(await firstDecision, expectedDecision);

    conversation.events.push({
        type: "assistant_text_delta",
        delta: "I clarified the delivery boundary.",
        messageId: "architect-reply",
        agentName: "Architect",
    });
    const revised = await startPlanReviewSurface<PlanDecision>({
        cwd: projectRoot,
        plan: "# Revised Plan\n\nClear delivery boundary.\n",
        previousPlan: "# Initial Plan\n",
        reviewConversation: conversation,
        agentLabel: "Architect",
        browser,
    });
    const status = await (await fetch(
        `${new URL(first.url).origin}/api/review/conversation?token=${encodeURIComponent(token)}`,
        { headers: { "x-runwield-review-token": token } },
    )).json();

    assertEquals(revised.url, first.url);
    assertEquals(revised.opened, false);
    assertEquals(browser.urls, [first.url]);
    assertEquals(status.agentLabel, "Architect");
    assertEquals(status.revision, 1);
    assertEquals(status.plan, "# Revised Plan\n\nClear delivery boundary.\n");
    assertEquals(status.events[0].delta, "I clarified the delivery boundary.");

    const revisedDecision = revised.waitForDecision();
    await revised.stop();
    assertEquals(await revisedDecision, { approved: false, feedback: "", exit: true, canceled: true });
});

reviewLauncherTest("disposing a Session closes its retained standalone Plan review", async (projectRoot) => {
    const session = new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot });
    const first = await startPlanReviewSurface<PlanDecision>({
        cwd: projectRoot,
        plan: "# Epic\n",
        reviewConversation: session.getPlanReviewConversation({ planId: "epic-id", planningAgentName: "architect" }),
        browser: recordingBrowser(false),
    });
    const token = new URL(first.url).searchParams.get("token") || "";
    const decision = first.waitForDecision();
    const response = await fetch(`${new URL(first.url).origin}/api/review/deny?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-runwield-review-token": token },
        body: JSON.stringify({ approved: false, conversationTurn: true, feedback: "Revise this Epic." }),
    });
    assertEquals(response.status, 200);
    await decision;
    await session.dispose();
    const closed = await fetch(first.url).catch(() => null);
    assertEquals(closed?.ok, undefined);
});

reviewLauncherTest(
    "standalone Code Review conversation reloads a revised patch in one token page",
    async (projectRoot) => {
        const browser = recordingBrowser(true);
        const conversation = {
            id: "code-conversation-fixture",
            agentLabel: "Reviewer Feedback Engineer",
            revision: 0,
            events: [] as Array<{
                type: "assistant_text_delta";
                delta: string;
                messageId: string;
                agentName: string;
            }>,
        };
        const first = await startCodeReviewSurface<CodeDecision>({
            rawPatch: "diff --git a/a.ts b/a.ts\n+first",
            gitRef: "fixture diff",
            agentCwd: projectRoot,
            reviewConversation: conversation,
            browser,
        });
        const token = new URL(first.url).searchParams.get("token") || "";
        const firstDecision = first.waitForDecision();
        const response = await fetch(
            `${new URL(first.url).origin}/api/review/deny?token=${encodeURIComponent(token)}`,
            {
                method: "POST",
                headers: { "content-type": "application/json", "x-runwield-review-token": token },
                body: JSON.stringify({
                    approved: false,
                    conversationTurn: true,
                    feedback: "Rename the helper.",
                    annotations: [],
                }),
            },
        );
        assertEquals(response.status, 200);
        const actualFirstDecision: Partial<CodeDecision> = await firstDecision;
        assertEquals(actualFirstDecision, {
            approved: false,
            conversationTurn: true,
            feedback: "Rename the helper.",
            annotations: [],
            plan: undefined,
            savedPath: undefined,
        });

        conversation.events.push({
            type: "assistant_text_delta",
            delta: "I renamed the helper.",
            messageId: "engineer-reply",
            agentName: "Reviewer Feedback Engineer",
        });
        const revisedPatch = "diff --git a/a.ts b/a.ts\n-first\n+renamed";
        const revised = await startCodeReviewSurface<CodeDecision>({
            rawPatch: revisedPatch,
            gitRef: "fixture diff",
            agentCwd: projectRoot,
            reviewConversation: conversation,
            browser,
        });
        const status = await (await fetch(
            `${new URL(first.url).origin}/api/review/conversation?token=${encodeURIComponent(token)}`,
            { headers: { "x-runwield-review-token": token } },
        )).json();

        assertEquals(revised.url, first.url);
        assertEquals(revised.opened, false);
        assertEquals(browser.urls, [first.url]);
        assertEquals(status.revision, 1);
        assertEquals(status.rawPatch, revisedPatch);
        assertEquals(status.events[0].delta, "I renamed the helper.");

        const revisedDecision = revised.waitForDecision();
        await revised.stop();
        assertEquals(await revisedDecision, {
            approved: false,
            feedback: "",
            annotations: [],
            exit: true,
            canceled: true,
        });
    },
);

reviewLauncherTest("reloading Code Review recomputes the proposed branch patch", async (projectRoot) => {
    await runGit(projectRoot, ["init", "-b", "main"]);
    await runGit(projectRoot, ["config", "user.email", "runwield@example.com"]);
    await runGit(projectRoot, ["config", "user.name", "RunWield Test"]);
    await Deno.writeTextFile(`${projectRoot}/review.ts`, "export const label = 'base';\n");
    await runGit(projectRoot, ["add", "review.ts"]);
    await runGit(projectRoot, ["commit", "-m", "fixture base"]);
    await runGit(projectRoot, ["branch", "target"]);
    await runGit(projectRoot, ["switch", "-c", "execution"]);
    await Deno.writeTextFile(`${projectRoot}/review.ts`, "export const label = 'first';\n");

    const server = await startCodeReviewSurface<CodeDecision>({
        rawPatch: "stale patch",
        gitRef: "fixture diff",
        agentCwd: projectRoot,
        targetBranch: "target",
        browser: recordingBrowser(false),
    });
    await runGit(projectRoot, ["add", "review.ts"]);
    await runGit(projectRoot, ["commit", "-m", "advance target"]);
    await runGit(projectRoot, ["update-ref", "refs/heads/target", "HEAD"]);
    await Deno.writeTextFile(`${projectRoot}/review.ts`, "export const label = 'second';\n");
    const expectedPatch = await getWorktreeReviewDiff(projectRoot, "target");
    const response = await fetch(server.url);
    const html = await response.text();
    const embedded = html.match(/<script[^>]*data-code-review-payload[^>]*>([\s\S]*?)<\/script>/)?.[1] || "{}";
    const payload = JSON.parse(embedded);

    assertEquals(response.status, 200);
    assertEquals(payload.rawPatch, expectedPatch);
    assertStringIncludes(html, "-export const label = 'first';");
    assertStringIncludes(html, "+export const label = 'second';");
    assertEquals(html.includes("label = 'base'"), false);
    assertEquals(html.includes("stale patch"), false);
    assertEquals(html.includes("targetBranch"), false);
    assertEquals(html.includes(projectRoot), false);

    const indexPath = `${projectRoot}/.git/index`;
    const savedIndexPath = `${projectRoot}/.git/index.saved`;
    await Deno.rename(indexPath, savedIndexPath);
    await Deno.mkdir(indexPath);
    try {
        const fallbackResponse = await fetch(server.url);
        const fallbackHtml = await fallbackResponse.text();
        const fallbackEmbedded = fallbackHtml.match(
            /<script[^>]*data-code-review-payload[^>]*>([\s\S]*?)<\/script>/,
        )?.[1] || "{}";
        assertEquals(fallbackResponse.status, 200);
        assertEquals(JSON.parse(fallbackEmbedded).rawPatch, "stale patch");
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

        const invalidResponse = await fetch(server.url);
        const invalidHtml = await invalidResponse.text();
        assertEquals(invalidResponse.status, 500);
        assertEquals(invalidHtml.includes("stale patch"), false);
    } finally {
        await Deno.remove(unrelatedRoot, { recursive: true });
        await server.stop();
    }
});

reviewLauncherTest(
    "TUI Code Review interaction keeps planTitle through the real Workspace payload",
    async () => {
        const projectRoot = await codeReviewGitFixture.checkout({ prefix: "runwield-code-review-" });
        try {
            await Deno.writeTextFile(`${projectRoot}/change.ts`, "export const changed = true;\n");
            const abort = new AbortController();
            let inspectPayload = Promise.resolve();
            const browser: BrowserPort = {
                open(url) {
                    inspectPayload = (async () => {
                        try {
                            const token = new URL(url).searchParams.get("token") || "";
                            const html = await (await fetch(url)).text();
                            assertStringIncludes(html, '"planTitle":"Readable Plan Title"');
                            assertStringIncludes(html, '"autoStart":true');
                            assertStringIncludes(html, '"untrackedFiles":["change.ts"]');
                            const response = await fetch(
                                `${new URL(url).origin}/api/review/deny?token=${encodeURIComponent(token)}`,
                                {
                                    method: "POST",
                                    headers: {
                                        "content-type": "application/json",
                                        "x-runwield-review-token": token,
                                    },
                                    body: JSON.stringify({ feedback: "Not yet." }),
                                },
                            );
                            assertEquals(response.status, 200);
                        } catch (error) {
                            abort.abort();
                            throw error;
                        }
                    })();
                    return Promise.resolve(false);
                },
            };
            const adapter = createTuiInteractionAdapter({
                appendSystemMessage: () => {},
                appendAgentMessageStart: () => ({ appendText: () => {} }),
                requestRender: () => {},
                promptSelect: () => Promise.resolve(null),
                promptText: () => Promise.resolve(null),
                showModelSelector: () => {},
                abortActivePrompt: () => {},
            }, { browser });
            const response = await adapter.requestInteraction({
                type: "code_review",
                prompt: "Review the code changes.",
                _meta: {
                    planName: "show-plan-title",
                    planTitle: "Readable Plan Title",
                    diffText: "diff --git a/change.ts b/change.ts\n+change",
                    executionCwd: projectRoot,
                    targetBranch: "main",
                    guidedReview: {
                        mode: "auto",
                        autoStart: true,
                        manualAvailable: true,
                        reasons: ["fixture"],
                        stats: {
                            changedFiles: 1,
                            changedLines: 1,
                            addedLines: 1,
                            removedLines: 0,
                            meaningfulAreas: ["src"],
                            lowSignalOnly: false,
                            paths: ["change.ts"],
                        },
                        score: 4,
                    },
                },
            }, abort.signal);
            await inspectPayload;
            assertEquals(response, {
                outcome: "selected",
                _meta: { approved: false, feedback: "Not yet.", annotations: [], canceled: false, exit: false },
            });
        } finally {
            await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
        }
    },
);

reviewLauncherTest("review server startup output reaches the caller", async (projectRoot) => {
    const output: ReviewServerOutput[] = [];
    const server = await startPlanReviewSurface<PlanDecision>({
        cwd: projectRoot,
        plan: "# Plan",
        browser: recordingBrowser(false),
        onOutput: (entry) => output.push(entry),
    });
    await server.stop();

    assertEquals(
        output.some((entry) => entry.stream === "stdout" && entry.text.includes("Listening on http://")),
        true,
    );
});

reviewLauncherTest("global cleanup stops every real review surface", async (projectRoot) => {
    const planServer = await startPlanReviewSurface<PlanDecision>({
        cwd: projectRoot,
        plan: "# Plan",
        browser: recordingBrowser(false),
    });
    const codeServer = await startCodeReviewSurface<CodeDecision>({
        rawPatch: "diff --git a/a.ts b/a.ts\n+change",
        gitRef: "fixture diff",
        agentCwd: projectRoot,
        browser: recordingBrowser(false),
    });
    const planDecision = planServer.waitForDecision();
    const codeDecision = codeServer.waitForDecision();

    await stopActiveReviewSurfaces();

    assertEquals(await planDecision, { approved: false, feedback: "", exit: true, canceled: true });
    assertEquals(await codeDecision, {
        approved: false,
        feedback: "",
        annotations: [],
        exit: true,
        canceled: true,
    });
});
