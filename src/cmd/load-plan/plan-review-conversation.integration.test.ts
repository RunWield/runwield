import { test } from "node:test";
import { ok as assert, rejects } from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fauxAssistantMessage, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import {
    ensurePlanIdentity,
    loadPlan,
    parsePlanFrontMatter,
    planDocumentMarkdown,
    savePlan,
} from "../../plan-store.js";
import type { SequenceReviewDocument } from "../../shared/workflow/sequence-review.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { requestLocalReviewInteraction } from "../../shared/session/local-review-interactions.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import type { PlanReviewConversation } from "../../shared/session/plan-review-conversation.ts";

interface ReviewAnswer {
    approved: boolean;
    conversationTurn?: boolean;
    feedback?: string;
    approvalAction?: string;
    executionAgent?: "engineer";
    collaborationRecommendation?: "autonomous";
    documents?: Array<{ planId: string; plan: string }>;
}

async function answer(url: string, body: ReviewAnswer) {
    const page = new URL(url);
    const token = page.searchParams.get("token")!;
    const response = await fetch(
        new URL(`/api/review/${body.approved ? "decision" : "deny"}?token=${token}`, page.origin),
        {
            method: "POST",
            headers: { "content-type": "application/json", "x-runwield-review-token": token },
            body: JSON.stringify(body),
        },
    );
    assertEquals(response.status, 200, await response.text());
}

for (const source of ["tool", "saved", "epic"] as const) {
    for (const reply of ["text-only reply", "Agent error", "Escape cancellation", "unreviewable Plan"] as const) {
        test(`${source} review handles ${reply}`, async () => {
            await withRuntimeCommandFixture(
                "conversation-rearm-",
                async ({ homeDir, projectRoot, setModelResponseFactories }) => {
                    await savePlan(projectRoot, "target", "# Target\n\n## Context\n\nThe delivery boundary.\n", {
                        classification: source === "epic" ? "PROJECT" : "PLANNED_CHANGE",
                        status: source === "tool" ? "draft" : "ready_for_work",
                        affectedPaths: [],
                        ...(source === "epic"
                            ? {}
                            : { executionAgent: "engineer", collaborationRecommendation: "autonomous" }),
                    });
                    const initial = await ensurePlanIdentity(projectRoot, "target");
                    const store = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
                    const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "test" });
                    let reviewUrl = "";
                    let rounds = 0;
                    const conversations: PlanReviewConversation[] = [];
                    let transcript: TranscriptContext | undefined;
                    let agentWorking = false;
                    let releaseAgent!: () => void;
                    const agentGate = new Promise<void>((resolve) => {
                        releaseAgent = resolve;
                    });
                    setModelResponseFactories([
                        ...(source === "tool"
                            ? [() => fauxAssistantMessage(fauxToolCall("plan_written", { planName: "target" }))]
                            : []),
                        async (context) => {
                            transcript = context;
                            if (reply === "unreviewable Plan") {
                                const markdown = await readFile(initial.path, "utf8");
                                await writeFile(initial.path, markdown.replace(/^status:.*$/m, "status: implemented"));
                                throw new Error("The Agent left a Plan that cannot be reviewed.");
                            }
                            if (reply === "Agent error") throw new Error("The planning provider is unavailable.");
                            if (reply === "Escape cancellation") {
                                agentWorking = true;
                                await agentGate;
                            }
                            return fauxAssistantMessage(
                                fauxText("The boundary is unchanged. No Plan revision is needed."),
                            );
                        },
                    ]);
                    try {
                        const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
                        const agent = source === "epic" ? "architect" : "planner";
                        if (source !== "tool") {
                            runtime.setInteractionAdapter(sessionId, {
                                requestInteraction: () => ({ outcome: "canceled" }),
                            });
                            await runtime.requestInteraction(sessionId, {
                                type: "plan_review",
                                prompt: "Seed saved review",
                                _meta: {
                                    planId: initial.attrs.planId,
                                    planName: "target",
                                    planningAgentName: agent,
                                },
                            });
                        }
                        runtime.setInteractionAdapter(sessionId, {
                            async requestInteraction(request, signal) {
                                if (request.type !== "plan_review") return { outcome: "canceled" };
                                conversations.push(request._meta?.reviewConversation as PlanReviewConversation);
                                return await requestLocalReviewInteraction(
                                    {
                                        ...request,
                                        _meta: {
                                            ...request._meta,
                                            onSurfaceReady: (surface: { url: string }) => {
                                                reviewUrl = surface.url;
                                                rounds++;
                                            },
                                        },
                                    },
                                    signal,
                                );
                            },
                        });
                        const running =
                            source === "tool"
                                ? runtime.runPlanningAgent(sessionId, {
                                      agentName: agent,
                                      planName: "target",
                                      triageMeta: initial.attrs,
                                      initialRequest: "Submit the saved Plan for review.",
                                  })
                                : runtime.reopenPlanReview(sessionId);
                        void running.catch(() => {});
                        for (let i = 0; i < 300 && rounds < 1; i++)
                            await new Promise((resolve) => setTimeout(resolve, 10));
                        assertEquals(rounds, 1);
                        const firstUrl = reviewUrl;
                        const before = await loadPlan(projectRoot, "target");
                        assert(before);
                        await answer(reviewUrl, {
                            approved: false,
                            conversationTurn: true,
                            feedback: "Why this boundary?",
                        });
                        if (reply === "Escape cancellation") {
                            for (let i = 0; i < 300 && !agentWorking; i++)
                                await new Promise((resolve) => setTimeout(resolve, 10));
                            assert(agentWorking, "The planning provider must be working before cancellation");
                            assertEquals(runtime.cancelSession(sessionId).aborted, true);
                            releaseAgent();
                        }
                        if (reply === "Escape cancellation") {
                            await Promise.race([
                                running,
                                new Promise((_, reject) =>
                                    setTimeout(() => reject(new Error("Canceled review reopened")), 3000),
                                ),
                            ]);
                            assertEquals(rounds, 1, "Escape during the Agent turn must not reopen review");
                            assertEquals(await readFile(before.path, "utf8"), before.markdown);
                            return;
                        }
                        if (reply === "unreviewable Plan") {
                            await rejects(
                                Promise.race([
                                    running,
                                    new Promise((_, reject) =>
                                        setTimeout(() => reject(new Error("Re-arm did not settle")), 3000),
                                    ),
                                ]),
                                /cannot be reviewed|not reviewable|status/i,
                            );
                            assertEquals(rounds, 1);
                            const statusUrl = new URL(firstUrl);
                            statusUrl.pathname = "/api/review/conversation";
                            const response = await fetch(statusUrl);
                            assertEquals(response.status, 200);
                            const status = await response.json();
                            assertStringIncludes(status.error, "review");
                            assertEquals(status.revision, conversations[0].revision);
                            return;
                        }
                        for (let i = 0; i < 500 && rounds < 2; i++)
                            await new Promise((resolve) => setTimeout(resolve, 10));
                        assertEquals(rounds, 2, "An Agent turn without plan_written must leave a live review");
                        assertEquals(reviewUrl, firstUrl);
                        assertEquals(conversations[1], conversations[0]);
                        assertEquals(await readFile(before.path, "utf8"), before.markdown);
                        assertEquals((await loadPlan(projectRoot, "target"))?.attrs, before.attrs);
                        if (reply === "Agent error")
                            assertStringIncludes(
                                conversations[1].events.map((event) => event.delta).join(""),
                                "Agent error:",
                            );
                        else if (reply === "text-only reply")
                            assertStringIncludes(
                                conversations[1].events.map((event) => event.delta).join(""),
                                "No Plan revision",
                            );
                        assert(transcript);
                        assertStringIncludes(JSON.stringify(transcript.messages), "Why this boundary?");
                        assertStringIncludes(JSON.stringify(transcript.messages), "When in doubt, revise.");
                        await answer(reviewUrl, { approved: true, approvalAction: "later" });
                        await running;
                        assertEquals(
                            (await loadPlan(projectRoot, "target"))?.attrs.status,
                            source === "epic" ? "ready_for_decomposition" : "ready_for_work",
                        );
                    } finally {
                        releaseAgent();
                        await runtime.closeAllSessions();
                        store.close();
                    }
                },
            );
        });
    }
}

for (const status of ["approved", "ready_for_work", "ready_for_decomposition"] as const) {
    for (const meaningful of [false, true]) {
        test(`plan_written ${meaningful ? "cancels" : "preserves"} ${status} after a reviewed revision`, async () => {
            await withRuntimeCommandFixture(
                "conversation-revision-",
                async ({ homeDir, projectRoot, setModelMessages }) => {
                    await savePlan(projectRoot, "target", "# Target\n\n## Context\n\nThe delivery boundary.\n", {
                        classification: status === "ready_for_decomposition" ? "PROJECT" : "PLANNED_CHANGE",
                        status,
                        affectedPaths: [],
                        ...(status === "ready_for_decomposition"
                            ? {}
                            : { executionAgent: "engineer", collaborationRecommendation: "autonomous" }),
                    });
                    const initial = await ensurePlanIdentity(projectRoot, "target");
                    const store = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
                    const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "test" });
                    let reviewUrl = "";
                    try {
                        const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
                        const agentName = status === "ready_for_decomposition" ? "architect" : "planner";
                        runtime.setInteractionAdapter(sessionId, {
                            requestInteraction: () => ({ outcome: "canceled" }),
                        });
                        await runtime.requestInteraction(sessionId, {
                            type: "plan_review",
                            prompt: "Review base",
                            _meta: {
                                cwd: projectRoot,
                                planPath: initial.path,
                                planName: "target",
                                planId: initial.attrs.planId,
                                planningAgentName: agentName,
                                triageMeta: initial.attrs,
                            },
                        });
                        const { writeFile } = await import("node:fs/promises");
                        await writeFile(
                            initial.path,
                            initial.markdown.replace(
                                "The delivery boundary.",
                                meaningful ? "A different delivery boundary." : "The delivery\nboundary.",
                            ),
                        );
                        setModelMessages([fauxAssistantMessage(fauxToolCall("plan_written", { planName: "target" }))]);
                        runtime.setInteractionAdapter(sessionId, {
                            async requestInteraction(request, signal) {
                                return await requestLocalReviewInteraction(
                                    {
                                        ...request,
                                        _meta: {
                                            ...request._meta,
                                            onSurfaceReady: (surface: { url: string }) => {
                                                reviewUrl = surface.url;
                                            },
                                        },
                                    },
                                    signal,
                                );
                            },
                        });
                        const running = runtime.runPlanningAgent(sessionId, {
                            agentName,
                            planName: "target",
                            initialRequest: "Present the saved revision.",
                            triageMeta: initial.attrs,
                        });
                        void running.catch(() => {});
                        for (let i = 0; i < 300 && !reviewUrl; i++)
                            await new Promise((resolve) => setTimeout(resolve, 10));
                        assert(reviewUrl);
                        assertEquals(
                            (await loadPlan(projectRoot, "target"))?.attrs.status,
                            meaningful ? "draft" : status,
                        );
                        await answer(reviewUrl, { approved: true, approvalAction: "later" });
                        await running;
                    } finally {
                        await runtime.closeAllSessions();
                        store.close();
                    }
                },
            );
        });
    }
}

test("explicit review cancellation does not run a conversation turn or re-arm", async () => {
    await withRuntimeCommandFixture(
        "conversation-cancel-",
        async ({ homeDir, projectRoot, setModelResponseFactories }) => {
            await savePlan(projectRoot, "target", "# Target\n\nKeep the scope.\n", {
                classification: "PLANNED_CHANGE",
                status: "ready_for_work",
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
                affectedPaths: [],
            });
            let agentTurns = 0;
            setModelResponseFactories([
                () => {
                    agentTurns++;
                    return fauxAssistantMessage(fauxToolCall("plan_written", { planName: "target" }));
                },
                () => {
                    agentTurns++;
                    return fauxAssistantMessage(fauxText("An owner cancellation must not request this reply."));
                },
            ]);
            const store = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
            const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "test" });
            let rounds = 0;
            let reviewUrl = "";
            const otherInteractions: string[] = [];
            try {
                const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
                runtime.setInteractionAdapter(sessionId, {
                    async requestInteraction(request, signal) {
                        if (request.type !== "plan_review") {
                            otherInteractions.push(request.type);
                            return { outcome: "canceled" };
                        }
                        return await requestLocalReviewInteraction(
                            {
                                ...request,
                                _meta: {
                                    ...request._meta,
                                    onSurfaceReady: (surface: { url: string }) => {
                                        reviewUrl = surface.url;
                                        rounds++;
                                    },
                                },
                            },
                            signal,
                        );
                    },
                });
                const running = runtime.runPlanningAgent(sessionId, {
                    agentName: "planner",
                    planName: "target",
                    initialRequest: "Review the Plan.",
                });
                void running.catch(() => {});
                for (let i = 0; i < 300 && !reviewUrl; i++) await new Promise((resolve) => setTimeout(resolve, 10));
                assert(reviewUrl);
                assertEquals(runtime.cancelSession(sessionId).aborted, true);
                const result = await running;
                assertEquals(result.outcome, "canceled");
                assertEquals(agentTurns, 1);
                assertEquals(rounds, 1);
                assertEquals(
                    otherInteractions.every((type) => type === "approval"),
                    true,
                );
                assertEquals(runtime.getSessionSnapshot(sessionId)?.livePlanReview, false);
                assertEquals((await loadPlan(projectRoot, "target"))?.attrs.status, "ready_for_work");
            } finally {
                await runtime.closeAllSessions();
                store.close();
            }
        },
    );
});

test("saved Sequence conversation re-arms every tab without losing child readiness", async () => {
    await withRuntimeCommandFixture("sequence-conversation-", async ({ homeDir, projectRoot, setModelMessages }) => {
        await savePlan(projectRoot, "target", "# Target sequence\n", {
            classification: "PROJECT",
            type: "sequence",
            status: "approved",
        });
        await savePlan(projectRoot, "target/child", "# Child\n\n## Context\n\nKeep this boundary.\n", {
            classification: "PLANNED_CHANGE",
            parentPlan: "target",
            order: 1,
            status: "ready_for_work",
            affectedPaths: [],
            executionAgent: "engineer",
            collaborationRecommendation: "autonomous",
        });
        const initial = await ensurePlanIdentity(projectRoot, "target");
        setModelMessages([fauxAssistantMessage(fauxText("The Sequence and child boundaries are unchanged."))]);
        const store = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
        const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "test" });
        let rounds = 0;
        let reviewUrl = "";
        let documents: Array<{ planId: string; plan: string }> = [];
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            runtime.setInteractionAdapter(sessionId, { requestInteraction: () => ({ outcome: "canceled" }) });
            await runtime.requestInteraction(sessionId, {
                type: "plan_review",
                prompt: "Saved Sequence",
                _meta: {
                    planName: "target",
                    planId: initial.attrs.planId,
                    planningAgentName: "architect",
                },
            });
            runtime.setInteractionAdapter(sessionId, {
                async requestInteraction(request, signal) {
                    documents = request._meta?.sequenceDocuments as typeof documents;
                    return await requestLocalReviewInteraction(
                        {
                            ...request,
                            _meta: {
                                ...request._meta,
                                onSurfaceReady: (surface: { url: string }) => {
                                    reviewUrl = surface.url;
                                    rounds++;
                                },
                            },
                        },
                        signal,
                    );
                },
            });
            const running = runtime.reopenPlanReview(sessionId);
            void running.catch(() => {});
            for (let i = 0; i < 300 && rounds < 1; i++) await new Promise((resolve) => setTimeout(resolve, 10));
            assertEquals(rounds, 1);
            const firstUrl = reviewUrl;
            const before = await Promise.all(["target", "target/child"].map((name) => loadPlan(projectRoot, name)));
            await answer(reviewUrl, {
                approved: false,
                conversationTurn: true,
                feedback: "Why these boundaries?",
                documents,
            });
            for (let i = 0; i < 500 && rounds < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
            assertEquals(rounds, 2);
            assertEquals(reviewUrl, firstUrl);
            assertEquals(documents.length, 2);
            for (const plan of before) {
                assert(plan);
                assertEquals(await readFile(plan.path, "utf8"), plan.markdown);
                assertEquals(
                    (await loadPlan(projectRoot, plan === before[0] ? "target" : "target/child"))?.attrs.status,
                    plan.attrs.status,
                );
            }
            await answer(reviewUrl, { approved: true, approvalAction: "later", documents });
            await running;
            assertEquals((await loadPlan(projectRoot, "target/child"))?.attrs.status, "ready_for_work");
            assertEquals((await loadPlan(projectRoot, "target"))?.attrs.status, "ready_for_work");
        } finally {
            await runtime.closeAllSessions();
            store.close();
        }
    });
});

test("Approve and Run after a reply-only tool turn starts execution through the re-armed review", async () => {
    await withRuntimeCommandFixture("conversation-run-", async ({ homeDir, projectRoot, setModelMessages }) => {
        await savePlan(projectRoot, "target", "# Target\n\n## Context\n\nImplement the saved scope.\n", {
            classification: "PLANNED_CHANGE",
            status: "draft",
            affectedPaths: [],
            executionAgent: "engineer",
            collaborationRecommendation: "autonomous",
        });
        setModelMessages([
            fauxAssistantMessage(fauxToolCall("plan_written", { planName: "target" })),
            fauxAssistantMessage(fauxText("The scope remains unchanged.")),
            fauxAssistantMessage(fauxToolCall("task_completed", { message: "Implementation complete." })),
        ]);
        const store = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
        const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "test" });
        let url = "";
        let rounds = 0;
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            runtime.setInteractionAdapter(sessionId, {
                async requestInteraction(request, signal) {
                    if (request.type === "select") return { outcome: "selected", value: "proceed" };
                    if (request.type !== "plan_review") return { outcome: "canceled" };
                    return await requestLocalReviewInteraction(
                        {
                            ...request,
                            _meta: {
                                ...request._meta,
                                onSurfaceReady: (surface: { url: string }) => {
                                    url = surface.url;
                                    rounds++;
                                },
                            },
                        },
                        signal,
                    );
                },
            });
            const running = runtime.runPlanningAgent(sessionId, {
                agentName: "planner",
                planName: "target",
                initialRequest: "Review the Plan.",
            });
            void running.catch(() => {});
            for (let i = 0; i < 300 && rounds < 1; i++) await new Promise((resolve) => setTimeout(resolve, 10));
            assertEquals(rounds, 1);
            await answer(url, { approved: false, conversationTurn: true, feedback: "Explain the scope." });
            for (let i = 0; i < 500 && rounds < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
            assertEquals(rounds, 2);
            await answer(url, {
                approved: true,
                approvalAction: "run",
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            });
            const outcome = await Promise.race([
                running,
                new Promise<never>((_, reject) => {
                    const timer = setTimeout(
                        () => reject(new Error("Re-armed approval did not hand off execution.")),
                        10000,
                    );
                    void running.finally(() => clearTimeout(timer)).catch(() => {});
                }),
            ]);
            assertEquals(outcome.outcome, "approved_execute");
            assertEquals((await loadPlan(projectRoot, "target"))?.attrs.status, "ready_for_work");
            const { loadPlanActionEvidence } = await import("../../shared/workflow/plan-actions.ts");
            const approved = await loadPlan(projectRoot, "target");
            assert(approved?.attrs.planId);
            const evidence = await loadPlanActionEvidence(projectRoot, approved.attrs.planId);
            assertEquals(evidence.kind, "success");
            if (evidence.kind !== "success") throw new Error(evidence.message);
            await runtime.executePlan(sessionId, {
                planName: "target",
                triageMeta: outcome.triageMeta,
                approvalEvidence: evidence.evidence,
            });
            const saved = await loadPlan(projectRoot, "target");
            assert(saved);
            assertEquals(saved.attrs.executionMode, "non_git_in_place");
            assert(["in_progress", "implemented", "failed", "ready_for_work"].includes(saved.attrs.status));
            assertEquals(saved.attrs.status !== "draft", true);
        } finally {
            await runtime.closeAllSessions();
            store.close();
        }
    });
});

test("direct conversation revision defers Approve and Run until the review writer releases", async () => {
    await withRuntimeCommandFixture(
        "direct-conversation-run-",
        async ({ homeDir, projectRoot, setModelResponseFactories }) => {
            await savePlan(projectRoot, "target", "# Target\n\n## Context\n\nOriginal scope.\n", {
                classification: "PLANNED_CHANGE",
                status: "ready_for_work",
                affectedPaths: [],
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            });
            const initial = await ensurePlanIdentity(projectRoot, "target");
            setModelResponseFactories([
                async () => {
                    const { writeFile } = await import("node:fs/promises");
                    const current = await loadPlan(projectRoot, "target");
                    assert(current);
                    await writeFile(current.path, current.markdown.replace("Original scope.", "The revised scope."));
                    return fauxAssistantMessage(fauxToolCall("plan_written", { planName: "target" }));
                },
                () => fauxAssistantMessage(fauxToolCall("task_completed", { message: "Implementation complete." })),
            ]);
            const store = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
            const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "test" });
            let url = "";
            let rounds = 0;
            try {
                const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
                runtime.setInteractionAdapter(sessionId, { requestInteraction: () => ({ outcome: "canceled" }) });
                await runtime.requestInteraction(sessionId, {
                    type: "plan_review",
                    prompt: "Saved review",
                    _meta: {
                        planName: "target",
                        planId: initial.attrs.planId,
                        planningAgentName: "planner",
                    },
                });
                runtime.setInteractionAdapter(sessionId, {
                    async requestInteraction(request, signal) {
                        if (request.type === "select") return { outcome: "selected", value: "proceed" };
                        if (request.type !== "plan_review") return { outcome: "canceled" };
                        return await requestLocalReviewInteraction(
                            {
                                ...request,
                                _meta: {
                                    ...request._meta,
                                    onSurfaceReady: (surface: { url: string }) => {
                                        url = surface.url;
                                        rounds++;
                                    },
                                },
                            },
                            signal,
                        );
                    },
                });
                const running = runtime.reopenPlanReview(sessionId);
                void running.catch(() => {});
                for (let i = 0; i < 300 && rounds < 1; i++) await new Promise((resolve) => setTimeout(resolve, 10));
                assertEquals(rounds, 1);
                await answer(url, { approved: false, conversationTurn: true, feedback: "Change the scope." });
                for (let i = 0; i < 500 && rounds < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
                assertEquals(rounds, 2);
                assertEquals((await loadPlan(projectRoot, "target"))?.attrs.status, "draft");
                await answer(url, {
                    approved: true,
                    approvalAction: "run",
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                });
                const result = await running;
                assertEquals(result.kind, "complete");
                assertEquals((await loadPlan(projectRoot, "target"))?.attrs.executionMode, "non_git_in_place");
            } finally {
                await runtime.closeAllSessions();
                store.close();
            }
        },
    );
});

test("a ready Sequence child revision presents one draft snapshot and accepts chat and approval", async () => {
    await withRuntimeCommandFixture(
        "sequence-revision-conversation-",
        async ({ homeDir, projectRoot, setModelResponseFactories }) => {
            await savePlan(projectRoot, "target", "# Target sequence\n", {
                classification: "PROJECT",
                type: "sequence",
                status: "approved",
            });
            await savePlan(projectRoot, "target/child", "# Child\n\n## Context\n\nOriginal boundary.\n", {
                classification: "PLANNED_CHANGE",
                parentPlan: "target",
                order: 1,
                status: "ready_for_work",
                affectedPaths: [],
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            });
            const initial = await ensurePlanIdentity(projectRoot, "target");
            setModelResponseFactories([
                async () => {
                    const child = await loadPlan(projectRoot, "target/child");
                    assert(child);
                    await writeFile(
                        child.path,
                        child.markdown.replace("Original boundary.", "The revised delivery boundary."),
                    );
                    return fauxAssistantMessage(fauxToolCall("plan_written", { planName: "target" }));
                },
                () => fauxAssistantMessage(fauxText("The revised boundary covers the requested scope.")),
            ]);
            const store = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
            const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "test" });
            let rounds = 0;
            let reviewUrl = "";
            let documents: SequenceReviewDocument[] = [];
            try {
                const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
                runtime.setInteractionAdapter(sessionId, { requestInteraction: () => ({ outcome: "canceled" }) });
                await runtime.requestInteraction(sessionId, {
                    type: "plan_review",
                    prompt: "Saved Sequence",
                    _meta: { planName: "target", planId: initial.attrs.planId, planningAgentName: "architect" },
                });
                runtime.setInteractionAdapter(sessionId, {
                    async requestInteraction(request, signal) {
                        assertEquals(request.type, "plan_review");
                        documents = request._meta?.sequenceDocuments as SequenceReviewDocument[];
                        return await requestLocalReviewInteraction(
                            {
                                ...request,
                                _meta: {
                                    ...request._meta,
                                    onSurfaceReady: (surface: { url: string }) => {
                                        reviewUrl = surface.url;
                                        rounds++;
                                    },
                                },
                            },
                            signal,
                        );
                    },
                });
                const running = runtime.reopenPlanReview(sessionId);
                void running.catch(() => {});
                for (let i = 0; i < 300 && rounds < 1; i++) await new Promise((resolve) => setTimeout(resolve, 10));
                assertEquals(rounds, 1);
                await answer(reviewUrl, {
                    approved: false,
                    conversationTurn: true,
                    feedback: "Revise the child's delivery boundary.",
                    documents,
                });
                for (let i = 0; i < 500 && rounds < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
                assertEquals(rounds, 2);
                const child = documents.find((document) => document.planName === "target/child");
                assert(child);
                const saved = await loadPlan(projectRoot, "target/child");
                assert(saved);
                assertEquals(child.frontmatter.status, "draft");
                assertEquals(parsePlanFrontMatter(child.plan).attrs.status, "draft");
                assertEquals(child.plan, planDocumentMarkdown(saved.markdown));
                assertEquals(child.revision, saved.revision);
                assertStringIncludes(child.plan, "The revised delivery boundary.");
                assertEquals(child.planVersions?.at(-1)?.plan, child.plan);
                await answer(reviewUrl, {
                    approved: false,
                    conversationTurn: true,
                    feedback: "Does this cover the requested scope?",
                    documents,
                });
                for (let i = 0; i < 500 && rounds < 3; i++) await new Promise((resolve) => setTimeout(resolve, 10));
                assertEquals(rounds, 3);
                await answer(reviewUrl, { approved: true, approvalAction: "later", documents });
                await running;
                for (const name of ["target", "target/child"]) {
                    assertEquals((await loadPlan(projectRoot, name))?.attrs.status, "ready_for_work");
                }
            } finally {
                await runtime.closeAllSessions();
                store.close();
            }
        },
    );
});
