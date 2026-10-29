import { test } from "node:test";
import { readFile as fsReadFile } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import { loadPlan } from "../../plan-store.js";
import { applyAttachedReviewDecision, openAttachedReviewRound } from "./coordinator.ts";
import { loadAttachedWorkflowRecord, locateAttachedWorkflows, writeAttachedWorkflowRecord } from "./record-store.ts";
import { spawnAttachedCli, submitReview, withProject } from "./attached-test-fixture.ts";

test("a saved pending checkpoint with committed approval/readiness recovers without replaying Plan writes", async () => {
    await withProject(async (root) => {
        const workflow = await submitReview(root);
        const location = locateAttachedWorkflows(root);
        const pending = await loadAttachedWorkflowRecord(location, workflow.workflowId);
        assert(pending.status === "found");
        const opened = await openAttachedReviewRound(root, workflow.workflowId);
        assert(opened.kind === "opened");
        await applyAttachedReviewDecision(root, workflow.workflowId, opened.basis, {
            approved: true,
            approvalAction: "run",
            executionAgent: "engineer",
            collaborationRecommendation: "autonomous",
        });
        const applied = await loadAttachedWorkflowRecord(location, workflow.workflowId);
        assert(applied.status === "found");
        // Recreate the disk checkpoint left by loss between Core and Attached commits.
        assertEquals(
            (await writeAttachedWorkflowRecord(location, pending.record, applied.record.revision)).status,
            "written",
        );
        const bytes = await fsReadFile(opened.basis.planPath, "utf8");
        const fresh = await spawnAttachedCli("status", root, { workflowId: workflow.workflowId });
        assert(fresh.result.ok);
        assertEquals(fresh.result.workflow.state, "plan_ready");
        const restored = await openAttachedReviewRound(root, workflow.workflowId);
        assert(restored.kind === "not_pending");
        assertEquals(restored.workflow.state, "plan_ready");
        assertEquals(await fsReadFile(opened.basis.planPath, "utf8"), bytes);
        assertEquals((await loadPlan(root, "dark-mode-toggle"))?.attrs.status, "ready_for_work");
        assertEquals(restored.workflow.review?.outcome, undefined, "Recovery must not invent a browser outcome.");
    });
});
