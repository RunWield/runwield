import { test } from "node:test";
import { ok as assert, strictEqual as equal } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setCustomSetting } from "../../../shared/settings.js";
import { drainWorkflowMetrics, getWorkflowMetricsFilePath } from "../../../shared/workflow/metrics.js";
import { applyAttachedReviewDecision, openAttachedReviewRound } from "../../../shared/attached/coordinator.ts";
import {
    planWrittenInput,
    runOperation,
    submitReview,
    withProject,
} from "../../../shared/attached/attached-test-fixture.ts";
import { evaluateEvidence } from "./evaluator.ts";
import { completeEvidence, editJson, putFile, RECORD } from "./evidence-test-fixture.ts";
import { type AcceptanceEvidence, type JsonMap } from "./evidence.ts";

const OPERATIONS = [
    "plan_event:readiness_passed",
    "plan_review_feedback",
    "plan_review_approved",
    "plan_event:execution_started",
    "plan_event:implementation_finished",
    "plan_event:mechanical_validation_passed",
    "plan_event:semantic_review_feedback",
    "plan_event:semantic_review_passed",
    "plan_event:validation_passed",
];

function writeMetrics(evidence: AcceptanceEvidence, rows: JsonMap[]) {
    const delivered = evidence.snapshots.delivered;
    assert(delivered);
    const file = delivered.files.find((file) => file.path.endsWith("metrics.jsonl"));
    assert(file);
    putFile(delivered, file.path, rows.map((row) => JSON.stringify(row)).join("\n"));
}
function metricRows(): JsonMap[] {
    return OPERATIONS.map((operation) => ({
        planName: "feature",
        event: "plan_transition_committed",
        details: { operation },
    }));
}
function outcome(evidence: AcceptanceEvidence) {
    return evaluateEvidence(evidence).checks.find((row) => row.id === "lifecycle-events")?.outcome;
}

test("Core Plan review decision metrics satisfy lifecycle evidence without invented event names", async () => {
    await withProject(async (root) => {
        await setCustomSetting("workflowMetrics", true, "project", root);
        const workflow = await submitReview(root);
        const first = await openAttachedReviewRound(root, workflow.workflowId);
        assert(first.kind === "opened");
        equal(
            (await applyAttachedReviewDecision(root, workflow.workflowId, first.basis, { feedback: "Use a selector." }))
                .kind,
            "feedback",
        );
        const fresh = await runOperation("status", root, { workflowId: workflow.workflowId });
        assert(fresh.ok && fresh.workflow.nextAction.kind === "plan");
        const resubmitted = await runOperation(
            "plan_written",
            root,
            planWrittenInput({
                workflowId: workflow.workflowId,
                actionId: fresh.workflow.nextAction.actionId,
                expectedRevision: fresh.workflow.revision,
                operationId: "resubmit-after-feedback",
            }),
        );
        assert(resubmitted.ok);
        const second = await openAttachedReviewRound(root, workflow.workflowId);
        assert(second.kind === "opened");
        equal(
            (
                await applyAttachedReviewDecision(root, workflow.workflowId, second.basis, {
                    approved: true,
                    approvalAction: "run",
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                })
            ).kind,
            "approved",
        );
        await drainWorkflowMetrics();
        const actual: JsonMap[] = (await readFile(getWorkflowMetricsFilePath(root), "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        const evidence = completeEvidence();
        const delivered = evidence.snapshots.delivered;
        assert(delivered);
        editJson(delivered, RECORD, (record) => {
            assert(record.plan && !Array.isArray(record.plan) && typeof record.plan === "object");
            record.plan.planName = "dark-mode-toggle";
        });
        // Keep the other lifecycle observations; source review observations from real Core decisions.
        const rest = metricRows().filter(
            (row) => !String((row.details as JsonMap).operation).startsWith("plan_review_"),
        );
        writeMetrics(evidence, [...rest.map((row) => ({ ...row, planName: "dark-mode-toggle" })), ...actual]);
        equal(outcome(evidence), "pass");
    });
});

for (const event of ["plan_transition_committed", "semantic_transition_committed"]) {
    test(`canonical operations with ${event} prove lifecycle transitions`, () => {
        const evidence = completeEvidence();
        writeMetrics(
            evidence,
            metricRows().map((row) => ({ ...row, event })),
        );
        equal(outcome(evidence), "pass");
    });
}

for (const operation of OPERATIONS) {
    test(`missing committed lifecycle operation fails: ${operation}`, () => {
        const evidence = completeEvidence();
        writeMetrics(
            evidence,
            metricRows().filter((row) => (row.details as JsonMap).operation !== operation),
        );
        equal(outcome(evidence), "fail");
    });
}
for (const operation of ["plan_review_feedback", "plan_review_approved"]) {
    test(`another Plan cannot supply ${operation}`, () => {
        const evidence = completeEvidence();
        const rows = metricRows();
        const row = rows.find((row) => (row.details as JsonMap).operation === operation)!;
        row.planName = "other-plan";
        writeMetrics(evidence, rows);
        equal(outcome(evidence), "fail");
    });
    test(`an invented generic Plan event cannot replace ${operation}`, () => {
        const evidence = completeEvidence();
        const rows = metricRows();
        const row = rows.find((row) => (row.details as JsonMap).operation === operation)!;
        (row.details as JsonMap).operation = `plan_event:${operation.replace("plan_", "")}`;
        writeMetrics(evidence, rows);
        equal(outcome(evidence), "fail");
    });
}
test("uncommitted metrics cannot prove lifecycle transitions", () => {
    const evidence = completeEvidence();
    writeMetrics(
        evidence,
        metricRows().map((row) => ({ ...row, event: "plan_transition_failed" })),
    );
    equal(outcome(evidence), "fail");
});
