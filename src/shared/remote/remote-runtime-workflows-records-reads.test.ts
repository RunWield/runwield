import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { assertEquals } from "../../testing/assertions.ts";
import { loadPlanActionEvidence } from "../workflow/plan-actions.ts";
import {
    buildExecutionSegmentContinuation,
    resolvePendingSegmentHandoff,
} from "../workflow/execution-segment-handoff.ts";
import type { ActiveExecutionWorkflow } from "../types.js";
import { savePlan } from "../../plan-store.js";
import { getRemoteSessionOwner } from "../session/file-session-store.ts";
import {
    readPersistedPendingSegmentContinuationEntry,
    recordPendingSegmentContinuation,
    recordNormalizedWorkflowContext,
} from "../session/workflow-context-session.js";
import { recordTutorialContext } from "../session/tutorial-context-session.ts";
import { appendExecutionWorkflowSnapshot } from "../session/execution-workflow-session.ts";
import { parseRemoteSessionTranscript } from "./session-protocol.ts";
import {
    assertRemoteStorageAbsent,
    withRemoteRuntimeFixture,
    type RuntimeFixture,
} from "./remote-runtime-test-fixture.ts";

/** Trusted laptop producer. These records never pass through the remote process or its save Worker. */
async function seedLaptopRecords(
    f: RuntimeFixture,
    id: string,
    purpose: "planning" | "execution" = "planning",
    tutorialPlanId: string | null = "laptop-only-plan",
) {
    const operation = await f.control.begin(id);
    const owner = getRemoteSessionOwner(operation);
    let sequence = 0;
    const hydrated = owner.handle({ operation, sequence: sequence++, kind: "hydrate", contents: "" });
    const manager = SessionManager.inMemory(
        f.remoteProject,
        undefined,
        parseRemoteSessionTranscript(hydrated.contents),
    );
    const segment = f.store.getCurrentSessionSegment(id)!;
    // Deliberately use a different property order from normalizePlanAssociation.
    const association = {
        purpose,
        planName: "laptop-only",
        recordedAt: "2026-01-01T00:00:00.000Z",
        segmentKind: segment.kind,
        segmentId: segment.segmentId,
        planId: "laptop-only-plan",
    };
    const previous = manager.getEntries().length;
    manager.appendCustomEntry("runwield.plan_association", association);
    recordNormalizedWorkflowContext(manager, {
        planId: "laptop-only-plan",
        planName: "laptop-only",
        status: "implemented",
    });
    recordTutorialContext(manager, {
        version: 1,
        guidanceEnabled: true,
        shownExplanationIds: ["laptop-saved"],
        recapShown: true,
        planId: tutorialPlanId,
    });
    if (purpose === "execution") {
        const activeWorkflow: ActiveExecutionWorkflow = {
            planName: "laptop-only",
            executionAgent: "engineer",
            executionStarted: true,
            projectRoot: f.remoteProject,
            executionCwd: f.remoteProject,
            executionMode: "non_git_in_place",
            triageMeta: {
                planId: "laptop-only-plan",
                status: "implemented",
                classification: "QUICK_FIX",
                complexity: "LOW",
            },
        };
        await savePlan(f.remoteProject, "laptop-only", "# Prepared remote execution\n", {
            ...activeWorkflow.triageMeta,
        });
        const prepared = await loadPlanActionEvidence(f.remoteProject, "laptop-only-plan");
        assert(prepared.kind === "success");
        appendExecutionWorkflowSnapshot(manager, activeWorkflow);
        recordPendingSegmentContinuation(
            manager,
            buildExecutionSegmentContinuation({
                runwieldSessionId: id,
                planId: "laptop-only-plan",
                planName: "laptop-only",
                approvedRevision: prepared.evidence.revision,
                approvedStatus: prepared.evidence.status,
                approvedMarkdown: "# Prepared remote execution\n",
                preparedEvidence: prepared.evidence,
                activeWorkflow,
                executionOwner: "plan-engineer",
                collaborationStyle: "autonomous",
                collaborationRecommendation: "autonomous",
            }),
        );
    }
    for (const entry of manager.getEntries().slice(previous)) {
        owner.handle({ operation, sequence: sequence++, kind: "append", contents: JSON.stringify(entry) + "\n" });
    }
    owner.handle({ operation, sequence: sequence++, kind: "plan-association", contents: JSON.stringify(association) });
    owner.handle({
        operation,
        sequence: sequence++,
        kind: "plan-review",
        contents: JSON.stringify({
            planId: "laptop-only-plan",
            planName: "laptop-only",
            planningAgentName: "remote-runtime",
        }),
    });
    await f.control.checkpoint(operation);
}

test("remote reads find laptop-seeded review and associations and enforce committed tutorial identity", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        await savePlan(f.remoteProject, "laptop-only", "# Laptop-only Plan\n", {
            planId: "laptop-only-plan",
            classification: "QUICK_FIX",
            status: "draft",
        });
        f.setModelResponseFactory(() => fauxAssistantMessage(fauxText("Saved conversation.")));
        const client = await f.start();
        await client.read();
        await client.send({ kind: "turn", text: "Create laptop-owned history." });
        const ready = await client.read();
        assert(ready.savedId);
        await seedLaptopRecords(f, ready.savedId);
        await client.send({ kind: "load", sessionId: ready.savedId });
        const loaded = await client.read();
        assertEquals(loaded.ok, true, loaded.error);
        assertEquals(loaded.canReopen, true);
        assertEquals(loaded.tutorialContext?.shownExplanationIds, ["laptop-saved"]);
        await client.send({ kind: "plan-sessions", planId: "laptop-only-plan" });
        const found = await client.read();
        assertEquals(found.candidates?.length, 1);
        const candidate = found.candidates![0];
        assertEquals(candidate.runwieldSessionId, ready.savedId);
        assertEquals(candidate.safePlanningResume, true);
        assertEquals(candidate.transcriptPath, "");
        await client.send({ kind: "tutorial", tutorial: { planId: "unassociated-plan" } });
        const refused = await client.read();
        assertEquals(refused.ok, false);
        assertEquals(refused.error, "tutorial_context_plan_association_required");
        await client.send({
            kind: "tutorial",
            tutorial: { planId: "laptop-only-plan", shownExplanationIds: ["laptop-saved", "remote-read"] },
        });
        assertEquals((await client.read()).ok, true);
        assertEquals(
            f.saves.some((request) => request.kind === "plan-association" || request.kind === "plan-review"),
            false,
            "The remote client did not create the facts it read",
        );
        await client.send({ kind: "reopen-review" });
        const review = await client.read();
        assertEquals(review.reviewCount, 1);
        assertEquals(review.reviewKind, "unanswered");
        assertEquals(f.modelRequests.length, 1, "Read and review operations do not run a model");
        await client.close();
        await assertRemoteStorageAbsent(f);
    });
});

test("project-scoped lookup preserves non-planning reasons and verifies current laptop evidence, not the caller's path", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        f.setModelResponseFactory(() => fauxAssistantMessage(fauxText("Saved.")));
        const client = await f.start();
        await client.read();
        await client.send({ kind: "turn", text: "Create laptop-owned history." });
        const first = await client.read();
        assert(first.savedId);
        await seedLaptopRecords(f, first.savedId, "execution");
        await client.send({ kind: "plan-sessions", planId: "laptop-only-plan" });
        const found = await client.read();
        const candidate = found.candidates![0];
        assertEquals(candidate.safePlanningResume, false);
        assertEquals(candidate.reason, "non_planning_purpose");
        await client.send({
            kind: "verify-plan-session",
            candidate: { ...candidate, transcriptPath: "/not-a-laptop-path" },
        });
        assertEquals((await client.read()).ok, true);
        const segment = f.store.getCurrentSessionSegment(first.savedId)!;
        // Corrupt a sealed predecessor: verification must include all committed segments.
        await client.send({ kind: "load", sessionId: first.savedId });
        assertEquals((await client.read()).ok, true);
        await client.send({ kind: "rollover", segmentKind: "execution" });
        assertEquals((await client.read()).ok, true);
        await client.send({ kind: "tutorial", tutorial: { shownExplanationIds: ["release-pending-owner"] } });
        assertEquals((await client.read()).ok, true);
        await client.send({ kind: "plan-sessions", planId: "laptop-only-plan" });
        const rolled = (await client.read()).candidates![0];
        assertEquals(rolled.reason, "execution_segment");
        await appendFile(segment.transcriptPath, "damaged sealed evidence\n");
        await client.send({ kind: "verify-plan-session", candidate: rolled });
        const damaged = await client.read();
        assertEquals(damaged.ok, false);
        await client.send({
            kind: "verify-plan-session",
            candidate: { ...rolled, runwieldSessionId: crypto.randomUUID() },
        });
        assertEquals((await client.read()).ok, false);
        await client.close();
        await assertRemoteStorageAbsent(f);
    });
});

test("remote reconnect restores laptop execution and tutorial context without replay or workflow effects", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        f.setModelResponseFactory(() => fauxAssistantMessage(fauxText("Saved before interruption.")));
        const client = await f.start();
        await client.read();
        await client.send({ kind: "turn", text: "Create laptop-owned history." });
        const ready = await client.read();
        assert(ready.savedId);
        await seedLaptopRecords(f, ready.savedId, "execution");
        const before = (await f.control.list(ready.savedId))[0].contents!;
        const savedManager = SessionManager.inMemory(f.remoteProject, undefined, parseRemoteSessionTranscript(before));
        const marker = readPersistedPendingSegmentContinuationEntry(savedManager);
        assert(marker);
        assertEquals(
            (
                await resolvePendingSegmentHandoff({
                    marker,
                    projectRoot: f.remoteProject,
                    runwieldSessionId: ready.savedId,
                })
            ).kind,
            "pending",
        );
        await client.close();
        const resumed = await f.start();
        await resumed.read();
        await resumed.send({ kind: "load", sessionId: ready.savedId });
        const loaded = await resumed.read();
        assertEquals(loaded.ok, true, loaded.error);
        assertEquals(loaded.activeWorkflow?.planName, "laptop-only");
        assertEquals(loaded.activeWorkflow?.executionMode, "non_git_in_place");
        assertEquals(loaded.workflowContext?.status, "implemented");
        assertEquals(loaded.tutorialContext?.shownExplanationIds, ["laptop-saved"]);
        assertEquals(
            (await f.control.list(ready.savedId))[0].contents,
            before,
            "Reconnect must not rewrite saved continuation evidence",
        );
        assertEquals(f.modelRequests.length, 1);
        await resumed.close();
        await assertRemoteStorageAbsent(f);
    });
});

test("remote reconnect reconciles confirmed legacy completion from remote Plan evidence without rewriting it", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        f.setModelResponseFactory(() => fauxAssistantMessage(fauxText("Saved history.")));
        const client = await f.start();
        await client.read();
        await client.send({ kind: "turn", text: "Retain legacy completion evidence." });
        const ready = await client.read();
        assert(ready.savedId);
        await seedLaptopRecords(f, ready.savedId);
        await savePlan(f.remoteProject, "laptop-only", "# Confirmed remote delivery\n", {
            planId: "laptop-only-plan",
            classification: "QUICK_FIX",
            status: "verified",
        });
        const before = (await f.control.list(ready.savedId))[0].contents;
        await client.close();
        const resumed = await f.start();
        await resumed.read();
        await resumed.send({ kind: "load", sessionId: ready.savedId });
        const loaded = await resumed.read();
        assertEquals(loaded.ok, true, loaded.error);
        assertEquals(loaded.workflowContext?.status, "verified");
        assertEquals((await f.control.list(ready.savedId))[0].contents, before);
        assertEquals(f.modelRequests.length, 1);
        await resumed.close();
        await assertRemoteStorageAbsent(f);
    });
});

test("remote turn hydration checks initial tutorial identity against committed laptop associations", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        f.setModelResponseFactory(() => fauxAssistantMessage(fauxText("Saved context.")));
        const client = await f.start();
        await client.read();
        await client.send({ kind: "turn", text: "Create saved history." });
        const first = await client.read();
        assert(first.savedId);
        await seedLaptopRecords(f, first.savedId, "planning", null);
        await client.send({
            kind: "turn-tutorial",
            initialTutorial: {
                version: 1,
                guidanceEnabled: true,
                recapShown: false,
                shownExplanationIds: ["hydrated"],
                planId: "laptop-only-plan",
            },
        });
        const applied = await client.read();
        assertEquals(applied.ok, true, applied.error);
        assertEquals(applied.tutorialContext?.planId, "laptop-only-plan");
        assertEquals(applied.tutorialContext?.shownExplanationIds, ["hydrated"]);
        await client.close();
        await assertRemoteStorageAbsent(f);
    });
});

test("remote project lookup reports another Session's active and uncertain owner without taking it over", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        f.setModelResponseFactory(() => fauxAssistantMessage(fauxText("Saved history.")));
        const first = await f.start();
        await first.read();
        await first.send({ kind: "turn", text: "Create the associated Session." });
        const saved = await first.read();
        assert(saved.savedId);
        await seedLaptopRecords(f, saved.savedId);
        await first.close();
        const second = await f.start();
        await second.read();
        await second.send({ kind: "turn", text: "Create the querying Session." });
        assertEquals((await second.read()).ok, true);
        const operation = await f.control.begin(saved.savedId);
        const owner = getRemoteSessionOwner(operation);
        owner.handle({ operation, sequence: 0, kind: "hydrate", contents: "" });
        try {
            await second.send({ kind: "plan-sessions", planId: "laptop-only-plan" });
            const active = (await second.read()).candidates![0];
            assertEquals(active.runwieldSessionId, saved.savedId);
            assertEquals(active.reason, "active_elsewhere");
            assertEquals(active.safePlanningResume, false);
            assertEquals(f.store.inspectSessionActivation(saved.savedId).activation?.state, "active");
        } finally {
            await f.control.markUncertain(operation);
        }
        await second.send({ kind: "plan-sessions", planId: "laptop-only-plan" });
        const uncertain = (await second.read()).candidates![0];
        assertEquals(uncertain.reason, "uncertain");
        assertEquals(uncertain.safePlanningResume, false);
        assertEquals(f.store.inspectSessionActivation(saved.savedId).activation?.state, "uncertain");
        await second.close();
        await assertRemoteStorageAbsent(f);
    });
});

test("normal record reads omit project history; Plan Session lookup requests its own bounded projection on the save channel", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        f.setModelResponseFactory(() => fauxAssistantMessage(fauxText("A small normal turn.")));
        const client = await f.start();
        await client.read();
        await client.send({ kind: "turn", text: "Create committed history." });
        const first = await client.read();
        assert(first.savedId);
        await seedLaptopRecords(f, first.savedId);
        let normalReads = 0;
        let lookups = 0;
        f.policy.handle = async (request, path, response) => {
            if (path === "/session/request" && request.kind === "records" && response.ok) {
                const result = await response.clone().json();
                const records = JSON.parse(result.contents);
                assertEquals(records.planSessions, [], "A normal turn must not project other Session transcripts");
                normalReads++;
            }
            if (path === "/session/request" && request.kind === "plan-sessions") {
                assertEquals(JSON.parse(request.contents), { planId: "laptop-only-plan" });
                lookups++;
            }
            return response;
        };
        await client.send({ kind: "turn", text: "Do not scan project history." });
        assertEquals((await client.read()).ok, true);
        assert(normalReads > 0);
        assertEquals(lookups, 0);
        await client.send({ kind: "plan-sessions", planId: "laptop-only-plan" });
        assertEquals((await client.read()).candidates?.length, 1);
        assertEquals(lookups, 1);
        await client.close();
        await assertRemoteStorageAbsent(f);
    });
});
