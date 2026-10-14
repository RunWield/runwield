import { test } from "node:test";
import { ok as assert, strictEqual as assertStrictEquals } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { ensurePlanIdentity, loadPlan, savePlan } from "../../plan-store.js";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { requestLocalReviewInteraction } from "../../shared/session/local-review-interactions.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";

async function decide(url: string, route: "deny" | "decision", body: Record<string, string | boolean>) {
    const page = new URL(url);
    const token = page.searchParams.get("token");
    assert(token);
    const response = await fetch(new URL(`/api/review/${route}?token=${encodeURIComponent(token)}`, page.origin), {
        method: "POST",
        headers: { "content-type": "application/json", "x-runwield-review-token": token },
        body: JSON.stringify(body),
    });
    assertEquals(response.status, 200, await response.text());
}

test("saved Epic chat review keeps one conversation and live page across two runtime review rounds", async () => {
    await withRuntimeCommandFixture("saved-epic-chat-", async ({ homeDir, projectRoot }) => {
        await savePlan(projectRoot, "epic", "# Epic\n\n## Context\n\nOriginal delivery boundary.\n", {
            classification: "PROJECT",
            status: "draft",
            affectedPaths: [],
        });
        const store = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
        const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "test" });
        let url = "";
        const conversations: Array<{ id: string; events: Array<{ delta: string }> }> = [];
        const turns: boolean[] = [];
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            runtime.setInteractionAdapter(sessionId, {
                async requestInteraction(
                    request: Parameters<typeof requestLocalReviewInteraction>[0],
                    signal?: AbortSignal,
                ) {
                    conversations.push(request._meta.reviewConversation);
                    const response = await requestLocalReviewInteraction(request, signal);
                    turns.push(response._meta?.conversationTurn === true);
                    return response;
                },
            });
            const original = await ensurePlanIdentity(projectRoot, "epic");
            assert(original);
            assert(original.attrs.planId);
            const review = (path: string, id: string, onSurfaceReady: (surface: { url: string }) => void) =>
                runtime.requestInteraction(sessionId, {
                    type: "plan_review",
                    prompt: "Review saved Epic",
                    _meta: {
                        cwd: projectRoot,
                        planId: id,
                        planName: "epic",
                        planPath: path,
                        planningAgentName: "architect",
                        onSurfaceReady,
                    },
                });
            const first = review(original.path, original.attrs.planId, (surface) => {
                url = surface.url;
            });
            for (let i = 0; i < 200 && !url; i++) await new Promise((resolve) => setTimeout(resolve, 20));
            assert(url, "The first review page must open");
            const initialUrl = url;
            await decide(url, "deny", {
                approved: false,
                conversationTurn: true,
                feedback: "Clarify the delivery boundary.",
            });
            const firstAnswer = await first;
            assertEquals(firstAnswer.outcome, "selected");
            assertEquals(turns[0], true);
            assertEquals((await loadPlan(projectRoot, "epic"))?.attrs.status, "feedback");

            const current = await loadPlan(projectRoot, "epic");
            assert(current);
            await savePlan(
                projectRoot,
                "epic",
                "# Epic\n\n## Context\n\nRevised delivery boundary with clear milestones.\n",
                current.attrs,
                {
                    expectedRevision: current.revision,
                },
            );
            const revised = await loadPlan(projectRoot, "epic");
            assert(revised);
            assert(revised.attrs.planId);
            let secondReady = false;
            const second = review(revised.path, revised.attrs.planId, (surface) => {
                url = surface.url;
                secondReady = true;
            });
            let settled = false;
            try {
                for (let i = 0; i < 200 && !secondReady; i++) {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }
                assert(secondReady, "The second review page must open");
                const page = new URL(url);
                const token = page.searchParams.get("token");
                assert(token);
                const status = await (await fetch(new URL(`/api/review/conversation?token=${token}`, page.origin), {
                    headers: { "x-runwield-review-token": token },
                })).json();
                await decide(url, "decision", { approved: true, approvalAction: "decompose" });
                const secondAnswer = await second;
                settled = true;
                assertEquals(conversations.length, 2);
                assertStrictEquals(conversations[0], conversations[1]);
                assertEquals(url, initialUrl);
                assertEquals(status.agentLabel, "Architect");
                assertEquals(status.revision, 1);
                assertStringIncludes(status.plan, "Revised delivery boundary with clear milestones.");
                assertEquals(secondAnswer.outcome, "accepted");
                assertEquals((await loadPlan(projectRoot, "epic"))?.attrs.status, "approved");
                await runtime.closeAllSessionsWhenIdle();
                const closed = await fetch(new URL(`/api/review/conversation?token=${token}`, page.origin)).catch(() =>
                    null
                );
                assert(!closed?.ok, "Closing the owner must close its review page");
            } finally {
                if (!settled) {
                    await decide(url, "deny", {
                        approved: false,
                        conversationTurn: true,
                        feedback: "End failed review round.",
                    });
                    await second;
                }
            }
        } finally {
            await runtime.closeAllSessionsWhenIdle();
            store.close();
        }
    });
});
