import { test } from "node:test";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { NO_OPEN_BROWSER_PORT } from "../browser-port.ts";
import { ensureReviewHosted, stopHostedAttachedReviews } from "./review-host.ts";
import { loadAttachedWorkflowRecord, locateAttachedWorkflows } from "./record-store.ts";
import { planWrittenInput, runOperation, submitReview, withProject } from "./attached-test-fixture.ts";
import { loadPlan } from "../../plan-store.js";
import { recordPlanEvent } from "../workflow/plan-lifecycle.js";

test("the production decision route acknowledges only a committed Attached outcome and reuses its page", async () => {
    await withProject(async (root) => {
        try {
            const workflow = await submitReview(root);
            const hosted = await ensureReviewHosted(root, workflow, NO_OPEN_BROWSER_PORT);
            assert(hosted);
            assertEquals(await ensureReviewHosted(root, workflow, NO_OPEN_BROWSER_PORT), hosted);
            const url = new URL(hosted.url);
            const revisionUrl = new URL(`/api/review/revision${url.search}`, url);
            assertEquals((await (await fetch(revisionUrl)).json()).revision, 0);
            const unauthorized = await fetch(new URL("/api/review/revision", url));
            assertEquals(unauthorized.status, 404);
            await unauthorized.text();
            const conversation = await fetch(new URL(`/api/review/conversation${url.search}`, url));
            assertEquals(conversation.status, 404);
            await conversation.text();
            const oldPlan = await loadPlan(root, "dark-mode-toggle");
            assert(oldPlan);
            const response = await fetch(new URL(`/api/review/deny${url.search}`, url), {
                method: "POST",
                body: JSON.stringify({ feedback: "Revise the title.", reviewRevision: 0 }),
            });
            assertEquals(response.status, 200);
            assertEquals(await response.text(), '{"ok":true}');
            const saved = await loadAttachedWorkflowRecord(locateAttachedWorkflows(root), workflow.workflowId);
            assert(saved.status === "found");
            assertEquals(saved.record.review?.status, "applied");
            assertEquals(saved.record.review?.outcome?.feedback, "Revise the title.");
            const status = await runOperation("status", root, { workflowId: workflow.workflowId });
            assert(status.ok && status.workflow.nextAction.kind === "plan");
            await fsWriteFile(oldPlan.path, oldPlan.markdown.replace("Add a toggle.", "Add a selector."));
            const next = await runOperation(
                "plan_written",
                root,
                planWrittenInput({
                    workflowId: workflow.workflowId,
                    actionId: status.workflow.nextAction.actionId,
                    expectedRevision: status.workflow.revision,
                    operationId: "second-review",
                }),
            );
            assert(next.ok);
            const second = await ensureReviewHosted(root, next.workflow, NO_OPEN_BROWSER_PORT);
            assert(second);
            assertEquals(second.url, hosted.url);
            assertEquals(second.round, 2);
            assertEquals((await (await fetch(revisionUrl)).json()).revision, 1);
            const staleTab = await fetch(new URL(`/api/review/decision${url.search}`, url), {
                method: "POST",
                body: JSON.stringify({
                    approvalAction: "run",
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                    reviewRevision: 0,
                    plan: oldPlan.markdown,
                }),
            });
            assertEquals(staleTab.status, 409);
            await staleTab.text();
            assertStringIncludes((await loadPlan(root, "dark-mode-toggle"))?.body ?? "", "Add a selector.");
            const approved = await fetch(new URL(`/api/review/decision${url.search}`, url), {
                method: "POST",
                body: JSON.stringify({
                    approvalAction: "run",
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                    reviewRevision: 1,
                }),
            });
            assertEquals(approved.status, 200);
            await approved.text();
            assertEquals((await loadPlan(root, "dark-mode-toggle"))?.attrs.status, "ready_for_work");
        } finally {
            await stopHostedAttachedReviews();
        }
    });
});

test("restoring hosting retains the durable round and does not invent cancellation", async () => {
    await withProject(async (root) => {
        try {
            const workflow = await submitReview(root);
            const original = await ensureReviewHosted(root, workflow, NO_OPEN_BROWSER_PORT);
            assert(original);
            await stopHostedAttachedReviews();
            await assertRejects(() => fetch(original.url));
            const status = await runOperation("status", root, { workflowId: workflow.workflowId });
            assert(status.ok);
            assertEquals(status.workflow.review, workflow.review);
            const restored = await ensureReviewHosted(root, status.workflow, NO_OPEN_BROWSER_PORT);
            assert(restored);
            assertEquals(restored.round, original.round);
            assert(restored.url !== original.url);
            const url = new URL(restored.url);
            const canceled = await fetch(new URL(`/api/review/exit${url.search}`, url), {
                method: "POST",
                body: JSON.stringify({ reviewRevision: 0 }),
            });
            assertEquals(canceled.status, 200);
            await canceled.text();
            const after = await runOperation("status", root, { workflowId: workflow.workflowId });
            assert(after.ok && after.workflow.nextAction.kind === "plan");
            assertStringIncludes(after.workflow.nextAction.note ?? "", "canceled");
        } finally {
            await stopHostedAttachedReviews();
        }
    });
});

test("the production stale-review response preserves the pending durable round", async () => {
    await withProject(async (root) => {
        try {
            const workflow = await submitReview(root);
            const hosted = await ensureReviewHosted(root, workflow, NO_OPEN_BROWSER_PORT);
            assert(hosted);
            const plan = await loadPlan(root, "dark-mode-toggle");
            assert(plan);
            await fsWriteFile(plan.path, plan.markdown.replace("Add a toggle.", "Delete the toggle."));
            const url = new URL(hosted.url);
            const rejected = await fetch(new URL(`/api/review/decision${url.search}`, url), {
                method: "POST",
                body: JSON.stringify({
                    approvalAction: "run",
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                    reviewRevision: 0,
                }),
            });
            assertEquals(rejected.status, 409);
            assertEquals((await rejected.json()).error, "stale_sequence_review");
            const saved = await loadAttachedWorkflowRecord(locateAttachedWorkflows(root), workflow.workflowId);
            assert(saved.status === "found");
            assertEquals(saved.record.review?.status, "pending");
            const page = await fetch(hosted.url);
            assertEquals(page.status, 200);
            assertStringIncludes(await page.text(), "Delete the toggle.");
            assertEquals((await (await fetch(new URL(`/api/review/revision${url.search}`, url))).json()).revision, 1);
            const accepted = await fetch(new URL(`/api/review/decision${url.search}`, url), {
                method: "POST",
                body: JSON.stringify({
                    approvalAction: "run",
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                    reviewRevision: 1,
                }),
            });
            assertEquals(accepted.status, 200);
            await accepted.text();
            assertEquals((await loadPlan(root, "dark-mode-toggle"))?.attrs.status, "ready_for_work");
        } finally {
            await stopHostedAttachedReviews();
        }
    });
});

test("a Core-advanced browser reload returns its position without waiting on its own shutdown", async () => {
    await withProject(async (root) => {
        try {
            const workflow = await submitReview(root);
            const hosted = await ensureReviewHosted(root, workflow, NO_OPEN_BROWSER_PORT);
            assert(hosted);
            await recordPlanEvent({
                cwd: root,
                planName: "dark-mode-toggle",
                event: "review_approved",
                currentStatus: "draft",
            });
            const url = new URL(hosted.url);
            const rejected = await fetch(new URL(`/api/review/decision${url.search}`, url), {
                method: "POST",
                body: JSON.stringify({
                    approvalAction: "run",
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                    reviewRevision: 0,
                }),
            });
            assertEquals(rejected.status, 409);
            await rejected.text();
            const reloaded = await fetch(hosted.url, { signal: AbortSignal.timeout(5000) });
            assertEquals(reloaded.status, 409);
            assertStringIncludes(await reloaded.text(), "advanced in Core");
            const status = await runOperation("status", root, { workflowId: workflow.workflowId });
            assert(status.ok);
            assertEquals(status.workflow.state, "plan_ready");
        } finally {
            await stopHostedAttachedReviews();
        }
    });
});
