/**
 * @module shared/workflow/plan-review-recovery
 * Adapter-neutral recovery helpers for interrupted Plan Review flows.
 */

import { RuntimeInteractionOutcomes, RuntimeInteractionTypes } from "../session/session-runtime-interactions.ts";

export const SESSION_COMPLETE_GUIDANCE =
    "This session is complete. To work on something new, make a new session with `/new` or close `wld`.";

/**
 * @typedef {Object} PlanReviewRecoveryResult
 * @property {"answered"|"complete"} kind
 * @property {any} [response]
 * @property {string} [message]
 * @property {string} [reason]
 */

/** @param {unknown} value */
function hasItems(value) {
    return Array.isArray(value) && value.length > 0;
}

/**
 * @param {any} response
 * @returns {any}
 */
export function planReviewPayload(response) {
    if (!response || typeof response !== "object") return {};
    const meta = response._meta && typeof response._meta === "object" ? response._meta : {};
    return { ...response, ...meta };
}

/**
 * @param {any} response
 * @returns {boolean}
 */
export function isAnsweredPlanReview(response) {
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
        documents.some((document) =>
            document.feedback?.trim() || hasItems(document.annotations) || hasItems(document.globalAttachments)
        )
    ) return true;
    if (typeof payload.feedback === "string" && payload.feedback.trim()) return true;
    if (hasItems(payload.images) || hasItems(payload.annotations) || hasItems(payload.globalAttachments)) return true;
    return false;
}

/**
 * @param {any} response
 * @returns {string}
 */
export function planReviewUnansweredReason(response) {
    const payload = planReviewPayload(response);
    if (!response || typeof response !== "object") return "missing_response";
    if (payload.exit === true) return "review_exit";
    if (payload.canceled === true || response.outcome === RuntimeInteractionOutcomes.CANCELED) return "review_canceled";
    if (response.outcome === RuntimeInteractionOutcomes.BLOCKED) return "review_blocked";
    if (response.outcome === RuntimeInteractionOutcomes.UNSUPPORTED) return "review_error";
    return "malformed_review_response";
}

/**
 * @param {any} response
 * @returns {boolean}
 */
function isRetryAccepted(response) {
    if (!response || typeof response !== "object") return false;
    if (response.outcome === RuntimeInteractionOutcomes.ACCEPTED) return true;
    if (response.value === true) return true;
    const value = String(response.value || "").trim().toLowerCase();
    return value === "yes" || value === "review_again" || value === "review";
}

/**
 * @param {{
 *   requestReview: (attempt: number) => Promise<any>|any,
 *   requestRetry: (options: { attempt: number, reason: string, response: any }) => Promise<any>|any,
 *   onUnanswered?: (options: { attempt: number, reason: string, response: any }) => void|Promise<void>,
 * }} options
 * @returns {Promise<PlanReviewRecoveryResult>}
 */
export async function requestRecoverablePlanReview({ requestReview, requestRetry, onUnanswered }) {
    let attempt = 0;
    while (true) {
        attempt += 1;
        /** @type {any} */
        let response;
        try {
            response = await requestReview(attempt);
        } catch (error) {
            response = {
                outcome: RuntimeInteractionOutcomes.UNSUPPORTED,
                message: error instanceof Error ? error.message : String(error),
            };
        }
        if (isAnsweredPlanReview(response)) return { kind: "answered", response };

        const reason = planReviewUnansweredReason(response);
        await onUnanswered?.({ attempt, reason, response });
        /** @type {any} */
        let retryResponse;
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

/**
 * @param {import('../session/hosted-session.js').HostedSession} hostedSession
 * @param {(hostedSession: import('../session/hosted-session.js').HostedSession, request: import('../session/session-runtime-interactions.ts').RuntimeInteractionRequest) => Promise<any>} requestInteraction
 * @param {{ attempt: number, reason: string, response: any }} details
 * @returns {Promise<any>}
 */
export function requestPlanReviewRetryConfirmation(hostedSession, requestInteraction, details) {
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

/**
 * @param {string} message
 * @returns {string}
 */
export function appendSessionCompleteGuidance(message) {
    const text = String(message || "").trim();
    if (!text) return SESSION_COMPLETE_GUIDANCE;
    if (text.includes(SESSION_COMPLETE_GUIDANCE)) return text;
    return `${text}\n\n${SESSION_COMPLETE_GUIDANCE}`;
}
