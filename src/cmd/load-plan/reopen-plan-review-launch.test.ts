import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { ensurePlanIdentity, savePlan } from "../../plan-store.js";
import { RuntimeInteractionTypes } from "../../shared/session/session-runtime-interactions.js";

test("a failed review launch does not claim the review was completed", async () => {
    await withRuntimeCommandFixture("reopen-launch-", async ({ homeDir, projectRoot }) => {
        await savePlan(projectRoot, "target", "# Target\n\n## Context\n\nReview this Plan.\n", {
            classification: "PLANNED_CHANGE",
            status: "draft",
            affectedPaths: [],
            executionAgent: "engineer",
            collaborationRecommendation: "autonomous",
        });
        const plan = await ensurePlanIdentity(projectRoot, "target");
        const store = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
        const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "test" });
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            runtime.setInteractionAdapter(sessionId, { requestInteraction: () => ({ outcome: "canceled" }) });
            await runtime.requestInteraction(sessionId, {
                type: RuntimeInteractionTypes.PLAN_REVIEW,
                prompt: "Review target",
                _meta: { planId: plan.attrs.planId, planName: "target", planningAgentName: "planner" },
            });
            runtime.setInteractionAdapter(sessionId, {
                requestInteraction(request) {
                    if (request.type === RuntimeInteractionTypes.PLAN_REVIEW) throw new Error("Browser unavailable");
                    return { outcome: "canceled" };
                },
            });
            const result = await runtime.reopenPlanReview(sessionId);
            assertEquals(result.kind, "unanswered");
            assertStringIncludes(result.message, "without an answer");
        } finally {
            await runtime.closeAllSessionsWhenIdle();
            store.close();
        }
    });
});
