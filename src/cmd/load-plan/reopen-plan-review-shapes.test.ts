import { seedPlan } from "../../shared/testing/plan-state-fixture.ts";
import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { createInteractiveSessionRuntime as createSessionRuntime } from "@runwield/session-runtime/services";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.ts";
import { ensurePlanIdentity } from "../../plan-store/index.ts";
import { loadPlan } from "../../shared/testing/plan-query-fixture.ts";

import { RuntimeInteractionTypes } from "@runwield/session-runtime/interactions";

for (const classification of ["PLANNED_CHANGE", "PROJECT"] as const) {
    test(`an idle Session opens the current ${classification} Plan and cancellation leaves its status unchanged`, async () => {
        await withRuntimeCommandFixture(`reopen-${classification}-`, async ({ homeDir, projectRoot }) => {
            await seedPlan(projectRoot, "target", "# Target\n\n## Context\n\nCurrent text.", {
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
                const { sessionId } = await runtime.createSession({ cwd: projectRoot });
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
                            requested =
                                request._meta?.planName === "target" &&
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
