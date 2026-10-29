import {
    parsePlanQuestions,
    formatPlanQuestionAnswers,
    type PlanQuestionAnswer,
} from "../../../shared/plan-questions.ts";
import type { Annotation, Block, CodeAnnotation, ImageAttachment } from "@plannotator/ui/types.ts";
import { exportAnnotations, exportCodeFileAnnotations } from "@plannotator/ui/utils/parser.ts";
import { composeRunWieldPlanFeedback } from "./plan-review-direct-edits.ts";

const NO_CHANGES = "No changes detected.";

export interface PlanReviewFeedbackInput {
    blocks: Block[];
    annotations: Annotation[];
    globalAttachments: ImageAttachment[];
    codeAnnotations: CodeAnnotation[];
    basePlan: string;
    reviewedPlan: string;
    questionAnswers?: PlanQuestionAnswer[];
}

export function buildPlanReviewFeedback(input: PlanReviewFeedbackInput): string {
    const hasPlanAnnotations = input.annotations.length > 0 || input.globalAttachments.length > 0;
    const annotationFeedback = hasPlanAnnotations
        ? exportAnnotations(input.blocks, input.annotations, input.globalAttachments)
        : NO_CHANGES;
    const planFeedback = composeRunWieldPlanFeedback(annotationFeedback, input.basePlan, input.reviewedPlan);
    const codeFeedback = exportCodeFileAnnotations(input.codeAnnotations).trim();

    const questionFeedback = formatPlanQuestionAnswers(
        parsePlanQuestions(input.reviewedPlan),
        input.questionAnswers ?? [],
    );
    const sections = [planFeedback, codeFeedback, questionFeedback].filter(
        (section) => section && section !== NO_CHANGES,
    );
    return sections.join("\n\n") || NO_CHANGES;
}
