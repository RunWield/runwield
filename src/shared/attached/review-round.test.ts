import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { archivePlan, loadPlan } from "../../plan-store.js";
import { recordPlanEvent } from "../workflow/plan-lifecycle.js";
import { openAttachedReviewRound } from "./coordinator.ts";
import { readRecordBytes, runOperation, spawnAttachedCli, submitReview, withProject } from "./attached-test-fixture.ts";
import { loadAttachedWorkflowRecord, locateAttachedWorkflows } from "./record-store.ts";

test("opening and restoring a round pin the current Plan document without changing its review identity", async () => {
    await withProject(async (projectRoot) => {
        const submitted = await submitReview(projectRoot);
        const first = await openAttachedReviewRound(projectRoot, submitted.workflowId);
        assert(first.kind === "opened");
        assertEquals(first.basis.review, submitted.review);
        assertStringIncludes(first.basis.markdown, "Add a toggle.");
        const path = join(projectRoot, "docs/plans/dark-mode-toggle.md");
        await fsWriteFile(path, (await fsReadFile(path, "utf8")).replace("Add a toggle.", "Add a theme selector."));
        const restored = await openAttachedReviewRound(projectRoot, submitted.workflowId);
        assert(restored.kind === "opened");
        const actual = await loadPlan(projectRoot, "dark-mode-toggle");
        assert(actual);
        assertEquals(restored.basis.review.round, first.basis.review.round);
        assertEquals(restored.basis.review.actionId, first.basis.review.actionId);
        assertEquals(restored.basis.review.planRevision, actual.revision);
        assertStringIncludes(restored.basis.markdown, "Add a theme selector.");
        assertEquals(restored.basis.attrs, actual.attrs);
        assertEquals(restored.basis.triageMeta, submitted.triageOutcome);
        const record = await loadAttachedWorkflowRecord(locateAttachedWorkflows(projectRoot), submitted.workflowId);
        assert(record.status === "found");
        assertEquals(record.record.review, restored.basis.review);
        const bytes = await readRecordBytes(projectRoot, submitted.workflowId);
        assertEquals(await openAttachedReviewRound(projectRoot, submitted.workflowId), restored);
        assertEquals(await readRecordBytes(projectRoot, submitted.workflowId), bytes);
    });
});

for (const canonicalStatus of ["approved", "ready_for_work", "in_progress"] as const) {
    test(`status reads Core ${canonicalStatus} without writing; opening reconciles without a review payload`, async () => {
        await withProject(async (projectRoot) => {
            const workflow = await submitReview(projectRoot);
            await recordPlanEvent({
                cwd: projectRoot,
                planName: "dark-mode-toggle",
                event: "review_approved",
                currentStatus: "draft",
            });
            if (canonicalStatus !== "approved") {
                await recordPlanEvent({
                    cwd: projectRoot,
                    planName: "dark-mode-toggle",
                    event: "readiness_passed",
                    currentStatus: "approved",
                });
            }
            if (canonicalStatus === "in_progress") {
                await recordPlanEvent({
                    cwd: projectRoot,
                    planName: "dark-mode-toggle",
                    event: "execution_started",
                    currentStatus: "ready_for_work",
                    details: { nonGitInPlace: true },
                });
            }
            const before = await readRecordBytes(projectRoot, workflow.workflowId);
            const fresh = await spawnAttachedCli("status", projectRoot, { workflowId: workflow.workflowId });
            assertEquals(fresh.code, 0, fresh.stderr);
            assert(fresh.result.ok);
            const expectedState = canonicalStatus === "in_progress" ? "closed" : "plan_ready";
            assertEquals(fresh.result.workflow.state, expectedState);
            assertEquals(await readRecordBytes(projectRoot, workflow.workflowId), before);
            const opened = await openAttachedReviewRound(projectRoot, workflow.workflowId);
            assert(opened.kind === "not_pending");
            assertEquals(opened.workflow.state, expectedState);
            assertEquals((await loadPlan(projectRoot, "dark-mode-toggle"))?.attrs.status, canonicalStatus);
            const record = await loadAttachedWorkflowRecord(locateAttachedWorkflows(projectRoot), workflow.workflowId);
            assert(record.status === "found");
            assertEquals(record.record.state, expectedState);
            if (canonicalStatus === "in_progress") {
                assertEquals(record.record.closure?.reason, "plan_advanced_in_core");
            }
        });
    });
}

test("Core draft feedback refreshes the pending review basis without changing status reads", async () => {
    await withProject(async (projectRoot) => {
        const workflow = await submitReview(projectRoot);
        const first = await openAttachedReviewRound(projectRoot, workflow.workflowId);
        assert(first.kind === "opened");
        await recordPlanEvent({
            cwd: projectRoot,
            planName: "dark-mode-toggle",
            event: "review_feedback",
            currentStatus: "draft",
            details: { failureReason: "Please revise." },
        });
        const before = await readRecordBytes(projectRoot, workflow.workflowId);
        const status = await runOperation("status", projectRoot, { workflowId: workflow.workflowId });
        assert(status.ok);
        assertEquals(status.workflow.state, "awaiting_review");
        assertEquals(status.workflow.nextAction.kind, "review");
        assertEquals(await readRecordBytes(projectRoot, workflow.workflowId), before);
        const opened = await openAttachedReviewRound(projectRoot, workflow.workflowId);
        assert(opened.kind === "opened");
        const plan = await loadPlan(projectRoot, "dark-mode-toggle");
        assert(plan);
        assertEquals(opened.basis.review.round, first.basis.review.round);
        assertEquals(opened.basis.review.actionId, first.basis.review.actionId);
        assertEquals(opened.basis.review.controllerRevision, plan.controllerRevision);
        assert(opened.basis.review.controllerRevision !== first.basis.review.controllerRevision);
        assertEquals(plan.attrs.status, "draft");
    });
});

test("an archived Core Plan closes Attached review without a payload", async () => {
    await withProject(async (projectRoot) => {
        const workflow = await submitReview(projectRoot);
        await archivePlan(projectRoot, "dark-mode-toggle", { force: true });
        const status = await runOperation("status", projectRoot, { workflowId: workflow.workflowId });
        assert(status.ok);
        assertEquals(status.workflow.state, "closed");
        assertEquals(status.workflow.closure?.reason, "plan_advanced_in_core");
        const opened = await openAttachedReviewRound(projectRoot, workflow.workflowId);
        assert(opened.kind === "not_pending");
        assertEquals(opened.workflow.state, "closed");
    });
});
