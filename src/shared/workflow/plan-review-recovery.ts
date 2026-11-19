/**
 * @module shared/workflow/plan-review-recovery
 * Adapter-neutral recovery helpers for interrupted Plan Review flows.
 */

import {
    RuntimeInteractionOutcomes,
    RuntimeInteractionTypes,
    type RuntimeInteractionRequest,
    type RuntimeInteractionResponse,
} from "../session/session-runtime-interactions.ts";
import type { HostedSession } from "../session/hosted-session.ts";
import type { SequenceReviewDecision } from "./sequence-review.ts";

export const SESSION_COMPLETE_GUIDANCE =
    "This session is complete. To work on something new, make a new session with `/new` or close `wld`.";

interface ReviewItems {
    readonly length: number;
}

interface PlanReviewPayload extends Pick<SequenceReviewDecision, "approved" | "documents" | "feedback"> {
    exit?: boolean;
    canceled?: boolean;
    remoteReview?: boolean;
    sequenceDecision?: SequenceReviewDecision;
    images?: ReviewItems;
    annotations?: ReviewItems;
    globalAttachments?: ReviewItems;
}

interface PlanReviewResponse extends PlanReviewPayload, Pick<RuntimeInteractionResponse, "_meta"> {
    outcome?: string;
    cancellationReason?: string;
}

interface FailedReviewRequest extends PlanReviewResponse {
    outcome: typeof RuntimeInteractionOutcomes.UNSUPPORTED;
    message: string;
}

interface ReviewRetryResponse extends Pick<RuntimeInteractionResponse, "value"> {
    outcome?: string;
}

type UnansweredReview<Response> = Response | FailedReviewRequest | null | undefined;

interface PlanReviewRecoveryDetails<Response> {
    attempt: number;
    reason: string;
    response: UnansweredReview<Response>;
}

interface PlanReviewRecoveryOptions<Response> {
    requestReview: (attempt: number) => Response | null | undefined | Promise<Response | null | undefined>;
    requestRetry: (
        details: PlanReviewRecoveryDetails<Response>,
    ) => ReviewRetryResponse | null | undefined | Promise<ReviewRetryResponse | null | undefined>;
    onUnanswered?: (details: PlanReviewRecoveryDetails<Response>) => void | Promise<void>;
}

interface AnsweredPlanReview<Response> {
    kind: "answered";
    response: Response;
}

interface CompletedPlanReview<Response> {
    kind: "complete";
    response: UnansweredReview<Response>;
    reason: string;
    message: string;
}

type PlanReviewRecoveryResult<Response> = AnsweredPlanReview<Response> | CompletedPlanReview<Response>;

type RequestInteraction<Response> = (
    hostedSession: HostedSession,
    request: RuntimeInteractionRequest,
) => Promise<Response>;

function hasItems(value: ReviewItems | undefined) {
    return Array.isArray(value) && value.length > 0;
}

export function planReviewPayload(response: PlanReviewResponse | null | undefined): PlanReviewPayload {
    if (!response || typeof response !== "object") return {};
    const meta = response._meta && typeof response._meta === "object" ? response._meta : {};
    return { ...response, ...meta };
}

export function isAnsweredPlanReview(response: PlanReviewResponse | null | undefined) {
    const payload = planReviewPayload(response);
    if (payload.exit === true) return false;
    if (payload.canceled === true || response?.outcome === RuntimeInteractionOutcomes.CANCELED) return false;
    if (response?.outcome === RuntimeInteractionOutcomes.BLOCKED) return false;
    if (response?.outcome === RuntimeInteractionOutcomes.UNSUPPORTED) return false;
    if (payload.remoteReview === true) return true;
    if (payload.approved === true) return true;
    const documents = payload.sequenceDecision?.documents || payload.documents;
    if (
        Array.isArray(documents) &&
        documents.some(
            (document) =>
                document.feedback?.trim() || hasItems(document.annotations) || hasItems(document.globalAttachments),
        )
    )
        return true;
    if (typeof payload.feedback === "string" && payload.feedback.trim()) return true;
    if (hasItems(payload.images) || hasItems(payload.annotations) || hasItems(payload.globalAttachments)) return true;
    return false;
}

export function planReviewUnansweredReason(response: PlanReviewResponse | null | undefined) {
    const payload = planReviewPayload(response);
    if (!response || typeof response !== "object") return "missing_response";
    if (payload.exit === true) return "review_exit";
    if (payload.canceled === true || response.outcome === RuntimeInteractionOutcomes.CANCELED) return "review_canceled";
    if (response.outcome === RuntimeInteractionOutcomes.BLOCKED) return "review_blocked";
    if (response.outcome === RuntimeInteractionOutcomes.UNSUPPORTED) return "review_error";
    return "malformed_review_response";
}

function isRetryAccepted(response: ReviewRetryResponse | null | undefined) {
    if (!response || typeof response !== "object") return false;
    if (response.outcome === RuntimeInteractionOutcomes.ACCEPTED) return true;
    if (response.value === true) return true;
    const value = String(response.value || "")
        .trim()
        .toLowerCase();
    return value === "yes" || value === "review_again" || value === "review";
}

export async function requestRecoverablePlanReview<Response extends PlanReviewResponse>({
    requestReview,
    requestRetry,
    onUnanswered,
}: PlanReviewRecoveryOptions<Response>): Promise<PlanReviewRecoveryResult<Response>> {
    let attempt = 0;
    while (true) {
        attempt += 1;
        let response: UnansweredReview<Response>;
        try {
            response = await requestReview(attempt);
        } catch (error) {
            response = {
                outcome: RuntimeInteractionOutcomes.UNSUPPORTED,
                message: error instanceof Error ? error.message : String(error),
            };
        }
        if (isAnsweredPlanReview(response)) {
            // The synthetic unsupported response and absent responses cannot count as answers.
            return { kind: "answered", response: response as Response };
        }

        const reason = planReviewUnansweredReason(response);
        await onUnanswered?.({ attempt, reason, response });
        let retryResponse: ReviewRetryResponse | null | undefined;
        try {
            retryResponse = await requestRetry({ attempt, reason, response });
        } catch (_error) {
            return {
                kind: "complete",
                response,
                reason: "retry_canceled",
                message: SESSION_COMPLETE_GUIDANCE,
            };
        }
        if (isRetryAccepted(retryResponse)) continue;
        return { kind: "complete", response, reason, message: SESSION_COMPLETE_GUIDANCE };
    }
}

export function requestPlanReviewRetryConfirmation<Response>(
    hostedSession: HostedSession,
    requestInteraction: RequestInteraction<Response>,
    details: PlanReviewRecoveryDetails<PlanReviewResponse>,
): Promise<Response> {
    return requestInteraction(hostedSession, {
        type: RuntimeInteractionTypes.APPROVAL,
        prompt: "Review the Plan again?",
        options: [
            { value: "yes", label: "Yes", _meta: { accepted: true, reason: details.reason } },
            { value: "no", label: "No", _meta: { accepted: false, reason: details.reason } },
        ],
        _meta: {
            planReviewRecovery: true,
            attempt: details.attempt,
            reason: details.reason,
        },
    });
}

export function appendSessionCompleteGuidance(message: string) {
    const text = String(message || "").trim();
    if (!text) return SESSION_COMPLETE_GUIDANCE;
    if (text.includes(SESSION_COMPLETE_GUIDANCE)) return text;
    return `${text}\n\n${SESSION_COMPLETE_GUIDANCE}`;
}
