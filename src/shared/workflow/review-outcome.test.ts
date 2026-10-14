import { test } from "node:test";
import { assertEquals } from "../../testing/assertions.ts";
import { normalizeReviewOutcome, reviewCompletionMetricDetails, type ReviewFindingInput } from "./review-outcome.ts";
import { type ReviewLedger } from "./review-ledger.ts";

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

test("review outcome confirms fixes and trims the completion payload", () => {
    assertEquals(
        normalizeReviewOutcome(
            {
                approved: true,
                feedback: " ignored ",
                findings: [FIX],
                advisories: [{ title: " note ", detail: " detail " }, { title: " " }],
                integrationNotes: [{ check: " check ", where: " src/a " }, { check: " " }],
            },
            LEDGER,
        ),
        {
            accepted: true,
            details: {
                outcome: "approved",
                approved: true,
                feedback: "",
                findings: [
                    {
                        id: "R1-1",
                        resolved: true,
                        status: "fix_confirmed",
                        rejectionReason: "",
                        title: "Fixed",
                        requirement: "",
                        evidence: "",
                    },
                ],
                advisories: [{ title: "note", detail: "detail" }],
                integrationNotes: [{ check: "check", where: "src/a" }],
            },
            message: "Semantic review approved — implementation matches the plan.",
            openFindingCount: 0,
            resolvedFindingCount: 1,
        },
    );
});

test("review outcome renders rejected fixes from structured findings", () => {
    const result = normalizeReviewOutcome(
        {
            approved: false,
            feedback: "do not duplicate",
            findings: [
                {
                    id: "R1-1",
                    title: " Still broken ",
                    status: "fix_rejected",
                    rejectionReason: " wrong branch ",
                    requirement: " handle failure ",
                    evidence: " src/a:2 ",
                },
            ],
        },
        LEDGER,
    );
    if (!result.accepted) throw new Error(result.message);
    assertEquals(
        result.details.feedback,
        "- R1-1 — Still broken\n  Plan: handle failure\n  Evidence: src/a:2\n  Fix rejected: wrong branch",
    );
    assertEquals(
        result.message,
        "Semantic review rejected — 1 issue open:\n- R1-1 — Still broken\n  Plan: handle failure\n  Evidence: src/a:2\n  Fix rejected: wrong branch",
    );
});

test("review outcome retains legacy states, attribution, and free-text feedback", () => {
    const result = normalizeReviewOutcome({
        approved: false,
        findings: [
            {
                title: " New bug ",
                origin: "repair_regression",
            },
            { title: " " },
        ],
    });
    if (!result.accepted) throw new Error(result.message);
    assertEquals(result.details.findings, [
        {
            id: undefined,
            resolved: false,
            status: "new",
            rejectionReason: "",
            origin: "repair_regression",
            title: "New bug",
            requirement: "",
            evidence: "",
        },
    ]);
    const legacy = normalizeReviewOutcome(
        {
            approved: true,
            findings: [{ id: "R1-1", title: "Fixed", resolved: true }],
        },
        LEDGER,
    );
    if (!legacy.accepted) throw new Error(legacy.message);
    assertEquals(legacy.details.findings[0].status, "fix_confirmed");
    const note = normalizeReviewOutcome({ approved: false, feedback: " note " });
    if (!note.accepted) throw new Error(note.message);
    assertEquals(note.details.feedback, "note");
    assertEquals(note.message, "Semantic review rejected — issues found:\nnote");
});

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
        assertEquals(normalizeReviewOutcome({ approved: true, findings }, LEDGER), {
            accepted: false,
            reason: "invalid_findings",
            message: `review_complete rejected: ${error}`,
        });
    });
}

test("review outcome rejects approval with open findings", () => {
    assertEquals(normalizeReviewOutcome({ approved: true, findings: [{ title: "bug" }] }), {
        accepted: false,
        reason: "approved_with_open_findings",
        message:
            "review_complete rejected: Cannot approve with 1 unresolved finding(s). Either resolve them (resolved: true, after verifying the fix in the code) or call review_complete with approved: false.",
    });
});

test("review completion metrics describe only accepted or approval-rejected payloads", () => {
    assertEquals(reviewCompletionMetricDetails(normalizeReviewOutcome({ approved: true, findings: [FIX] }, LEDGER)), {
        outcome: "approved",
        approved: true,
        hasFeedback: false,
        findingCount: 1,
        openFindingCount: 0,
        resolvedFindingCount: 1,
        advisoryCount: 0,
    });
    assertEquals(
        reviewCompletionMetricDetails(normalizeReviewOutcome({ approved: true, findings: [{ title: "Open" }] })),
        {
            outcome: "rejected",
            reason: "approved_with_open_findings",
        },
    );
    assertEquals(reviewCompletionMetricDetails(normalizeReviewOutcome({ approved: true }, LEDGER)), null);
});
