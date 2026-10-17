import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../../testing/assertions.ts";
import { type Annotation, AnnotationType, type CodeAnnotation } from "@plannotator/ui/types.ts";
import {
    createPlanReviewDraft,
    parsePlanReviewDraft,
    planReviewDraftDescription,
    planReviewDraftKey,
    serializePlanReviewDraft,
} from "./plan-review-draft.ts";

const annotation: Annotation = {
    id: "annotation-1",
    blockId: "context",
    startOffset: 0,
    endOffset: 7,
    type: AnnotationType.COMMENT,
    text: "Clarify this.",
    originalText: "Context",
    createdA: 1,
};

const codeAnnotation: CodeAnnotation = {
    id: "code-1",
    type: "comment",
    filePath: "src/example.ts",
    lineStart: 3,
    lineEnd: 3,
    side: "new",
    text: "Reuse the existing helper.",
    createdAt: 2,
};

test("Plan Review drafts round-trip annotations, attachments, and direct edits", () => {
    const draft = createPlanReviewDraft({
        basePlan: "# Initial Plan\n",
        annotations: [annotation],
        codeAnnotations: [codeAnnotation],
        globalAttachments: [{ path: "/tmp/reference.png", name: "reference" }],
        editedPlan: "# Edited Plan\n",
    });

    const restored = parsePlanReviewDraft(serializePlanReviewDraft(draft), "# Initial Plan\n");

    assertEquals(restored, draft);
    assertEquals(planReviewDraftKey("review-token"), "runwield:plan-review:review-token:draft");
    assertStringIncludes(planReviewDraftDescription(draft), "2 annotations");
    assertStringIncludes(planReviewDraftDescription(draft), "1 attachment");
    assertStringIncludes(planReviewDraftDescription(draft), "direct Plan edits");
});

test("Plan Review drafts reject malformed data and a different submitted Plan", () => {
    const draft = createPlanReviewDraft({
        basePlan: "# Initial Plan\n",
        annotations: [],
        codeAnnotations: [],
        globalAttachments: [],
        editedPlan: "# Edited Plan\n",
    });
    const serialized = serializePlanReviewDraft(draft);

    assertEquals(parsePlanReviewDraft(serialized, "# Different Plan\n"), null);
    assertEquals(parsePlanReviewDraft("not json", "# Initial Plan\n"), null);
    assertEquals(parsePlanReviewDraft('{"version":1}', "# Initial Plan\n"), null);
    assertEquals(
        parsePlanReviewDraft(
            serializePlanReviewDraft(
                createPlanReviewDraft({
                    basePlan: "# Initial Plan\n",
                    annotations: [],
                    codeAnnotations: [],
                    globalAttachments: [],
                    editedPlan: null,
                }),
            ),
            "# Initial Plan\n",
        ),
        null,
    );
});

test("answer-only drafts round-trip and describe the restored question answers", () => {
    const plan = '# Plan\n\n```wld-question\n{"id":"keep","type":"yes_no","prompt":"Keep old links?"}\n```\n';
    const draft = createPlanReviewDraft({
        basePlan: plan,
        annotations: [],
        codeAnnotations: [],
        globalAttachments: [],
        editedPlan: null,
        questionAnswers: [{ id: "keep", value: false }],
    });
    const restored = parsePlanReviewDraft(serializePlanReviewDraft(draft), plan);
    assertEquals(restored?.questionAnswers, [{ id: "keep", value: false }]);
    assertStringIncludes(planReviewDraftDescription(restored!), "1 question answer");
});

test("restored drafts drop answers for question ids removed by direct edits", () => {
    const plan = '# Plan\n\n```wld-question\n{"id":"keep","type":"yes_no","prompt":"Keep old links?"}\n```\n';
    const draft = createPlanReviewDraft({
        basePlan: plan,
        annotations: [],
        codeAnnotations: [],
        globalAttachments: [],
        editedPlan: "# Settled Plan\n",
        questionAnswers: [
            { id: "keep", value: false },
            { id: "gone", value: "text" },
        ],
    });
    assertEquals(parsePlanReviewDraft(serializePlanReviewDraft(draft), plan)?.questionAnswers, []);
});

test("older annotation drafts without answers still restore", () => {
    const draft = createPlanReviewDraft({
        basePlan: "# Plan",
        annotations: [annotation],
        codeAnnotations: [],
        globalAttachments: [],
        editedPlan: null,
    });
    delete draft.questionAnswers;
    assertEquals(parsePlanReviewDraft(serializePlanReviewDraft(draft), "# Plan")?.questionAnswers, []);
});
