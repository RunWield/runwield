/**
 * @module tools/review-complete
 * Custom tool for the semantic code reviewer to signal completion with a
 * structured outcome (approved + optional feedback). Analogous to
 * plan_written for planners.
 */

import { type Static, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { HostedSession } from "../shared/session/hosted-session.js";
import { emitReviewResultMessage } from "../shared/session/workflow-messages.js";
import { recordWorkflowOutcome, workflowOutcomeEventId } from "../shared/workflow/outcome-observations.ts";
import { publishWorkflowToolEvent } from "../shared/workflow/workflow-tool-events.ts";
import { type ReviewLedger, unaccountedOpenItems } from "../shared/workflow/review-ledger.ts";
import type { ReviewInspection } from "../shared/workflow/review-inspection.ts";

export interface ReviewFinding {
    id?: string;
    resolved: boolean;
    title: string;
    requirement: string;
    evidence: string;
    status?: "new" | "fix_confirmed" | "fix_rejected";
    rejectionReason?: string;
    /** Reviewer attribution for diagnostics only; not persisted as a ledger state. */
    origin?: "missed_original" | "repair_regression";
}

/** Something only the assembled Epic can show, left by an Epic child's reviewer for the integration review. */
export interface ReviewIntegrationNote {
    check: string;
    where: string;
}

export interface ReviewAdvisory {
    title: string;
    detail: string;
}

const FINDING_PARAMS = Type.Object({
    origin: Type.Optional(Type.Union([Type.Literal("missed_original"), Type.Literal("repair_regression")], {
        description:
            "For a new finding after round one: was it already present before repair, or introduced by repair? Metrics only. Omit for existing IDs and first-round findings.",
    })),
    status: Type.Optional(Type.Union([
        Type.Literal("new"),
        Type.Literal("fix_confirmed"),
        Type.Literal("fix_rejected"),
    ], {
        description:
            "New defect, independently confirmed fix, or rejected fix. Only the repair completion can claim a fix.",
    })),
    rejectionReason: Type.Optional(
        Type.String({
            description: "Required for a rejected fix: what is still wrong and why the repair did not resolve it.",
        }),
    ),
    id: Type.Optional(Type.String({
        description:
            'Existing ledger identity this finding refers to (e.g. "R1-2"). Omit for a newly discovered issue; RunWield assigns the identity. Never invent or renumber identities.',
    })),
    resolved: Type.Optional(Type.Boolean({
        description:
            "Legacy equivalent of status: fix_confirmed. Prefer status; if both are supplied they must agree. An Engineer's claim is not confirmation.",
    })),
    title: Type.String({
        description: "One-line statement of the defect.",
        minLength: 1,
    }),
    requirement: Type.Optional(Type.String({
        description:
            "The specific Plan requirement this diverges from, or the concrete defect class if not plan-derived.",
    })),
    evidence: Type.Optional(Type.String({
        description: "Where to look: changed file and hunk, or the code location that demonstrates the problem.",
    })),
});

const ADVISORY_PARAMS = Type.Object({
    title: Type.String({
        description: "One-line statement of the non-blocking observation.",
        minLength: 1,
    }),
    detail: Type.Optional(Type.String({
        description: "Why it was raised, and any interpretation chosen or future clarification worth recording.",
    })),
});

const INTEGRATION_NOTE_PARAMS = Type.Object({
    check: Type.String({
        description: "What the integration review should check once the Epic's children are assembled.",
        minLength: 1,
    }),
    where: Type.Optional(Type.String({
        description: "Files, symbols, or sibling children involved.",
    })),
});

const PARAMETERS = Type.Object({
    approved: Type.Boolean({
        description: "Whether the implementation satisfies the plan requirements with no open blocking issues.",
    }),
    feedback: Type.Optional(Type.String({
        default: "",
        description:
            "Optional brief note about your decision. Leave this empty when you supply `findings` — RunWield renders the open findings itself. Do not restate resolved items here; they are shown as resolved from the structured result.",
    })),
    findings: Type.Optional(Type.Array(FINDING_PARAMS, {
        default: [],
        description:
            "Include every open issue each round: fix_confirmed or fix_rejected with rejectionReason. Use new without id for new defects. Approving with unresolved findings is rejected.",
    })),
    advisories: Type.Optional(Type.Array(ADVISORY_PARAMS, {
        default: [],
        description:
            "Non-blocking Review Advisories: code smells, maintainability observations, and genuine Plan ambiguity. These never block approval.",
    })),
    integrationNotes: Type.Optional(Type.Array(INTEGRATION_NOTE_PARAMS, {
        default: [],
        description:
            "Epic children only: what the integration review should check once the children are assembled. Never blocks this review. Omit when there is nothing to note.",
    })),
});

type ReviewFindingParam = Static<typeof FINDING_PARAMS>;
type ReviewAdvisoryParam = Static<typeof ADVISORY_PARAMS>;
type ReviewIntegrationNoteParam = Static<typeof INTEGRATION_NOTE_PARAMS>;

type ReviewCompleteDetails =
    | { outcome: "rejected"; reason: "approved_with_open_findings" | "incomplete_inspection" | "invalid_findings" }
    | {
        outcome: "approved" | "feedback";
        approved: boolean;
        feedback: string;
        findings: ReviewFinding[];
        advisories: ReviewAdvisory[];
        integrationNotes: ReviewIntegrationNote[];
    };

type ReviewCompleteResult = AgentToolResult<ReviewCompleteDetails> & { terminate: boolean };

interface ReviewCompletedToolOptions {
    hostedSession: HostedSession;
    agentName?: string;
    inspection?: ReviewInspection;
    ledger?: ReviewLedger;
}

export function createReviewCompletedTool(
    { hostedSession, agentName = "reviewer", inspection, ledger }: ReviewCompletedToolOptions,
) {
    if (!hostedSession) throw new Error("createReviewCompletedTool: hostedSession is required");
    return defineTool<typeof PARAMETERS, ReviewCompleteDetails>({
        name: "review_complete",
        label: "Review Complete",
        description: "Signal that the semantic code review is complete with a structured result. " +
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
            const approved = params.approved === true;
            const feedback = typeof params.feedback === "string" ? params.feedback.trim() : "";
            const findings = normalizeFindings(params.findings);
            const advisories = normalizeAdvisories(params.advisories);
            const integrationNotes = normalizeIntegrationNotes(params.integrationNotes);
            const openFindings = findings.filter((finding) => !finding.resolved);
            const findingError = validateFindingStates(params.findings || [], ledger);
            if (findingError) {
                return {
                    content: [{ type: "text", text: `review_complete rejected: ${findingError}` }],
                    details: { outcome: "rejected", reason: "invalid_findings" },
                    terminate: false,
                };
            }

            if (approved && openFindings.length > 0) {
                const rejection = `Cannot approve with ${openFindings.length} unresolved finding(s). ` +
                    "Either resolve them (resolved: true, after verifying the fix in the code) or call " +
                    "review_complete with approved: false.";
                await recordWorkflowOutcome(hostedSession.cwd, {
                    category: "validation",
                    event: "review_complete",
                    operationId: crypto.randomUUID(),
                    outcome: "rejected",
                    session: hostedSession.getManagedMetadata(),
                    planName: hostedSession.getActiveExecutionWorkflow()?.planName,
                });
                return {
                    content: [{ type: "text", text: `review_complete rejected: ${rejection}` }],
                    details: { outcome: "rejected", reason: "approved_with_open_findings" },
                    terminate: false,
                };
            }

            const outcome: "approved" | "feedback" = approved ? "approved" : "feedback";
            const resolvedCount = findings.length - openFindings.length;
            const projection = findings.length > 0 ? formatFindingsProjection(openFindings) : feedback;
            const openLabel = openFindings.length === 1 ? "1 issue open" : `${openFindings.length} issues open`;
            const resolvedNote = resolvedCount > 0 ? `, ${resolvedCount} resolved this round` : "";
            const message = approved
                ? "Semantic review approved — implementation matches the plan."
                : `Semantic review rejected — ${
                    findings.length > 0 ? `${openLabel}${resolvedNote}` : "issues found"
                }:\n${projection || "(no feedback provided)"}`;

            emitReviewResultMessage(hostedSession, agentName, message, approved, toolCallId);
            const details = { outcome, approved, feedback: projection, findings, advisories, integrationNotes };
            const event = publishWorkflowToolEvent({
                hostedSession,
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

function normalizeIntegrationNotes(value: ReviewIntegrationNoteParam[] | undefined): ReviewIntegrationNote[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((note) => {
        const check = note.check.trim();
        return check ? [{ check, where: typeof note.where === "string" ? note.where.trim() : "" }] : [];
    });
}

function normalizeFindings(value: ReviewFindingParam[] | undefined): ReviewFinding[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((finding) => {
        const title = finding.title.trim();
        if (!title) return [];
        return [{
            id: typeof finding.id === "string" && finding.id.trim() ? finding.id.trim() : undefined,
            resolved: finding.status ? finding.status === "fix_confirmed" : finding.resolved === true,
            status: finding.status || (finding.resolved ? "fix_confirmed" : finding.id ? "fix_rejected" : "new"),
            rejectionReason: finding.rejectionReason?.trim() || "",
            ...(finding.origin ? { origin: finding.origin } : {}),
            title,
            requirement: typeof finding.requirement === "string" ? finding.requirement.trim() : "",
            evidence: typeof finding.evidence === "string" ? finding.evidence.trim() : "",
        }];
    });
}

function validateFindingStates(findings: ReviewFindingParam[], ledger?: ReviewLedger): string {
    const ids = new Set<string>();
    for (const finding of findings) {
        if (
            finding.status && finding.resolved !== undefined &&
            finding.resolved !== (finding.status === "fix_confirmed")
        ) {
            return "status and resolved contradict each other. Use status to state the decision.";
        }
        if (finding.id) {
            if (ids.has(finding.id)) return `Report ${finding.id} exactly once.`;
            ids.add(finding.id);
            if (ledger && !ledger.items.some((item) => item.id === finding.id)) {
                return `Unknown finding ${finding.id}. Omit id for new defects.`;
            }
            if (finding.status === "new") {
                return `Keep ${finding.id} under its existing identity and use fix_rejected with a reason, or fix_confirmed.`;
            }
        } else if (finding.status === "fix_confirmed" || finding.status === "fix_rejected" || finding.resolved) {
            return "A fix decision requires an existing finding id. Use new without an id for a new defect.";
        }
        const rejectsFix = finding.status === "fix_rejected" || (finding.id && !finding.status && !finding.resolved);
        if (rejectsFix && !finding.rejectionReason?.trim()) {
            return `Explain why the fix for ${finding.id} is rejected in rejectionReason.`;
        }
    }
    if (ledger) {
        const missing = unaccountedOpenItems(ledger, normalizeFindings(findings));
        if (missing.length) {
            return `Account for every open finding: ${
                missing.join(", ")
            }. Confirm or reject each fix using its existing id.`;
        }
    }
    return "";
}

function normalizeAdvisories(value: ReviewAdvisoryParam[] | undefined): ReviewAdvisory[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((advisory) => {
        const title = advisory.title.trim();
        if (!title) return [];
        return [{
            title,
            detail: typeof advisory.detail === "string" ? advisory.detail.trim() : "",
        }];
    });
}

function formatFindingsProjection(openFindings: ReviewFinding[]): string {
    return openFindings
        .map((finding) => {
            const parts = [`- ${finding.id ? `${finding.id} — ` : ""}${finding.title}`];
            if (finding.requirement) parts.push(`  Plan: ${finding.requirement}`);
            if (finding.evidence) parts.push(`  Evidence: ${finding.evidence}`);
            if (finding.rejectionReason) parts.push(`  Fix rejected: ${finding.rejectionReason}`);
            return parts.join("\n");
        })
        .join("\n");
}
