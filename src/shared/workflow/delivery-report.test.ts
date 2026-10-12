import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildDeliveryReport, type DeliveryReportInput } from "./delivery-report.ts";
import { deliveryReportText } from "../../ui/tui/delivery-report-text.ts";
import { readDeliveryEvidence, recordDeliveryEvidence, savePublicationEvidence } from "./delivery-evidence.ts";
import { createPublicationAttempt } from "./publication-attempt.ts";

Deno.test("delivery evidence separates review, human verification and merge proof", () => {
    const report = buildDeliveryReport({
        planName: "example",
        attrs: { status: "verified", humanReviewDecision: "approved", humanReviewedAt: "2026-10-08T10:00:00Z" },
        guidedReview: "auto",
        codeReview: "always",
        workRecordFailed: false,
        semanticRequired: true,
    });
    assertEquals(report.rows.find((row) => row.label === "Code Review")?.outcome, "Approved");
    assertEquals(report.rows.find((row) => row.label === "User verification")?.outcome, "Not recorded");
    assertEquals(report.rows.find((row) => row.label === "Merge")?.outcome, "Evidence unavailable");
    assertEquals(report.deliveredCommit, undefined);
    assertStringIncludes(report.settings, "guidedReview = auto");
    assertStringIncludes(deliveryReportText(report), "totals unavailable");
});

Deno.test("delivery receipts persist recorded counts, isolate attempts and preserve different commits", async () => {
    const root = await Deno.makeTempDir({ prefix: "delivery-evidence-" });
    try {
        await recordDeliveryEvidence(root, "example", "attempt-a", "ci", "Exit 1", "Missing export");
        await recordDeliveryEvidence(root, "example", "attempt-a", "ci-repair", "Started");
        await recordDeliveryEvidence(root, "example", "attempt-a", "ci", "Exit 0", "Tests passed");
        await recordDeliveryEvidence(root, "example", "attempt-b", "ci", "Exit 1", "Other attempt");
        const evidence = await readDeliveryEvidence(root, "example", "attempt-a");
        assertEquals(evidence.entries.length, 3);
        assertEquals(evidence.artifacts.length, 1);
        const results = await Deno.readTextFile(`${root}/${evidence.artifacts[0].path}`);
        assertStringIncludes(results, "Missing export");
        assertEquals(results.includes("Other attempt"), false);
        const publication = {
            ...createPublicationAttempt({
                attemptId: "attempt-a",
                planId: "plan-a",
                planName: "example",
                targetBranch: "main",
                executionBranch: "feature",
                executionCwd: root,
                publicationRoot: root,
                validatedCommit: "a".repeat(40),
                targetHeadAtSeal: "c".repeat(40),
            }),
            publishedCommit: "b".repeat(40),
            verifiedAt: "2026-10-08T10:00:00Z",
        };
        const receipt = await savePublicationEvidence(root, publication);
        assertEquals(receipt?.title, "Merge confirmation");
        const report = buildDeliveryReport({
            planName: "example",
            attrs: { humanReviewMode: "none", humanReviewDecision: "not_required" },
            publication,
            evidence,
            guidedReview: "auto",
            codeReview: "none",
            workRecordFailed: true,
            semanticRequired: true,
        });
        assertEquals(report.checkedCommit, "a".repeat(40));
        assertEquals(report.deliveredCommit, "b".repeat(40));
        assertStringIncludes(report.rows[0].detail, "2 / 1 recorded");
        assertStringIncludes(report.rows[2].detail, "Never (stored: none)");
        assertEquals(report.rows[3].outcome, "Not recorded");
        assertEquals(report.rows[5].outcome, "Failed");
        assertStringIncludes(report.rows[5].detail, "wld wr backfill");
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("confirmed Plan Branch delivery names the landing and guides the onward merge", () => {
    const publication = {
        ...createPublicationAttempt({
            attemptId: "plan-landing",
            planId: "plan-a",
            planName: "example",
            targetBranch: "plan/example",
            executionBranch: "worktree/example",
            executionCwd: "/fixture",
            publicationRoot: "/fixture",
            validatedCommit: "a".repeat(40),
            targetHeadAtSeal: "c".repeat(40),
        }),
        publishedCommit: "b".repeat(40),
        verifiedAt: "2026-10-08T10:00:00Z",
    };
    const input: DeliveryReportInput = {
        planName: "example",
        attrs: { classification: "PLANNED_CHANGE", targetBranch: "release", deliveryBranch: "plan/example" },
        publication,
        guidedReview: "auto",
        codeReview: "none",
        workRecordFailed: false,
        semanticRequired: true,
    };
    const report = buildDeliveryReport(input);
    assertEquals(report.heading, "Ready for your merge/PR");
    assertEquals(report.targetBranch, "plan/example");
    assertStringIncludes(deliveryReportText(report), "Landing branch: plan/example");
    assertStringIncludes(report.rows.find((row) => row.label === "Merge")?.detail || "", "open a PR to release");
    assertEquals(buildDeliveryReport({ ...input, publication: undefined }).heading, "Workflow complete");
    assertEquals(
        buildDeliveryReport({
            ...input,
            attrs: { ...input.attrs, parentPlan: "epic" },
        }).heading,
        "Code delivered",
    );
    assertEquals(
        buildDeliveryReport({
            ...input,
            attrs: { ...input.attrs, targetBranch: "plan/example" },
        }).heading,
        "Code delivered",
    );
});

Deno.test("resettable retry counters cannot masquerade as run totals", () => {
    const report = buildDeliveryReport({
        planName: "legacy",
        attrs: { validationCiAttempts: 3, validationSemanticRounds: 2 },
        guidedReview: "auto",
        codeReview: "none",
        workRecordFailed: false,
        semanticRequired: true,
    });
    assertStringIncludes(report.rows[0].detail, "unavailable");
    assertEquals(report.rows[0].detail.includes("3"), false);
    assertEquals(report.rows[1].detail.includes("2"), false);
});

Deno.test("untrusted Plan receipt metadata cannot confirm publication", async () => {
    const { parsePlanFrontMatter } = await import("../../plan-store.js");
    const { attrs } = parsePlanFrontMatter(
        "---\nstatus: verified\npublicationReceipt:\n  validatedCommit: forged\n  publishedCommit: forged\n  targetBranch: main\n---\n# Plan",
    );
    const report = buildDeliveryReport({
        planName: "forged",
        attrs,
        guidedReview: "auto",
        codeReview: "none",
        workRecordFailed: false,
        semanticRequired: true,
    });
    assertEquals(report.rows.find((row) => row.label === "Merge")?.outcome, "Evidence unavailable");
    assertEquals(report.deliveredCommit, undefined);
});

Deno.test("semantic skip and absent check evidence never claim an AI run or passing tests", () => {
    const report = buildDeliveryReport({
        planName: "skip",
        attrs: {},
        guidedReview: "auto",
        codeReview: "none",
        workRecordFailed: false,
        semanticRequired: true,
        evidence: {
            entries: [{
                version: 1,
                kind: "ai-skip",
                outcome: "Skipped",
                recordedAt: "2026-10-08T10:00:00Z",
                detail: "No implementation diff remained to review.",
            }],
            artifacts: [],
        },
    });
    assertEquals(report.rows[0].outcome, "Evidence unavailable");
    assertEquals(report.rows[1].outcome, "Skipped");
    assertStringIncludes(report.rows[1].detail, "No implementation diff");
});

Deno.test("failed receipts cannot stand in for missing passing checks", () => {
    const report = buildDeliveryReport({
        planName: "missing-pass",
        attrs: {},
        guidedReview: "auto",
        codeReview: "always",
        workRecordFailed: false,
        semanticRequired: true,
        evidence: {
            entries: [
                { version: 1, kind: "ci", outcome: "Exit 1", recordedAt: "2026-10-08T10:00:00Z", detail: "failed" },
                {
                    version: 1,
                    kind: "ai",
                    outcome: "Changes requested",
                    recordedAt: "2026-10-08T10:00:00Z",
                    detail: "fix required",
                },
            ],
            artifacts: [],
        },
    });
    assertEquals(report.rows[0].outcome, "Evidence unavailable");
    assertEquals(report.rows[1].outcome, "Evidence unavailable");
});
