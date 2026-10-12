import {
    type LoadedReviewImage,
    loadReviewFeedbackImages,
    type ReviewAnnotationInput,
    type ReviewImageInput,
} from "../../shared/workflow/review-feedback-images.ts";
import type { SequenceReviewDecision, SequenceReviewDocument } from "../../shared/workflow/sequence-review.ts";
/**
 * @module ui/review/plan-review
 * Browser plan-review consumer used by the terminal runtime adapter.
 *
 * Launches the review UI through review-launcher.js so a future Workspace-hosted
 * The browser surface is isolated here so core only requests a review.
 */

import { injectFrontMatter, loadPlanFileStrict, planDocumentMarkdown } from "../../plan-store.js";
import { assertSharedPlanWriteAllowed } from "../../shared/collaboration/lock.ts";
import { isAnsweredPlanReview } from "../../shared/workflow/plan-review-recovery.js";
import { applySharedPlanReviewDecision } from "../../shared/workflow/plan-review-actions.ts";
import { startPlanReviewSurface } from "./review-launcher.ts";
import type { PlanFrontMatter } from "../../plan-store.js";
import type { PlanApprovalAction } from "../../shared/workflow/plan-approval.ts";
import type { BrowserPort } from "../../shared/browser-port.ts";

interface PlanReviewDecision extends SequenceReviewDecision {
    approved?: boolean;
    canceled?: boolean;
    exit?: boolean;
    _cancelled?: boolean;
    feedback?: string;
    approvalAction?: PlanApprovalAction;
    plan?: string;
    savedPath?: string;
    executionAgent?: "engineer" | "frontend-engineer";
    collaborationRecommendation?: "autonomous" | "pair";
    images?: ReviewImageInput[];
    globalAttachments?: ReviewImageInput[];
    annotations?: ReviewAnnotationInput[];
    codeAnnotations?: ReviewAnnotationInput[];
    conversationTurn?: boolean;
}

interface PlanReviewConversationEvent {
    type: "assistant_text_delta";
    delta: string;
    messageId: string;
    agentName: string;
}

interface PlanReviewConversation {
    id: string;
    agentLabel: string;
    revision: number;
    events: PlanReviewConversationEvent[];
}

interface PlanReviewRecoveryRequired {
    message: string;
    entryIds: string[];
}

export interface PlanReviewResult {
    [key: string]:
        | string
        | boolean
        | PlanApprovalAction
        | PlanFrontMatter
        | SequenceReviewDecision
        | LoadedReviewImage[]
        | PlanReviewRecoveryRequired
        | undefined;
    sequenceDecision?: SequenceReviewDecision;
    conversationTurn?: boolean;
    approved: boolean;
    canceled?: boolean;
    cancellationReason?: string;
    feedback?: string;
    approvalAction?: PlanApprovalAction;
    planAttrs?: PlanFrontMatter;
    revision?: string;
    savedPath?: string;
    images?: LoadedReviewImage[];
    recoveryRequired?: PlanReviewRecoveryRequired;
}

interface ReviewServerOutput {
    stream: "stdout" | "stderr";
    text: string;
}

interface ReviewSurfaceReady {
    url: string;
    opened: boolean;
}

interface SubmitPlanForReviewOptions {
    sequenceDocuments?: SequenceReviewDocument[];
    cwd: string;
    planName: string;
    planPath: string;
    previousPlan?: string;
    planVersions?: Array<{ plan: string; timestamp: string }>;
    reviewConversation?: PlanReviewConversation;
    agentLabel?: string;
    triageMeta?: Partial<PlanFrontMatter>;
    onOutput?(output: ReviewServerOutput): void;
    onSurfaceReady?(surface: ReviewSurfaceReady): void;
    signal?: AbortSignal;
    browser: BrowserPort;
}

/** Compose the same document-only payload for Core and Attached review hosts. */
export async function preparePlanReviewPayload(planPath: string, triageMeta?: Partial<PlanFrontMatter>) {
    const plan = await loadPlanFileStrict(planPath);
    if (plan.kind !== "loaded") {
        if (plan.kind === "malformed") throw plan.error;
        throw new Error("The Plan could not be opened for review. Your files have not been changed.");
    }
    const { attrs, body, revision: planRevision } = plan;

    assertSharedPlanWriteAllowed(attrs);
    const fmOverrides: Partial<PlanFrontMatter> = {
        ...attrs,
        updatedAt: new Date().toISOString(),
    };

    if (triageMeta) {
        if (triageMeta.classification) {
            fmOverrides.classification = triageMeta.classification;
        }
        if (triageMeta.workKind) fmOverrides.workKind = triageMeta.workKind;
        if (triageMeta.complexity) fmOverrides.complexity = triageMeta.complexity;
        if (triageMeta.summary) fmOverrides.summary = triageMeta.summary;
        if (triageMeta.affectedPaths) {
            fmOverrides.affectedPaths = triageMeta.affectedPaths;
        }
    }

    const trustedClassification = fmOverrides.classification;
    const trustedWorkKind = fmOverrides.workKind;
    const planWithFm = planDocumentMarkdown(injectFrontMatter(body, fmOverrides));

    return { attrs, planRevision, planWithFm, trustedClassification, trustedWorkKind };
}

// ─── Main Function ────────────────────────────────────────────────────

/**
 * Submit a plan for interactive review via the browser review surface.
 */
export async function submitPlanForReview({
    cwd,
    sequenceDocuments,
    planName,
    planPath,
    previousPlan,
    planVersions,
    reviewConversation,
    agentLabel,
    triageMeta,
    onOutput,
    onSurfaceReady,
    signal,
    browser,
}: SubmitPlanForReviewOptions): Promise<PlanReviewResult> {
    const { attrs, planRevision, planWithFm, trustedClassification, trustedWorkKind } = await preparePlanReviewPayload(
        planPath,
        triageMeta,
    );

    // 4. Start the real review surface; only browser opening crosses the port.
    const server = await startPlanReviewSurface<PlanReviewDecision>({
        cwd,
        plan: planWithFm,
        sequenceDocuments,
        planPath,
        previousPlan,
        planVersions,
        reviewConversation,
        agentLabel,
        browser,
        onOutput,
        onSurfaceReady,
    });

    let keepSurfaceOpen = false;
    try {
        const canceled = new Promise<PlanReviewDecision>((resolveCanceled) => {
            if (signal?.aborted) {
                resolveCanceled({ _cancelled: true });
                return;
            }
            signal?.addEventListener("abort", () => resolveCanceled({ _cancelled: true }), { once: true });
        });
        const decision: PlanReviewDecision = await (
            signal ? Promise.race([server.waitForDecision(), canceled]) : server.waitForDecision()
        );
        keepSurfaceOpen = decision.conversationTurn === true;

        // Handle cancellation triggered from the TUI or review timeout/exit before
        // writing edited review content or recording Plan Review lifecycle events.
        if (decision._cancelled) {
            return {
                approved: false,
                canceled: true,
                feedback: "Cancelled by user (Esc)",
                cancellationReason: "abort_signal",
            };
        }
        if (decision?.canceled || decision?.exit) {
            return {
                approved: false,
                canceled: true,
                feedback: typeof decision.feedback === "string" ? decision.feedback : "",
                cancellationReason: decision.exit ? "review_exit" : "review_canceled",
            };
        }
        if (!isAnsweredPlanReview(decision)) {
            return {
                approved: false,
                feedback: typeof decision?.feedback === "string" ? decision.feedback : "",
                cancellationReason: "malformed_review_response",
            };
        }

        if (sequenceDocuments) {
            // The workflow owns the complete group transaction, including its durable dispatch event.
            return {
                approved: decision.approved === true,
                approvalAction: decision.approvalAction,
                feedback: decision.feedback,
                sequenceDecision: decision,
                ...(decision.conversationTurn === true && { conversationTurn: true }),
            };
        }
        const actionResult = await applySharedPlanReviewDecision({
            cwd,
            planName,
            planPath,
            planWithFrontMatter: planWithFm,
            planRevision,
            originalAttrs: attrs,
            trustedClassification,
            trustedWorkKind,
            decision,
        });

        const images = await loadReviewFeedbackImages(decision, cwd);
        return {
            ...actionResult,
            ...(decision.conversationTurn === true && { conversationTurn: true }),
            ...(decision.savedPath && { savedPath: decision.savedPath }),
            ...(images.length > 0 && { images }),
        };
    } finally {
        // Conversation turns keep the token page alive for the agent's next Plan revision.
        if (!keepSurfaceOpen) await server.stop();
    }
}
