import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { test } from "node:test";
import {
    buildFallbackGuidedReviewExplainer,
    buildGuidedReviewPolicy,
    buildGuidedReviewPrompt,
    recommendGuidedReview,
    validateGuidedReviewExplainer,
} from "./guided-review.js";

const DIFF = `diff --git a/src/a.js b/src/a.js
index 1111111..2222222 100644
--- a/src/a.js
+++ b/src/a.js
@@ -1 +1,2 @@
 export const a = 1;
+export const b = 2;
diff --git a/src/ui/view.js b/src/ui/view.js
index 1111111..2222222 100644
--- a/src/ui/view.js
+++ b/src/ui/view.js
@@ -1 +1,2 @@
 export const view = true;
+export const ready = true;
diff --git a/src/server/api.js b/src/server/api.js
index 1111111..2222222 100644
--- a/src/server/api.js
+++ b/src/server/api.js
@@ -1 +1,2 @@
 export const api = true;
+export const next = true;
diff --git a/src/shared/data.js b/src/shared/data.js
index 1111111..2222222 100644
--- a/src/shared/data.js
+++ b/src/shared/data.js
@@ -1 +1,2 @@
 export const data = true;
+export const more = true;
`;

test("recommendGuidedReview scores complexity and cross-area diffs", () => {
    const recommendation = recommendGuidedReview({
        planAttrs: { complexity: "HIGH", dependencies: ["child"] },
        planContent: "frontend UI flow",
        diffText: DIFF,
        usedLargeDiffPath: true,
    });

    assertEquals(recommendation.recommended, true);
    assertEquals(recommendation.stats.changedFiles, 4);
    assertEquals(recommendation.stats.meaningfulAreas.length >= 3, true);
});

test("recommendGuidedReview applies child Planned Change and visual path signals precisely", () => {
    const projectRecommendation = recommendGuidedReview({
        planAttrs: { classification: "PROJECT", dependencies: ["child"], parentPlan: "epic" },
        planContent: "backend change",
        diffText: "diff --git a/src/core.js b/src/core.js\n+change",
    });
    assertEquals(projectRecommendation.reasons.includes("child Planned Change dependencies"), false);
    assertEquals(projectRecommendation.reasons.includes("child Planned Change Epic context"), false);

    const featureRecommendation = recommendGuidedReview({
        planAttrs: { classification: "FEATURE", dependencies: ["child"], parentPlan: "epic" },
        planContent: "backend change",
        diffText: "diff --git a/src/ui/panel.js b/src/ui/panel.js\n+change",
    });
    assertEquals(featureRecommendation.reasons.includes("child Planned Change dependencies"), true);
    assertEquals(featureRecommendation.reasons.includes("child Planned Change Epic context"), true);
    assertEquals(featureRecommendation.reasons.includes("visual or interactive change"), true);
});

test("buildGuidedReviewPolicy auto-starts for auto recommendations", () => {
    const recommendation = recommendGuidedReview({ planAttrs: { complexity: "HIGH" }, diffText: DIFF });
    assertEquals(buildGuidedReviewPolicy("auto", recommendation).autoStart, true);
    assertEquals(buildGuidedReviewPolicy("none", recommendation).autoStart, false);
});

test("buildFallbackGuidedReviewExplainer creates structured explainer blocks", () => {
    const guide = buildFallbackGuidedReviewExplainer({ diffText: DIFF });
    assertEquals(guide.schemaVersion, "1.0");
    assertEquals(
        guide.sections[0].blocks.some((block) => block.type === "mermaid"),
        true,
    );
    assertEquals(
        guide.sections[0].blocks.some((block) => block.type === "diff"),
        true,
    );
});

test("validateGuidedReviewExplainer adds coverage fallbacks for omitted changed files", () => {
    const result = validateGuidedReviewExplainer(
        {
            schemaVersion: "1.0",
            title: "Partial guide",
            sections: [{ title: "Core", role: "core", blocks: [{ type: "diff", file: "src/a.js" }] }],
            everythingElse: [],
        },
        { changedFiles: ["src/a.js", "src/b.js"] },
    );

    assertEquals(result.ok, true);
    if (!result.ok) throw new Error("expected valid guide");
    assertEquals(result.value.everythingElse, [{ file: "src/b.js" }]);
});

test("validateGuidedReviewExplainer rejects unsafe refs and widgets", () => {
    const result = validateGuidedReviewExplainer(
        {
            schemaVersion: "1.0",
            title: "Bad guide",
            sections: [
                {
                    title: "Bad",
                    role: "test",
                    blocks: [
                        { type: "diff", file: "src/missing.js" },
                        {
                            type: "widget",
                            id: "bad",
                            entry: "index.html",
                            html: '<img src="https://example.com/x.png">',
                        },
                    ],
                },
            ],
        },
        { changedFiles: ["src/a.js"] },
    );

    assertEquals(result.ok, false);
    if (result.ok) throw new Error("expected validation failure");
    assertEquals(
        result.errors.some((/** @type {string} */ error) => error.includes("changed file")),
        true,
    );
    assertEquals(
        result.errors.some((/** @type {string} */ error) => error.includes("external network")),
        true,
    );
    assertEquals(
        result.errors.some((/** @type {string} */ error) => error.includes("role must be one of")),
        true,
    );
});

test("buildGuidedReviewPrompt asks for strict JSON and Plan-grounded changed-file refs", () => {
    const prompt = buildGuidedReviewPrompt({
        diffText: DIFF,
        gitRef: "test",
        changedFiles: ["src/a.js"],
        planContent: "# Plan\nExplain the product reason.",
        planAttrs: { classification: "FEATURE" },
    });
    assertEquals(prompt.includes("Return ONLY JSON"), true);
    assertEquals(prompt.includes('"data_flow"'), true);
    assertEquals(prompt.includes('"test"'), false);
    assertEquals(prompt.includes("# Plan"), true);
    assertEquals(prompt.includes("classification"), true);
    assertEquals(
        prompt.includes("data flow, sequence, state machine, UI composition, game loop/timeline, or dependency graph"),
        true,
    );
    assertEquals(prompt.includes("src/a.js"), true);
});

test("planless Guided Review grounds in PR context and reads the real head ref", () => {
    const prompt = buildGuidedReviewPrompt({
        diffText: "diff",
        gitRef: "abc123",
        changedFiles: ["a.ts"],
        reviewContext: "PR title and body",
    });
    assertStringIncludes(prompt, "PR title and body");
    assertStringIncludes(prompt, "git show abc123:<path>");
    assertEquals(prompt.includes("Plan content unavailable"), false);
    assertEquals(prompt.includes("Ground the explainer in both the Plan"), false);
});
test("working-tree Guided Review reads current files rather than a nonexistent ref", () => {
    const prompt = buildGuidedReviewPrompt({
        diffText: "diff",
        gitRef: "Working tree (topic)",
        changedFiles: ["a.ts"],
    });
    assertStringIncludes(prompt, "Read the current checkout files directly");
    assertEquals(prompt.includes("git show Working tree"), false);
});
