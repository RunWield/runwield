import { ok as assert } from "node:assert/strict";
import { applyAttachedReviewDecision, openAttachedReviewRound } from "./coordinator.ts";
import { EVIDENCE, runOperation, submitReview } from "./attached-test-fixture.ts";
import { type AttachedJsonObject, type AttachedWorkflowView } from "./operations.ts";

export async function readyPlan(root: string): Promise<AttachedWorkflowView> {
    const submitted = await submitReview(root);
    const round = await openAttachedReviewRound(root, submitted.workflowId);
    assert(round.kind === "opened");
    await applyAttachedReviewDecision(root, submitted.workflowId, round.basis, {
        approved: true,
        approvalAction: "run",
        executionAgent: "engineer",
        collaborationRecommendation: "autonomous",
    });
    const status = await runOperation("status", root, { workflowId: submitted.workflowId });
    assert(status.ok);
    return status.workflow;
}

export function executionInput(
    workflow: AttachedWorkflowView,
    operationId: string,
    payload: AttachedJsonObject = {},
): AttachedJsonObject {
    return {
        operationId,
        workflowId: workflow.workflowId,
        expectedRevision: workflow.revision,
        evidence: EVIDENCE,
        payload,
    };
}

export async function implementing(root: string) {
    const ready = await readyPlan(root);
    const started = await runOperation("start_execution", root, executionInput(ready, "start"));
    assert(started.ok && started.workflow.nextAction.kind === "implementation", JSON.stringify(started));
    return started;
}

export function completionInput(workflow: AttachedWorkflowView, operationId = "complete") {
    assert(workflow.nextAction.kind === "implementation");
    return executionInput(workflow, operationId, {
        actionId: workflow.nextAction.actionId,
        message: "- Added the toggle.\n- Focused checks passed.",
    });
}
