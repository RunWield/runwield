import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { NO_OPEN_BROWSER_PORT } from "../browser-port.ts";
import { ensureReviewHosted, stopHostedAttachedReviews } from "./review-host.ts";
import { EVIDENCE, readRecordBytes, spawnAttachedCli } from "./attached-test-fixture.ts";
import { conversation, pendingChat, reply, reviewApi, sendChat } from "./review-chat-test-fixture.ts";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { toDelivery } from "./delivery-test-fixture.ts";
import { continueHostTurnValidation } from "../workflow/validation-host-turn.ts";
import { loadPlan } from "../../plan-store.js";

test("Code page chat queues and replies without a decision, survives a fresh process, and permits later approval", async () => {
    const fixture = await attachedValidationFixture();
    try {
        const started = await toDelivery(fixture);
        assert(started.workflow.nextAction.kind === "code_review");
        const hosted = await ensureReviewHosted(fixture.root, started.workflow, NO_OPEN_BROWSER_PORT);
        assert(hosted);
        const originalPlan = (await loadPlan(fixture.cwd, "p"))?.markdown;
        const before = await conversation(hosted.url);
        await sendChat(hosted.url, "PRIVATE_CODE_FIRST");
        await sendChat(hosted.url, "PRIVATE_CODE_SECOND");
        let current = await fixture.status();
        const first = pendingChat(current);
        assertEquals(first.message, "PRIVATE_CODE_FIRST");
        assertEquals((await loadPlan(fixture.cwd, "p"))?.markdown, originalPlan);
        assertEquals((await conversation(hosted.url)).revision, before.revision);
        await stopHostedAttachedReviews();
        const fresh = await spawnAttachedCli("status", fixture.root, { workflowId: fixture.workflowId });
        assert(fresh.result.ok);
        assertEquals(pendingChat(fresh.result.workflow).turnId, first.turnId);
        const restored = await ensureReviewHosted(fixture.root, fresh.result.workflow, NO_OPEN_BROWSER_PORT);
        assert(restored);
        const queued = await conversation(restored.url);
        assertEquals(
            queued.turns?.map((turn) => turn.message),
            ["PRIVATE_CODE_FIRST", "PRIVATE_CODE_SECOND"],
        );
        assertEquals(queued.pending, true);
        const answered = await spawnAttachedCli("review_reply", fixture.root, {
            workflowId: fixture.workflowId,
            expectedRevision: fresh.result.workflow.revision,
            operationId: "code-answer",
            evidence: EVIDENCE,
            payload: { turnId: first.turnId, text: "PRIVATE_CODE_ANSWER" },
        });
        assert(answered.result.ok, JSON.stringify(answered));
        const restoredReply = await conversation(restored.url);
        assertEquals(restoredReply.events[0].delta, "PRIVATE_CODE_ANSWER");
        assertEquals(restoredReply.turns?.[0].reply, "PRIVATE_CODE_ANSWER");
        assertEquals(restoredReply.pending, true);
        current = await fixture.status();
        assertEquals(pendingChat(current).message, "PRIVATE_CODE_SECOND");
        assertEquals((await fixture.evidence()).filter((entry) => entry.kind === "human").length, 0);
        const duplicate = await reply(
            fixture.root,
            current,
            { turnId: first.turnId, text: "Duplicate" },
            "code-answer",
        );
        assert(!duplicate.ok && duplicate.rejection.code === "action_superseded");
        const approved = await fetch(reviewApi(restored.url, "decision"), {
            method: "POST",
            body: JSON.stringify({ approved: true, reviewRevision: 0 }),
        });
        assertEquals(approved.status, 200, await approved.text());
        current = await fixture.status();
        assertEquals(current.nextAction.kind, "recorder");
        const late = await reply(fixture.root, current, { turnId: first.turnId, text: "Late" });
        assert(!late.ok && late.rejection.code === "action_superseded");
        assertEquals((await readRecordBytes(fixture.root, fixture.workflowId)).includes("PRIVATE_CODE"), false);
    } finally {
        await stopHostedAttachedReviews();
        await fixture.close();
    }
});

test("a code chat change persists only its summary, re-verifies, and opens the changed diff on the same page", async () => {
    const fixture = await attachedValidationFixture();
    try {
        const started = await toDelivery(fixture);
        assert(started.workflow.nextAction.kind === "code_review");
        const previousActionId = started.workflow.nextAction.actionId;
        const hosted = await ensureReviewHosted(fixture.root, started.workflow, NO_OPEN_BROWSER_PORT);
        assert(hosted);
        await sendChat(hosted.url, "PRIVATE_RENAME_REQUEST");
        const current = await fixture.status();
        const turnId = pendingChat(current).turnId;
        const changed = await reply(
            fixture.root,
            current,
            { turnId, text: "PRIVATE_RENAME_REPLY", change: { summary: "Export value 3." } },
            "code-change",
        );
        assert(
            changed.ok &&
                changed.workflow.nextAction.kind === "validation" &&
                changed.workflow.nextAction.request.kind === "repair",
        );
        await ensureReviewHosted(fixture.root, changed.workflow, NO_OPEN_BROWSER_PORT, changed.reviewReply);
        assertStringIncludes(changed.workflow.nextAction.request.prompt, "Export value 3.");
        assertStringIncludes(JSON.stringify(await fixture.evidence()), "Export value 3.");
        assertStringIncludes(await fixture.checkpointBytes(), "Export value 3.");
        for (const artifact of [
            JSON.stringify(await fixture.evidence()),
            await fixture.checkpointBytes(),
            (await loadPlan(fixture.cwd, "p"))?.markdown || "",
            await readRecordBytes(fixture.root, fixture.workflowId),
        ])
            assertEquals(artifact.includes("PRIVATE_RENAME"), false);
        const replay = await reply(
            fixture.root,
            changed.workflow,
            { turnId, text: "Duplicate", change: { summary: "Export value 9." } },
            "code-change",
        );
        assert(!replay.ok && replay.rejection.code === "action_superseded");
        await writeFile(join(fixture.cwd, "implementation.ts"), "export const value = 3;\n");
        const repaired = await fixture.call("task_completed", changed.workflow, {
            actionId: changed.workflow.nextAction.actionId,
            message: "- Exported value 3.",
        });
        assert(repaired.ok && repaired.workflow.nextAction.kind === "code_review", JSON.stringify(repaired));
        assert(repaired.workflow.nextAction.actionId !== previousActionId);
        assertEquals(await fixture.ciCount(), 2);
        const next = await ensureReviewHosted(fixture.root, repaired.workflow, NO_OPEN_BROWSER_PORT);
        assert(next);
        assertEquals(next.url, hosted.url);
        const live = await conversation(next.url);
        assertStringIncludes(live.rawPatch, "value = 3");
        assert(live.revision > 0);
        assertEquals(live.events.at(-1)?.delta, "PRIVATE_RENAME_REPLY");
        await conversation(next.url);
        assertEquals((await conversation(next.url)).events, []);
        const stale = await fixture.call("validation_decision", repaired.workflow, {
            actionId: previousActionId,
            answer: { outcome: "approved" },
        });
        assert(!stale.ok && stale.rejection.code === "action_superseded");
        assertEquals(
            (await fixture.evidence()).filter(
                (entry) => entry.kind === "human" && JSON.stringify(entry).includes("approved"),
            ).length,
            0,
        );
        assertEquals(live.reviewRevision, 1);
        await sendChat(next.url, "Question on revised code", live.reviewRevision);
        const revised = await fixture.status();
        assert(
            (await reply(fixture.root, revised, { turnId: pendingChat(revised).turnId, text: "Revised code answer" }))
                .ok,
        );
        const approved = await fetch(reviewApi(next.url, "decision"), {
            method: "POST",
            body: JSON.stringify({ approved: true, reviewRevision: live.reviewRevision }),
        });
        assertEquals(approved.status, 200, await approved.text());
        assertEquals((await fixture.status()).nextAction.kind, "recorder");
    } finally {
        await stopHostedAttachedReviews();
        await fixture.close();
    }
});

test("an external Core decision closes the saved code chat without retaining text in receipts", async () => {
    const fixture = await attachedValidationFixture();
    try {
        const started = await toDelivery(fixture);
        assert(started.workflow.nextAction.kind === "code_review");
        const hosted = await ensureReviewHosted(fixture.root, started.workflow, NO_OPEN_BROWSER_PORT);
        assert(hosted);
        await sendChat(hosted.url, "PRIVATE_CORE_CODE_CLOSE");
        const current = await fixture.status();
        assert(
            (
                await reply(fixture.root, current, {
                    turnId: pendingChat(current).turnId,
                    text: "PRIVATE_CORE_CODE_ANSWER",
                })
            ).ok,
        );
        const advanced = await continueHostTurnValidation({
            projectRoot: fixture.root,
            planName: "p",
            resume: {
                kind: "decision",
                identity: started.workflow.nextAction.request.identity,
                answer: { outcome: "approved" },
            },
        });
        assert(advanced.kind === "host_request" && advanced.request.kind === "recorder");
        const reconciled = await fixture.status();
        assertEquals(reconciled.nextAction.kind, "validation_recovery");
        assertEquals((await readRecordBytes(fixture.root, fixture.workflowId)).includes("PRIVATE_CORE_CODE"), false);
        const late = await reply(fixture.root, reconciled, { turnId: pendingChat(current).turnId, text: "Late" });
        assert(!late.ok && late.rejection.code === "action_superseded");
    } finally {
        await stopHostedAttachedReviews();
        await fixture.close();
    }
});
