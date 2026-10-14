import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { startPlanReviewSurface } from "./review-launcher.ts";
import { type ReviewDecision } from "../workspace/routes/api/review-handlers.js";
import { withProject } from "../../shared/attached/attached-test-fixture.ts";

test("the review browser acknowledgment and Core waiter both wait for decision acceptance", async () => {
    await withProject(async (cwd) => {
        const entered = Promise.withResolvers<void>();
        const accepted = Promise.withResolvers<void>();
        const server = await startPlanReviewSurface<ReviewDecision>({
            cwd,
            plan: "# Plan",
            browser: { open: () => Promise.resolve(false) },
            async onDecision(decision) {
                assertEquals(decision.feedback, "Revise this.");
                entered.resolve();
                await accepted.promise;
            },
        });
        try {
            let acknowledged = false;
            let waiterResolved = false;
            const waiter = server.waitForDecision().then(() => {
                waiterResolved = true;
            });
            const response = fetch(new URL(`/api/review/deny${new URL(server.url).search}`, server.url), {
                method: "POST",
                body: JSON.stringify({ feedback: "Revise this." }),
            }).then((value) => {
                acknowledged = true;
                return value;
            });
            await entered.promise;
            await Promise.resolve();
            assertEquals(acknowledged, false);
            assertEquals(waiterResolved, false);
            accepted.resolve();
            const result = await response;
            assertEquals(result.status, 200);
            assertEquals(await result.text(), '{"ok":true}');
            await waiter;
        } finally {
            accepted.resolve();
            await server.stop();
        }
    });
});

test("a rejected decision offers stale-review reload and leaves the Core waiter available for retry", async () => {
    await withProject(async (cwd) => {
        const server = await startPlanReviewSurface<ReviewDecision>({
            cwd,
            plan: "# Plan",
            browser: { open: () => Promise.resolve(false) },
            onDecision(decision) {
                if (decision.feedback === "Stale") {
                    return Promise.reject(new Error("Plan changed after review opened."));
                }
                return Promise.resolve();
            },
        });
        try {
            const endpoint = new URL(`/api/review/deny${new URL(server.url).search}`, server.url);
            const rejected = await fetch(endpoint, { method: "POST", body: JSON.stringify({ feedback: "Stale" }) });
            assertEquals(rejected.status, 409);
            const body = await rejected.json();
            assertEquals(body.error, "stale_sequence_review");
            assertStringIncludes(body.message, "Plan changed");
            const retry = await fetch(endpoint, { method: "POST", body: JSON.stringify({ feedback: "Current" }) });
            assertEquals(retry.status, 200);
            assertEquals(await retry.text(), '{"ok":true}');
            assertEquals((await server.waitForDecision()).feedback, "Current");
        } finally {
            await server.stop();
        }
    });
});

test("stopping a review surface does not send a user cancellation to its durable sink", async () => {
    await withProject(async (cwd) => {
        let accepted = false;
        const server = await startPlanReviewSurface<ReviewDecision>({
            cwd,
            plan: "# Plan",
            browser: { open: () => Promise.resolve(false) },
            onDecision: () => {
                accepted = true;
                return Promise.resolve();
            },
        });
        const waiter = server.waitForDecision();
        await server.stop();
        assertEquals(accepted, false);
        assertEquals(await waiter, { approved: false, feedback: "", exit: true, canceled: true });
    });
});

for (const initialSink of [false, true]) {
    test(`reusing a review page ${initialSink ? "removes" : "adds"} the next round's decision sink`, async () => {
        await withProject(async (cwd) => {
            let accepted = "";
            const reviewConversation = {
                id: `sink-reuse-${initialSink}`,
                agentLabel: "Planner",
                revision: 0,
                events: [],
            };
            const browser = { open: () => Promise.resolve(false) };
            const first = await startPlanReviewSurface<ReviewDecision>({
                cwd,
                plan: "# First",
                reviewConversation,
                browser,
                ...(initialSink && {
                    onDecision: () => {
                        accepted = "old";
                        return Promise.resolve();
                    },
                }),
            });
            try {
                const second = await startPlanReviewSurface<ReviewDecision>({
                    cwd,
                    plan: "# Second",
                    reviewConversation,
                    browser,
                    ...(!initialSink && {
                        onDecision: () => {
                            accepted = "new";
                            return Promise.resolve();
                        },
                    }),
                });
                assertEquals(second.url, first.url);
                const response = await fetch(new URL(`/api/review/deny${new URL(second.url).search}`, second.url), {
                    method: "POST",
                    body: JSON.stringify({ feedback: "Revise second." }),
                });
                assertEquals(response.status, 200);
                assertEquals(await response.text(), '{"ok":true}');
                assertEquals(accepted, initialSink ? "" : "new");
                assertEquals((await second.waitForDecision()).feedback, "Revise second.");
            } finally {
                await first.stop();
            }
        });
    });
}
