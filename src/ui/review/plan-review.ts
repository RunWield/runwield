import {
    applyPlanReviewConversation,
    hasCanonicalPlanAccess,
    openPlanLifecycleForCheckout,
    preparePlanReviewVersion,
    preparePlanWorkflow,
    prepareSequenceReviewVersion,
    validatePlanReviewSequence,
    withLocalPlanWorkflow,
} from "../../plan-store/index.ts";
import type { PlanReviewVersion, SequenceReviewPresentation } from "@runwield/plans/lifecycle";
import { type LoadedReviewImage, loadReviewFeedbackImages } from "../../shared/workflow/review-feedback-images.ts";
import type { ReviewAnnotationInput, ReviewImageInput } from "@runwield/plans/lifecycle";
import type { SequenceReviewDecision } from "../../plan-store/index.ts";
/**
 * @module ui/review/plan-review
 * Browser plan-review consumer used by the terminal runtime adapter.
 *
 * Launches the review UI through review-launcher.js so a future Workspace-hosted
 * The browser surface is isolated here so core only requests a review.
 */

import { isAnsweredPlanReview } from "../../shared/workflow/plan-review-recovery.ts";
import { startPlanReviewSurface } from "./review-launcher.ts";
import type { PlanFrontMatter } from "@runwield/plans";
import type { ReviewConversation, ReviewServerOutput } from "@runwield/session-runtime/interactions";
import type { PlanApprovalAction } from "@runwield/plans/lifecycle";
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

interface PlanReviewRecoveryRequired {
    message: string;
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

interface ReviewSurfaceReady {
    url: string;
    opened: boolean;
}

interface SubmitPlanForReviewOptions {
    sequenceDocuments?: SequenceReviewPresentation[];
    displayedVersion?: PlanReviewVersion;
    cwd: string;
    planName: string;
    planPath: string;
    previousPlan?: string;
    planVersions?: Array<{ plan: string; timestamp: string }>;
    reviewConversation?: ReviewConversation;
    agentLabel?: string;
    triageMeta?: Partial<PlanFrontMatter>;
    onOutput?(output: ReviewServerOutput): void;
    onSurfaceReady?(surface: ReviewSurfaceReady): void;
    signal?: AbortSignal;
    browser: BrowserPort;
}

// ─── Main Function ────────────────────────────────────────────────────

/**
 * Submit a plan for interactive review via the browser review surface.
 */
export async function submitPlanForReview(options: SubmitPlanForReviewOptions): Promise<PlanReviewResult> {
    return await withLocalPlanWorkflow(options.cwd, options.planName, () => submitPlanForReviewInScope(options));
}
async function submitPlanForReviewInScope({
    cwd,
    sequenceDocuments,
    displayedVersion,
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
    await preparePlanWorkflow(cwd, planName);
    const prepare = () =>
        preparePlanReviewVersion(cwd, planName, planPath, { triage: triageMeta, renderMarkdown: true });
    let individual = sequenceDocuments ? undefined : await prepare();
    const sequenceVersion = sequenceDocuments
        ? (displayedVersion ?? (await prepareSequenceReviewVersion(cwd, planName, sequenceDocuments)))
        : undefined;
    const server = await startPlanReviewSurface<PlanReviewDecision>({
        cwd,
        plan: individual?.markdown ?? sequenceDocuments![0].plan,
        sequenceDocuments,
        planPath,
        previousPlan,
        planVersions,
        reviewConversation,
        agentLabel,
        browser,
        onOutput,
        onSurfaceReady,
        onDecision: sequenceVersion
            ? async (decision) => {
                  if (!decision.exit) await validatePlanReviewSequence(cwd, sequenceVersion, decision);
              }
            : undefined,
        onReviewOpen:
            individual && hasCanonicalPlanAccess()
                ? async () => {
                      individual = await prepare();
                  }
                : undefined,
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
        const decision: PlanReviewDecision = await (signal
            ? Promise.race([server.waitForDecision(), canceled])
            : server.waitForDecision());
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
        const version = individual!.displayedVersion;
        const lifecycle = openPlanLifecycleForCheckout(cwd);
        if (!lifecycle) throw new Error("The review Project is no longer available.");
        const actionResult = decision.conversationTurn
            ? await applyPlanReviewConversation(cwd, version, decision)
            : await lifecycle.applyEvent(version.planId, {
                  ...decision,
                  event: decision.approved === true ? "review_approved" : "review_feedback",
                  displayedVersion: version,
              });

        const { sequence: _sequence, ...result } = actionResult;
        const images = await loadReviewFeedbackImages(decision, cwd);
        return {
            ...result,
            ...(decision.conversationTurn === true && { conversationTurn: true }),
            ...(decision.savedPath && { savedPath: decision.savedPath }),
            ...(images.length > 0 && { images }),
        };
    } finally {
        // Conversation turns keep the token page alive for the agent's next Plan revision.
        if (!keepSurfaceOpen) await server.stop();
    }
}
