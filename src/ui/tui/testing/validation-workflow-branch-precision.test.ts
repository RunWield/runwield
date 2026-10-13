import { assertEquals } from "../../../testing/assertions.ts";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { VALIDATION_WORKFLOW_BRANCHES, type ValidationWorkflowBranchId } from "./validation-workflow-coverage.ts";

function branch(id: ValidationWorkflowBranchId) {
    const found = VALIDATION_WORKFLOW_BRANCHES.find((entry) => entry.id === id);
    assert(found, `Missing validation branch ${id}.`);
    return found;
}

test("human review none and ask-skip branches have independent owners and evidence", () => {
    const none = branch("human-review:none");
    const askSkip = branch("human-review:ask-skip");

    assertEquals(none.owner, "validation-tree-human-review-none");
    assertEquals(askSkip.owner, "validation-tree-human-review-ask-skip");
    assertEquals(none.evidence.stateEquals["projectState.plans.0.controllerState.humanReviewMode"], "none");
    assertEquals(none.evidence.stateEquals["projectState.plans.0.controllerState.humanReviewDecision"], "not_required");
    assert(none.evidence.interactionAbsentValues.includes("skip"));
    assertEquals(askSkip.evidence.stateEquals["projectState.plans.0.controllerState.humanReviewMode"], "ask");
    assertEquals(askSkip.evidence.stateEquals["projectState.plans.0.controllerState.humanReviewDecision"], "skipped");
    assert(askSkip.evidence.interactionValues.includes("skip"));
});
