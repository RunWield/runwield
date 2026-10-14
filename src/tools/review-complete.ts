/**
 * @module tools/review-complete
 * Custom tool for the semantic code reviewer to signal completion with a
 * structured outcome (approved + optional feedback). Analogous to
 * plan_written for planners.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { HostedSession } from "../shared/session/hosted-session.js";
import { emitReviewResultMessage } from "../shared/session/workflow-messages.js";
import { recordWorkflowMetric } from "../shared/workflow/metrics.js";
import { publishWorkflowToolEvent } from "../shared/workflow/workflow-tool-events.ts";
import type { ReviewLedger } from "../shared/workflow/review-ledger.ts";
import type { ReviewInspection } from "../shared/workflow/review-inspection.ts";

export type { ReviewAdvisory, ReviewFinding, ReviewIntegrationNote } from "../shared/workflow/review-outcome.ts";
import {
    normalizeReviewOutcome,
    reviewCompletionMetricDetails,
    type ReviewOutcomeDetails,
} from "../shared/workflow/review-outcome.ts";

const FINDING_PARAMS = Type.Object({
    origin: Type.Optional(
        Type.Union([Type.Literal("missed_original"), Type.Literal("repair_regression")], {
            description:
                "For a new finding after round one: was it already present before repair, or introduced by repair? Metrics only. Omit for existing IDs and first-round findings.",
        }),
    ),
    status: Type.Optional(
        Type.Union([Type.Literal("new"), Type.Literal("fix_confirmed"), Type.Literal("fix_rejected")], {
            description:
                "New defect, independently confirmed fix, or rejected fix. Only the repair completion can claim a fix.",
        }),
    ),
    rejectionReason: Type.Optional(
        Type.String({
            description: "Required for a rejected fix: what is still wrong and why the repair did not resolve it.",
        }),
    ),
    id: Type.Optional(
        Type.String({
            description:
                'Existing ledger identity this finding refers to (e.g. "R1-2"). Omit for a newly discovered issue; RunWield assigns the identity. Never invent or renumber identities.',
        }),
    ),
    resolved: Type.Optional(
        Type.Boolean({
            description:
                "Legacy equivalent of status: fix_confirmed. Prefer status; if both are supplied they must agree. An Engineer's claim is not confirmation.",
        }),
    ),
    title: Type.String({
        description: "One-line statement of the defect.",
        minLength: 1,
    }),
    requirement: Type.Optional(
        Type.String({
            description:
                "The specific Plan requirement this diverges from, or the concrete defect class if not plan-derived.",
        }),
    ),
    evidence: Type.Optional(
        Type.String({
            description: "Where to look: changed file and hunk, or the code location that demonstrates the problem.",
        }),
    ),
});

const ADVISORY_PARAMS = Type.Object({
    title: Type.String({
        description: "One-line statement of the non-blocking observation.",
        minLength: 1,
    }),
    detail: Type.Optional(
        Type.String({
            description: "Why it was raised, and any interpretation chosen or future clarification worth recording.",
        }),
    ),
});

const INTEGRATION_NOTE_PARAMS = Type.Object({
    check: Type.String({
        description: "What the integration review should check once the Epic's children are assembled.",
        minLength: 1,
    }),
    where: Type.Optional(
        Type.String({
            description: "Files, symbols, or sibling children involved.",
        }),
    ),
});

const PARAMETERS = Type.Object({
    approved: Type.Boolean({
        description: "Whether the implementation satisfies the plan requirements with no open blocking issues.",
    }),
    feedback: Type.Optional(
        Type.String({
            default: "",
            description:
                "Optional brief note about your decision. Leave this empty when you supply `findings` — RunWield renders the open findings itself. Do not restate resolved items here; they are shown as resolved from the structured result.",
        }),
    ),
    findings: Type.Optional(
        Type.Array(FINDING_PARAMS, {
            default: [],
            description:
                "Include every open issue each round: fix_confirmed or fix_rejected with rejectionReason. Use new without id for new defects. Approving with unresolved findings is rejected.",
        }),
    ),
    advisories: Type.Optional(
        Type.Array(ADVISORY_PARAMS, {
            default: [],
            description:
                "Non-blocking Review Advisories: code smells, maintainability observations, and genuine Plan ambiguity. These never block approval.",
        }),
    ),
    integrationNotes: Type.Optional(
        Type.Array(INTEGRATION_NOTE_PARAMS, {
            default: [],
            description:
                "Epic children only: what the integration review should check once the children are assembled. Never blocks this review. Omit when there is nothing to note.",
        }),
    ),
});

type ReviewCompleteDetails =
    | { outcome: "rejected"; reason: "approved_with_open_findings" | "incomplete_inspection" | "invalid_findings" }
    | ReviewOutcomeDetails;

type ReviewCompleteResult = AgentToolResult<ReviewCompleteDetails> & { terminate: boolean };

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
    return defineTool<typeof PARAMETERS, ReviewCompleteDetails>({
        name: "review_complete",
        label: "Review Complete",
        description:
            "Signal that the semantic code review is complete with a structured result. " +
            "Call with `approved: true` when the implementation satisfies the plan and no blocking issue remains. " +
            "Call with `approved: false` plus a `findings` array when it does not; each finding is one concrete defect. " +
            "Report non-blocking observations as `advisories` — they never block approval. " +
            "Finish reading every required diff chunk before either verdict. If rejected, follow the correction instructions and retry. Do not output text after an accepted completion.",
        parameters: PARAMETERS,
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
                    await recordWorkflowMetric(
                        {
                            category: "validation",
                            event: "review_complete",
                            agentName,
                            details: { ...reviewCompletionMetricDetails(result) },
                        },
                        hostedSession.cwd,
                    );
                }
                return {
                    content: [{ type: "text", text: result.message }],
                    details: { outcome: "rejected", reason: result.reason },
                    terminate: false,
                };
            }
            const { details, message } = result;
            const { approved } = details;

            emitReviewResultMessage(hostedSession, agentName, message, approved, toolCallId);
            await recordWorkflowMetric(
                {
                    category: "validation",
                    event: "review_complete",
                    agentName,
                    details: { ...reviewCompletionMetricDetails(result) },
                },
                hostedSession.cwd,
            );

            publishWorkflowToolEvent({
                hostedSession,
                toolCallId,
                kind: "review_complete",
                payload: details,
            });
            return {
                content: [{ type: "text", text: message }],
                details,
                terminate: true,
            };
        },
    });
}
