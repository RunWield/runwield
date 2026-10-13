import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import {
    fauxAssistantMessage,
    fauxText,
    fauxToolCall,
    getCurrentSystemPrompt,
    type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ensurePlanIdentity, loadPlan, savePlan } from "../../plan-store.js";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { RuntimeInteractionTypes } from "../../shared/session/session-runtime-interactions.js";
import { applySharedPlanReviewDecision } from "../../shared/workflow/plan-review-actions.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import type { SequenceReviewDocument } from "../../shared/workflow/sequence-review.ts";

const image = {
    base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    mimeType: "image/png",
};

async function savedReview(
    runtime: ReturnType<typeof createSessionRuntime>,
    sessionId: string,
    projectRoot: string,
    planName: string,
    agent: string,
) {
    const plan = await ensurePlanIdentity(projectRoot, planName);
    runtime.setInteractionAdapter(sessionId, { requestInteraction: () => ({ outcome: "canceled" }) });
    await runtime.requestInteraction(sessionId, {
        type: RuntimeInteractionTypes.PLAN_REVIEW,
        prompt: `Review ${planName}`,
        _meta: { planId: plan.attrs.planId, planName, planningAgentName: agent },
    });
}

test("reopened ordinary feedback sends its image to the saved planning Agent in the same Session", async () => {
    await withRuntimeCommandFixture(
        "reopen-feedback-agent-",
        async ({ homeDir, projectRoot, setModelResponseFactory }) => {
            await savePlan(projectRoot, "target", "# Target\n\n## Context\n\nRevise the proposal.\n", {
                classification: "PLANNED_CHANGE",
                status: "draft",
                affectedPaths: [],
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            });
            const store = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
            const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "test" });
            try {
                const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
                await savedReview(runtime, sessionId, projectRoot, "target", "architect");
                const persistentId = runtime.getSessionSnapshot(sessionId)?.managed?.runwieldSessionId;
                let context: TranscriptContext | undefined;
                setModelResponseFactory((messages: TranscriptContext) => {
                    context = messages;
                    return fauxAssistantMessage(fauxText("I will revise the Plan."));
                });
                runtime.setInteractionAdapter(sessionId, {
                    async requestInteraction(request) {
                        if (request.type !== RuntimeInteractionTypes.PLAN_REVIEW) return { outcome: "canceled" };
                        const current = await loadPlan(projectRoot, "target");
                        assert(current);
                        const result = await applySharedPlanReviewDecision({
                            cwd: projectRoot,
                            planName: "target",
                            planPath: current.path,
                            planWithFrontMatter: current.markdown,
                            planRevision: current.revision,
                            originalAttrs: current.attrs,
                            trustedClassification: current.attrs.classification,
                            decision: { approved: false, feedback: "Use the attached screenshot." },
                        });
                        return { outcome: "accepted", _meta: { ...result, images: [image] } };
                    },
                });
                const result = await runtime.reopenPlanReview(sessionId);
                assertEquals(result.kind, "complete", result.message);
                assertEquals((await loadPlan(projectRoot, "target"))?.attrs.status, "feedback");
                assertEquals(runtime.getSessionSnapshot(sessionId)?.managed?.runwieldSessionId, persistentId);
                assertEquals(runtime.getSessionSnapshot(sessionId)?.activeAgent, "architect");
                assert(context, "The planning Agent did not receive the feedback turn");
                assertStringIncludes(JSON.stringify(context.messages), "iVBORw0KGgo");
                assertStringIncludes(JSON.stringify(context.messages), "Use the attached screenshot.");
                assertStringIncludes(getCurrentSystemPrompt(context.messages), "Architect");
            } finally {
                await runtime.closeAllSessionsWhenIdle();
                store.close();
            }
        },
    );
});

test("reopened ordinary approval and run starts the saved Plan", async () => {
    await withRuntimeCommandFixture("reopen-approve-run-", async ({ homeDir, projectRoot, setModelMessages }) => {
        await savePlan(projectRoot, "target", "# Target\n\n## Context\n\nImplement this.\n", {
            classification: "PLANNED_CHANGE",
            status: "draft",
            affectedPaths: [],
            executionAgent: "engineer",
            collaborationRecommendation: "autonomous",
        });
        setModelMessages([
            fauxAssistantMessage(fauxToolCall("task_completed", { message: "Implementation complete." })),
        ]);
        const store = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
        const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "test" });
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            await savedReview(runtime, sessionId, projectRoot, "target", "planner");
            runtime.setInteractionAdapter(sessionId, {
                async requestInteraction(request) {
                    if (request.type === RuntimeInteractionTypes.SELECT) {
                        return { outcome: "selected", value: "proceed" };
                    }
                    if (request.type !== RuntimeInteractionTypes.PLAN_REVIEW) return { outcome: "canceled" };
                    const current = await loadPlan(projectRoot, "target");
                    assert(current);
                    const result = await applySharedPlanReviewDecision({
                        cwd: projectRoot,
                        planName: "target",
                        planPath: current.path,
                        planWithFrontMatter: current.markdown,
                        planRevision: current.revision,
                        originalAttrs: current.attrs,
                        trustedClassification: current.attrs.classification,
                        decision: {
                            approved: true,
                            approvalAction: "run",
                            executionAgent: "engineer",
                            collaborationRecommendation: "autonomous",
                        },
                    });
                    return { outcome: "accepted", _meta: { ...result } };
                },
            });
            const result = await runtime.reopenPlanReview(sessionId);
            assertEquals(result.kind, "complete", result.message);
            const saved = await loadPlan(projectRoot, "target");
            assert(saved);
            assertEquals(saved.attrs.executionMode, "non_git_in_place");
            assert(saved.attrs.status !== "draft", "Approval and run must start the Plan");
        } finally {
            await runtime.closeAllSessionsWhenIdle();
            store.close();
        }
    });
});

test("reopened PROJECT Epic approval starts decomposition in the same Session", async () => {
    await withRuntimeCommandFixture(
        "reopen-epic-decompose-",
        async ({ homeDir, projectRoot, setModelResponseFactory }) => {
            await savePlan(projectRoot, "epic", "# Epic\n\n## Context\n\nSplit the work.\n", {
                classification: "PROJECT",
                status: "draft",
                affectedPaths: [],
            });
            let slicerPrompt = "";
            setModelResponseFactory((context: TranscriptContext) => {
                slicerPrompt = getCurrentSystemPrompt(context.messages);
                return fauxAssistantMessage(fauxText("Decomposition draft ready."));
            });
            const store = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
            const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "test" });
            try {
                const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
                await savedReview(runtime, sessionId, projectRoot, "epic", "architect");
                const persistentId = runtime.getSessionSnapshot(sessionId)?.managed?.runwieldSessionId;
                runtime.setInteractionAdapter(sessionId, {
                    async requestInteraction(request) {
                        if (request.type !== RuntimeInteractionTypes.PLAN_REVIEW) return { outcome: "canceled" };
                        const current = await loadPlan(projectRoot, "epic");
                        assert(current);
                        const result = await applySharedPlanReviewDecision({
                            cwd: projectRoot,
                            planName: "epic",
                            planPath: current.path,
                            planWithFrontMatter: current.markdown,
                            planRevision: current.revision,
                            originalAttrs: current.attrs,
                            trustedClassification: current.attrs.classification,
                            decision: { approved: true, approvalAction: "decompose" },
                        });
                        return { outcome: "accepted", _meta: { ...result } };
                    },
                });
                const result = await runtime.reopenPlanReview(sessionId);
                assertEquals(result.kind, "complete", result.message);
                assertEquals((await loadPlan(projectRoot, "epic"))?.attrs.status, "ready_for_decomposition");
                assertEquals(runtime.getSessionSnapshot(sessionId)?.managed?.runwieldSessionId, persistentId);
                assertStringIncludes(slicerPrompt, "Slicer");
            } finally {
                await runtime.closeAllSessionsWhenIdle();
                store.close();
            }
        },
    );
});

test("reopened Sequence combines child feedback and then approves and runs the first child", async () => {
    await withRuntimeCommandFixture(
        "reopen-sequence-decisions-",
        async ({ homeDir, projectRoot, setModelResponseFactory }) => {
            await savePlan(projectRoot, "sequence", "# Sequence\n\n## Context\n\nDeliver both.\n", {
                classification: "PROJECT",
                type: "sequence",
                status: "draft",
                affectedPaths: [],
            });
            for (const [index, name] of ["first", "second"].entries()) {
                await savePlan(projectRoot, `sequence/${name}`, `# ${name}\n\n## Context\n\nBuild ${name}.\n`, {
                    classification: "PLANNED_CHANGE",
                    status: "draft",
                    parentPlan: "sequence",
                    order: index + 1,
                    dependencies: index ? ["sequence/first"] : [],
                    affectedPaths: [],
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                });
            }
            let engineerTurn = "";
            setModelResponseFactory((context: TranscriptContext) => {
                engineerTurn = JSON.stringify(context.messages);
                return fauxAssistantMessage(fauxToolCall("task_completed", { message: "First child complete." }));
            });
            const store = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
            const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "test" });
            try {
                const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
                await savedReview(runtime, sessionId, projectRoot, "sequence", "architect");
                let reviewed: SequenceReviewDocument[] = [];
                runtime.setInteractionAdapter(sessionId, {
                    requestInteraction(request) {
                        if (request.type === RuntimeInteractionTypes.SELECT) {
                            return { outcome: "selected", value: "proceed" };
                        }
                        if (request.type !== RuntimeInteractionTypes.PLAN_REVIEW) {
                            return { outcome: "canceled" };
                        }
                        reviewed = request._meta?.sequenceDocuments as SequenceReviewDocument[];
                        return {
                            outcome: "accepted",
                            _meta: {
                                sequenceDecision: {
                                    approved: true,
                                    approvalAction: "run",
                                    feedback: "Use the shared design.",
                                    documents: reviewed.map((doc) => ({
                                        planId: doc.planId,
                                        plan: doc.plan,
                                        ...(doc.planName === "sequence/second"
                                            ? { feedback: "Keep the second child separate." }
                                            : {}),
                                    })),
                                },
                            },
                        };
                    },
                });
                const result = await runtime.reopenPlanReview(sessionId);
                assertEquals(result.kind, "complete", result.message);
                assertEquals(reviewed.map((doc) => doc.planName), ["sequence", "sequence/first", "sequence/second"]);
                assertEquals((await loadPlan(projectRoot, "sequence/second"))?.attrs.status, "ready_for_work");
                const first = await loadPlan(projectRoot, "sequence/first");
                assert(first);
                assertEquals(
                    first.attrs.executionMode,
                    "non_git_in_place",
                    "The first child must start after grouped approval",
                );
                assertStringIncludes(engineerTurn, "Use the shared design.");
                assertStringIncludes(engineerTurn, "Keep the second child separate.");
            } finally {
                await runtime.closeAllSessionsWhenIdle();
                store.close();
            }
        },
    );
});
