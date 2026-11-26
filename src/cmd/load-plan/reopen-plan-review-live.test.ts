import { authorLocalPlan } from "../../plan-store/index.ts";
import { loadPlan } from "../../shared/testing/plan-query-fixture.ts";
import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { createInteractiveSessionRuntime as createSessionRuntime } from "@runwield/session-runtime/services";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.ts";
import { RuntimeInteractionTypes } from "@runwield/session-runtime/interactions";

test("reopening a live review returns its address without opening another review", async () => {
    await withRuntimeCommandFixture("reopen-live-", async ({ homeDir, projectRoot }) => {
        await authorLocalPlan(projectRoot, { planName: "target", contextMarkdown: "# Target\n" });
        const plan = await loadPlan(projectRoot, "target");
        const ownerStore = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
        const runtime = createSessionRuntime({ sessionStore: ownerStore, ownerProcessKind: "test" });
        const pending = Promise.withResolvers<{ outcome: "canceled" }>();
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            let presentations = 0;
            const presented = Promise.withResolvers<void>();
            runtime.setInteractionAdapter(sessionId, {
                requestInteraction() {
                    presentations++;
                    presented.resolve();
                    return pending.promise;
                },
            });
            const original = runtime.requestInteraction(sessionId, {
                type: RuntimeInteractionTypes.PLAN_REVIEW,
                prompt: "Review target",
                reviewUrl: "https://example.test/current-review",
                _meta: { planId: plan!.attrs.planId, planName: "target", planningAgentName: "planner" },
            });
            await presented.promise;
            const result = await runtime.reopenPlanReview(sessionId);
            assertEquals(result.kind, "live");
            assertEquals(result.url, "https://example.test/current-review");
            assertEquals(presentations, 1);
            pending.resolve({ outcome: "canceled" });
            await original;
        } finally {
            pending.resolve({ outcome: "canceled" });
            await runtime.closeAllSessionsWhenIdle();
            ownerStore.close();
        }
    });
});
