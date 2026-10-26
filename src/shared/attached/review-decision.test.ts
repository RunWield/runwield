import { test } from "node:test";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { loadPlan, updatePlanFrontMatter } from "../../plan-store.js";
import { listEntries } from "../worktree-registry.js";
import { executionInput } from "./execution-test-fixture.ts";
import { recordPlanEvent } from "../workflow/plan-lifecycle.js";
import { loadAttachedWorkflowRecord, locateAttachedWorkflows, writeAttachedWorkflowRecord } from "./record-store.ts";
import { readAttachedAction, applyAttachedReviewDecision, openAttachedReviewRound } from "./coordinator.ts";
import {
    EVIDENCE,
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
        assertEquals(fresh.result.workflow.review?.outcome, outcome.kind);
        const full = await runOperation("status", root, { workflowId: workflow.workflowId });
        assert(full.ok);
        assertEquals(full.workflow.review?.outcome, outcome);
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
        const summary = fresh.result.workflow.nextAction;
        assert(summary.kind === "plan");
        const content = await readAttachedAction({
            evidence: EVIDENCE,
            projectRoot: root,
            workflowId: workflow.workflowId,
            actionId: summary.actionId,
            content: "instructions",
        });
        assert(content.ok && "context" in content && content.context?.kind === "plan");
        const action = content.context;
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

for (const approvalAction of ["later", "run"] as const) {
    test(`Approve ${approvalAction} keeps readiness and starts only on explicit execution`, async () => {
        await withProject(async (root) => {
            const workflow = await submitReview(root);
            const opened = await openAttachedReviewRound(root, workflow.workflowId);
            assert(opened.kind === "opened");
            await applyAttachedReviewDecision(root, workflow.workflowId, opened.basis, { ...approval, approvalAction });
            assertEquals((await loadPlan(root, "dark-mode-toggle"))?.attrs.status, "ready_for_work");
            assertEquals((await listEntries(root)).length, 0);
            const fresh = await spawnAttachedCli("status", root, { workflowId: workflow.workflowId });
            assert(fresh.result.ok);
            assertEquals(fresh.result.workflow.state, "plan_ready");
            assertEquals(fresh.result.workflow.nextAction.kind, approvalAction === "run" ? "plan_ready" : "plan_saved");
            assert("guidance" in fresh.result.workflow.nextAction);
            if (approvalAction === "later") {
                assertStringIncludes(fresh.result.workflow.nextAction.guidance, "Ready For Work");
                assertStringIncludes(fresh.result.workflow.nextAction.guidance, "/runwield:implement");
            }
            const started = await runOperation(
                "start_execution",
                root,
                executionInput(fresh.result.workflow, "explicit-start"),
            );
            assert(started.ok && started.workflow.nextAction.kind === "implementation", JSON.stringify(started));
        });
    });
}

test("Core readiness without a saved browser outcome stays saved for later", async () => {
    await withProject(async (root) => {
        const workflow = await submitReview(root);
        await recordPlanEvent({
            cwd: root,
            planName: "dark-mode-toggle",
            event: "review_approved",
            currentStatus: "draft",
        });
        await recordPlanEvent({
            cwd: root,
            planName: "dark-mode-toggle",
            event: "readiness_passed",
            currentStatus: "approved",
        });
        const before = await loadPlan(root, "dark-mode-toggle");
        assert(before);
        const status = await runOperation("status", root, { workflowId: workflow.workflowId });
        assert(status.ok);
        assertEquals(status.workflow.state, "plan_ready");
        assertEquals(status.workflow.nextAction.kind, "plan_saved");
        assertEquals(status.workflow.review?.outcome, undefined);
        assertEquals((await listEntries(root)).length, 0);
        assertEquals(
            await loadPlan(root, "dark-mode-toggle"),
            before,
            "Status must not write readiness or controller state.",
        );
    });
});

test("a newer Core approval cannot reuse an earlier Attached run decision", async () => {
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
            event: "review_approved",
            currentStatus: "feedback",
        });
        await recordPlanEvent({
            cwd: root,
            planName: "dark-mode-toggle",
            event: "readiness_passed",
            currentStatus: "approved",
        });
        const before = await loadPlan(root, "dark-mode-toggle");
        const record = await readRecordBytes(root, workflow.workflowId);
        const fresh = await spawnAttachedCli("status", root, { workflowId: workflow.workflowId });
        assert(fresh.result.ok);
        assertEquals(fresh.result.workflow.state, "plan_ready");
        assertEquals(fresh.result.workflow.nextAction.kind, "plan_saved");
        assert(!fresh.result.workflow.execution);
        assertEquals((await listEntries(root)).length, 0);
        assertEquals(await loadPlan(root, "dark-mode-toggle"), before);
        assertEquals(await readRecordBytes(root, workflow.workflowId), record);
    });
});

test("an older saved run outcome without approval revision proof stays saved for later", async () => {
    await withProject(async (root) => {
        const workflow = await submitReview(root);
        const opened = await openAttachedReviewRound(root, workflow.workflowId);
        assert(opened.kind === "opened");
        await applyAttachedReviewDecision(root, workflow.workflowId, opened.basis, approval);
        const location = locateAttachedWorkflows(root);
        const loaded = await loadAttachedWorkflowRecord(location, workflow.workflowId);
        assert(loaded.status === "found" && loaded.record.review);
        const oldRecord = {
            ...loaded.record,
            review: { ...loaded.record.review },
            revision: loaded.record.revision + 1,
        };
        delete oldRecord.review.approvalControllerRevision;
        const written = await writeAttachedWorkflowRecord(location, oldRecord, loaded.record.revision);
        assertEquals(written.status, "written");
        const before = await loadPlan(root, "dark-mode-toggle");
        const record = await readRecordBytes(root, workflow.workflowId);
        const status = await runOperation("status", root, { workflowId: workflow.workflowId });
        assert(status.ok);
        assertEquals(status.workflow.state, "plan_ready");
        assertEquals(status.workflow.nextAction.kind, "plan_saved");
        assertEquals((await listEntries(root)).length, 0);
        assertEquals(await loadPlan(root, "dark-mode-toggle"), before);
        assertEquals(await readRecordBytes(root, workflow.workflowId), record);
    });
});

test("reopening after a controller-only draft update rejects the old browser basis without writes", async () => {
    await withProject(async (root) => {
        const workflow = await submitReview(root);
        const first = await openAttachedReviewRound(root, workflow.workflowId);
        assert(first.kind === "opened");
        await updatePlanFrontMatter(
            root,
            "dark-mode-toggle",
            { failureReason: "New Core evidence." },
            {},
            { expectedRevision: first.basis.review.planRevision },
        );
        const second = await openAttachedReviewRound(root, workflow.workflowId);
        assert(second.kind === "opened");
        assertEquals(second.basis.review.planRevision, first.basis.review.planRevision);
        assert(second.basis.review.controllerRevision !== first.basis.review.controllerRevision);
        const before = await loadPlan(root, "dark-mode-toggle");
        const record = await readRecordBytes(root, workflow.workflowId);
        await assertRejects(
            () => applyAttachedReviewDecision(root, workflow.workflowId, first.basis, approval),
            Error,
            "action_superseded",
        );
        assertEquals(await loadPlan(root, "dark-mode-toggle"), before);
        assertEquals(await readRecordBytes(root, workflow.workflowId), record);
        assertEquals(
            (await applyAttachedReviewDecision(root, workflow.workflowId, second.basis, approval)).kind,
            "approved",
        );
        assertEquals((await loadPlan(root, "dark-mode-toggle"))?.attrs.status, "ready_for_work");
    });
});

test("a controller-only Core update rejects a pinned Attached draft decision without writes", async () => {
    await withProject(async (root) => {
        const workflow = await submitReview(root);
        const opened = await openAttachedReviewRound(root, workflow.workflowId);
        assert(opened.kind === "opened");
        await updatePlanFrontMatter(
            root,
            "dark-mode-toggle",
            { failureReason: "New Core evidence." },
            {},
            { expectedRevision: opened.basis.review.planRevision },
        );
        const before = await loadPlan(root, "dark-mode-toggle");
        assert(before);
        const record = await readRecordBytes(root, workflow.workflowId);
        await assertRejects(
            () => applyAttachedReviewDecision(root, workflow.workflowId, opened.basis, approval),
            Error,
            "Plan changed after review opened",
        );
        assertEquals(await loadPlan(root, "dark-mode-toggle"), before);
        assertEquals(await readRecordBytes(root, workflow.workflowId), record);
    });
});
