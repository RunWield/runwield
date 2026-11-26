import { test } from "node:test";
import { deepStrictEqual } from "node:assert/strict";
import { toolRegistry, type ReviewFindingInput } from "@runwield/tools";

const reviewComplete = toolRegistry.get("review_complete");

const FIX: ReviewFindingInput = { id: "R1-1", title: " Fixed ", status: "fix_confirmed" };

test("review outcome confirms fixes and trims the completion payload", () => {
    deepStrictEqual(
        reviewComplete.prepare({
            approved: true,
            feedback: " ignored ",
            findings: [FIX],
            advisories: [{ title: " note ", detail: " detail " }, { title: " " }],
            integrationNotes: [{ check: " check ", where: " src/a " }, { check: " " }],
        }).report,
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
    const result = reviewComplete.prepare({
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
    }).report;
    if (!result.accepted) throw new Error(result.message);
    deepStrictEqual(
        result.details.feedback,
        "- R1-1 — Still broken\n  Plan: handle failure\n  Evidence: src/a:2\n  Fix rejected: wrong branch",
    );
    deepStrictEqual(
        result.message,
        "Semantic review rejected — 1 issue open:\n- R1-1 — Still broken\n  Plan: handle failure\n  Evidence: src/a:2\n  Fix rejected: wrong branch",
    );
});

test("review outcome retains legacy states, attribution, and free-text feedback", () => {
    const result = reviewComplete.prepare({
        approved: false,
        findings: [
            {
                title: " New bug ",
                origin: "repair_regression",
            },
            { title: " " },
        ],
    }).report;
    if (!result.accepted) throw new Error(result.message);
    deepStrictEqual(result.details.findings, [
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
    const legacy = reviewComplete.prepare({
        approved: true,
        findings: [{ id: "R1-1", title: "Fixed", resolved: true }],
    }).report;
    if (!legacy.accepted) throw new Error(legacy.message);
    deepStrictEqual(legacy.details.findings[0].status, "fix_confirmed");
    const note = reviewComplete.prepare({ approved: false, feedback: " note " }).report;
    if (!note.accepted) throw new Error(note.message);
    deepStrictEqual(note.details.feedback, "note");
    deepStrictEqual(note.message, "Semantic review rejected — issues found:\nnote");
});

test("review outcome rejects approval with open findings", () => {
    deepStrictEqual(reviewComplete.prepare({ approved: true, findings: [{ title: "bug" }] }).report, {
        accepted: false,
        reason: "approved_with_open_findings",
        message:
            "review_complete rejected: Cannot approve with 1 unresolved finding(s). Either resolve them (resolved: true, after verifying the fix in the code) or call review_complete with approved: false.",
    });
});

const INVALID_SUBMISSIONS: [string, ReviewFindingInput[], string][] = [
    [
        "contradictory states",
        [{ ...FIX, resolved: false }],
        "status and resolved contradict each other. Use status to state the decision.",
    ],
    ["duplicate finding IDs", [FIX, FIX], "Report R1-1 exactly once."],
    [
        "an existing ID marked new",
        [{ ...FIX, status: "new" }],
        "Keep R1-1 under its existing identity and use fix_rejected with a reason, or fix_confirmed.",
    ],
    [
        "a fix without an ID",
        [{ title: "Fixed", status: "fix_confirmed" }],
        "A fix decision requires an existing finding id. Use new without an id for a new defect.",
    ],
    [
        "a rejected fix without a reason",
        [{ ...FIX, status: "fix_rejected" }],
        "Explain why the fix for R1-1 is rejected in rejectionReason.",
    ],
];

for (const [label, findings, message] of INVALID_SUBMISSIONS) {
    test("the standalone review report rejects " + label, () => {
        const payload = { approved: true, findings };
        const expected = {
            accepted: false,
            reason: "invalid_findings",
            message: "review_complete rejected: " + message,
        };
        deepStrictEqual(reviewComplete.prepare(payload).report, expected);
    });
}
