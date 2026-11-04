import { validateSequenceReviewDecision } from "../../../../shared/workflow/sequence-review.ts";
/** Review decision transport for Workspace-hosted review surfaces. */

import { normalizePlanClassification } from "../../../../constants.js";
import { readPlanApprovalAction } from "../../../../shared/workflow/plan-approval.ts";
import { normalizeCollaborationMode, normalizeExecutionAgent } from "../../../../plan-store.js";

import type { SequenceReviewDecision, SequenceReviewDocument } from "../../../../shared/workflow/sequence-review.ts";
import type {
    ReviewImageDecision,
    ReviewImageInput,
    ReviewAnnotationInput,
} from "../../../../shared/workflow/review-feedback-images.ts";
import type { PlanQuestionAnswer } from "../../../../shared/plan-questions.ts";
import type { PlanFrontMatter } from "../../../../plan-store.js";

export interface ReviewExecutionPolicy {
    executionAgent?: "engineer" | "frontend-engineer";
    collaborationRecommendation?: "autonomous" | "pair";
}

export interface ReviewDecisionFields {
    plan?: string;
    questionAnswers?: PlanQuestionAnswer[];
    savedPath?: string;
    agentSwitch?: string;
    permissionMode?: string;
    reviewAction?: string;
    conversationTurn?: boolean;
    exit?: boolean;
    canceled?: boolean;
}

export type ReviewDecision = SequenceReviewDecision &
    ReviewImageDecision &
    ReviewExecutionPolicy &
    ReviewDecisionFields;

export interface ReviewPlanSave {
    enabled?: boolean;
    path?: string;
}

export interface ReviewRequestFields {
    executionAgent?: string;
    collaborationRecommendation?: string;
    reviewRevision?: number;
    approvalAction?: string;
    reviewType?: "plan" | "code";
    planSave?: ReviewPlanSave;
}

export type ReviewRequestBody = Omit<
    ReviewDecision,
    "executionAgent" | "collaborationRecommendation" | "approvalAction"
> &
    ReviewRequestFields;

export interface ReviewPayload {
    reviewRevision?: number;
    classification?: string;
    frontmatter?: Pick<PlanFrontMatter, "classification">;
    sequenceDocuments?: SequenceReviewDocument[];
}

export interface ReviewRequestState {
    reviewType?: "plan" | "code";
    cwd: string;
    reviewToken?: string;
    reviewPayload?: ReviewPayload;
    onDecision?: ReviewDecisionSink;
    keepConversationTurns?: boolean;
}

export interface ReviewDecisionReceipt {
    /** Core-created durable operation identity. */
    operationId: string;
    workflowId: string;
    actionId: string;
    attemptId: string;
    generation: string;
    /** Candidate-bound validation decision identity. */
    decisionKey: string;
}

export type ReviewDecisionSink = (decision: ReviewDecision) => Promise<void | ReviewDecisionReceipt>;

export interface ReviewRequestContext {
    req: Request;
    request?: Request;
    state?: ReviewRequestState;
}

export type ReviewDecisionResolver = (decision: ReviewDecision) => void;
export type ReviewDecisionFactory = (body: ReviewRequestBody) => ReviewDecision | Response;

export interface ReviewDecisionPending {
    resolve: ReviewDecisionResolver;
    promise: Promise<ReviewDecision>;
}

const reviewDecisions = new Map<string, ReviewDecisionPending>();

export function registerReviewDecisionPromise(token: string): ReviewDecisionPending {
    unregisterReviewDecision(token);

    let resolveDecision: ReviewDecisionResolver = () => {};

    const promise = new Promise<ReviewDecision>((resolve) => {
        resolveDecision = resolve;
    });
    reviewDecisions.set(token, { resolve: resolveDecision, promise });
    return { resolve: resolveDecision, promise };
}

export function resolveReviewDecision(token: string, decision: ReviewDecision): boolean {
    const entry = reviewDecisions.get(token);
    if (!entry) return false;
    reviewDecisions.delete(token);
    entry.resolve(decision);
    return true;
}

export function unregisterReviewDecision(token: string) {
    const entry = reviewDecisions.get(token);
    if (!entry) return;
    reviewDecisions.delete(token);
}

export async function reviewDecisionApi(ctx: ReviewRequestContext) {
    return await resolveFromRequest(ctx, (body) => {
        const executionPolicy = ctx.state?.reviewPayload?.sequenceDocuments
            ? {}
            : validateApprovedExecutionPolicy(body, ctx.state?.reviewPayload);
        if (executionPolicy instanceof Response) return executionPolicy;
        return {
            approved: true,
            ...(Array.isArray(body.questionAnswers) && {
                questionAnswers: body.questionAnswers.filter(
                    (answer) =>
                        answer &&
                        typeof answer.id === "string" &&
                        (typeof answer.value === "boolean" || typeof answer.value === "string"),
                ),
            }),
            feedback: typeof body.feedback === "string" ? body.feedback : undefined,
            annotations: Array.isArray(body.annotations) ? body.annotations : [],
            ...reviewImageDecisionFields(body),
            plan: typeof body.plan === "string" ? body.plan : undefined,
            savedPath: readPlanSavePath(body.planSave),
            approvalAction: readPlanApprovalAction(body.approvalAction),
            ...executionPolicy,
            agentSwitch: typeof body.agentSwitch === "string" ? body.agentSwitch : undefined,
            permissionMode: typeof body.permissionMode === "string" ? body.permissionMode : undefined,
        };
    });
}

export async function reviewDenyApi(ctx: ReviewRequestContext) {
    return await resolveFromRequest(ctx, (body) => ({
        approved: false,
        ...(body.conversationTurn === true && { conversationTurn: true }),
        feedback: typeof body.feedback === "string" ? body.feedback : "",
        annotations: Array.isArray(body.annotations) ? body.annotations : [],
        ...reviewImageDecisionFields(body),
        plan: typeof body.plan === "string" ? body.plan : undefined,
        savedPath: readPlanSavePath(body.planSave),
    }));
}

export async function reviewFeedbackApi(ctx: ReviewRequestContext) {
    return await resolveFromRequest(ctx, (body) => ({
        approved: body.approved === true,
        ...(["post_comments", "approve_pr", "approve_commit"].includes(String(body.reviewAction)) && {
            reviewAction: body.reviewAction,
        }),
        feedback: typeof body.feedback === "string" ? body.feedback : "",
        annotations: Array.isArray(body.annotations) ? body.annotations : [],
        ...reviewImageDecisionFields(body),
        agentSwitch: typeof body.agentSwitch === "string" ? body.agentSwitch : undefined,
    }));
}

function reviewImageDecisionFields(body: ReviewRequestBody) {
    const globalAttachments = readImageAttachments(body.globalAttachments);
    const images = collectImageAttachments(body);
    return {
        ...(globalAttachments.length > 0 && { globalAttachments }),
        ...(images.length > 0 && { images }),
    };
}

function collectImageAttachments(body: ReviewRequestBody) {
    const candidates = [
        ...readImageAttachments(body.globalAttachments),
        ...(Array.isArray(body.annotations) ? body.annotations.flatMap(readAnnotationImageAttachments) : []),
    ];
    const seen = new Set();
    return candidates.filter((image) => {
        if (seen.has(image.path)) return false;
        seen.add(image.path);
        return true;
    });
}

function readAnnotationImageAttachments(annotation: ReviewAnnotationInput) {
    return readImageAttachments(annotation?.images);
}

function readImageAttachments(value?: ReviewImageInput[]) {
    if (!Array.isArray(value)) return [];
    return value.flatMap((image) => {
        const path = typeof image?.path === "string" ? image.path.trim() : "";
        if (!path) return [];
        const name = typeof image?.name === "string" && image.name.trim() ? image.name.trim() : "image";
        return [{ path, name }];
    });
}

export async function reviewExitApi(ctx: ReviewRequestContext) {
    return await resolveFromRequest(ctx, (body) => {
        if (body.reviewType === "plan") {
            return { approved: false, feedback: "", exit: true };
        }
        return {
            approved: false,
            feedback: "",
            annotations: [],
            exit: true,
        };
    });
}

async function resolveFromRequest(ctx: ReviewRequestContext, createDecision: ReviewDecisionFactory) {
    const token = reviewToken(ctx.request || ctx.req);
    if (!token) return jsonError("missing_token", "Review token required.", 401);
    const expectedToken = ctx.state?.reviewToken;
    if (expectedToken && token !== expectedToken) return jsonError("invalid_token", "Invalid review token.", 401);
    if (!reviewDecisions.has(token)) return jsonError("review_not_found", "Review expired or completed.", 404);

    let body: ReviewRequestBody = {};
    try {
        body = await (ctx.request || ctx.req).json();
    } catch {
        body = {};
    }

    const expectedRevision = ctx.state?.reviewPayload?.reviewRevision;
    if (expectedRevision !== undefined && body?.reviewRevision !== expectedRevision) {
        return jsonError(
            ctx.state?.reviewType === "code" ? "stale_code_review" : "stale_sequence_review",
            "This browser page shows a superseded review revision. Reload it.",
            409,
        );
    }
    const decision = createDecision(body || {});
    if (decision instanceof Response) return decision;
    if (ctx.state?.reviewPayload?.sequenceDocuments && !decision.exit) {
        decision.documents = body.documents;
        try {
            await validateSequenceReviewDecision(ctx.state.cwd, ctx.state.reviewPayload.sequenceDocuments, decision);
        } catch (error) {
            return jsonError("stale_sequence_review", error instanceof Error ? error.message : String(error), 409);
        }
    }

    let receipt: void | ReviewDecisionReceipt = undefined;
    if (ctx.state?.onDecision) {
        try {
            receipt = await ctx.state.onDecision(decision);
        } catch (error) {
            return jsonError("stale_sequence_review", error instanceof Error ? error.message : String(error), 409);
        }
    }
    if (!(decision.conversationTurn && ctx.state?.keepConversationTurns) && !resolveReviewDecision(token, decision)) {
        return jsonError("review_not_found", "Review expired or completed.", 404);
    }
    return Response.json({ ok: true, ...receipt }, { headers: { "cache-control": "no-store" } });
}

function validateApprovedExecutionPolicy(
    body: ReviewRequestBody,
    reviewPayload?: ReviewPayload,
): ReviewExecutionPolicy | Response {
    const hasAgent = Object.hasOwn(body, "executionAgent");
    const hasRecommendation = Object.hasOwn(body, "collaborationRecommendation");
    if (!hasAgent && !hasRecommendation) return {};
    if (!hasAgent || !hasRecommendation) {
        return jsonError(
            "invalid_execution_policy",
            "Approval must include both executionAgent and collaborationRecommendation.",
            400,
        );
    }

    const classification = trustedReviewClassification(reviewPayload);
    if (classification === "PROJECT") {
        return jsonError(
            "project_execution_policy",
            "PROJECT Epics are non-executable and cannot approve execution policy fields.",
            400,
        );
    }

    const executionAgent = normalizeExecutionAgent(body.executionAgent);
    if (!executionAgent) {
        return jsonError(
            "invalid_execution_agent",
            `Invalid executionAgent: ${String(
                body.executionAgent,
            )}. Supported values are engineer and frontend-engineer.`,
            400,
        );
    }
    const collaborationRecommendation = normalizeCollaborationMode(body.collaborationRecommendation);
    if (!collaborationRecommendation) {
        return jsonError(
            "invalid_collaboration_recommendation",
            `Invalid collaborationRecommendation: ${String(
                body.collaborationRecommendation,
            )}. Supported values are autonomous and pair.`,
            400,
        );
    }
    return { executionAgent, collaborationRecommendation };
}

function trustedReviewClassification(reviewPayload?: ReviewPayload) {
    const classification =
        typeof reviewPayload?.classification === "string"
            ? reviewPayload.classification
            : typeof reviewPayload?.frontmatter?.classification === "string"
              ? reviewPayload.frontmatter.classification
              : "PLANNED_CHANGE";
    return normalizePlanClassification(classification);
}

function readPlanSavePath(planSave?: ReviewPlanSave) {
    if (!planSave || typeof planSave !== "object") return undefined;
    if (planSave.enabled === false) return undefined;
    return typeof planSave.path === "string" ? planSave.path : undefined;
}

function reviewToken(request: Request) {
    const url = new URL(request.url);
    return request.headers.get("x-runwield-review-token") || url.searchParams.get("token") || "";
}

function jsonError(error: string, message: string, status: number) {
    return Response.json({ error, message, status }, { status, headers: { "cache-control": "no-store" } });
}
