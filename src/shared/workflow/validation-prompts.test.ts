import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { buildSemanticReviewAttempt } from "./validation-semantic.ts";

test("Semantic review prompt includes the canonical effective Plan projection", () => {
    const config = buildSemanticReviewAttempt(
        1,
        undefined,
        { semanticRound: 1, reviewLedger: { items: [], sequence: 0 }, repairBaselineTree: "", lastRepairReport: "" },
        "discovery",
        "diff --git a/src/app.js b/src/app.js",
        "",
        `---
planDeviations:
  - id: call-1
    supersededRequirement: "Replace nav."
    replacementRequirement: "Keep nav."
    approvedAt: "2026-09-10T00:00:00.000Z"
---
# Plan

Implement the screen.
`,
    );

    assertStringIncludes(config.prompt, "### Approved Plan");
    assertStringIncludes(config.prompt, "# Plan");
    assertStringIncludes(config.prompt, "## Approved Plan Deviations");
    assertStringIncludes(config.prompt, "Replacement requirement: Keep nav.");
    assertEquals(config.prompt.includes("Plan content is supplied by the validation request"), false);
});

test("attached reviewer prompts reference the approved Plan instead of inlining it", () => {
    const planMarker = "oversized-plan-body-".repeat(4000);
    const config = buildSemanticReviewAttempt(
        1,
        undefined,
        { semanticRound: 1, reviewLedger: { items: [], sequence: 0 }, repairBaselineTree: "", lastRepairReport: "" },
        "discovery",
        "diff --git a/src/app.js b/src/app.js",
        "",
        planMarker,
        undefined,
        "",
        "docs/plans/large-plan.md",
    );

    assertStringIncludes(config.prompt, "Read the complete approved Plan at docs/plans/large-plan.md.");
    assertEquals(config.prompt.includes(planMarker), false);
});

test("Semantic review request carries the Epic context before the Plan", () => {
    const config = buildSemanticReviewAttempt(
        1,
        undefined,
        { semanticRound: 1, reviewLedger: { items: [], sequence: 0 }, repairBaselineTree: "", lastRepairReport: "" },
        "discovery",
        "diff --git a/a.ts b/a.ts\n",
        "",
        "# Child Plan\n",
        undefined,
        "### Epic Context\n\nThis Plan is one child of the Epic epic.",
    );

    const epicIndex = config.prompt.indexOf("### Epic Context");
    assertEquals(epicIndex >= 0, true);
    assertEquals(epicIndex < config.prompt.indexOf("### Approved Plan"), true);
});
