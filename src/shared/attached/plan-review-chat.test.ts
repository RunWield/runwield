import { test } from "node:test";
import type { AttachedJsonObject } from "./operations.ts";
import { ok as assert } from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { NO_OPEN_BROWSER_PORT } from "../browser-port.ts";
import { ensureReviewHosted, stopHostedAttachedReviews } from "./review-host.ts";
import {
    EVIDENCE,
    planWrittenInput,
    readRecordBytes,
    runOperation,
    spawnAttachedCli,
    submitReview,
    withProject,
} from "./attached-test-fixture.ts";
import { conversation, pendingChat, reply, reviewApi, sendChat, status } from "./review-chat-test-fixture.ts";
import { loadAttachedWorkflowRecord, locateAttachedWorkflows } from "./record-store.ts";
import { loadPlan } from "../../plan-store.js";
import { recordPlanEvent } from "../workflow/plan-lifecycle.js";

test("Plan page chat queues in order, replies through the saved source, and still accepts a structured decision", async () => {
    await withProject(async (root) => {
        try {
            const workflow = await submitReview(root);
            const hosted = await ensureReviewHosted(root, workflow, NO_OPEN_BROWSER_PORT);
            assert(hosted);
            const before = await conversation(hosted.url);
            const original = await loadPlan(root, "dark-mode-toggle");
            await sendChat(hosted.url, "First private question");
            await sendChat(hosted.url, "Second private question");
            let current = await status(root, workflow.workflowId);
            const first = pendingChat(current);
            assertEquals(first.message, "First private question");
            assertEquals(first.selections, [{ file: "implementation.ts", line: 1, text: "Selected value" }]);
            assertEquals(current.review?.status, "pending");
            assertEquals((await loadPlan(root, "dark-mode-toggle"))?.markdown, original?.markdown);
            assertEquals((await conversation(hosted.url)).revision, before.revision);
            const loaded = await loadAttachedWorkflowRecord(locateAttachedWorkflows(root), workflow.workflowId);
            assert(loaded.status === "found");
            const second = loaded.record.review?.chat?.turns[1];
            assert(second);
            const outOfOrder = await reply(root, current, { turnId: second.turnId, text: "Too early" });
            assert(!outOfOrder.ok && outOfOrder.rejection.code === "action_superseded");
            const stale = await reply(root, workflow, { turnId: first.turnId, text: "Stale" });
            assert(!stale.ok && stale.rejection.code === "revision_conflict");
            const answered = await reply(root, current, { turnId: first.turnId, text: "First private answer" });
            assert(answered.ok);
            const live = await conversation(hosted.url);
            assertEquals(live.revision, before.revision + 1);
            assertEquals(
                live.events.map((event) => event.delta),
                ["First private answer"],
            );
            current = await status(root, workflow.workflowId);
            assertEquals(pendingChat(current).turnId, second.turnId);
            const answeredAgain = await reply(root, current, { turnId: first.turnId, text: "Duplicate" });
            assert(!answeredAgain.ok && answeredAgain.rejection.code === "action_superseded");
            assert((await reply(root, current, { turnId: second.turnId, text: "Second private answer" })).ok);
            const approved = await fetch(reviewApi(hosted.url, "decision"), {
                method: "POST",
                body: JSON.stringify({
                    approvalAction: "run",
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                    reviewRevision: 0,
                }),
            });
            assertEquals(approved.status, 200, await approved.text());
            current = await status(root, workflow.workflowId);
            assertEquals(current.state, "plan_ready");
            const closed = await reply(root, current, { turnId: second.turnId, text: "Late" });
            assert(!closed.ok && closed.rejection.code === "action_superseded");
            const bytes = await readRecordBytes(root, workflow.workflowId);
            for (const text of [
                "First private question",
                "Second private question",
                "First private answer",
                "Second private answer",
            ])
                assertEquals(bytes.includes(text), false);
            assertEquals((await conversation(hosted.url)).events, []);
        } finally {
            await stopHostedAttachedReviews();
        }
    });
});

test("a queued Plan chat survives fresh Core processes and browser rehosting", async () => {
    await withProject(async (root) => {
        try {
            const workflow = await submitReview(root);
            const hosted = await ensureReviewHosted(root, workflow, NO_OPEN_BROWSER_PORT);
            assert(hosted);
            await sendChat(hosted.url, "Recover this private question");
            await stopHostedAttachedReviews();
            const fresh = await spawnAttachedCli("status", root, { workflowId: workflow.workflowId });
            assertEquals(fresh.code, 0);
            assert(fresh.result.ok);
            const turn = pendingChat(fresh.result.workflow);
            assertEquals(turn.message, "Recover this private question");
            const restored = await ensureReviewHosted(root, fresh.result.workflow, NO_OPEN_BROWSER_PORT);
            assert(restored);
            const queued = await conversation(restored.url);
            assertEquals(queued.turns, [{ turnId: turn.turnId, message: turn.message }]);
            assertEquals(queued.pending, true);
            const answered = await spawnAttachedCli("review_reply", root, {
                workflowId: workflow.workflowId,
                expectedRevision: fresh.result.workflow.revision,
                operationId: "fresh-reply",
                evidence: EVIDENCE,
                payload: { turnId: turn.turnId, text: "Reply from another process" },
            });
            assert(answered.result.ok, JSON.stringify(answered));
            const restoredReply = await conversation(restored.url);
            assertEquals(restoredReply.events[0].delta, "Reply from another process");
            assertEquals(restoredReply.turns?.[0].reply, "Reply from another process");
            assertEquals(restoredReply.pending, false);
            await stopHostedAttachedReviews();
            const afterReply = await status(root, workflow.workflowId);
            const restoredAnswer = await ensureReviewHosted(root, afterReply, NO_OPEN_BROWSER_PORT);
            assert(restoredAnswer);
            assertEquals((await conversation(restoredAnswer.url)).events[0].delta, "Reply from another process");
        } finally {
            await stopHostedAttachedReviews();
        }
    });
});

test("a Plan change from chat has no Feedback and opens the next round on the same page", async () => {
    await withProject(async (root) => {
        try {
            const workflow = await submitReview(root);
            const hosted = await ensureReviewHosted(root, workflow, NO_OPEN_BROWSER_PORT);
            assert(hosted);
            await sendChat(hosted.url, "PRIVATE_PLAN_CHANGE");
            const current = await status(root, workflow.workflowId);
            const turn = pendingChat(current);
            const invalidChanges: AttachedJsonObject[] = [{}, { summary: " " }];
            for (const change of invalidChanges) {
                const invalid = await reply(root, current, { turnId: turn.turnId, text: "Revising", change });
                assert(!invalid.ok && invalid.rejection.code === "invalid_input");
            }
            const changed = await reply(root, current, {
                turnId: turn.turnId,
                text: "PRIVATE_PLAN_REPLY",
                change: { summary: "Use a selector" },
            });
            assert(changed.ok && changed.workflow.nextAction.kind === "plan");
            await ensureReviewHosted(root, changed.workflow, NO_OPEN_BROWSER_PORT, changed.reviewReply);
            assertEquals((await conversation(hosted.url)).events.at(-1)?.delta, "PRIVATE_PLAN_REPLY");
            assertEquals(changed.workflow.state, "awaiting_planning");
            assertEquals(changed.workflow.nextAction.feedback, undefined);
            assertEquals(changed.workflow.review?.outcome, undefined);
            const plan = await loadPlan(root, "dark-mode-toggle");
            assert(plan);
            assertEquals(plan.attrs.status, "draft");
            await writeFile(plan.path, plan.markdown.replace("Add a toggle.", "Add a selector."));
            const submitted = await runOperation(
                "plan_written",
                root,
                planWrittenInput({
                    workflowId: workflow.workflowId,
                    expectedRevision: changed.workflow.revision,
                    actionId: changed.workflow.nextAction.actionId,
                    operationId: "new-plan-round",
                }),
            );
            assert(submitted.ok);
            const next = await ensureReviewHosted(root, submitted.workflow, NO_OPEN_BROWSER_PORT);
            assert(next);
            assertEquals(next.url, hosted.url);
            assertEquals(next.round, 2);
            const live = await conversation(next.url);
            assert(live.revision > 0);
            assertStringIncludes(live.plan, "Add a selector.");
            assertEquals(live.events.at(-1)?.delta, "PRIVATE_PLAN_REPLY");
            // The reply is delivered once with the new artifact, not retained as page history.
            await conversation(next.url);
            assertEquals((await conversation(next.url)).events, []);
            assertEquals((await readRecordBytes(root, workflow.workflowId)).includes("PRIVATE_PLAN"), false);
            const late = await reply(root, submitted.workflow, { turnId: turn.turnId, text: "Late" });
            assert(!late.ok && late.rejection.code === "action_superseded");
            assertEquals(live.reviewRevision, 1);
            await sendChat(next.url, "Question on revised Plan", live.reviewRevision);
            const revised = await status(root, workflow.workflowId);
            assert((await reply(root, revised, { turnId: pendingChat(revised).turnId, text: "Revised answer" })).ok);
            const approved = await fetch(reviewApi(next.url, "decision"), {
                method: "POST",
                body: JSON.stringify({
                    approvalAction: "run",
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                    reviewRevision: live.reviewRevision,
                }),
            });
            assertEquals(approved.status, 200, await approved.text());
            assertEquals((await status(root, workflow.workflowId)).state, "plan_ready");
        } finally {
            await stopHostedAttachedReviews();
        }
    });
});

test("Core advancement scrubs active Plan chat and all old operation snapshots", async () => {
    await withProject(async (root) => {
        try {
            const workflow = await submitReview(root);
            const hosted = await ensureReviewHosted(root, workflow, NO_OPEN_BROWSER_PORT);
            assert(hosted);
            await sendChat(hosted.url, "PRIVATE_EXTERNAL_CLOSE");
            const current = await status(root, workflow.workflowId);
            assert(
                (await reply(root, current, { turnId: pendingChat(current).turnId, text: "PRIVATE_EXTERNAL_ANSWER" }))
                    .ok,
            );
            await recordPlanEvent({
                cwd: root,
                planName: "dark-mode-toggle",
                event: "review_approved",
                currentStatus: "draft",
            });
            assertEquals((await status(root, workflow.workflowId)).state, "plan_ready");
            assertEquals((await readRecordBytes(root, workflow.workflowId)).includes("PRIVATE_EXTERNAL"), false);
        } finally {
            await stopHostedAttachedReviews();
        }
    });
});
