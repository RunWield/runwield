import { parsePlanQuestions, type PlanQuestionAnswer } from "../../../shared/plan-questions.ts";
import type { PlanReviewPolicyFields } from "./plan-review-policy.ts";
import type { Annotation, CodeAnnotation, ImageAttachment } from "@plannotator/ui/types.ts";

const PLAN_REVIEW_DRAFT_VERSION = 1;

export interface PlanReviewDraft {
    version: 1;
    basePlanFingerprint: string;
    annotations: Annotation[];
    codeAnnotations: CodeAnnotation[];
    globalAttachments: ImageAttachment[];
    questionAnswers?: PlanQuestionAnswer[];
    executionPolicy?: PlanReviewPolicyFields;
    editedPlan: string | null;
    updatedAt: string;
}

export interface PlanReviewDraftInput {
    basePlan: string;
    annotations: Annotation[];
    codeAnnotations: CodeAnnotation[];
    globalAttachments: ImageAttachment[];
    questionAnswers?: PlanQuestionAnswer[];
    executionPolicy?: PlanReviewPolicyFields;
    editedPlan: string | null;
}

export function planReviewDraftKey(reviewToken: string): string {
    return `runwield:plan-review:${reviewToken || "unknown"}:draft`;
}

export function planReviewPlanFingerprint(plan: string): string {
    let hash = 2166136261;
    for (let index = 0; index < plan.length; index += 1) {
        hash ^= plan.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `${plan.length}:${(hash >>> 0).toString(16)}`;
}

export function createPlanReviewDraft(input: PlanReviewDraftInput): PlanReviewDraft {
    return {
        version: PLAN_REVIEW_DRAFT_VERSION,
        basePlanFingerprint: planReviewPlanFingerprint(input.basePlan),
        annotations: input.annotations,
        codeAnnotations: input.codeAnnotations,
        globalAttachments: input.globalAttachments,
        editedPlan: input.editedPlan,
        questionAnswers: input.questionAnswers ?? [],
        ...(input.executionPolicy ? { executionPolicy: input.executionPolicy } : {}),
        updatedAt: new Date().toISOString(),
    };
}

export function serializePlanReviewDraft(draft: PlanReviewDraft): string {
    return JSON.stringify(draft);
}

export function parsePlanReviewDraft(raw: string, basePlan: string): PlanReviewDraft | null {
    try {
        const draft: PlanReviewDraft = JSON.parse(raw);
        if (
            draft?.version !== PLAN_REVIEW_DRAFT_VERSION ||
            draft.basePlanFingerprint !== planReviewPlanFingerprint(basePlan) ||
            !Array.isArray(draft.annotations) ||
            !(draft.questionAnswers === undefined || Array.isArray(draft.questionAnswers)) ||
            !(draft.codeAnnotations === undefined || Array.isArray(draft.codeAnnotations)) ||
            !Array.isArray(draft.globalAttachments) ||
            !(draft.editedPlan === null || typeof draft.editedPlan === "string") ||
            typeof draft.updatedAt !== "string" ||
            (draft.annotations.length === 0 &&
                (draft.codeAnnotations?.length ?? 0) === 0 &&
                draft.globalAttachments.length === 0 &&
                draft.editedPlan === null &&
                !draft.executionPolicy &&
                !draft.questionAnswers?.length)
        ) {
            return null;
        }
        const validIds = new Set(
            parsePlanQuestions(draft.editedPlan ?? basePlan)
                .filter((block) => block.question && !block.error)
                .map((block) => block.id),
        );
        const questionAnswers = (draft.questionAnswers ?? []).filter(
            (answer) =>
                answer &&
                typeof answer.id === "string" &&
                validIds.has(answer.id) &&
                (typeof answer.value === "boolean" || typeof answer.value === "string"),
        );
        return { ...draft, codeAnnotations: draft.codeAnnotations ?? [], questionAnswers };
    } catch {
        return null;
    }
}

export function planReviewDraftDescription(draft: PlanReviewDraft): string {
    const annotationCount = draft.annotations.length + draft.codeAnnotations.length;
    const attachmentCount = draft.globalAttachments.length;
    const parts: string[] = [];
    if (annotationCount > 0) {
        parts.push(`${annotationCount} annotation${annotationCount === 1 ? "" : "s"}`);
    }
    if (attachmentCount > 0) {
        parts.push(`${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`);
    }
    if (draft.questionAnswers?.length) {
        parts.push(`${draft.questionAnswers.length} question answer${draft.questionAnswers.length === 1 ? "" : "s"}`);
    }
    if (draft.editedPlan !== null) parts.push("direct Plan edits");
    return parts.join(", ");
}
