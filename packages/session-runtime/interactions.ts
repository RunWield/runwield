/**
 * @module @runwield/session-runtime/interactions
 * Requests, responses, and host adapter callbacks for Session Runtime interactions.
 */

import type { PlanFrontMatter } from "@runwield/plans";
import type { SequenceReviewDecision } from "../../src/plan-store/index.ts";
import type { PlanReviewVersion, SequenceReviewPresentation } from "@runwield/plans/lifecycle";
import type { SessionArtifactKind } from "../../src/shared/session/file-session-store-types.ts";
import type { GuidedReviewPolicy } from "../../src/shared/workflow/guided-review.ts";
import type { PlanApprovalAction } from "@runwield/plans/lifecycle";
import type { ImageAttachment, RuntimeAssistantTextDeltaEvent } from "./events.ts";

/** Interaction kinds hosts can route to an adapter. */
export const RuntimeInteractionTypes = Object.freeze({
    SELECT: "select",
    TEXT: "text",
    APPROVAL: "approval",
    LINK: "link",
    PLAN_REVIEW: "plan_review",
    ARTIFACT_REVIEW: "artifact_review",
    CODE_REVIEW: "code_review",
    PAIR_CHECKPOINT: "pair_checkpoint",
    PLAN_DEVIATION_CONFIRMATION: "plan_deviation_confirmation",
});

/** Outcomes returned by an adapter or the Session Runtime broker. */
export const RuntimeInteractionOutcomes = Object.freeze({
    SELECTED: "selected",
    TEXT: "text",
    ACCEPTED: "accepted",
    CANCELED: "canceled",
    UNSUPPORTED: "unsupported",
    BLOCKED: "blocked",
});

/** The request kind used to choose how to present an interaction. */
export type RuntimeInteractionType = (typeof RuntimeInteractionTypes)[keyof typeof RuntimeInteractionTypes];
/** The disposition of a completed interaction. */
export type RuntimeInteractionOutcome = (typeof RuntimeInteractionOutcomes)[keyof typeof RuntimeInteractionOutcomes];

/** Approval and free-entry hints attached to a selectable choice. */
export interface RuntimeInteractionOptionMetadata {
    accepted?: boolean;
    approvalOutcome?: "accepted" | "declined";
    reason?: string;
    source?: string;
    questionType?: string;
    questionId?: string;
    other?: boolean;
}

/** Link and browser-open state reported when an interaction has a review surface. */
export interface RuntimeInteractionSurface {
    url: string;
    opened?: boolean;
}

/** A review decision value carried between the host and its review surface. */
export type ReviewDecisionValue =
    string | number | boolean | null | undefined | ReviewDecisionValue[] | { [key: string]: ReviewDecisionValue };

/** A reviewer comment and its optional location in the diff. */
export type CodeReviewAnnotation = { [key: string]: ReviewDecisionValue } & {
    file?: string;
    path?: string;
    filePath?: string;
    line?: number;
    text?: string;
    comment?: string;
};

/** One stdout or stderr message from the review host. */
export interface ReviewServerOutput {
    stream: "stdout" | "stderr";
    text: string;
}

/** An assistant text update captured for a review conversation. */
export type ReviewConversationEvent = Pick<
    RuntimeAssistantTextDeltaEvent,
    "type" | "delta" | "messageId" | "agentName"
>;

/** A reviewer prompt and its optional reply in a saved review round. */
export interface ReviewConversationTurn {
    turnId: string;
    message: string;
    reply?: string;
}

/** Conversation state passed between the Session Runtime and a review host. */
export interface ReviewConversation {
    /** Present only for hosts that restore temporary turns from a saved active round. */
    turns?: ReviewConversationTurn[];
    pending?: boolean;
    /** Refresh the conversation from its saved source before the host displays it. */
    refresh?(): Promise<void>;
    /** Notify the host that the reviewer exited the conversation. */
    onExit?(): void;
    completed?: boolean;
    resultMessage?: string;
    completionDelivered?: boolean;
    error?: string;
    id: string;
    agentLabel: string;
    revision: number;
    events: ReviewConversationEvent[];
}

type RuntimeInteractionGuidedReview = Omit<GuidedReviewPolicy, "manualAvailable" | "stats"> &
    Partial<Pick<GuidedReviewPolicy, "manualAvailable">> & {
        stats: Partial<GuidedReviewPolicy["stats"]>;
    };

/** Presentation and review parameters carried with a prompt. */
export interface RuntimeInteractionRequestMetadata {
    cwd?: string;
    artifactId?: string;
    artifactKind?: SessionArtifactKind;
    artifactPath?: string;
    title?: string;
    markdown?: string;
    documentRoot?: string;
    reviewUrl?: string;
    planId?: string;
    planName?: string;
    planPath?: string;
    planReviewRecovery?: boolean;
    planningAgentName?: string;
    reviewContainerPlanId?: string;
    reviewContainerPlanName?: string;
    sequenceDocuments?: SequenceReviewPresentation[];
    classification?: string;
    expectedRevision?: string;
    expectedStatus?: string;
    previousPlan?: string;
    planVersions?: { plan: string; timestamp: string }[];
    triageMeta?: Partial<PlanFrontMatter>;
    displayedVersion?: PlanReviewVersion;
    reviewConversation?: ReviewConversation;
    agentLabel?: string;
    planTitle?: string;
    planContent?: string;
    planAttrs?: Partial<PlanFrontMatter>;
    diffText?: string;
    targetBranch?: string;
    targetBaseRef?: string;
    executionCwd?: string;
    guidedReview?: RuntimeInteractionGuidedReview;
    presentation?: "code_review_offer";
    supersededRequirement?: string;
    replacementRequirement?: string;
    reason?: string;
    attempt?: number;
    source?: string;
    questionType?: string;
    questionId?: string;
    other?: boolean;
    /** Receive output from the review host while the interaction is active. */
    onOutput?(output: ReviewServerOutput): void;
    /** Receive the review link and optional browser-open state once the surface is available. */
    onSurfaceReady?(surface: RuntimeInteractionSurface | string): void | Promise<void>;
}

interface RuntimeInteractionReviewImage extends ImageAttachment {
    name?: string;
}

interface RuntimeInteractionImageReference {
    path: string;
    name: string;
}

interface RuntimeInteractionReviewRecovery {
    message: string;
}

/** Review decisions and feedback returned by an interaction adapter. */
export interface RuntimeInteractionResponseMetadata {
    approved?: boolean;
    canceled?: boolean;
    exit?: boolean;
    conversationTurn?: boolean;
    cancellationReason?: string;
    feedback?: string;
    approvalAction?: PlanApprovalAction;
    planAttrs?: Partial<PlanFrontMatter>;
    revision?: string;
    savedPath?: string;
    url?: string;
    images?: readonly (RuntimeInteractionReviewImage | RuntimeInteractionImageReference)[];
    annotations?: readonly CodeReviewAnnotation[];
    sequenceDecision?: SequenceReviewDecision;
    recoveryRequired?: RuntimeInteractionReviewRecovery;
    remoteReview?: boolean;
    reviewerUrl?: string;
    spaceId?: string;
    serverUrl?: string;
    reused?: boolean;
    message?: string;
}

/** A choice a user can select from a request. */
export type RuntimeInteractionOption = {
    value: string;
    label: string;
    description?: string;
    _meta?: RuntimeInteractionOptionMetadata;
};

/** A prompt issued during a Session. The broker assigns an ID if the caller omits it. */
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
    _meta?: RuntimeInteractionRequestMetadata;
}

/** The user's response or the reason the interaction could not complete. */
export interface RuntimeInteractionResponse {
    outcome: RuntimeInteractionOutcome;
    value?: string | boolean;
    valueLabel?: string;
    /** Free text supplied alongside the selected Other choice. */
    otherText?: string;
    message?: string;
    _meta?: RuntimeInteractionResponseMetadata;
}

/** Presents a Session's interaction using the host's user interface. */
export interface RuntimeInteractionAdapter {
    /** Resolve a prompt or stop presenting it when the supplied signal aborts. */
    requestInteraction: (
        request: RuntimeInteractionRequest,
        signal?: AbortSignal,
    ) => Promise<RuntimeInteractionResponse> | RuntimeInteractionResponse;
    /** Report if this adapter can present the requested interaction kind. */
    supportsInteraction?: (type: string) => boolean;
    /** Dismiss pending prompts during Session teardown. */
    cancelAll?: () => void;
}

/** Recognize an affirmative choice using explicit metadata first and its value or label second. */
export function isApprovalAcceptedValue<Request extends Pick<RuntimeInteractionRequest, "options">>(
    request: Request,
    value: string,
): boolean {
    const options = request.options || [];
    const option = options.find((item) => item.value === value);
    if (option?._meta?.accepted === true || option?._meta?.approvalOutcome === "accepted") return true;
    if (option?._meta?.accepted === false || option?._meta?.approvalOutcome === "declined") return false;
    const acceptedValues = [
        "accept",
        "accepted",
        "approve",
        "approved",
        "yes",
        "true",
        "proceed",
        "continue",
        "confirm",
        "ok",
    ];
    const normalizedValue = value.toLowerCase();
    const normalizedLabel = String(option?.label || "").toLowerCase();
    return acceptedValues.includes(normalizedValue) || acceptedValues.includes(normalizedLabel);
}
