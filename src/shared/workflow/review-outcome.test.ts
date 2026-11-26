import { test } from "node:test";
import { deepStrictEqual } from "node:assert/strict";
import type { ReviewFindingInput } from "@runwield/tools";
import { normalizeReviewOutcome, reviewCompletionMetricDetails } from "./review-outcome.ts";
import type { ReviewLedger } from "@runwield/plans/controller-state";

// Literal contract values captured from review-complete.ts before extraction.
const LEDGER: ReviewLedger = {
    sequence: 1,
    items: [
        {
            id: "R1-1",
            openedInRound: 1,
            resolvedInRound: null,
            title: "Original",
            requirement: "",
            evidence: "",
            status: "fix_claimed",
        },
    ],
};
const FIX: ReviewFindingInput = { id: "R1-1", title: " Fixed ", status: "fix_confirmed" };

const INVALID_CASES: [string, ReviewFindingInput[], string][] = [
    [
        "contradictory states",
        [{ ...FIX, resolved: false }],
        "status and resolved contradict each other. Use status to state the decision.",
    ],
    ["duplicate identities", [FIX, FIX], "Report R1-1 exactly once."],
    ["invented or renumbered identity", [{ ...FIX, id: "R2-1" }], "Unknown finding R2-1. Omit id for new defects."],
    [
        "existing identity marked new",
        [{ ...FIX, status: "new" }],
        "Keep R1-1 under its existing identity and use fix_rejected with a reason, or fix_confirmed.",
    ],
    [
        "fix without identity",
        [{ title: "fixed", status: "fix_confirmed" }],
        "A fix decision requires an existing finding id. Use new without an id for a new defect.",
    ],
    [
        "rejected fix without reason",
        [{ ...FIX, status: "fix_rejected" }],
        "Explain why the fix for R1-1 is rejected in rejectionReason.",
    ],
    [
        "legacy rejection without reason",
        [{ id: "R1-1", title: "broken", resolved: false }],
        "Explain why the fix for R1-1 is rejected in rejectionReason.",
    ],
    [
        "missing ledger item",
        [],
        "Account for every open finding: R1-1. Confirm or reject each fix using its existing id.",
    ],
];
for (const [label, findings, error] of INVALID_CASES) {
    test(`review outcome rejects ${label}`, () => {
        deepStrictEqual(normalizeReviewOutcome({ approved: true, findings }, LEDGER), {
            accepted: false,
            reason: "invalid_findings",
            message: `review_complete rejected: ${error}`,
        });
    });
}

test("review completion metrics describe only accepted or approval-rejected payloads", () => {
    deepStrictEqual(
        reviewCompletionMetricDetails(normalizeReviewOutcome({ approved: true, findings: [FIX] }, LEDGER)),
        {
            outcome: "approved",
            approved: true,
            hasFeedback: false,
            findingCount: 1,
            openFindingCount: 0,
            resolvedFindingCount: 1,
            advisoryCount: 0,
        },
    );
    deepStrictEqual(
        reviewCompletionMetricDetails(normalizeReviewOutcome({ approved: true, findings: [{ title: "Open" }] })),
        {
            outcome: "rejected",
            reason: "approved_with_open_findings",
        },
    );
    deepStrictEqual(reviewCompletionMetricDetails(normalizeReviewOutcome({ approved: true }, LEDGER)), null);
});

test("review validation preserves the order of submission and ledger diagnostics", () => {
    const contradiction: ReviewFindingInput = { ...FIX, resolved: false };
    const invented: ReviewFindingInput = { ...FIX, id: "R2-1", status: "new" };
    const expectedContradiction = {
        accepted: false,
        reason: "invalid_findings",
        message:
            "review_complete rejected: status and resolved contradict each other. Use status to state the decision.",
    };
    const expectedUnknown = {
        accepted: false,
        reason: "invalid_findings",
        message: "review_complete rejected: Unknown finding R2-1. Omit id for new defects.",
    };
    deepStrictEqual(
        normalizeReviewOutcome({ approved: true, findings: [contradiction, invented] }, LEDGER),
        expectedContradiction,
    );
    deepStrictEqual(
        normalizeReviewOutcome({ approved: true, findings: [invented, contradiction] }, LEDGER),
        expectedUnknown,
    );
    deepStrictEqual(
        normalizeReviewOutcome({ approved: true, findings: [{ ...contradiction, id: invented.id }] }, LEDGER),
        expectedContradiction,
    );
    deepStrictEqual(normalizeReviewOutcome({ approved: true, findings: [{ title: "A new finding" }] }, LEDGER), {
        accepted: false,
        reason: "invalid_findings",
        message:
            "review_complete rejected: Account for every open finding: R1-1. Confirm or reject each fix using its existing id.",
    });
});
