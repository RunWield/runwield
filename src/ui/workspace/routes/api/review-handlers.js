import { validateSequenceReviewDecision } from "../../../../shared/workflow/sequence-review.ts";
/** Review decision transport for Workspace-hosted review surfaces. */

import { normalizePlanClassification } from "../../../../constants.js";
import { readPlanApprovalAction } from "../../../../shared/workflow/plan-approval.ts";
import { normalizeCollaborationMode, normalizeExecutionAgent } from "../../../../plan-store.js";

/**
 * @typedef {import("../../../../shared/workflow/sequence-review.ts").SequenceReviewDecision} SequenceReviewDecision
 * @typedef {import("../../../../shared/workflow/sequence-review.ts").SequenceReviewDocument} SequenceReviewDocument
 * @typedef {import("../../../../shared/workflow/review-feedback-images.ts").ReviewImageDecision} ReviewImageDecision
 * @typedef {import("../../../../shared/workflow/review-feedback-images.ts").ReviewImageInput} ReviewImageInput
 * @typedef {import("../../../../shared/workflow/review-feedback-images.ts").ReviewAnnotationInput} ReviewAnnotationInput
 *
 * @typedef {Object} ReviewExecutionPolicy
 * @property {"engineer" | "frontend-engineer"} [executionAgent]
 * @property {"autonomous" | "pair"} [collaborationRecommendation]
 *
 * @typedef {Object} ReviewDecisionFields
 * @property {string} [plan]
 * @property {import("../../../../shared/plan-questions.ts").PlanQuestionAnswer[]} [questionAnswers]
 * @property {string} [savedPath]
 * @property {string} [agentSwitch]
 * @property {string} [permissionMode]
 * @property {string} [reviewAction]
 * @property {boolean} [conversationTurn]
 * @property {boolean} [exit]
 * @property {boolean} [canceled]
 *
 * @typedef {SequenceReviewDecision & ReviewImageDecision & ReviewExecutionPolicy & ReviewDecisionFields} ReviewDecision
 *
 * @typedef {Object} ReviewPlanSave
 * @property {boolean} [enabled]
 * @property {string} [path]
 *
 * @typedef {Object} ReviewRequestFields
 * @property {string} [executionAgent]
 * @property {string} [collaborationRecommendation]
 * @property {string} [approvalAction]
 * @property {"plan" | "code"} [reviewType]
 * @property {ReviewPlanSave} [planSave]
 *
 * @typedef {Omit<ReviewDecision, "executionAgent" | "collaborationRecommendation" | "approvalAction"> & ReviewRequestFields} ReviewRequestBody
 *
 * @typedef {Object} ReviewPayload
 * @property {string} [classification]
 * @property {Pick<import("../../../../plan-store.js").PlanFrontMatter, "classification">} [frontmatter]
 * @property {SequenceReviewDocument[]} [sequenceDocuments]
 *
 * @typedef {Object} ReviewRequestState
 * @property {string} cwd
 * @property {string} [reviewToken]
 * @property {ReviewPayload} [reviewPayload]
 *
 * @typedef {Object} ReviewRequestContext
 * @property {Request} req
 * @property {Request} [request]
 * @property {ReviewRequestState} [state]
 *
 * @callback ReviewDecisionResolver
 * @param {ReviewDecision} decision
 * @returns {void}
 *
 * @callback ReviewDecisionFactory
 * @param {ReviewRequestBody} body
 * @returns {ReviewDecision | Response}
 *
 * @typedef {Object} ReviewDecisionPending
 * @property {ReviewDecisionResolver} resolve
 * @property {Promise<ReviewDecision>} promise
 */

/** @type {Map<string, ReviewDecisionPending>} */
const reviewDecisions = new Map();

/**
 * @param {string} token
 * @returns {ReviewDecisionPending}
 */
export function registerReviewDecisionPromise(token) {
    unregisterReviewDecision(token);
    /** @type {ReviewDecisionResolver} */
    let resolveDecision = () => {};
    /** @type {Promise<ReviewDecision>} */
    const promise = new Promise((resolve) => {
        resolveDecision = resolve;
    });
    reviewDecisions.set(token, { resolve: resolveDecision, promise });
    return { resolve: resolveDecision, promise };
}

/**
 * @param {string} token
 * @param {ReviewDecision} decision
 * @returns {boolean}
 */
export function resolveReviewDecision(token, decision) {
    const entry = reviewDecisions.get(token);
    if (!entry) return false;
    reviewDecisions.delete(token);
    entry.resolve(decision);
    return true;
}

/** @param {string} token */
export function unregisterReviewDecision(token) {
    const entry = reviewDecisions.get(token);
    if (!entry) return;
    reviewDecisions.delete(token);
}

/** @param {ReviewRequestContext} ctx */
export async function reviewDecisionApi(ctx) {
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

/** @param {ReviewRequestContext} ctx */
export async function reviewDenyApi(ctx) {
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

/** @param {ReviewRequestContext} ctx */
export async function reviewFeedbackApi(ctx) {
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

/** @param {ReviewRequestBody} body */
function reviewImageDecisionFields(body) {
    const globalAttachments = readImageAttachments(body.globalAttachments);
    const images = collectImageAttachments(body);
    return {
        ...(globalAttachments.length > 0 && { globalAttachments }),
        ...(images.length > 0 && { images }),
    };
}

/** @param {ReviewRequestBody} body */
function collectImageAttachments(body) {
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

/** @param {ReviewAnnotationInput} annotation */
function readAnnotationImageAttachments(annotation) {
    return readImageAttachments(annotation?.images);
}

/** @param {ReviewImageInput[]} [value] */
function readImageAttachments(value) {
    if (!Array.isArray(value)) return [];
    return value.flatMap((image) => {
        const path = typeof image?.path === "string" ? image.path.trim() : "";
        if (!path) return [];
        const name = typeof image?.name === "string" && image.name.trim() ? image.name.trim() : "image";
        return [{ path, name }];
    });
}

/** @param {ReviewRequestContext} ctx */
export async function reviewExitApi(ctx) {
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

/**
 * @param {ReviewRequestContext} ctx
 * @param {ReviewDecisionFactory} createDecision
 */
async function resolveFromRequest(ctx, createDecision) {
    const token = reviewToken(ctx.request || ctx.req);
    if (!token) return jsonError("missing_token", "Review token required.", 401);
    const expectedToken = ctx.state?.reviewToken;
    if (expectedToken && token !== expectedToken) return jsonError("invalid_token", "Invalid review token.", 401);
    if (!reviewDecisions.has(token)) return jsonError("review_not_found", "Review expired or completed.", 404);

    /** @type {ReviewRequestBody} */
    let body = {};
    try {
        body = await (ctx.request || ctx.req).json();
    } catch {
        body = {};
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
    if (!resolveReviewDecision(token, decision)) {
        return jsonError("review_not_found", "Review expired or completed.", 404);
    }
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}

/**
 * @param {ReviewRequestBody} body
 * @param {ReviewPayload} [reviewPayload]
 * @returns {ReviewExecutionPolicy | Response}
 */
function validateApprovedExecutionPolicy(body, reviewPayload) {
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

/** @param {ReviewPayload} [reviewPayload] */
function trustedReviewClassification(reviewPayload) {
    const classification =
        typeof reviewPayload?.classification === "string"
            ? reviewPayload.classification
            : typeof reviewPayload?.frontmatter?.classification === "string"
              ? reviewPayload.frontmatter.classification
              : "PLANNED_CHANGE";
    return normalizePlanClassification(classification);
}

/** @param {ReviewPlanSave} [planSave] */
function readPlanSavePath(planSave) {
    if (!planSave || typeof planSave !== "object") return undefined;
    if (planSave.enabled === false) return undefined;
    return typeof planSave.path === "string" ? planSave.path : undefined;
}

/** @param {Request} request */
function reviewToken(request) {
    const url = new URL(request.url);
    return request.headers.get("x-runwield-review-token") || url.searchParams.get("token") || "";
}

/** @param {string} error @param {string} message @param {number} status */
function jsonError(error, message, status) {
    return Response.json({ error, message, status }, { status, headers: { "cache-control": "no-store" } });
}
