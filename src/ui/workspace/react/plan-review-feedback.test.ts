import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../../testing/assertions.ts";
import { buildPlanReviewFeedback, type PlanReviewFeedbackInput } from "./plan-review-feedback.ts";
import { parseMarkdownToBlocks } from "@plannotator/ui/utils/parser.ts";
import { AnnotationType } from "@plannotator/ui/types.ts";

const plan =
    '# Plan\n\n```wld-question\n{"id":"scope","type":"yes_no","prompt":"Keep old links?","default":true}\n```\n';
const input: PlanReviewFeedbackInput = {
    blocks: parseMarkdownToBlocks(plan),
    annotations: [],
    codeAnnotations: [],
    globalAttachments: [],
    basePlan: plan,
    reviewedPlan: plan,
};

test("complete Plan feedback includes direct edits and referenced-file comments", () => {
    const feedback = buildPlanReviewFeedback({
        ...input,
        reviewedPlan: plan + "\nKeep all old links.\n",
        codeAnnotations: [
            {
                id: "code",
                type: "comment",
                filePath: "src/example.ts",
                lineStart: 1,
                lineEnd: 1,
                side: "new",
                text: "Reuse the resolver.",
                createdAt: 1,
            },
        ],
    });
    assertStringIncludes(feedback, "# Direct Plan Edits");
    assertStringIncludes(feedback, "Keep all old links.");
    assertStringIncludes(feedback, "src/example.ts");
    assertStringIncludes(feedback, "Reuse the resolver.");
});

test("question answers appear only when answers exist", () => {
    assertEquals(buildPlanReviewFeedback(input), "No changes detected.");
    const feedback = buildPlanReviewFeedback({ ...input, questionAnswers: [{ id: "scope", value: false }] });
    assertStringIncludes(feedback, "### Question answers\n\n- scope: Keep old links? — No");
    assertEquals(feedback.includes("No changes detected."), false);
    assertEquals(
        buildPlanReviewFeedback({ ...input, questionAnswers: [{ id: "removed", value: true }] }),
        "No changes detected.",
    );
});

test("annotation-only feedback still includes review notes, with or without answers", () => {
    const note = {
        id: "note",
        blockId: input.blocks[0].id,
        startOffset: 0,
        endOffset: 4,
        type: AnnotationType.COMMENT,
        text: "Clarify the title.",
        originalText: "Plan",
        createdA: 1,
    };
    const feedback = buildPlanReviewFeedback({ ...input, annotations: [note] });
    assertStringIncludes(feedback, "Clarify the title.");
    assertEquals(feedback.includes("### Question answers"), false);
    const combined = buildPlanReviewFeedback({
        ...input,
        annotations: [note],
        questionAnswers: [{ id: "scope", value: true }],
    });
    assertStringIncludes(combined, "Clarify the title.");
    assertStringIncludes(combined, "### Question answers");
});
