/**
 * @module shared/session/session-runtime-interactions
 * Adapter-neutral interaction broker for HostedSession-bound prompts.
 */

import { emitHostedSessionRuntimeEvent, RuntimeEventTypes } from "./session-runtime-events.ts";
import { RuntimeInteractionOutcomes, RuntimeInteractionTypes } from "./interaction-values.ts";
export { isApprovalAcceptedValue, RuntimeInteractionOutcomes, RuntimeInteractionTypes } from "./interaction-values.ts";

import type { HostedSession } from "./hosted-session.ts";
import type { ManagedOperationCapability } from "./managed-operation.ts";

export type RuntimeInteractionType = (typeof RuntimeInteractionTypes)[keyof typeof RuntimeInteractionTypes];
export type RuntimeInteractionOutcome = (typeof RuntimeInteractionOutcomes)[keyof typeof RuntimeInteractionOutcomes];

export type RuntimeInteractionOption = {
    value: string;
    label: string;
    description?: string;
    _meta?: Record<string, unknown>;
};

export interface RuntimeInteractionRequest {
    id?: string;
    type: RuntimeInteractionType;
    prompt: string;
    options?: RuntimeInteractionOption[];
    /** Choice whose answer can be supplied as free text in the same form. */
    otherOptionValue?: string;
    defaultValue?: string;
    placeholder?: string;
    allowEmpty?: boolean;
    toolCallId?: string;
    reviewUrl?: string;
    _meta?: Record<string, unknown>;
}

export interface RuntimeInteractionResponse {
    outcome: RuntimeInteractionOutcome;
    value?: string | boolean;
    valueLabel?: string;
    /** Free text supplied alongside the selected Other choice. */
    otherText?: string;
    message?: string;
    _meta?: Record<string, unknown>;
}

export interface RuntimeInteractionAdapter {
    requestInteraction: (
        request: RuntimeInteractionRequest,
        signal?: AbortSignal,
    ) => Promise<RuntimeInteractionResponse> | RuntimeInteractionResponse;
    supportsInteraction?: (type: string) => boolean;
    cancelAll?: () => void;
}

interface RuntimeInteractionSurface {
    url: string;
}

export function supportsHostedSessionInteraction(
    hostedSession: HostedSession | undefined | null,
    type: string,
): boolean {
    const adapter = hostedSession?.getInteractionAdapter?.();
    if (!adapter || typeof adapter.supportsInteraction !== "function") return false;
    try {
        return adapter.supportsInteraction(type) === true;
    } catch {
        return false;
    }
}

function isAbortError(value: unknown) {
    return value instanceof DOMException && value.name === "AbortError";
}

export function createInteractionId() {
    return crypto.randomUUID();
}

export function normalizeInteractionResponse(
    response: Partial<RuntimeInteractionResponse> | undefined | null,
): RuntimeInteractionResponse {
    if (!response || typeof response !== "object") {
        return {
            outcome: RuntimeInteractionOutcomes.UNSUPPORTED,
            message: "Interaction adapter returned no response.",
        };
    }
    const outcome = response.outcome;
    if (Object.values(RuntimeInteractionOutcomes).includes(outcome as RuntimeInteractionOutcome)) {
        return { ...response, outcome } as RuntimeInteractionResponse;
    }
    return {
        outcome: RuntimeInteractionOutcomes.UNSUPPORTED,
        message: `Unsupported interaction outcome: ${String(outcome)}`,
    };
}

export function interactionErrorToResponse(error: unknown): RuntimeInteractionResponse {
    if (isAbortError(error)) return { outcome: RuntimeInteractionOutcomes.CANCELED, message: "Interaction canceled." };
    const message = error instanceof Error ? error.message : String(error || "Interaction failed.");
    return { outcome: RuntimeInteractionOutcomes.UNSUPPORTED, message };
}

export async function requestHostedSessionInteraction(
    hostedSession: HostedSession,
    request: RuntimeInteractionRequest,
    signal?: AbortSignal,
    capability: ManagedOperationCapability | null = null,
): Promise<RuntimeInteractionResponse> {
    const currentCapability = hostedSession.getManagedOperationCapability?.() || null;
    if (hostedSession.getManagedMetadata?.() && (!capability || currentCapability !== capability)) {
        return {
            outcome: RuntimeInteractionOutcomes.BLOCKED,
            message: currentCapability
                ? "Interaction request blocked: another managed operation is active."
                : "Interaction request blocked: managed operation authority is required.",
        };
    }
    capability?.assertLive?.();
    const id = request.id || createInteractionId();
    const interaction = { ...request, id };
    if (
        request.type === RuntimeInteractionTypes.PLAN_REVIEW &&
        !Array.isArray(request._meta?.sequenceDocuments) &&
        typeof request._meta?.planPath === "string" &&
        !request._meta?.reviewedSource
    ) {
        // Keep file-backed review authority out of browser bundles that import
        // the shared interaction outcome helpers from this module.
        const { loadPlanFileStrict } = await import("../../plan-store.js");
        const { loadPlanActionEvidence } = await import("../workflow/plan-actions.ts");
        const source = await loadPlanFileStrict(request._meta.planPath);
        if (source.kind !== "loaded") {
            throw new Error("The Plan could not be opened for review. Your files have not been changed.");
        }
        const triage = request._meta.triageMeta;
        const planId =
            request._meta.reviewContainerPlanId ||
            request._meta.planId ||
            (triage && typeof triage === "object" && "planId" in triage ? triage.planId : null);
        if (typeof planId !== "string" || source.attrs.planId !== planId) {
            throw new Error("The Plan identity changed before review. Reload the Plan and review again.");
        }
        const evidence = await loadPlanActionEvidence(hostedSession.cwd, planId);
        if (evidence.kind !== "success") throw new Error(evidence.message);
        if (evidence.evidence.revision !== source.revision) {
            throw new Error("The Plan changed before review. Reload the Plan and review again.");
        }
        interaction._meta = {
            ...request._meta,
            expectedRevision: evidence.evidence.revision,
            expectedStatus: evidence.evidence.status,
            expectedWorktree: evidence.evidence.worktree,
            reviewedSource: {
                planName: request._meta.planName,
                path: source.path,
                markdown: source.markdown,
                revision: source.revision,
                attrs: source.attrs,
            },
        };
    }

    let reviewContainerPlanId: string | null = null;
    if (request.type === RuntimeInteractionTypes.PLAN_REVIEW) {
        const meta = interaction._meta || {};
        const triagePlanId =
            meta.triageMeta && typeof meta.triageMeta === "object" && "planId" in meta.triageMeta
                ? meta.triageMeta.planId
                : null;
        const planId = meta.reviewContainerPlanId || meta.planId || triagePlanId;
        const planName = meta.reviewContainerPlanName || meta.planName;
        const planningAgentName = meta.planningAgentName;
        if (capability) {
            if (
                typeof planId !== "string" ||
                !planId.trim() ||
                typeof planName !== "string" ||
                !planName.trim() ||
                typeof planningAgentName !== "string" ||
                !planningAgentName.trim() ||
                !capability.recordLastPlanReview
            )
                throw new Error("Plan review requires a Plan ID, name, and planning Agent with writer authority");
            // Verify the writer proof after the reviewed source and revision checks.
            capability.recordLastPlanReview({ planId, planName, planningAgentName });
        }
        if (
            typeof planId === "string" &&
            planId.trim() &&
            typeof planningAgentName === "string" &&
            planningAgentName.trim()
        ) {
            reviewContainerPlanId = planId;
            const { parsePlanFrontMatter } = await import("../../plan-store.js");
            if (Array.isArray(meta.sequenceDocuments)) {
                for (const doc of meta.sequenceDocuments) {
                    hostedSession.planReviewConversations.rememberReviewBase(doc.planId, {
                        attrs: doc.frontmatter,
                        body: parsePlanFrontMatter(doc.plan).body,
                    });
                }
            } else if (
                interaction._meta?.reviewedSource &&
                typeof interaction._meta.reviewedSource === "object" &&
                "attrs" in interaction._meta.reviewedSource &&
                "markdown" in interaction._meta.reviewedSource &&
                typeof interaction._meta.reviewedSource.markdown === "string"
            ) {
                const source = interaction._meta.reviewedSource;
                hostedSession.planReviewConversations.rememberReviewBase(
                    planId,
                    parsePlanFrontMatter(String(source.markdown)),
                );
            }
            const conversation = hostedSession.getPlanReviewConversation({ planId, planningAgentName });
            interaction._meta = { ...meta, reviewConversation: conversation, agentLabel: conversation.agentLabel };
        }
    }
    if (request.type === RuntimeInteractionTypes.PLAN_REVIEW || request.type === RuntimeInteractionTypes.CODE_REVIEW) {
        const originalReady = request._meta?.onSurfaceReady;

        const onSurfaceReady = (surface: string | RuntimeInteractionSurface) => {
            const url = typeof surface === "string" ? surface : surface?.url;
            if (typeof url === "string" && url && hostedSession.getActiveInteractions().has(id)) {
                interaction.reviewUrl = url;
                if (request.type === RuntimeInteractionTypes.CODE_REVIEW) hostedSession.setLiveCodeReviewUrl(url);
            }
            if (typeof originalReady === "function") return originalReady(surface);
        };
        interaction._meta = { ...interaction._meta, onSurfaceReady };
    }
    const reviewMeta =
        request.type === RuntimeInteractionTypes.PLAN_REVIEW && request._meta
            ? {
                  sequenceDocuments: request._meta.sequenceDocuments,
                  planId: typeof request._meta.planId === "string" ? request._meta.planId : undefined,
                  planName: typeof request._meta.planName === "string" ? request._meta.planName : undefined,
                  classification:
                      typeof request._meta.classification === "string" ? request._meta.classification : undefined,
                  expectedRevision:
                      typeof request._meta.expectedRevision === "string" ? request._meta.expectedRevision : undefined,
                  expectedStatus:
                      typeof request._meta.expectedStatus === "string" ? request._meta.expectedStatus : undefined,
                  expectedWorktree:
                      request._meta.expectedWorktree && typeof request._meta.expectedWorktree === "object"
                          ? request._meta.expectedWorktree
                          : undefined,
              }
            : undefined;
    const emitRequested = () =>
        emitHostedSessionRuntimeEvent(hostedSession, {
            type: RuntimeEventTypes.INTERACTION_REQUESTED,
            interactionId: id,
            interactionType: request.type,
            prompt: request.prompt,
            ...(reviewMeta && { review: reviewMeta }),
        });
    const adapter = hostedSession.getInteractionAdapter?.();
    if (!adapter || typeof adapter.requestInteraction !== "function") {
        if (request.type === RuntimeInteractionTypes.CODE_REVIEW) hostedSession.setLiveCodeReviewUrl("");
        emitRequested();
        if (reviewContainerPlanId) hostedSession.planReviewConversations.stopCapture(reviewContainerPlanId);
        const response = {
            outcome: RuntimeInteractionOutcomes.UNSUPPORTED,
            message: "No interaction adapter is available for this session.",
        };
        emitHostedSessionRuntimeEvent(hostedSession, {
            type: RuntimeEventTypes.INTERACTION_RESOLVED,
            interactionId: id,
            interactionType: request.type,
            outcome: response.outcome,
            message: response.message,
        });
        return response;
    }
    const abortController = new AbortController();

    let removeAbortListener: (() => void) | null = null;
    const operationSignal = capability?.signal || null;
    if (signal || operationSignal) {
        const abort = () => abortController.abort();
        signal?.addEventListener("abort", abort, { once: true });
        operationSignal?.addEventListener("abort", abort, { once: true });
        removeAbortListener = () => {
            signal?.removeEventListener("abort", abort);
            operationSignal?.removeEventListener("abort", abort);
        };
    }
    const remoteAnswer = new Promise<RuntimeInteractionResponse>((resolve) => {
        hostedSession.addActiveInteraction(id, {
            request: interaction,
            abortController,
            answer: (response, source) => {
                if (!hostedSession.getActiveInteractions().has(id)) {
                    throw new Error("This question has already been answered.");
                }
                const normalized = normalizeInteractionResponse(response);
                if (
                    normalized.outcome === "text" &&
                    !interaction.allowEmpty &&
                    !String(normalized.value || "").trim()
                ) {
                    throw new Error("An answer is required.");
                }
                if (source) hostedSession.notificationSurface = source;
                hostedSession.removeActiveInteraction(id);
                resolve(normalized);
            },
        });
    });
    let retainCodeReview = false;
    try {
        emitRequested();
        if (signal?.aborted || operationSignal?.aborted || abortController.signal.aborted) {
            if (reviewContainerPlanId) hostedSession.planReviewConversations.stopCapture(reviewContainerPlanId);
            const response = { outcome: RuntimeInteractionOutcomes.CANCELED, message: "Interaction canceled." };
            hostedSession.removeActiveInteraction(id);
            emitHostedSessionRuntimeEvent(hostedSession, {
                type: RuntimeEventTypes.INTERACTION_CANCELED,
                interactionId: id,
                interactionType: request.type,
                outcome: response.outcome,
                message: response.message,
            });
            return response;
        }
        const canceled = new Promise<RuntimeInteractionResponse>((resolve) => {
            abortController.signal.addEventListener(
                "abort",
                () => resolve({ outcome: RuntimeInteractionOutcomes.CANCELED, message: "Interaction canceled." }),
                { once: true },
            );
        });
        const response = normalizeInteractionResponse(
            await Promise.race([
                Promise.resolve(adapter.requestInteraction(interaction, abortController.signal)).then((response) => {
                    if (
                        response &&
                        ["selected", "text", "accepted"].includes(response.outcome || "") &&
                        hostedSession.getActiveInteractions().has(id) &&
                        hostedSession.localInputSurface
                    ) {
                        hostedSession.notificationSurface = hostedSession.localInputSurface;
                    }
                    return response;
                }),
                remoteAnswer,
                canceled,
            ]),
        );
        retainCodeReview =
            request.type === RuntimeInteractionTypes.CODE_REVIEW &&
            response.outcome === RuntimeInteractionOutcomes.SELECTED &&
            response._meta?.approved !== true &&
            response._meta?.canceled !== true &&
            response._meta?.exit !== true &&
            Boolean(
                response._meta?.conversationTurn ||
                response._meta?.feedback ||
                (Array.isArray(response._meta?.annotations) && response._meta.annotations.length) ||
                (Array.isArray(response._meta?.images) && response._meta.images.length),
            );
        hostedSession.removeActiveInteraction(id);
        if (request.type === RuntimeInteractionTypes.CODE_REVIEW && !retainCodeReview)
            hostedSession.setLiveCodeReviewUrl("");
        emitHostedSessionRuntimeEvent(hostedSession, {
            type:
                response.outcome === RuntimeInteractionOutcomes.CANCELED
                    ? RuntimeEventTypes.INTERACTION_CANCELED
                    : RuntimeEventTypes.INTERACTION_RESOLVED,
            interactionId: id,
            interactionType: request.type,
            outcome: response.outcome,
            message: response.message,
        });
        if (
            reviewContainerPlanId &&
            (response.outcome === RuntimeInteractionOutcomes.CANCELED ||
                (response.outcome === RuntimeInteractionOutcomes.ACCEPTED &&
                    response._meta?.approved === true &&
                    response._meta?.conversationTurn !== true))
        )
            hostedSession.planReviewConversations.stopCapture(reviewContainerPlanId);
        return response;
    } catch (error) {
        const response = interactionErrorToResponse(error);
        hostedSession.removeActiveInteraction(id);
        if (request.type === RuntimeInteractionTypes.CODE_REVIEW) hostedSession.setLiveCodeReviewUrl("");
        if (reviewContainerPlanId && response.outcome === RuntimeInteractionOutcomes.CANCELED) {
            hostedSession.planReviewConversations.stopCapture(reviewContainerPlanId);
        }
        emitHostedSessionRuntimeEvent(hostedSession, {
            type:
                response.outcome === RuntimeInteractionOutcomes.CANCELED
                    ? RuntimeEventTypes.INTERACTION_CANCELED
                    : RuntimeEventTypes.INTERACTION_RESOLVED,
            interactionId: id,
            interactionType: request.type,
            outcome: response.outcome,
            message: response.message,
        });
        return response;
    } finally {
        if (request.type === RuntimeInteractionTypes.CODE_REVIEW && !retainCodeReview)
            hostedSession.setLiveCodeReviewUrl("");
        removeAbortListener?.();
        hostedSession.removeActiveInteraction?.(id);
        // Dismiss the other surface's prompt after either surface answers.
        abortController.abort();
    }
}
