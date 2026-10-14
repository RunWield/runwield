/** Host-neutral review completion normalization and ledger identity gates. */
import { type ReviewLedger, unaccountedOpenItems } from "./review-ledger.ts";

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

export interface ReviewFindingInput {
    id?: string;
    resolved?: boolean;
    title: string;
    requirement?: string;
    evidence?: string;
    status?: "new" | "fix_confirmed" | "fix_rejected";
    rejectionReason?: string;
    origin?: "missed_original" | "repair_regression";
}
export interface ReviewAdvisoryInput {
    title: string;
    detail?: string;
}
export interface ReviewIntegrationNoteInput {
    check: string;
    where?: string;
}
export interface ReviewCompletePayload {
    approved: boolean;
    feedback?: string;
    findings?: ReviewFindingInput[];
    advisories?: ReviewAdvisoryInput[];
    integrationNotes?: ReviewIntegrationNoteInput[];
}
export interface ReviewOutcomeDetails {
    outcome: "approved" | "feedback";
    approved: boolean;
    feedback: string;
    findings: ReviewFinding[];
    advisories: ReviewAdvisory[];
    integrationNotes: ReviewIntegrationNote[];
}
export interface AcceptedReviewOutcome {
    accepted: true;
    details: ReviewOutcomeDetails;
    message: string;
    openFindingCount: number;
    resolvedFindingCount: number;
}
export interface RejectedReviewOutcome {
    accepted: false;
    reason: "invalid_findings" | "approved_with_open_findings";
    message: string;
}
export type ReviewOutcome = AcceptedReviewOutcome | RejectedReviewOutcome;

export function normalizeReviewOutcome(payload: ReviewCompletePayload, ledger?: ReviewLedger): ReviewOutcome {
    const approved = payload.approved === true;
    const feedback = typeof payload.feedback === "string" ? payload.feedback.trim() : "";
    const findings = normalizeFindings(payload.findings);
    const advisories = normalizeAdvisories(payload.advisories);
    const integrationNotes = normalizeIntegrationNotes(payload.integrationNotes);
    const openFindings = findings.filter((finding) => !finding.resolved);
    const findingError = validateFindingStates(payload.findings || [], ledger);
    if (findingError) {
        return { accepted: false, reason: "invalid_findings", message: `review_complete rejected: ${findingError}` };
    }
    if (approved && openFindings.length > 0) {
        const rejection =
            `Cannot approve with ${openFindings.length} unresolved finding(s). ` +
            "Either resolve them (resolved: true, after verifying the fix in the code) or call " +
            "review_complete with approved: false.";
        return {
            accepted: false,
            reason: "approved_with_open_findings",
            message: `review_complete rejected: ${rejection}`,
        };
    }

    const outcome: "approved" | "feedback" = approved ? "approved" : "feedback";
    const resolvedCount = findings.length - openFindings.length;
    const projection = findings.length > 0 ? formatFindingsProjection(openFindings) : feedback;
    const openLabel = openFindings.length === 1 ? "1 issue open" : `${openFindings.length} issues open`;
    const resolvedNote = resolvedCount > 0 ? `, ${resolvedCount} resolved this round` : "";
    const message = approved
        ? "Semantic review approved — implementation matches the plan."
        : `Semantic review rejected — ${findings.length > 0 ? `${openLabel}${resolvedNote}` : "issues found"}:\n${
              projection || "(no feedback provided)"
          }`;

    return {
        accepted: true,
        details: { outcome, approved, feedback: projection, findings, advisories, integrationNotes },
        message,
        openFindingCount: openFindings.length,
        resolvedFindingCount: resolvedCount,
    };
}

function normalizeIntegrationNotes(value: ReviewIntegrationNoteInput[] | undefined): ReviewIntegrationNote[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((note) => {
        const check = note.check.trim();
        return check ? [{ check, where: typeof note.where === "string" ? note.where.trim() : "" }] : [];
    });
}

function normalizeFindings(value: ReviewFindingInput[] | undefined): ReviewFinding[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((finding) => {
        const title = finding.title.trim();
        if (!title) return [];
        return [
            {
                id: typeof finding.id === "string" && finding.id.trim() ? finding.id.trim() : undefined,
                resolved: finding.status ? finding.status === "fix_confirmed" : finding.resolved === true,
                status: finding.status || (finding.resolved ? "fix_confirmed" : finding.id ? "fix_rejected" : "new"),
                rejectionReason: finding.rejectionReason?.trim() || "",
                ...(finding.origin ? { origin: finding.origin } : {}),
                title,
                requirement: typeof finding.requirement === "string" ? finding.requirement.trim() : "",
                evidence: typeof finding.evidence === "string" ? finding.evidence.trim() : "",
            },
        ];
    });
}

function validateFindingStates(findings: ReviewFindingInput[], ledger?: ReviewLedger): string {
    const ids = new Set<string>();
    for (const finding of findings) {
        if (
            finding.status &&
            finding.resolved !== undefined &&
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
            return `Account for every open finding: ${missing.join(
                ", ",
            )}. Confirm or reject each fix using its existing id.`;
        }
    }
    return "";
}

function normalizeAdvisories(value: ReviewAdvisoryInput[] | undefined): ReviewAdvisory[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((advisory) => {
        const title = advisory.title.trim();
        if (!title) return [];
        return [
            {
                title,
                detail: typeof advisory.detail === "string" ? advisory.detail.trim() : "",
            },
        ];
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

export type AcceptedReviewMetricDetails = {
    outcome: "approved" | "feedback";
    approved: boolean;
    hasFeedback: boolean;
    findingCount: number;
    openFindingCount: number;
    resolvedFindingCount: number;
    advisoryCount: number;
};
export type RejectedReviewMetricDetails = { outcome: "rejected"; reason: "approved_with_open_findings" };
export type ReviewMetricDetails = AcceptedReviewMetricDetails | RejectedReviewMetricDetails;

/** Metric data for the same accepted/rejected completion contract on every host. */
export function reviewCompletionMetricDetails(result: ReviewOutcome): ReviewMetricDetails | null {
    if (!result.accepted) {
        return result.reason === "approved_with_open_findings" ? { outcome: "rejected", reason: result.reason } : null;
    }
    const { outcome, approved, feedback, findings, advisories } = result.details;
    return {
        outcome,
        approved,
        hasFeedback: Boolean(feedback),
        findingCount: findings.length,
        openFindingCount: result.openFindingCount,
        resolvedFindingCount: result.resolvedFindingCount,
        advisoryCount: advisories.length,
    };
}
