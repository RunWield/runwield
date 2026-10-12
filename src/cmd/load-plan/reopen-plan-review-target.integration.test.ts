import { readFile as fsReadFile, rm as fsRm } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { defineCommittedGitFixture } from "../../shared/git-test-fixture.ts";
import { archivePlan, ensurePlanIdentity, loadPlan, savePlan } from "../../plan-store.js";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { RuntimeInteractionTypes } from "../../shared/session/session-runtime-interactions.js";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";

const gitFixture = defineCommittedGitFixture();

async function createReviewPlan(root: string, name: string, content = `# ${name}\n\n## Context\n\nOriginal.\n`) {
    await savePlan(root, name, content, {
        classification: "PLANNED_CHANGE",
        status: "draft",
        affectedPaths: [],
        executionAgent: "engineer",
        collaborationRecommendation: "autonomous",
    });
    const plan = await ensurePlanIdentity(root, name);
    assert(plan.attrs.planId);
    return plan;
}

test("the Session reopens B with its latest contents after reviews of A and B and a newer unrelated C", async () => {
    await withRuntimeCommandFixture("reopen-last-target-", async ({ homeDir, setModelResponseFactory }) => {
        const root = await gitFixture.checkout();
        const store = openOwnerCoordinationStore({ dbPath: join(homeDir, "owner.sqlite3") });
        let runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "test" });
        try {
            const a = await createReviewPlan(root, "a");
            const b = await createReviewPlan(root, "b");
            const { sessionId } = await runtime.createInteractiveSession({ cwd: root, mode: "new" });
            runtime.setInteractionAdapter(sessionId, { requestInteraction: () => ({ outcome: "canceled" }) });
            for (const [name, id] of [["a", a.attrs.planId], ["b", b.attrs.planId]]) {
                await runtime.requestInteraction(sessionId, {
                    type: RuntimeInteractionTypes.PLAN_REVIEW,
                    prompt: `Review ${name}`,
                    _meta: { planName: name, planId: id, planningAgentName: "architect" },
                });
            }
            const stableSessionId = runtime.getSessionSnapshot(sessionId)?.managed?.runwieldSessionId;
            assert(stableSessionId);
            await runtime.closeAllSessionsWhenIdle();
            runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "test" });
            const resumed = await runtime.createInteractiveSession({
                cwd: root,
                mode: "continue",
                resumeSessionId: stableSessionId,
            });
            assertEquals(runtime.getSessionSnapshot(resumed.sessionId)?.managed?.runwieldSessionId, stableSessionId);
            const before = await loadPlan(root, "b");
            assert(before);
            await savePlan(root, "b", "# B\n\n## Context\n\nThe revised B, not A or C.\n", before.attrs, {
                expectedRevision: before.revision,
            });
            await createReviewPlan(root, "c", "# C\n\n## Context\n\nNewest unrelated Plan.\n");
            let modelTurns = 0;
            setModelResponseFactory(() => {
                modelTurns++;
                return fauxAssistantMessage(fauxText("Unexpected model turn"));
            });
            let reviewCount = 0;
            runtime.setInteractionAdapter(resumed.sessionId, {
                async requestInteraction(request) {
                    if (request.type !== RuntimeInteractionTypes.PLAN_REVIEW) return { outcome: "canceled" };
                    reviewCount++;
                    assertEquals(request._meta?.planName, "b");
                    assertEquals(request._meta?.planningAgentName, "architect");
                    assertEquals(request._meta?.planId, b.attrs.planId);
                    assertStringIncludes(
                        await fsReadFile(String(request._meta?.planPath), "utf8"),
                        "The revised B, not A or C.",
                    );
                    return { outcome: "canceled" };
                },
            });
            const result = await runtime.reopenPlanReview(resumed.sessionId);
            assertEquals(result.kind, "unanswered", result.message);
            assertEquals(reviewCount, 1);
            assertEquals(modelTurns, 0);
            assertEquals((await loadPlan(root, "b"))?.attrs.status, "draft");

            const other = await runtime.createInteractiveSession({ cwd: root, mode: "new" });
            assertEquals((await runtime.reopenPlanReview(other.sessionId)).kind, "no_reference");
            assertEquals(reviewCount, 1);
        } finally {
            await runtime.closeAllSessionsWhenIdle();
            store.close();
            await fsRm(root, { recursive: true });
        }
    });
});

test("a deleted reviewed Plan is not replaced by another Plan", async () => {
    await withRuntimeCommandFixture("reopen-deleted-", async ({ homeDir, setModelResponseFactory }) => {
        const root = await gitFixture.checkout();
        const store = openOwnerCoordinationStore({ dbPath: join(homeDir, "owner.sqlite3") });
        const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "test" });
        try {
            const target = await createReviewPlan(root, "target");
            const { sessionId } = await runtime.createInteractiveSession({ cwd: root, mode: "new" });
            runtime.setInteractionAdapter(sessionId, { requestInteraction: () => ({ outcome: "canceled" }) });
            await runtime.requestInteraction(sessionId, {
                type: RuntimeInteractionTypes.PLAN_REVIEW,
                prompt: "Review target",
                _meta: { planId: target.attrs.planId, planName: "target", planningAgentName: "planner" },
            });
            await fsRm(target.path);
            await createReviewPlan(root, "other");
            let turns = 0;
            setModelResponseFactory(() => {
                turns++;
                return fauxAssistantMessage(fauxText("Unexpected turn"));
            });
            assertEquals((await runtime.reopenPlanReview(sessionId)).kind, "missing_plan");
            assertEquals(turns, 0);
        } finally {
            await runtime.closeAllSessionsWhenIdle();
            store.close();
            await fsRm(root, { recursive: true });
        }
    });
});

test("a reused Plan name with a different identity is not reopened", async () => {
    await withRuntimeCommandFixture("reopen-reused-name-", async ({ homeDir }) => {
        const root = await gitFixture.checkout();
        const store = openOwnerCoordinationStore({ dbPath: join(homeDir, "owner.sqlite3") });
        const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "test" });
        try {
            const target = await createReviewPlan(root, "target");
            const { sessionId } = await runtime.createInteractiveSession({ cwd: root, mode: "new" });
            runtime.setInteractionAdapter(sessionId, { requestInteraction: () => ({ outcome: "canceled" }) });
            await runtime.requestInteraction(sessionId, {
                type: RuntimeInteractionTypes.PLAN_REVIEW,
                prompt: "Review target",
                _meta: { planId: target.attrs.planId, planName: "target", planningAgentName: "planner" },
            });
            await fsRm(target.path);
            const replacement = await createReviewPlan(
                root,
                "target",
                "# Replacement\n\n## Context\n\nDifferent Plan.\n",
            );
            assert(replacement.attrs.planId !== target.attrs.planId);
            assertEquals((await runtime.reopenPlanReview(sessionId)).kind, "identity_mismatch");
            assertEquals((await loadPlan(root, "target"))?.attrs.status, "draft");
        } finally {
            await runtime.closeAllSessionsWhenIdle();
            store.close();
            await fsRm(root, { recursive: true });
        }
    });
});

for (const status of ["archived", "verified"] as const) {
    test(`a reviewed Plan in ${status} status cannot reopen or reset its lifecycle`, async () => {
        await withRuntimeCommandFixture(`reopen-${status}-`, async ({ homeDir, setModelResponseFactory }) => {
            const root = await gitFixture.checkout();
            const store = openOwnerCoordinationStore({ dbPath: join(homeDir, "owner.sqlite3") });
            const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "test" });
            try {
                const target = await createReviewPlan(root, "target");
                const { sessionId } = await runtime.createInteractiveSession({ cwd: root, mode: "new" });
                runtime.setInteractionAdapter(sessionId, { requestInteraction: () => ({ outcome: "canceled" }) });
                await runtime.requestInteraction(sessionId, {
                    type: RuntimeInteractionTypes.PLAN_REVIEW,
                    prompt: "Review target",
                    _meta: { planId: target.attrs.planId, planName: "target", planningAgentName: "planner" },
                });
                const before = await loadPlan(root, "target");
                assert(before);
                if (status === "archived") {
                    await archivePlan(root, "target", { force: true });
                } else {
                    await savePlan(root, "target", "# target\n\n## Context\n\nOriginal.\n", {
                        ...before.attrs,
                        status,
                    }, { expectedRevision: before.revision });
                }
                let turns = 0;
                setModelResponseFactory(() => {
                    turns++;
                    return fauxAssistantMessage(fauxText("Unexpected turn"));
                });
                assertEquals(
                    (await runtime.reopenPlanReview(sessionId)).kind,
                    status === "archived" ? "missing_plan" : "not_reviewable",
                );
                assertEquals(
                    (await loadPlan(root, status === "archived" ? "archived/target" : "target"))?.attrs.status,
                    status === "archived" ? "draft" : status,
                );
                assertEquals(turns, 0);
            } finally {
                await runtime.closeAllSessionsWhenIdle();
                store.close();
                await fsRm(root, { recursive: true });
            }
        });
    });
}

test("an unrelated active turn reports busy rather than launching the saved review", async () => {
    await withRuntimeCommandFixture("reopen-other-turn-", async ({ homeDir, setModelResponseFactory }) => {
        const root = await gitFixture.checkout();
        const store = openOwnerCoordinationStore({ dbPath: join(homeDir, "owner.sqlite3") });
        const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "test" });
        try {
            const target = await createReviewPlan(root, "target");
            const { sessionId } = await runtime.createInteractiveSession({ cwd: root, mode: "new" });
            runtime.setInteractionAdapter(sessionId, { requestInteraction: () => ({ outcome: "canceled" }) });
            await runtime.requestInteraction(sessionId, {
                type: RuntimeInteractionTypes.PLAN_REVIEW,
                prompt: "Review target",
                _meta: { planId: target.attrs.planId, planName: "target", planningAgentName: "planner" },
            });
            let releaseTurn: (() => void) | undefined;
            let modelStarted: (() => void) | undefined;
            const started = new Promise<void>((resolve) => {
                modelStarted = resolve;
            });
            setModelResponseFactory(async () => {
                modelStarted?.();
                await new Promise<void>((resolve) => {
                    releaseTurn = resolve;
                });
                return fauxAssistantMessage(fauxText("Unrelated work finished."));
            });
            const pending = runtime.promptUserTurn(sessionId, { initialRequest: "Explain this project." });
            try {
                await Promise.race([
                    started,
                    new Promise<never>((_, reject) =>
                        setTimeout(() => reject(new Error("Agent turn did not start")), 5_000)
                    ),
                ]);
                const result = await runtime.reopenPlanReview(sessionId);
                assertEquals(result.kind, "busy", result.message);
                assertStringIncludes(result.message, "busy");
            } finally {
                releaseTurn?.();
                await pending;
            }
            assertEquals((await loadPlan(root, "target"))?.attrs.status, "draft");
        } finally {
            await runtime.closeAllSessionsWhenIdle();
            store.close();
            await fsRm(root, { recursive: true });
        }
    });
});
