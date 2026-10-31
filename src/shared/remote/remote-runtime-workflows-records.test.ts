import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { assertEquals } from "../../testing/assertions.ts";
import { savePlan } from "../../plan-store.js";
import { assertRemoteStorageAbsent, withRemoteRuntimeFixture } from "./remote-runtime-test-fixture.ts";

test("remote plan_written commits its exact artifact, association and review and a fresh runtime reopens the saved review", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        await savePlan(f.remoteProject, "remote-records", "# Remote records\n\nPreserve laptop records.\n", {
            planId: "remote-records-plan",
            classification: "QUICK_FIX",
            complexity: "LOW",
            status: "draft",
        });
        let turns = 0;
        f.setModelResponseFactory(() =>
            ++turns === 1
                ? fauxAssistantMessage(fauxToolCall("plan_written", { planName: "remote-records" }))
                : fauxAssistantMessage(fauxText("Review saved.")),
        );
        const client = await f.start();
        await client.read();
        await client.send({ kind: "plan-written" });
        const written = await client.read();
        assertEquals(written.ok, true, written.error);
        assertEquals(written.reviewCount, 1);
        assert(written.savedId);
        const id = written.savedId;
        const artifacts = f.store.listSessionArtifacts(id);
        assertEquals(artifacts.length, 1);
        assertEquals(artifacts[0].path, "docs/plans/remote-records.md");
        assertEquals(artifacts[0].kind, "plan");
        const associations = f.store.listSessionPlanAssociations(id);
        assertEquals(associations.length, 1);
        assertEquals(associations[0].planId, "remote-records-plan");
        assert(Number.isInteger(associations[0].committedGeneration));
        const reference = f.store.getLastPlanReview(id);
        assertEquals(reference?.planName, "remote-records");
        assertEquals(reference?.planId, "remote-records-plan");
        assertEquals(reference?.planningAgentName, "remote-runtime");
        assertEquals(written.canReopen, true);
        await client.close();
        const resumed = await f.start();
        await resumed.read();
        await resumed.send({ kind: "load", sessionId: id });
        const loaded = await resumed.read();
        assertEquals(loaded.ok, true, loaded.error);
        assertEquals(loaded.canReopen, true);
        assertEquals(loaded.planAssociations?.[0].planId, "remote-records-plan");
        await resumed.send({ kind: "plan-sessions", planId: "remote-records-plan" });
        const found = await resumed.read();
        assertEquals(found.candidates?.length, 1);
        const candidate = found.candidates![0];
        assertEquals(candidate.runwieldSessionId, id);
        assertEquals(candidate.transcriptPath, "");
        assertEquals(candidate.safePlanningResume, true);
        assertEquals(candidate.reason, null);
        assert(!JSON.stringify(candidate).includes(f.homeDir));
        await resumed.send({ kind: "verify-plan-session", candidate });
        assertEquals((await resumed.read()).ok, true);
        await resumed.send({
            kind: "tutorial",
            tutorial: {
                version: 1,
                recapShown: false,
                guidanceEnabled: true,
                planId: "remote-records-plan",
                shownExplanationIds: ["saved-review"],
            },
        });
        const tutorial = await resumed.read();
        assertEquals(tutorial.ok, true, tutorial.error);
        assertEquals(tutorial.tutorialContext?.planId, "remote-records-plan");
        await resumed.send({ kind: "reopen-review" });
        const review = await resumed.read();
        assertEquals(review.reviewCount, 1);
        assertEquals(review.reviewKind, "unanswered");
        assertEquals(f.modelRequests.length, turns, "Loading and reopening cannot replay the planning model turn");
        await resumed.close();
        const fresh = await f.start();
        await fresh.read();
        await fresh.send({ kind: "load", sessionId: id });
        const roundtrip = await fresh.read();
        assertEquals(roundtrip.tutorialContext?.shownExplanationIds, ["saved-review"]);
        assertEquals(roundtrip.tutorialContext?.planId, "remote-records-plan");
        await fresh.close();
        await assertRemoteStorageAbsent(f);
    });
});

test("remote artifact, association and review registration accept receipts larger than a small control envelope", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        let turns = 0;
        f.setModelResponseFactory(() =>
            ++turns === 1
                ? fauxAssistantMessage(fauxToolCall("fixture_artifact", {}))
                : fauxAssistantMessage(fauxText("Artifact saved.")),
        );
        const client = await f.start();
        await client.read();
        const title = "Large artifact title. ".repeat(400);
        await client.send({ kind: "artifact", text: title });
        const report = await client.read();
        assertEquals(report.ok, true, report.error);
        assert(report.savedId);
        assertEquals(f.store.listSessionArtifacts(report.savedId)[0].title, title);
        assertEquals(f.store.listSessionPlanAssociations(report.savedId)[0].planName, title.trim());
        assertEquals(f.store.getLastPlanReview(report.savedId)?.planName, title);
        await client.close();
        await assertRemoteStorageAbsent(f);
    });
});
