import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { fauxAssistantMessage, fauxText, type TranscriptContext } from "@earendil-works/pi-ai";
import { ensurePlanIdentity, loadPlan, savePlan } from "../../plan-store.js";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { RuntimeInteractionTypes } from "../../shared/session/session-runtime-interactions.js";
import type { SequenceReviewDocument } from "../../shared/workflow/sequence-review.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";

test("reopened Sequence combines container and child feedback for its planning Agent", async () => {
    await withRuntimeCommandFixture(
        "reopen-sequence-feedback-",
        async ({ homeDir, projectRoot, setModelResponseFactory }) => {
            await savePlan(projectRoot, "sequence", "# Sequence\n\n## Context\n\nThe entire change.\n", {
                classification: "PROJECT",
                type: "sequence",
                status: "draft",
                affectedPaths: [],
            });
            await savePlan(projectRoot, "sequence/first", "# First\n\n## Context\n\nThe first step.\n", {
                classification: "PLANNED_CHANGE",
                status: "draft",
                parentPlan: "sequence",
                order: 1,
                dependencies: [],
                affectedPaths: [],
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            });
            const plan = await ensurePlanIdentity(projectRoot, "sequence");
            const store = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
            const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "test" });
            try {
                const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
                const persistentId = runtime.getSessionSnapshot(sessionId)?.managed?.runwieldSessionId;
                runtime.setInteractionAdapter(sessionId, { requestInteraction: () => ({ outcome: "canceled" }) });
                await runtime.requestInteraction(sessionId, {
                    type: RuntimeInteractionTypes.PLAN_REVIEW,
                    prompt: "Review Sequence",
                    _meta: { planId: plan.attrs.planId, planName: "sequence", planningAgentName: "architect" },
                });
                let planningTurn = "";
                setModelResponseFactory((context: TranscriptContext) => {
                    planningTurn = JSON.stringify(context.messages);
                    return fauxAssistantMessage(fauxText("I will revise this Sequence."));
                });
                runtime.setInteractionAdapter(sessionId, {
                    requestInteraction(request) {
                        if (request.type !== RuntimeInteractionTypes.PLAN_REVIEW) return { outcome: "canceled" };
                        const documents = request._meta?.sequenceDocuments as SequenceReviewDocument[];
                        assertEquals(documents.map((doc) => doc.planName), ["sequence", "sequence/first"]);
                        return {
                            outcome: "accepted",
                            _meta: {
                                sequenceDecision: {
                                    approved: false,
                                    feedback: "Revise the whole Sequence.",
                                    documents: documents.map((doc) => ({
                                        planId: doc.planId,
                                        plan: doc.plan,
                                        ...(doc.planName === "sequence/first"
                                            ? { feedback: "Change the first child scope." }
                                            : {}),
                                    })),
                                },
                            },
                        };
                    },
                });
                const result = await runtime.reopenPlanReview(sessionId);
                assertEquals(result.kind, "complete", result.message);
                assertEquals((await loadPlan(projectRoot, "sequence"))?.attrs.status, "feedback");
                assertEquals((await loadPlan(projectRoot, "sequence/first"))?.attrs.status, "feedback");
                assertEquals(runtime.getSessionSnapshot(sessionId)?.managed?.runwieldSessionId, persistentId);
                assertEquals(runtime.getSessionSnapshot(sessionId)?.activeAgent, "architect");
                assert(planningTurn, "The saved planning Agent did not receive the Sequence feedback");
                assertStringIncludes(planningTurn, "Revise the whole Sequence.");
                assertStringIncludes(planningTurn, "Change the first child scope.");
            } finally {
                await runtime.closeAllSessionsWhenIdle();
                store.close();
            }
        },
    );
});
