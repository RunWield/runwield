import { recordDeliveryEvidence } from "./delivery-evidence.ts";
/**
 * @module shared/workflow/validation-human-review
 * The Code Review phase: asking the user to review the diff, handling
 * approval/feedback/closed-window, and persisting the review metadata.
 */

import { getCodeReviewMode, getGuidedReviewMode } from "../settings.js";
import { AGENTS } from "../../constants.js";
import { runPlanFrontMatterTransition } from "./state-transition.ts";
import { type ValidationInteractionResponse, ValidationInteractionTypes } from "./validation-ports.ts";
import type {
    HumanReviewMetadata,
    PhaseContext,
    UserActionPause,
    ValidationLoopArgs,
    ValidationPhaseResult,
} from "./validation-types.ts";
import { getPlanAttrs, recordLifecycleEvent } from "./validation-context.ts";
import { getWorktreeReviewDiff } from "./git-snapshot.ts";
import { emitProgress } from "./validation-emit.ts";
import { pauseForUserAction, requestInteraction } from "./validation-interactions.ts";
import { dispatchReviewFeedbackRepair } from "./validation-semantic.ts";
import { buildValidationUserMessage } from "./validation-user-messages.ts";

type HumanReviewAnnotations = Array<{ file?: string; line?: number; text?: string; body?: string }>;

type HumanReviewSurfaceReady = { url: string };

export function codeReviewPlanTitle(planContent: string, planName: string): string {
    const heading = planContent.split(/\r?\n/).find((line) => /^#\s+\S/.test(line));
    const title = heading ? heading.replace(/^#\s+/, "").trim() : "";
    return title || planName.trim();
}

export async function runHumanReviewPhase(
    args: ValidationLoopArgs,
    context: PhaseContext,
): Promise<ValidationPhaseResult> {
    const persistedMode = args.triageMeta.humanReviewMode;
    const mode = persistedMode === "always" || persistedMode === "ask" || persistedMode === "none"
        ? persistedMode
        : getCodeReviewMode(context.projectRoot);
    if (mode === "none") {
        await persistHumanReviewMetadata(args, context.executionCwd, {
            humanReviewMode: "none",
            humanReviewDecision: "not_required",
            humanReviewedAt: null,
        });
        return {
            kind: "paused",
            planName: args.planName,
            projectRoot: context.projectRoot,
            reason: "Code Review is not required.",
            continueValidation: true,
        };
    }

    // Asked once, not once per round. Someone who has already written feedback on this
    // diff does not need to be asked whether they want to see it again.
    if (mode === "ask" && args.triageMeta.humanReviewDecision !== "changes_requested") {
        const response = await requestInteraction(args, {
            type: ValidationInteractionTypes.SELECT,
            prompt: buildValidationUserMessage({ kind: "human_review_offer" }),
            _meta: { presentation: "code_review_offer" },
            options: [
                { value: "open", label: "Open code review" },
                { value: "skip", label: "Skip code review" },
                { value: "close", label: "Close and come back later" },
            ],
        });
        if (response.outcome !== "selected" || (response.value !== "open" && response.value !== "skip")) {
            return {
                kind: "paused",
                planName: args.planName,
                projectRoot: context.projectRoot,
                awaitingUserAction: true,
                reason:
                    `Code review is still waiting for your decision. Resume with /load-plan ${args.planName} to choose again.`,
            };
        }
        if (response.value === "skip") {
            await persistHumanReviewMetadata(args, context.executionCwd, {
                humanReviewMode: "ask",
                humanReviewDecision: "skipped",
                humanReviewedAt: null,
            });
            emitProgress(args, buildValidationUserMessage({ kind: "human_review_skipped" }), "info", {
                stage: "cycle",
                checks: { humanReview: "skipped" },
            });
            return {
                kind: "paused",
                planName: args.planName,
                projectRoot: context.projectRoot,
                reason: "Code Review skipped by user.",
                continueValidation: true,
            };
        }
    }

    let diffText = context.nonGitInPlace
        ? ""
        : await getWorktreeReviewDiff(context.executionCwd, context.worktreeBaseBranch || "");
    const planAttrs = getPlanAttrs(args.planContent);
    const planTitle = codeReviewPlanTitle(args.planContent, args.planName);
    const agentLabel = args.session.getAgentDisplayName(AGENTS.REVIEWER_FEEDBACK_ENGINEER, context.projectRoot);
    const conversationState = args.codeReviewConversation || { history: [] };
    const reviewConversation = conversationState.conversation ||= {
        id: crypto.randomUUID(),
        agentLabel,
        revision: 0,
        events: [] as Array<{
            type: "assistant_text_delta";
            delta: string;
            messageId: string;
            agentName: string;
        }>,
    };
    const conversationHistory = conversationState.history;
    const guidedReview = {
        mode: getGuidedReviewMode(context.projectRoot),
        autoStart: false,
        reasons: [],
        score: 0,
        stats: {},
    };
    for (;;) {
        const outcome = await requestHumanReviewDecision();
        if (outcome.kind === "conversation") continue;
        if (outcome.kind === "decided") return outcome.result;
        // The review window closed with no answer in it. That is not a rejection, so
        // it must not throw the work back to the start — ask what the user meant.
        // Retry opens the same review again; Stop leaves the Plan ready to publish
        // whenever they come back, with the review still outstanding.
        if (await pauseForUserAction(args, outcome.pause) === "retry") continue;
        return {
            kind: "paused",
            planName: args.planName,
            projectRoot: context.projectRoot,
            reason:
                `${outcome.pause.whatHappened} Run this Plan again when you are ready and RunWield will pick up at the review.`,
        };
    }

    async function requestHumanReviewDecision(): Promise<
        | { kind: "conversation" }
        | { kind: "decided"; result: ValidationPhaseResult }
        | { kind: "no_answer"; pause: UserActionPause }
    > {
        const humanReviewResponse = await requestInteraction(args, {
            type: ValidationInteractionTypes.CODE_REVIEW,
            prompt: buildValidationUserMessage({ kind: "human_review_prompt", planName: args.planName }),
            _meta: {
                planName: args.planName,
                planTitle,
                planContent: args.planContent,
                planAttrs,
                diffText,
                targetBranch: context.worktreeBaseBranch,
                executionCwd: context.executionCwd,
                guidedReview,
                reviewConversation,
                agentLabel,
                onSurfaceReady: (surface: HumanReviewSurfaceReady) => {
                    emitProgress(
                        args,
                        buildValidationUserMessage({ kind: "human_review_wait", reviewUrl: surface.url }),
                        "info",
                        {
                            outcome: "running",
                            stage: "human_review",
                            checks: { humanReview: "running" },
                        },
                    );
                },
            },
        });
        const humanReview = normalizeHumanReview(humanReviewResponse);
        if (humanReview.approved) {
            await recordDeliveryEvidence(
                context.projectRoot,
                args.planName,
                context.worktreeId || "in-place",
                "human",
                "Approved",
            );
            await persistHumanReviewMetadata(args, context.executionCwd, {
                humanReviewMode: mode,
                humanReviewDecision: "approved",
                humanReviewedAt: new Date().toISOString(),
            });
            emitProgress(args, buildValidationUserMessage({ kind: "human_review_approved" }), "success", {
                stage: "human_review",
                checks: { humanReview: "passed" },
            });
            return {
                kind: "decided",
                result: {
                    kind: "paused",
                    planName: args.planName,
                    projectRoot: context.projectRoot,
                    reason: "Code Review approved.",
                    continueValidation: true,
                },
            };
        }
        if (humanReview.feedback || humanReview.annotations.length || humanReview.images.length) {
            const feedbackText = buildHumanReviewFeedbackText(humanReview.feedback, humanReview.annotations);
            await recordDeliveryEvidence(
                context.projectRoot,
                args.planName,
                context.worktreeId || "in-place",
                "human",
                "Changes requested",
                feedbackText,
            );
            const conversationContext = humanReview.conversationTurn && conversationHistory.length > 0
                ? [
                    "Prior Code Review conversation:",
                    ...conversationHistory.map((entry) =>
                        `${entry.role === "user" ? "User" : agentLabel}: ${entry.text}`
                    ),
                    "",
                    "Current message:",
                    feedbackText,
                ].join("\n")
                : feedbackText;
            // Editing invalidates the checked revision even if the Agent is interrupted.
            await persistHumanReviewMetadata(args, context.executionCwd, {
                humanReviewMode: mode,
                humanReviewDecision: "changes_requested",
                humanReviewedAt: null,
            });
            await recordLifecycleEvent(
                args,
                context.projectRoot,
                "validation_failed",
                "reviewed",
                feedbackText,
            );
            const repair = await dispatchReviewFeedbackRepair(args, context, {
                diffText,
                findingsSection: conversationContext,
                repairKind: "human_feedback",
                images: humanReview.images,
                reason:
                    `User code review returned feedback. Dispatching repair...\nUser Code Review Feedback:\n${feedbackText}`,
            });
            if (repair.completed) {
                if (humanReview.conversationTurn) {
                    const reply = repair.report.trim() || "I applied the requested changes and refreshed the diff.";
                    conversationHistory.push(
                        { role: "user", text: feedbackText },
                        { role: "agent", text: reply },
                    );
                    reviewConversation.events.push({
                        type: "assistant_text_delta",
                        delta: reply,
                        messageId: `code-review-${crypto.randomUUID()}`,
                        agentName: agentLabel,
                    });
                    diffText = context.nonGitInPlace
                        ? ""
                        : await getWorktreeReviewDiff(context.executionCwd, context.worktreeBaseBranch || "");
                }
                return {
                    kind: "decided",
                    result: {
                        kind: "paused",
                        planName: args.planName,
                        projectRoot: context.projectRoot,
                        reason: "Code review feedback repair dispatched.",
                        continueValidation: true,
                    },
                };
            }
            // The repair stopped on a blocker or an operational failure. Its own
            // text is the reason; the review is not reopened over work that could
            // not be done.
            return {
                kind: "decided",
                result: {
                    kind: "paused",
                    planName: args.planName,
                    projectRoot: context.projectRoot,
                    reason: repair.reason || "The human-feedback repair did not finish.",
                },
            };
        }

        return {
            kind: "no_answer",
            pause: {
                whatHappened: humanReview.canceled
                    ? `You closed the code review for "${args.planName}" without approving it or leaving notes.`
                    : `The code review for "${args.planName}" ended without an approval or any notes.`,
                doThis: "Pick Retry to open it again, or Stop to come back to it later. Nothing has been thrown away.",
            },
        };
    }
}

export function normalizeHumanReview(response: ValidationInteractionResponse): {
    approved: boolean;
    feedback: string;
    annotations: HumanReviewAnnotations;
    images: Array<{ base64: string; mimeType: string }>;
    exit: boolean;
    canceled: boolean;
    conversationTurn: boolean;
} {
    const meta = response._meta && typeof response._meta === "object"
        ? response._meta as {
            approved?: boolean;
            feedback?: string;
            annotations?: HumanReviewAnnotations;
            images?: Array<{ base64: string; mimeType: string }>;
            exit?: boolean;
            canceled?: boolean;
            conversationTurn?: boolean;
        }
        : {};
    return {
        approved: meta.approved === true,
        feedback: typeof meta.feedback === "string" ? meta.feedback : response.message || "",
        annotations: Array.isArray(meta.annotations) ? meta.annotations : [],
        images: Array.isArray(meta.images) ? meta.images : [],
        exit: meta.exit === true,
        canceled: meta.canceled === true || response.outcome === "canceled",
        conversationTurn: meta.conversationTurn === true,
    };
}

function buildHumanReviewFeedbackText(feedback: string, annotations: HumanReviewAnnotations): string {
    const baseFeedback = feedback.trim() || "(no free-text feedback provided)";
    const missingAnnotations = feedback.trim()
        ? annotations.filter((annotation) => !feedbackIncludesAnnotation(feedback, annotation))
        : annotations;
    const annotationText = formatCodeReviewAnnotations(missingAnnotations);
    return [
        baseFeedback,
        annotationText ? `Annotations:\n${annotationText}` : "",
    ].filter(Boolean).join("\n\n");
}

function feedbackIncludesAnnotation(feedback: string, annotation: HumanReviewAnnotations[number]): boolean {
    const text = annotation.text || annotation.body || "";
    const normalizedText = normalizeFeedbackText(text);
    if (!normalizedText) return true;
    return normalizeFeedbackText(feedback).includes(normalizedText);
}

function normalizeFeedbackText(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

export function formatCodeReviewAnnotations(annotations: HumanReviewAnnotations): string {
    return annotations.map((annotation, index) => {
        const location = [annotation.file, annotation.line].filter((part) => part !== undefined && part !== "").join(
            ":",
        );
        const text = annotation.text || annotation.body || "(no annotation text)";
        return `${index + 1}. ${location ? `${location}: ` : ""}${text}`;
    }).join("\n");
}

export async function persistHumanReviewMetadata(
    args: ValidationLoopArgs,
    projectRoot: string,
    metadata: HumanReviewMetadata,
): Promise<void> {
    await runPlanFrontMatterTransition({
        projectRoot,
        planName: args.planName,
        operation: "validation_human_review_metadata",
        updates: metadata,
        recoveryAttrs: { ...args.triageMeta },
    });
}
