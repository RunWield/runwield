/**
 * @module tools/review-complete
 * Custom tool for the semantic code reviewer to signal completion with a
 * structured outcome (approved + optional feedback). Analogous to
 * plan_written for planners.
 */

import { toolRegistry } from "@runwield/tools";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { HostedSession } from "../shared/session/hosted-session.ts";
import { emitReviewResultMessage } from "../shared/session/workflow-messages.ts";
import { recordWorkflowOutcome, workflowOutcomeEventId } from "../shared/workflow/outcome-observations.ts";
import { workflowEvents } from "@runwield/workflow/events";
import type { ReviewLedger } from "@runwield/plans/controller-state";
import type { ReviewInspection } from "../shared/workflow/review-inspection.ts";

export type { ReviewAdvisory, ReviewFinding, ReviewIntegrationNote } from "../shared/workflow/review-outcome.ts";
import { normalizeReviewOutcome, type ReviewOutcomeDetails } from "../shared/workflow/review-outcome.ts";

const definition = toolRegistry.get("review_complete").definition;

type ReviewCompleteDetails =
    | { outcome: "rejected"; reason: "approved_with_open_findings" | "incomplete_inspection" | "invalid_findings" }
    | ReviewOutcomeDetails;

export type ReviewCompleteResult = AgentToolResult<ReviewCompleteDetails> & { terminate: boolean };

interface ReviewCompletedToolOptions {
    hostedSession: HostedSession;
    agentName?: string;
    inspection?: ReviewInspection;
    ledger?: ReviewLedger;
}

export function createReviewCompletedTool({
    hostedSession,
    agentName = "reviewer",
    inspection,
    ledger,
}: ReviewCompletedToolOptions) {
    if (!hostedSession) throw new Error("createReviewCompletedTool: hostedSession is required");
    return defineTool<typeof definition.parameters, ReviewCompleteDetails>({
        ...definition,

        async execute(toolCallId, params): Promise<ReviewCompleteResult> {
            await Promise.resolve();
            const unread = inspection?.feedback();
            if (unread) {
                return {
                    content: [{ type: "text", text: unread }],
                    details: { outcome: "rejected", reason: "incomplete_inspection" },
                    terminate: false,
                };
            }
            const result = normalizeReviewOutcome(params, ledger);
            if (!result.accepted) {
                if (result.reason === "approved_with_open_findings") {
                    await recordWorkflowOutcome(hostedSession.cwd, {
                        category: "validation",
                        event: "review_complete",
                        operationId: crypto.randomUUID(),
                        outcome: "rejected",
                        session: hostedSession.getManagedMetadata(),
                        planName: hostedSession.getActiveExecutionWorkflow()?.planName,
                    });
                }
                return {
                    content: [{ type: "text", text: result.message }],
                    details: { outcome: "rejected", reason: result.reason },
                    terminate: false,
                };
            }
            const { details, message } = result;
            const { approved, outcome, findings, advisories } = details;

            emitReviewResultMessage(hostedSession, agentName, message, approved, toolCallId);
            const event = workflowEvents(hostedSession).publish({
                toolCallId,
                kind: "review_complete",
                payload: details,
            });
            await recordWorkflowOutcome(hostedSession.cwd, {
                category: "validation",
                event: "review_complete",
                operationId: workflowOutcomeEventId("review", `${hostedSession.id}:${event.eventId}`),
                outcome,
                findingCount: findings.length,
                advisoryCount: advisories.length,
                session: hostedSession.getManagedMetadata(),
                planName: event.workflow?.planName,
            });
            return {
                content: [{ type: "text", text: message }],
                details,
                terminate: true,
            };
        },
    });
}
