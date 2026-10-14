import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { openFileSessionStore } from "../../shared/session/file-session-store.ts";
import { ensurePlanIdentity, loadPlan, savePlan } from "../../plan-store.js";
import { RuntimeInteractionTypes } from "../../shared/session/session-runtime-interactions.js";
import type { SequenceReviewDocument } from "../../shared/workflow/sequence-review.ts";

test("an idle Session reopens the complete saved Sequence and saves approval without a model turn", async () => {
    await withRuntimeCommandFixture("reopen-sequence-", async ({ homeDir, projectRoot, setModelResponseFactory }) => {
        let modelTurns = 0;
        setModelResponseFactory(() => {
            modelTurns++;
            return fauxAssistantMessage(fauxText("Unexpected planning turn"));
        });
        await savePlan(projectRoot, "sequence", "# Container\n\n## Context\n\nReview both.", {
            classification: "PROJECT",
            type: "sequence",
            status: "draft",
            affectedPaths: [],
        });
        await savePlan(projectRoot, "sequence/child", "# Child\n\n## Context\n\nImplement.", {
            classification: "PLANNED_CHANGE",
            status: "draft",
            parentPlan: "sequence",
            order: 1,
            affectedPaths: [],
            dependencies: [],
        });
        const plan = await ensurePlanIdentity(projectRoot, "sequence");
        const ownerStore = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
        const fileStore = openFileSessionStore();
        const runtime = createSessionRuntime({ sessionStore: ownerStore, ownerProcessKind: "test" });
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            runtime.setInteractionAdapter(sessionId, { requestInteraction: () => ({ outcome: "canceled" }) });
            await runtime.requestInteraction(sessionId, {
                type: RuntimeInteractionTypes.PLAN_REVIEW,
                prompt: "Review Sequence",
                _meta: { planId: plan.attrs.planId, planName: "sequence", planningAgentName: "planner" },
            });
            let reviewed: SequenceReviewDocument[] = [];
            runtime.setInteractionAdapter(sessionId, {
                requestInteraction(request) {
                    if (request.type !== RuntimeInteractionTypes.PLAN_REVIEW) return { outcome: "canceled" };
                    reviewed = request._meta?.sequenceDocuments as SequenceReviewDocument[];
                    return {
                        outcome: "accepted",
                        _meta: {
                            sequenceDecision: {
                                approved: true,
                                approvalAction: "later",
                                documents: reviewed.map((doc) => ({ planId: doc.planId, plan: doc.plan })),
                            },
                        },
                    };
                },
            });
            const notices: string[] = [];
            runtime.subscribeSessionEvents(sessionId, (event) => {
                if ("message" in event && typeof event.message === "string") notices.push(event.message);
            });
            assertEquals((await runtime.reopenPlanReview(sessionId)).kind, "complete");
            assertEquals(reviewed.map((doc) => doc.planName), ["sequence", "sequence/child"], notices.join("\n"));
            assertEquals(
                (await loadPlan(projectRoot, "sequence/child"))?.attrs.status,
                "ready_for_work",
                notices.join("\n"),
            );
            assertEquals(modelTurns, 0);
        } finally {
            await runtime.closeAllSessionsWhenIdle();
            fileStore.close();
            ownerStore.close();
        }
    });
});

test("a saved review does not open a replacement Plan identity", async () => {
    await withRuntimeCommandFixture("reopen-identity-", async ({ homeDir, projectRoot }) => {
        await savePlan(projectRoot, "target", "# Target", {
            classification: "PLANNED_CHANGE",
            status: "draft",
            affectedPaths: [],
        });
        const ownerStore = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
        const runtime = createSessionRuntime({ sessionStore: ownerStore, ownerProcessKind: "test" });
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            runtime.setInteractionAdapter(sessionId, { requestInteraction: () => ({ outcome: "canceled" }) });
            await runtime.requestInteraction(sessionId, {
                type: RuntimeInteractionTypes.PLAN_REVIEW,
                prompt: "Review target",
                _meta: { planId: "old-identity", planName: "target", planningAgentName: "planner" },
            });
            const result = await runtime.reopenPlanReview(sessionId);
            assert(result.kind === "identity_mismatch");
        } finally {
            await runtime.closeAllSessionsWhenIdle();
            ownerStore.close();
        }
    });
});
