import { test } from "node:test";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { loadPlan } from "../../plan-store.js";
import { recordPlanEvent } from "../workflow/plan-lifecycle.js";
import { applyAttachedReviewDecision, openAttachedReviewRound } from "./coordinator.ts";
import {
    planWrittenInput,
    readRecordBytes,
    runOperation,
    spawnAttachedCli,
    submitReview,
    withProject,
} from "./attached-test-fixture.ts";

const approval = {
    approved: true,
    approvalAction: "run" as const,
    executionAgent: "engineer" as const,
    collaborationRecommendation: "autonomous" as const,
};

test("approval survives a fresh status process with canonical readiness and an idempotent outcome", async () => {
    await withProject(async (root) => {
        const workflow = await submitReview(root);
        const opened = await openAttachedReviewRound(root, workflow.workflowId);
        assert(opened.kind === "opened");
        const outcome = await applyAttachedReviewDecision(root, workflow.workflowId, opened.basis, approval);
        assertEquals(outcome.kind, "approved");
        assertEquals((await loadPlan(root, "dark-mode-toggle"))?.attrs.status, "ready_for_work");
        const path = opened.basis.planPath;
        const bytes = await fsReadFile(path, "utf8");
        const record = await readRecordBytes(root, workflow.workflowId);
        assertEquals(
            await applyAttachedReviewDecision(root, workflow.workflowId, opened.basis, { feedback: "Late callback" }),
            outcome,
        );
        assertEquals(await fsReadFile(path, "utf8"), bytes);
        assertEquals(await readRecordBytes(root, workflow.workflowId), record);
        const fresh = await spawnAttachedCli("status", root, { workflowId: workflow.workflowId });
        assert(fresh.result.ok);
        assertEquals(fresh.result.workflow.state, "plan_ready");
        assertEquals(fresh.result.workflow.review?.outcome, outcome);
    });
});

test("feedback and readable image paths survive loss and resubmission creates a new round", async () => {
    await withProject(async (root) => {
        const workflow = await submitReview(root);
        const opened = await openAttachedReviewRound(root, workflow.workflowId);
        assert(opened.kind === "opened");
        const image = join(root, "feedback.png");
        await fsWriteFile(image, new Uint8Array([137, 80, 78, 71]));
        const outcome = await applyAttachedReviewDecision(root, workflow.workflowId, opened.basis, {
            feedback: "Use a selector.",
            annotations: [{ images: [{ path: image }] }],
            globalAttachments: [{ path: image }, { path: join(root, "missing.png") }],
            plan: opened.basis.markdown.replace("Add a toggle.", "Add a theme selector."),
        });
        assertEquals(outcome, { kind: "feedback", feedback: "Use a selector.", imagePaths: [image] });
        const fresh = await spawnAttachedCli("status", root, { workflowId: workflow.workflowId });
        assert(fresh.result.ok);
        const action = fresh.result.workflow.nextAction;
        assert(action.kind === "plan");
        assertEquals(action.feedback, "Use a selector.");
        assertEquals(action.imagePaths, [image]);
        assertStringIncludes(action.note ?? "", "do not apply them twice");
        assertStringIncludes((await loadPlan(root, "dark-mode-toggle"))?.body ?? "", "theme selector");
        const second = await runOperation(
            "plan_written",
            root,
            planWrittenInput({
                workflowId: workflow.workflowId,
                actionId: action.actionId,
                expectedRevision: fresh.result.workflow.revision,
                operationId: "resubmit",
            }),
        );
        assert(second.ok);
        assertEquals(second.workflow.review?.round, 2);
        await assertRejects(
            () => applyAttachedReviewDecision(root, workflow.workflowId, opened.basis, approval),
            Error,
            "action_superseded",
        );
    });
});

for (const decision of [{ canceled: true }, { exit: true }]) {
    test(`${decision.exit ? "exit" : "canceled"} returns to Claude with a cancel note and leaves the draft unchanged`, async () => {
        await withProject(async (root) => {
            const workflow = await submitReview(root);
            const opened = await openAttachedReviewRound(root, workflow.workflowId);
            assert(opened.kind === "opened");
            const bytes = await fsReadFile(opened.basis.planPath, "utf8");
            assertEquals(await applyAttachedReviewDecision(root, workflow.workflowId, opened.basis, decision), {
                kind: "canceled",
            });
            const status = await runOperation("status", root, { workflowId: workflow.workflowId });
            assert(status.ok && status.workflow.nextAction.kind === "plan");
            assertStringIncludes(status.workflow.nextAction.note ?? "", "canceled");
            assertEquals(status.workflow.state, "awaiting_planning");
            assertEquals((await loadPlan(root, "dark-mode-toggle"))?.attrs.status, "draft");
            assertEquals(await fsReadFile(opened.basis.planPath, "utf8"), bytes);
        });
    });
}

test("a meaningfully edited Plan rejects approval without changing the pending round", async () => {
    await withProject(async (root) => {
        const workflow = await submitReview(root);
        const opened = await openAttachedReviewRound(root, workflow.workflowId);
        assert(opened.kind === "opened");
        await fsWriteFile(opened.basis.planPath, opened.basis.markdown.replace("Add a toggle.", "Remove all themes."));
        const record = await readRecordBytes(root, workflow.workflowId);
        await assertRejects(() => applyAttachedReviewDecision(root, workflow.workflowId, opened.basis, approval));
        assertEquals(await readRecordBytes(root, workflow.workflowId), record);
        assertEquals((await loadPlan(root, "dark-mode-toggle"))?.attrs.status, "draft");
    });
});

test("formatting-only Plan rewrites still approve through the shared semantic comparison", async () => {
    await withProject(async (root) => {
        const workflow = await submitReview(root);
        const opened = await openAttachedReviewRound(root, workflow.workflowId);
        assert(opened.kind === "opened");
        await fsWriteFile(opened.basis.planPath, opened.basis.markdown.replace("Add a toggle.", "Add a\ntoggle."));
        assertEquals(
            (await applyAttachedReviewDecision(root, workflow.workflowId, opened.basis, approval)).kind,
            "approved",
        );
        assertEquals((await loadPlan(root, "dark-mode-toggle"))?.attrs.status, "ready_for_work");
    });
});

for (const decision of [{}, { approved: true, approvalAction: "run" as const }]) {
    test(`${decision.approved ? "invalid approval policy" : "unanswered review"} leaves the durable round pending`, async () => {
        await withProject(async (root) => {
            const workflow = await submitReview(root);
            const opened = await openAttachedReviewRound(root, workflow.workflowId);
            assert(opened.kind === "opened");
            const record = await readRecordBytes(root, workflow.workflowId);
            await assertRejects(() => applyAttachedReviewDecision(root, workflow.workflowId, opened.basis, decision));
            assertEquals(await readRecordBytes(root, workflow.workflowId), record);
            assertEquals((await loadPlan(root, "dark-mode-toggle"))?.attrs.status, "draft");
        });
    });
}

test("Core approval reconciles instead of applying a second browser transition", async () => {
    await withProject(async (root) => {
        const workflow = await submitReview(root);
        const opened = await openAttachedReviewRound(root, workflow.workflowId);
        assert(opened.kind === "opened");
        await recordPlanEvent({
            cwd: root,
            planName: "dark-mode-toggle",
            event: "review_approved",
            currentStatus: "draft",
        });
        const bytes = await fsReadFile(opened.basis.planPath, "utf8");
        await assertRejects(
            () => applyAttachedReviewDecision(root, workflow.workflowId, opened.basis, approval),
            Error,
            "advanced in Core",
        );
        assertEquals(await fsReadFile(opened.basis.planPath, "utf8"), bytes);
        const status = await runOperation("status", root, { workflowId: workflow.workflowId });
        assert(status.ok);
        assertEquals(status.workflow.state, "plan_ready");
        assertEquals((await loadPlan(root, "dark-mode-toggle"))?.attrs.status, "approved");
    });
});

test("Core feedback after Attached approval yields a usable new Planner action", async () => {
    await withProject(async (root) => {
        const workflow = await submitReview(root);
        const opened = await openAttachedReviewRound(root, workflow.workflowId);
        assert(opened.kind === "opened");
        await applyAttachedReviewDecision(root, workflow.workflowId, opened.basis, approval);
        await recordPlanEvent({
            cwd: root,
            planName: "dark-mode-toggle",
            event: "review_reopened",
            currentStatus: "ready_for_work",
        });
        await recordPlanEvent({
            cwd: root,
            planName: "dark-mode-toggle",
            event: "review_feedback",
            currentStatus: "feedback",
            details: { failureReason: "Core feedback." },
        });
        const status = await runOperation("status", root, { workflowId: workflow.workflowId });
        assert(status.ok && status.workflow.nextAction.kind === "plan");
        const submitted = await runOperation(
            "plan_written",
            root,
            planWrittenInput({
                workflowId: workflow.workflowId,
                actionId: status.workflow.nextAction.actionId,
                expectedRevision: status.workflow.revision,
                operationId: "after-core-feedback",
            }),
        );
        assert(submitted.ok);
        assertEquals(submitted.workflow.state, "awaiting_review");
        assertEquals(submitted.workflow.review?.round, 2);
    });
});
