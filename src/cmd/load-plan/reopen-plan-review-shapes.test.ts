import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { ensurePlanIdentity, loadPlan, savePlan } from "../../plan-store.js";
import { RuntimeInteractionTypes } from "../../shared/session/session-runtime-interactions.js";

for (const classification of ["PLANNED_CHANGE", "PROJECT"] as const) {
    test(`an idle Session opens the current ${classification} Plan and cancellation leaves its status unchanged`, async () => {
        await withRuntimeCommandFixture(`reopen-${classification}-`, async ({ homeDir, projectRoot }) => {
            await savePlan(projectRoot, "target", "# Target\n\n## Context\n\nCurrent text.", {
                classification,
                status: "draft",
                affectedPaths: [],
                ...(classification === "PLANNED_CHANGE"
                    ? { executionAgent: "engineer", collaborationRecommendation: "autonomous" }
                    : {}),
            });
            const plan = await ensurePlanIdentity(projectRoot, "target");
            const ownerStore = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
            const runtime = createSessionRuntime({ sessionStore: ownerStore, ownerProcessKind: "test" });
            try {
                const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
                runtime.setInteractionAdapter(sessionId, { requestInteraction: () => ({ outcome: "canceled" }) });
                await runtime.requestInteraction(sessionId, {
                    type: RuntimeInteractionTypes.PLAN_REVIEW,
                    prompt: "Review target",
                    _meta: { planId: plan.attrs.planId, planName: "target", planningAgentName: "architect" },
                });
                let requested = false;
                runtime.setInteractionAdapter(sessionId, {
                    requestInteraction(request) {
                        if (request.type === RuntimeInteractionTypes.PLAN_REVIEW) {
                            requested = request._meta?.planName === "target" &&
                                request._meta?.planningAgentName === "architect";
                        }
                        return { outcome: "canceled" };
                    },
                });
                assertEquals((await runtime.reopenPlanReview(sessionId)).kind, "unanswered");
                assertEquals(requested, true);
                assertEquals((await loadPlan(projectRoot, "target"))?.attrs.status, "draft");
            } finally {
                await runtime.closeAllSessionsWhenIdle();
                ownerStore.close();
            }
        });
    });
}
