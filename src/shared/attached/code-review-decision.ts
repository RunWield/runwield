/** Browser decisions use the same durable validation operation as the MCP carrier. */
import { runValidationOperation } from "./coordinator.ts";
import { loadReviewFeedbackImagePaths } from "../workflow/review-feedback-images.ts";
import { normalizeCodeReviewDecision } from "../../ui/review/code-review.ts";
import { loadAttachedWorkflowRecord, locateAttachedWorkflows } from "./record-store.ts";
import { buildHumanReviewFeedbackText } from "../workflow/validation-human-review.ts";
import type { ReviewDecision } from "../../ui/workspace/routes/api/review-handlers.js";

export async function applyAttachedCodeReviewDecision(
    projectRoot: string,
    workflowId: string,
    actionId: string,
    decision: ReviewDecision,
): Promise<void> {
    if (decision.conversationTurn) throw new Error("Review chat is not available in this Preview step.");
    const loaded = await loadAttachedWorkflowRecord(locateAttachedWorkflows(projectRoot), workflowId);
    if (loaded.status !== "found") throw new Error("The Attached workflow cannot be restored.");
    const record = loaded.record;
    if (record.validation?.actionId !== actionId) throw new Error("The code review round changed. Read status.");
    const normalized = normalizeCodeReviewDecision(JSON.parse(JSON.stringify(decision)));
    const canceled = normalized.canceled || normalized.exit;
    const paths = await loadReviewFeedbackImagePaths(
        decision,
        String(
            record.validation?.request?.kind === "decision"
                ? record.validation.request.interaction._meta?.executionCwd
                : projectRoot,
        ),
    );
    const feedback = [
        buildHumanReviewFeedbackText(normalized.feedback, normalized.annotations),
        paths.length ? `Read these review image attachments before repairing:\n${paths.join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
    const result = await runValidationOperation("validation_decision", {
        projectRoot,
        workflowId,
        operationId: crypto.randomUUID(),
        expectedRevision: record.revision,
        evidence: record.evidence,
        payload: {
            actionId,
            answer: {
                outcome: canceled ? "canceled" : decision.approved ? "approved" : "feedback",
                message: canceled || decision.approved ? undefined : feedback,
            },
        },
    });
    if (!result.ok) throw new Error(result.rejection.message);
}
