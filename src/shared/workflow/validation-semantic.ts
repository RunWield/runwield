import { recordDeliveryEvidence } from "./delivery-evidence.ts";
/**
 * @module shared/workflow/validation-semantic
 * The Semantic Review phase: reviewer rounds with ledger convergence, repair
 * dispatch, and the round-limit decision when the automatic rounds are spent.
 */

import { AGENTS } from "../../constants.js";
import { captureWorktreeTree, getWorkflowDiff, getWorktreeReviewDiff } from "./git-snapshot.ts";
import { buildDiffInspectionSection, createReviewDiffTool, parseDiffFiles } from "./review-diff-tool.js";
import { ReviewInspection } from "./review-inspection.ts";
import { loadEpicReviewContext, recordIntegrationNotes } from "./epic-review-context.ts";
import { logValidationFailure } from "./validation-state-errors.ts";
import {
    applyRoundFindings,
    claimReviewFixes,
    openItems,
    renderOpenItems,
    renderResolvedItems,
    unaccountedOpenItems,
} from "./review-ledger.ts";
import { hasImplementationDiff, requiresImplementationDiff } from "./validation-scope.ts";
import { buildValidationUserMessage, validationReviewerPauseMessage } from "./validation-user-messages.ts";
import type { OpaqueToolDefinition, ValidationReviewOutcome, ValidationWorkflowState } from "./validation-ports.ts";
import type {
    PhaseContext,
    ReviewFeedbackRepairPacket,
    SemanticRoundState,
    ValidationLoopArgs,
    ValidationPhaseResult,
} from "./validation-types.ts";
import {
    hasFinalHumanReviewDecision,
    readHumanReviewMetadata,
    readSemanticRoundState,
    recordLifecycleEvent,
    recordMetric,
    resolvePhaseContext,
} from "./validation-context.ts";
import { SEMANTIC_REVIEW_CYCLES } from "./validation-types.ts";
import { clampCycle, emitHalted, emitProgress, emitStatus, repairBlockedReason } from "./validation-emit.ts";
import { requestInteraction } from "./validation-interactions.ts";
import { ValidationInteractionTypes } from "./validation-ports.ts";
import { persistHumanReviewMetadata, runHumanReviewPhase } from "./validation-human-review.ts";
import { runPublicationPhase } from "./validation-publication.ts";
import { buildValidationRepairPrompt } from "./validation-repair-prompt.ts";
import { projectEngineerPlanBody } from "./engineer-plan-projection.ts";
import { makeValidationCheckpoint, type ValidationReviewState } from "./validation-checkpoint.ts";
import { classifyValidationOperationalError } from "./validation-operational-errors.ts";
import {
    decideValidationRecovery,
    readValidationRetryPolicy,
    recordOperationalRecoveryMetric,
    waitForValidationRetryWithSessionCancellation,
} from "./validation-recovery.ts";

export async function runSemanticReviewPhase(args: ValidationLoopArgs): Promise<ValidationPhaseResult> {
    const phase = await resolvePhaseContext(args);
    if (phase.kind === "blocked") return phase.result;
    const context = phase.context;
    if (context.nonGitInPlace) {
        await recordDeliveryEvidence(
            context.projectRoot,
            args.planName,
            context.worktreeId || "in-place",
            "ai-skip",
            "Skipped",
            "Non-Git in-place workflow has no implementation diff review.",
        );
        emitStatus(args, buildValidationUserMessage({ kind: "semantic_skipped", reason: "non_git" }), "info");
        await recordLifecycleEvent(
            args,
            context.projectRoot,
            "semantic_review_passed",
            args.triageMeta.status === "implemented" ? "implemented" : "validated_ci",
        );
        return {
            kind: "paused",
            planName: args.planName,
            projectRoot: context.projectRoot,
            reason: "Semantic Review skipped for non-Git execution.",
            continueValidation: true,
        };
    }
    // The user asked for these changes themselves, so they are the reviewer now — they
    // took over either because the Semantic Code Reviewer found nothing or because it
    // kept finding things round after round. Sweeping the diff again would hand back
    // objections the user has already moved past, and cost a full review cycle for
    // every note they write. Run the tests, then give them the diff back.
    if (args.triageMeta.humanReviewDecision === "changes_requested") {
        await recordLifecycleEvent(
            args,
            context.projectRoot,
            "semantic_review_passed",
            args.triageMeta.status === "implemented" ? "implemented" : "validated_ci",
        );
        return {
            kind: "paused",
            planName: args.planName,
            projectRoot: context.projectRoot,
            reason: "Reopening your code review with the repair.",
            continueValidation: true,
        };
    }

    const state = readSemanticRoundState(args, context);
    const round = state.semanticRound;
    const ledger = state.reviewLedger;
    const diffText = await getWorktreeReviewDiff(context.executionCwd, context.worktreeBaseBranch || "");
    if (requiresImplementationDiff(args.triageMeta) && !hasImplementationDiff(diffText, args.planName)) {
        const planOnly = Boolean(diffText.trim());
        const reason = planOnly
            ? "No implementation changes detected in workflow diff; only plan document changes were found."
            : "No implementation changes detected in workflow diff.";
        emitHalted(args, buildValidationUserMessage({ kind: "semantic_diff_missing", planOnly }), reason);
        await recordLifecycleEvent(
            args,
            context.projectRoot,
            "validation_failed",
            args.triageMeta.status === "implemented" ? "implemented" : "validated_ci",
            reason,
        );
        return { kind: "failed", planName: args.planName, projectRoot: context.projectRoot, reason };
    }
    if (!hasImplementationDiff(diffText, args.planName)) {
        await recordDeliveryEvidence(
            context.projectRoot,
            args.planName,
            context.worktreeId || "in-place",
            "ai-skip",
            "Skipped",
            "No implementation diff remained to review.",
        );
        emitStatus(args, buildValidationUserMessage({ kind: "semantic_skipped", reason: "empty_diff" }), "info");
        await recordLifecycleEvent(
            args,
            context.projectRoot,
            "semantic_review_passed",
            args.triageMeta.status === "implemented" ? "implemented" : "validated_ci",
        );
        return {
            kind: "paused",
            planName: args.planName,
            projectRoot: context.projectRoot,
            reason: "Semantic Review skipped because the diff is empty.",
            continueValidation: true,
        };
    }

    if (round >= SEMANTIC_REVIEW_CYCLES && state.lastRepairReport) {
        const action = await promptForSemanticRoundLimit(
            args,
            round,
            openItems(ledger).length,
            true,
        );
        if (action === "code_review") {
            await recordDeliveryEvidence(
                context.projectRoot,
                args.planName,
                context.worktreeId || "in-place",
                "ai-skip",
                "Human takeover",
                "AI review reached its round limit; the user chose human Code Review. This is not AI approval.",
            );
            await persistHumanReviewMetadata(args, context.executionCwd, {
                humanReviewMode: "always",
                humanReviewDecision: null,
                humanReviewedAt: null,
            });
            await recordLifecycleEvent(
                args,
                context.projectRoot,
                "semantic_review_passed",
                args.triageMeta.status === "implemented" ? "implemented" : "validated_ci",
                undefined,
                { humanReviewMode: "always", humanReviewDecision: null, humanReviewedAt: null },
            );
            return {
                kind: "paused",
                planName: args.planName,
                projectRoot: context.projectRoot,
                reason: "Semantic Review round limit reached; Code Review requested.",
                continueValidation: true,
            };
        }
        if (action === "engineer_follow_up") {
            const response = await requestInteraction(args, {
                type: ValidationInteractionTypes.TEXT,
                prompt: buildValidationUserMessage({ kind: "repair_feedback_prompt" }),
                defaultValue: buildValidationUserMessage({ kind: "repair_feedback_default" }),
            });
            if (response.outcome !== "text") {
                return {
                    kind: "paused",
                    planName: args.planName,
                    projectRoot: context.projectRoot,
                    awaitingUserAction: true,
                    reason: "Engineer follow-up canceled. Your review findings are saved.",
                };
            }
            const feedback = typeof response.value === "string" ? response.value.trim() : "";
            await recordLifecycleEvent(
                args,
                context.projectRoot,
                "validation_failed",
                args.triageMeta.status === "implemented" ? "implemented" : "validated_ci",
                feedback,
            );
            const repair = await args.session.continueLastRepairTurn(feedback);
            if (!repair?.completed) {
                return {
                    kind: "paused",
                    planName: args.planName,
                    projectRoot: context.projectRoot,
                    reason: repairBlockedReason(args, context.projectRoot, repair?.blockerText),
                };
            }
            args.session.setActiveWorkflow({
                ...context.workflowBase,
                semanticRound: round,
                reviewLedger: claimReviewFixes(ledger),
                repairBaselineTree: state.repairBaselineTree,
                lastRepairReport: repair.report,
            });
            return {
                kind: "paused",
                planName: args.planName,
                projectRoot: context.projectRoot,
                continueValidation: true,
                reason: "The repair is complete. Running checks before another review.",
            };
        } else if (action === "stop") {
            return {
                kind: "paused",
                planName: args.planName,
                projectRoot: context.projectRoot,
                reason: `The reviewer still has ${
                    openItems(ledger).length
                } open point(s) on "${args.planName}". The findings and last repair session are saved.`,
            };
        }
    }

    // The first two rounds review the whole implementation. Subsequent rounds
    // verify the ledger and repair delta, without reopening general discovery.
    // Each round below the limit ends by handing the
    // Plan back to `implemented`, so the tests run over the repair before the next
    // review. At the limit the user takes the wheel, and their "look again" re-enters
    // right here — another focused round on the repaired diff, no detour.
    for (;;) {
        const nextRound = round + 1;
        const reviewMode = nextRound <= 2 ? "discovery" : "verify";
        // The reviewer runs in its own session, so without this the whole round is
        // silent: the user sees the Engineer finish, then nothing, and the verdict
        // lands only in the Plan's failure reason. Say a round is starting, and say
        // which kind it is — a verify round reads very differently from a sweep.
        emitProgress(
            args,
            buildValidationUserMessage({
                kind: "semantic_round",
                round: nextRound,
                maxRounds: SEMANTIC_REVIEW_CYCLES,
                mode: reviewMode,
            }),
            "info",
            {
                outcome: "running",
                stage: "semantic_review",
                cycle: clampCycle(nextRound, SEMANTIC_REVIEW_CYCLES),
                maxCycles: SEMANTIC_REVIEW_CYCLES,
                checks: { semanticReview: "running" },
            },
        );
        const review = await runReviewerRound(
            args,
            context,
            { ...state, semanticRound: nextRound, reviewLedger: ledger },
            reviewMode,
            diffText,
        );
        if (review.kind === "paused") return review.result;
        if (review.kind === "failed") {
            await recordLifecycleEvent(
                args,
                context.projectRoot,
                "validation_failed",
                args.triageMeta.status === "implemented" ? "implemented" : "validated_ci",
                review.reason,
            );
            return {
                kind: "failed",
                planName: args.planName,
                projectRoot: context.projectRoot,
                reason: review.reason,
            };
        }

        await recordDeliveryEvidence(
            context.projectRoot,
            args.planName,
            context.worktreeId || "in-place",
            "ai",
            review.outcome.approved ? "Approved" : "Changes requested",
            "````json\n" + JSON.stringify(review.outcome, null, 2) + "\n````",
        );
        if (review.outcome.approved) {
            await recordMetric(args, context.projectRoot, {
                category: "validation",
                event: "semantic_review_result",
                planName: args.planName,
                details: {
                    semanticRound: nextRound,
                    reviewMode,
                    approved: true,
                    hasDiff: true,
                    approvedByRoundTwo: nextRound <= 2,
                    resolvedThisRound: review.resolvedCount,
                    advisoryCount: review.outcome.advisories.length,
                    ...reviewFindingMetrics(review.outcome.findings, nextRound),
                },
            });
            emitProgress(args, buildValidationUserMessage({ kind: "semantic_approved", round: nextRound }), "success", {
                stage: "semantic_review",
                cycle: clampCycle(nextRound, SEMANTIC_REVIEW_CYCLES),
                maxCycles: SEMANTIC_REVIEW_CYCLES,
                checks: { semanticReview: "passed" },
            });
            const priorCheckpoint = args.validationCheckpoint || args.triageMeta.validationCheckpoint;
            const reviewState: ValidationReviewState = {
                ...state,
                semanticRound: nextRound,
                reviewLedger: review.ledger,
            };
            const checkpoint = makeValidationCheckpoint({
                attemptId: context.worktreeId || "in-place",
                generation: priorCheckpoint?.generation || crypto.randomUUID(),
                status: "reviewed",
                phase: "delivery",
                state: "ready",
                reviewState,
            });
            await recordLifecycleEvent(
                args,
                context.projectRoot,
                "semantic_review_passed",
                args.triageMeta.status === "implemented" ? "implemented" : "validated_ci",
                undefined,
                {
                    validationCheckpoint: checkpoint,
                },
            );
            args.session.setActiveWorkflow({ ...context.workflowBase, ...reviewState });
            return {
                kind: "paused",
                planName: args.planName,
                projectRoot: context.projectRoot,
                reason: "Semantic Review passed.",
                continueValidation: true,
            };
        }

        const openCount = openItems(review.ledger).length;
        await recordMetric(args, context.projectRoot, {
            category: "validation",
            event: "semantic_review_result",
            planName: args.planName,
            details: {
                semanticRound: nextRound,
                reviewMode,
                approved: false,
                hasReviewerOutput: Boolean(review.outcome.feedback),
                openFindingCount: openCount,
                resolvedThisRound: review.resolvedCount,
                appendedThisRound: review.appendedCount,
                advisoryCount: review.outcome.advisories.length,
                ...reviewFindingMetrics(review.outcome.findings, nextRound),
            },
        });

        const repairBaselineTree = await captureWorktreeTree(context.executionCwd);
        const findingsSection = openCount > 0 ? renderOpenItems(review.ledger) : review.outcome.feedback;
        const priorCheckpoint = args.validationCheckpoint || args.triageMeta.validationCheckpoint;
        const repairGeneration = crypto.randomUUID();
        const reviewState: ValidationReviewState = {
            semanticRound: nextRound,
            reviewLedger: review.ledger,
            repairBaselineTree,
        };
        const repairCheckpoint = makeValidationCheckpoint({
            attemptId: context.worktreeId || "in-place",
            generation: priorCheckpoint?.generation || crypto.randomUUID(),
            status: "implemented",
            phase: "mechanical",
            state: "awaiting_repair",
            repairKind: "semantic",
            repairGeneration,
            reviewState,
        });
        await recordLifecycleEvent(
            args,
            context.projectRoot,
            "semantic_review_feedback",
            args.triageMeta.status === "implemented" ? "implemented" : "validated_ci",
            review.outcome.feedback || "Semantic Review requested changes.",
            { validationCheckpoint: repairCheckpoint },
        );
        args.session.setActiveWorkflow({
            ...context.workflowBase,
            semanticRound: nextRound,
            reviewLedger: review.ledger,
            repairBaselineTree,
            validationRepairGeneration: repairGeneration,
        });
        if (!args.supportsSemanticRepairHandoff) {
            const repair = await dispatchReviewFeedbackRepair(args, context, {
                diffText,
                findingsSection,
                repairKind: "semantic",
                reason: `Review round ${nextRound} found ${openCount || "open"} issue(s). Dispatching repair...`,
                activeWorkflow: {
                    semanticRound: nextRound,
                    reviewLedger: review.ledger,
                    repairBaselineTree,
                    validationRepairGeneration: repairGeneration,
                },
            });
            if (!repair.completed) {
                const reason = repair.reason ||
                    "Reviewer-Feedback Engineer stopped without task_completed during semantic repair.";
                return { kind: "paused", planName: args.planName, projectRoot: context.projectRoot, reason };
            }
            return {
                kind: "paused",
                planName: args.planName,
                projectRoot: context.projectRoot,
                continueValidation: true,
                reason: "The repair is complete. Running checks before another review.",
            };
        }
        await recordDeliveryEvidence(
            context.projectRoot,
            args.planName,
            context.worktreeId || "in-place",
            "ai-repair",
            "Started",
        );
        emitProgress(args, buildValidationUserMessage({ kind: "review_repair", repairKind: "semantic" }), "warning", {
            stage: "engineer_repair",
            outcome: "running",
            checks: { semanticReview: "failed", humanReview: "pending", merge: "pending" },
        });
        return {
            kind: "semantic_repair_handoff",
            planName: args.planName,
            projectRoot: context.projectRoot,
            reason: `Review round ${nextRound} found ${openCount || "open"} issue(s). Dispatching repair...`,
            semanticRepairHandoff: {
                semanticRound: nextRound,
                repairGeneration,
                reviewLedger: review.ledger,
                repairBaselineTree,
                diffText,
                findingsSection,
                activeWorkflow: {
                    semanticRound: nextRound,
                    reviewLedger: review.ledger,
                    repairBaselineTree,
                    validationRepairGeneration: repairGeneration,
                },
            },
        };
    }
}

export async function runValidatedReviewerPhase(args: ValidationLoopArgs): Promise<ValidationPhaseResult> {
    const phase = await resolvePhaseContext(args);
    if (phase.kind === "blocked") return phase.result;
    if (!hasFinalHumanReviewDecision(args.triageMeta)) {
        return await runHumanReviewPhase(args, phase.context);
    }
    const publication = await runPublicationPhase(args, phase.context, readHumanReviewMetadata(args.triageMeta));
    return publication.result;
}

export async function runReviewerRound(
    args: ValidationLoopArgs,
    context: PhaseContext,
    state: SemanticRoundState,
    reviewMode: "discovery" | "verify",
    diffText: string,
): Promise<
    | {
        kind: "complete";
        outcome: ValidationReviewOutcome;
        ledger: SemanticRoundState["reviewLedger"];
        resolvedCount: number;
        appendedCount: number;
    }
    | { kind: "paused"; result: ValidationPhaseResult }
    | { kind: "failed"; reason: string }
> {
    // One in-memory session manager per round, shared across every nudge attempt:
    // the reviewer's accumulated context is what makes a nudge "continue this
    // review" instead of "start over".
    const reviewerSessionManager = args.session.createInMemorySessionManager(context.executionCwd);
    let nudgeReason: string | undefined;
    let inspectedDiff = false;
    let latestOutcome: ValidationReviewOutcome | null = null;
    // A child of an Epic with its own branch is reviewed for its own correctness, with the Epic as context.
    const epicContext = await loadEpicReviewContext(context.projectRoot, args.planName, args.triageMeta).catch(() =>
        null
    );
    let operationalAttempt = 1;
    const repairDiffText = state.repairBaselineTree
        ? await getWorkflowDiff(context.executionCwd, state.repairBaselineTree)
        : "";
    const requiredScope = reviewMode === "discovery" ? "full" : "repair";
    const inspection = new ReviewInspection(
        parseDiffFiles(requiredScope === "full" ? diffText : repairDiffText).map((file) => ({
            scope: requiredScope,
            path: file.path,
            byteLength: file.byteLength,
        })),
    );

    function preserveReviewerRoundState(): void {
        emitStatus(args, validationReviewerPauseMessage(args.planName), "warning");
        args.session.setActiveWorkflow({
            ...context.workflowBase,
            ...(args.session.getActiveWorkflow() || {}),
            semanticRound: state.semanticRound - 1,
            reviewLedger: state.reviewLedger,
            repairBaselineTree: state.repairBaselineTree,
            lastRepairReport: state.lastRepairReport,
        });
    }

    for (let attempt = 1; !latestOutcome; attempt++) {
        if (attempt > 1) {
            emitStatus(
                args,
                buildValidationUserMessage({
                    kind: "reviewer_nudge",
                    round: state.semanticRound,
                    attempt,
                }),
                "info",
            );
        }
        const config = buildSemanticReviewAttempt(
            attempt,
            nudgeReason,
            state,
            reviewMode,
            diffText,
            repairDiffText,
            args.planContent,
            inspection,
            epicContext?.section || "",
        );
        nudgeReason = undefined;
        try {
            const sessionOutcome = await args.session.runIsolatedAgentSession({
                kind: "reviewer",
                agentName: AGENTS.REVIEWER,
                userRequest: config.prompt,
                cwd: context.executionCwd,
                reviewerMode: reviewMode,
                customTools: config.customTools,
                sessionManager: reviewerSessionManager,
            });
            if (sessionOutcome.outcome === "operational_failure") {
                const decision = decideValidationRecovery({
                    failure: sessionOutcome.failure,
                    attempt: sessionOutcome.failure.recoveryClass === "transient" ? operationalAttempt : attempt,
                    correctionAttempt: attempt,
                    policy: readValidationRetryPolicy(context.projectRoot),
                    nextPhase: "semantic",
                });
                await recordOperationalRecoveryMetric(args, context.projectRoot, decision.result);
                emitStatus(args, decision.result.message, decision.action === "halt" ? "error" : "warning");
                if (decision.action === "retry") {
                    const wait = await waitForValidationRetryWithSessionCancellation(
                        args,
                        decision.delayMs,
                        "semantic",
                    );
                    if (wait === "completed") {
                        operationalAttempt += 1;
                        attempt -= 1;
                        continue;
                    }
                }
                if (decision.action === "correct") {
                    nudgeReason = decision.result.message;
                    continue;
                }
                preserveReviewerRoundState();
                return {
                    kind: "paused",
                    result: {
                        kind: decision.action === "halt" ? "failed" : "paused",
                        planName: args.planName,
                        projectRoot: context.projectRoot,
                        reason: decision.result.message,
                        recovery: decision.result,
                    },
                };
            }
            if (sessionOutcome.usedDiffTool) inspectedDiff = true;
            const trustedOpaqueMcpReview = sessionOutcome.trustedOpaqueMcpReview;
            const outcome = sessionOutcome.reviewOutcome;
            const unaccounted = unaccountedOpenItems(state.reviewLedger, outcome?.findings);
            if (!outcome) {
                const correction = inspection.feedback() ||
                    (unaccounted.length
                        ? `Account for every open finding: ${
                            unaccounted.join(", ")
                        }. Reuse the existing identities exactly; confirm or reject each fix with a reason.`
                        : "");
                const failure = classifyValidationOperationalError({
                    source: "reviewer_protocol",
                    kind: "missing_review_complete",
                    operation: "semantic_review",
                    message: "Semantic Reviewer finished without an accepted review_complete.",
                    required:
                        `No review_complete was accepted. Follow any tool rejection instructions and retry without restarting the review. ${correction}`,
                });
                const decision = decideValidationRecovery({
                    failure,
                    attempt,
                    correctionAttempt: attempt,
                    policy: readValidationRetryPolicy(context.projectRoot),
                    nextPhase: "semantic",
                });
                await recordOperationalRecoveryMetric(args, context.projectRoot, decision.result);
                if (decision.action === "correct") {
                    nudgeReason = decision.result.message;
                    continue;
                }
                preserveReviewerRoundState();
                return {
                    kind: "paused",
                    result: {
                        kind: decision.action === "halt" ? "failed" : "paused",
                        planName: args.planName,
                        projectRoot: context.projectRoot,
                        reason: decision.result.message,
                        recovery: decision.result,
                    },
                };
            } else if (!inspectedDiff && !trustedOpaqueMcpReview) {
                const failure = classifyValidationOperationalError({
                    source: "reviewer_protocol",
                    kind: "diff_not_read",
                    operation: "semantic_review",
                    message: "Semantic Reviewer decided without inspecting the diff.",
                    required:
                        'You called review_complete without inspecting the diff. Read the changes with review_diff(command: "list") and then review_diff(command: "show", ...) before deciding, then call review_complete again.',
                });
                const decision = decideValidationRecovery({
                    failure,
                    attempt,
                    correctionAttempt: attempt,
                    policy: readValidationRetryPolicy(context.projectRoot),
                    nextPhase: "semantic",
                });
                await recordOperationalRecoveryMetric(args, context.projectRoot, decision.result);
                if (decision.action === "correct") {
                    nudgeReason = decision.result.message;
                    continue;
                }
                preserveReviewerRoundState();
                return {
                    kind: "paused",
                    result: {
                        kind: decision.action === "halt" ? "failed" : "paused",
                        planName: args.planName,
                        projectRoot: context.projectRoot,
                        reason: decision.result.message,
                        recovery: decision.result,
                    },
                };
            } else if (unaccounted.length > 0) {
                const required = `Your result does not mention ${
                    unaccounted.length === 1 ? "this open finding" : "these open findings"
                }: ${
                    unaccounted.join(", ")
                }. Every open finding must appear in your \`findings\` array — with \`resolved: true\` if you have verified the fix in the code, or with \`resolved: false\` and what is still missing. Reuse the existing identities exactly; do not renumber them or report the same issue as a new finding. Call review_complete again with the complete set.`;
                const failure = classifyValidationOperationalError({
                    source: "reviewer_protocol",
                    kind: "unaccounted_findings",
                    operation: "semantic_review",
                    message: `Semantic Reviewer did not account for open finding(s): ${unaccounted.join(", ")}.`,
                    field: "findings",
                    required,
                });
                const decision = decideValidationRecovery({
                    failure,
                    attempt,
                    correctionAttempt: attempt,
                    policy: readValidationRetryPolicy(context.projectRoot),
                    nextPhase: "semantic",
                });
                await recordOperationalRecoveryMetric(args, context.projectRoot, decision.result);
                if (decision.action === "correct") {
                    nudgeReason = decision.result.message;
                    continue;
                }
                preserveReviewerRoundState();
                return {
                    kind: "paused",
                    result: {
                        kind: decision.action === "halt" ? "failed" : "paused",
                        planName: args.planName,
                        projectRoot: context.projectRoot,
                        reason: decision.result.message,
                        recovery: decision.result,
                    },
                };
            } else {
                latestOutcome = outcome;
            }
        } catch (error) {
            await logValidationFailure(error instanceof Error ? error : new Error(String(error)), "semantic_review");
            const failure = classifyValidationOperationalError({
                source: "provider",
                kind: "legacy_text",
                operation: "semantic_review",
                message: "The code review could not finish. Your commits are safe. Run validation again to retry it.",
            });
            const decision = decideValidationRecovery({
                failure,
                attempt: operationalAttempt,
                policy: readValidationRetryPolicy(context.projectRoot),
                nextPhase: "semantic",
            });
            await recordOperationalRecoveryMetric(args, context.projectRoot, decision.result);
            emitStatus(args, decision.result.message, decision.action === "halt" ? "error" : "warning");
            if (decision.action === "retry") {
                const wait = await waitForValidationRetryWithSessionCancellation(args, decision.delayMs, "semantic");
                if (wait === "completed") {
                    operationalAttempt += 1;
                    attempt -= 1;
                    continue;
                }
            }
            preserveReviewerRoundState();
            return {
                kind: "paused",
                result: {
                    kind: decision.action === "halt" ? "failed" : "paused",
                    planName: args.planName,
                    projectRoot: context.projectRoot,
                    reason: decision.result.message,
                    recovery: decision.result,
                },
            };
        }
    }

    if (!latestOutcome) {
        const reason = validationReviewerPauseMessage(args.planName);
        args.session.setActiveWorkflow({
            ...context.workflowBase,
            ...(args.session.getActiveWorkflow() || {}),
            semanticRound: state.semanticRound - 1,
            reviewLedger: state.reviewLedger,
            repairBaselineTree: state.repairBaselineTree,
            lastRepairReport: state.lastRepairReport,
        });
        emitStatus(args, validationReviewerPauseMessage(args.planName), "warning");
        return {
            kind: "paused",
            result: { kind: "paused", planName: args.planName, projectRoot: context.projectRoot, reason },
        };
    }

    if (epicContext && latestOutcome.integrationNotes?.length) {
        const written = await recordIntegrationNotes(
            context.projectRoot,
            epicContext.epicPlanName,
            args.planName,
            latestOutcome.integrationNotes,
        ).catch(() => null);
        if (written) {
            emitStatus(
                args,
                buildValidationUserMessage({
                    kind: "integration_notes_saved",
                    count: latestOutcome.integrationNotes.length,
                    epicPlanName: epicContext.epicPlanName,
                }),
                "info",
            );
        }
    }
    const applied = applyRoundFindings(state.reviewLedger, latestOutcome.findings, state.semanticRound);
    if (!latestOutcome.approved && openItems(applied.ledger).length > 0) {
        emitReviewerLedgerReport(args, applied.ledger, applied.resolvedCount);
    }
    return {
        kind: "complete",
        outcome: latestOutcome,
        ledger: applied.ledger,
        resolvedCount: applied.resolvedCount,
        appendedCount: applied.appendedCount,
    };
}

function emitReviewerLedgerReport(
    args: ValidationLoopArgs,
    ledger: ReturnType<typeof applyRoundFindings>["ledger"],
    resolvedCount: number,
): void {
    const openCount = openItems(ledger).length;
    const openLabel = openCount === 1 ? "1 issue open" : `${openCount} issues open`;
    const resolvedNote = resolvedCount > 0 ? `, ${resolvedCount} resolved this round` : "";
    args.session.emitAssistantMessage(
        AGENTS.REVIEWER,
        `Semantic review rejected — ${openLabel}${resolvedNote}:\n${renderOpenItems(ledger)}`,
        {
            messageKind: "workflow",
            workflowMessage: "review_report_update",
            approved: false,
        },
    );
}

export function buildSemanticReviewAttempt(
    attempt: number,
    nudgeReason: string | undefined,
    state: SemanticRoundState,
    reviewMode: "discovery" | "verify",
    diffText: string,
    repairDiffText = "",
    planContent = "",
    inspection?: ReviewInspection,
    epicContextSection = "",
): {
    prompt: string;
    customTools: OpaqueToolDefinition[];
} {
    const hasRepairScope = state.repairBaselineTree.trim() !== "";
    const toolDiffs = hasRepairScope ? { full: diffText, repair: repairDiffText } : { full: diffText };
    // `createReviewDiffTool` returns a Pi ToolDefinition; the engine brands it opaque
    // here so the adapter can un-brand it once at the port boundary.
    const customTools = [createReviewDiffTool(toolDiffs, {
        inspection,
        ledger: state.reviewLedger,
    }) as unknown as OpaqueToolDefinition];
    if (attempt > 1) {
        return {
            prompt: nudgeReason ||
                "You have not called review_complete yet. Finish this review now by calling review_complete with your decision. Do not restart the review — use what you have already inspected.",
            customTools,
        };
    }

    const sections = [`You are reviewing ${state.semanticRound}. This is review round ${state.semanticRound}.`, ""];
    if (reviewMode === "discovery" && state.reviewLedger.items.length > 0) {
        sections.push(
            "Previous findings are listed below. Sweep the Plan as usual **and** independently verify each open finding against the code.",
            "",
            "### Open Findings",
            "",
            renderOpenItems(state.reviewLedger),
            "",
            "### Already Resolved",
            "",
            renderResolvedItems(state.reviewLedger),
            "",
        );
    } else if (reviewMode === "verify") {
        sections.push(
            "An earlier broad review already checked this implementation against the whole Plan. Verify the open findings below and check the repair for regressions. Do not sweep the Plan again.",
            "",
            "### Open Findings",
            "",
            renderOpenItems(state.reviewLedger),
            "",
            "### Already Resolved",
            "",
            renderResolvedItems(state.reviewLedger),
            "",
        );
    }
    if (state.lastRepairReport) {
        sections.push(
            "### Repair Agent's Report",
            "",
            "These are claims to verify, not proof. Check each one against the code yourself.",
            "",
            state.lastRepairReport,
            "",
        );
    }
    sections.push(
        buildDiffInspectionSection(reviewMode === "verify" ? repairDiffText : diffText, {
            hasRepairScope,
            scope: reviewMode === "verify" ? "repair" : "full",
        }),
        "",
        ...(epicContextSection ? [epicContextSection, ""] : []),
        "### Approved Plan",
        "",
        projectEngineerPlanBody(planContent),
    );
    return {
        prompt: sections.join("\n"),
        customTools,
    };
}

export async function dispatchReviewFeedbackRepair(
    args: ValidationLoopArgs,
    context: PhaseContext,
    packet: ReviewFeedbackRepairPacket,
): Promise<{ completed: boolean; report: string; reason?: string }> {
    await recordDeliveryEvidence(
        context.projectRoot,
        args.planName,
        context.worktreeId || "in-place",
        packet.repairKind === "semantic" ? "ai-repair" : "human-revision",
        "Started",
    );
    emitStatus(args, buildValidationUserMessage({ kind: "review_repair", repairKind: packet.repairKind }), "warning");
    try {
        const workflowState: ValidationWorkflowState = { ...context.workflowBase, ...packet.activeWorkflow };
        args.session.setActiveWorkflow(workflowState);
        const sessionOutcome = await args.session.runIsolatedAgentSession({
            kind: "feedback_engineer",
            agentName: AGENTS.REVIEWER_FEEDBACK_ENGINEER,
            userRequest: buildValidationRepairPrompt({
                executionCwd: context.executionCwd,
                repairCwd: context.executionCwd,
                worktreeId: context.worktreeId,
                worktreeBranch: context.worktreeBranch,
                worktreeBaseBranch: context.worktreeBaseBranch,
                authorityNote: packet.repairKind === "human_feedback"
                    ? "A human reviewed this change. Their feedback is authoritative."
                    : "A code reviewer found these issues. Fix every finding.",
                repairsNeeded: [
                    "### Findings",
                    "",
                    packet.findingsSection || "(no findings text supplied)",
                    "",
                    buildDiffInspectionSection(packet.diffText),
                ].join("\n"),
                completionInstruction:
                    "Report a disposition for every finding, then call task_completed. If a finding is still open because something blocked you, stop in plain text instead and name it.",
            }),
            images: packet.images,
            cwd: context.executionCwd,
            customTools: [createReviewDiffTool({ full: packet.diffText }) as unknown as OpaqueToolDefinition],
        });
        if (sessionOutcome.outcome === "operational_failure") {
            return { completed: false, report: "", reason: sessionOutcome.failure.message };
        }
        const taskReport = sessionOutcome.taskReport;
        args.session.setActiveWorkflow({
            ...workflowState,
            ...(sessionOutcome.taskReport.completed && workflowState.reviewLedger
                ? { reviewLedger: claimReviewFixes(workflowState.reviewLedger) }
                : {}),
            lastRepairReport: taskReport.report,
        });
        if (!taskReport.completed) {
            return {
                completed: false,
                report: "",
                reason: repairBlockedReason(args, context.projectRoot, taskReport.blockerText),
            };
        }
        return { completed: true, report: taskReport.report };
    } catch (error) {
        await logValidationFailure(error instanceof Error ? error : new Error(String(error)), "semantic_repair");
        return {
            completed: false,
            report: "",
            reason: "The repair could not finish. Your changes are safe. Continue the repair to try again.",
        };
    }
}

/** Origin is diagnostic attribution, never a repair state or approval criterion. */
export function reviewFindingMetrics(findings: ValidationReviewOutcome["findings"], round: number) {
    return {
        initialFindingCount: round === 1 ? findings.filter((finding) => !finding.id).length : 0,
        missedOriginalCount: round > 1
            ? findings.filter((finding) => !finding.id && finding.origin === "missed_original").length
            : 0,
        repairRegressionCount: round > 1
            ? findings.filter((finding) => !finding.id && finding.origin === "repair_regression").length
            : 0,
        unclassifiedNewCount: round > 1 ? findings.filter((finding) => !finding.id && !finding.origin).length : 0,
        existingStillOpenCount: findings.filter((finding) => finding.id && !finding.resolved).length,
        fixConfirmedCount: findings.filter((finding) => finding.id && finding.resolved).length,
    };
}

/**
 * The decision when the automatic review rounds are spent.
 *
 * Three ways forward, and every one of them is a way forward: another focused round,
 * hand it to a person, or stop somewhere it can be picked up again. Stop used to be
 * missing here on the grounds that stopping strands the work — but the Plan keeps its
 * passing tests and its review findings, so returning resumes at the review rather
 * than the beginning. A menu with no exit is not the same thing as never stranding
 * someone.
 */
export async function promptForSemanticRoundLimit(
    args: ValidationLoopArgs,
    semanticRound: number,
    openFindingCount: number,
    testsPass: boolean,
): Promise<"continue" | "engineer_follow_up" | "code_review" | "stop"> {
    const prompt = buildValidationUserMessage({
        kind: "semantic_limit",
        planName: args.planName,
        rounds: semanticRound,
        openCount: openFindingCount,
        testsPass,
    });
    emitStatus(args, prompt, "warning");
    const response = await requestInteraction(args, {
        type: ValidationInteractionTypes.SELECT,
        prompt,
        options: [
            { value: "continue", label: "Have the reviewer look again" },
            { value: "engineer_follow_up", label: "Talk to the repair engineer" },
            { value: "code_review", label: "Let me read the changes" },
            { value: "stop", label: "Stop" },
        ],
    });
    if (response.outcome !== "selected") return "stop";
    if (response.value === "code_review") return "code_review";
    if (response.value === "engineer_follow_up") return "engineer_follow_up";
    return response.value === "continue" ? "continue" : "stop";
}
