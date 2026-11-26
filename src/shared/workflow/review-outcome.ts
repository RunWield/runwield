/** Bind review completion to Workflow’s findings ledger and metrics. */
import { toolRegistry, type ReviewCompleteParams, type ReviewReport } from "@runwield/tools";
import type { ReviewLedger } from "@runwield/plans/controller-state";
import { unaccountedOpenItems } from "./review-ledger.ts";

const reviewComplete = toolRegistry.get("review_complete");

/** Check submitted findings against the existing ledger before accepting a review outcome. */
export function normalizeReviewOutcome(payload: ReviewCompleteParams, ledger?: ReviewLedger): ReviewReport {
    const prepared = reviewComplete.prepare(payload);
    if (!ledger) return prepared.report;

    // Each identity was reached before the first invalid input. Preserve the submitted error order.
    const unknownId = prepared.findingIdsToCheck.find((id) => !ledger.items.some((item) => item.id === id));
    if (unknownId) {
        return {
            accepted: false,
            reason: "invalid_findings",
            message: `review_complete rejected: Unknown finding ${unknownId}. Omit id for new defects.`,
        };
    }
    if (!prepared.report.accepted && prepared.report.reason === "invalid_findings") return prepared.report;

    const missing = unaccountedOpenItems(ledger, prepared.findings);
    if (missing.length) {
        return {
            accepted: false,
            reason: "invalid_findings",
            message: `review_complete rejected: Account for every open finding: ${missing.join(", ")}. Confirm or reject each fix using its existing id.`,
        };
    }
    return prepared.report;
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
export function reviewCompletionMetricDetails(result: ReviewReport): ReviewMetricDetails | null {
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
