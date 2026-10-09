import {
    readDeliveryEvidence,
    saveDeliveredPlanEvidence,
    saveDeliveredWorkRecordEvidence,
    savePublicationEvidence,
} from "./delivery-evidence.ts";
import { relative } from "@std/path";
import { buildDeliveryReport } from "./delivery-report.ts";
import { getCodeReviewMode, getGuidedReviewMode } from "../settings.js";
import {
    readPublishedDeliverySources,
    readPublishedRecordMarkdown,
    retainPublishedWorkRecordSource,
} from "../work-records/published-source.ts";
/**
 * @module shared/workflow/validation-publication
 * The publication phase: merging the validated worktree into the target branch
 * through the durable publication state machine, settling the worktree registry, running
 * post-verification handoffs, and building the verified result.
 *
 * Ordering invariant: prepareEpicChildManualQaArtifact runs before checkpointExecutionWorktree
 * so the durable Epic Manual QA artifact is sealed into child delivery.
 */

import { AGENTS, isPlannedChangeClassification } from "../../constants.js";
import { logValidationFailure } from "./validation-state-errors.ts";
import { loadPlan, withPlanLock } from "../../plan-store.js";
import { resolveTargetedWorkRecordSource } from "../work-records/auto-generation.ts";
import { createQaChecklistGeneratedTool } from "../../tools/qa-checklist-generated.ts";
import { findEpicManualQaSection } from "../epic-artifacts.ts";
import { checkpointExecutionWorktree, resolveTargetBranchName } from "../worktree.js";
import { publishExecutionWorktreeIsolated } from "../isolated-publication.ts";
import { findById as findWorktreeRegistryEntryById } from "../worktree-registry.js";
import { ensureRunWieldOwnedGitignoreBlock } from "../runwield-owned-paths.ts";
import { stageValidationPassedInExecutionWorktree } from "./plan-lifecycle.js";
import { shouldContinueParentEpicAfterValidation } from "./validation-scope.ts";
import type {
    HumanReviewMetadata,
    PhaseContext,
    PublicationOutcome,
    ValidationLoopArgs,
    ValidationPhaseResult,
} from "./validation-types.ts";
import type { OpaqueToolDefinition } from "./validation-ports.ts";
import type { EpicContinuationResolution } from "./epic-continuation.ts";
import { MAX_AGENT_MERGE_REPAIRS } from "./validation-types.ts";
import {
    annotatePublicationStage,
    describeMergePause,
    dispatchMergeRepair,
    finalizeMergeRepair,
    getMergeFailureKind,
    getMergeWorktreePath,
    normalizePublicationFailure,
    type PublicationFailure,
    publicationFailureNeedsUserAction,
    type PublicationStage,
} from "./validation-merge-repair.ts";
import { recordLifecycleEvent } from "./validation-context.ts";
import { completeProgressRecord, emitProgress, emitStatus, updateProgressRecord } from "./validation-emit.ts";
import { pauseForUserAction } from "./validation-interactions.ts";
import { buildValidationUserMessage, validationUserMessage } from "./validation-user-messages.ts";
import {
    classifyValidationOperationalError,
    type GitPublicationErrorKind,
    type ValidationOperationalFailure,
} from "./validation-operational-errors.ts";
import {
    decideValidationRecovery,
    readValidationRetryPolicy,
    recordOperationalRecoveryMetric,
    waitForValidationRetryWithSessionCancellation,
} from "./validation-recovery.ts";
import {
    advanceStoredPublication,
    cleanupStoredPublication,
    failStoredPublication,
    loadPublicationAttempt,
    publishedWorkRecordFailed,
    reconcileStoredPublication,
    startPublicationAttempt,
} from "./publication-machine.ts";
import type { PublicationAttempt } from "./publication-attempt.ts";
import { preparePublicationRevalidation, PUBLICATION_REVALIDATION_MESSAGE } from "./publication-revalidation.ts";

type DeliveryEvidence = import("../../plan-store.js").DeliveryEvidence;
type WorktreeDeliveryEvidence = import("../../plan-store.js").WorktreeDeliveryEvidence;
type ManualQaPreparationResult = { kind: "ready" } | { kind: "blocked"; outcome: PublicationOutcome };

function firstMarkdownHeading(markdown: string, fallback: string): string {
    const heading = markdown.split(/\r?\n/).find((line) => /^#\s+\S/.test(line));
    return heading ? heading.replace(/^#\s+/, "").trim() : fallback;
}

export function publicationFailureKindFromMergeKind(failureKind: string | undefined): GitPublicationErrorKind {
    switch (failureKind) {
        case "target_reference_race":
            return "target_reference_race";
        case "remote_unavailable":
            return "remote_unavailable";
        case "target_sync_conflict":
        case "isolated_publication_conflict":
        case "detached_merge_conflict":
        case "current_checkout_merge_conflict":
        case "local_publication_conflict":
        case "content_conflict":
            return "content_conflict";
        case "primary_checkout_dirty":
        case "runwield_runtime_tracked":
            return "primary_checkout_dirty";
        case "target_branch_advanced":
        case "target_history_rewrite":
            return "target_reference_race";
        case "permission_denied":
            return "permission_denied";
        case "policy_violation":
        case "target_checked_out":
        case "publication_target_changed":
            return "policy_violation";
        default:
            return "post_publication_bookkeeping";
    }
}

function operationalPhaseResult(
    args: ValidationLoopArgs,
    projectRoot: string,
    failure: ValidationOperationalFailure,
    attempt: number,
): PublicationOutcome {
    const decision = decideValidationRecovery({
        failure,
        attempt,
        policy: readValidationRetryPolicy(projectRoot),
        nextPhase: "delivery",
    });
    return {
        recorded: false,
        result: {
            kind: decision.action === "halt" ? "failed" : "paused",
            planName: args.planName,
            projectRoot,
            reason: decision.result.message,
            recovery: decision.result,
        },
    };
}

async function prepareEpicChildManualQaArtifact(
    args: ValidationLoopArgs,
    cwd: string,
    projectRoot: string,
): Promise<ManualQaPreparationResult> {
    const plan = await loadPlan(cwd, args.planName).catch(() => null);
    const parentPlan = typeof plan?.attrs.parentPlan === "string" && plan.attrs.parentPlan.trim()
        ? plan.attrs.parentPlan.trim()
        : "";
    if (!parentPlan) return { kind: "ready" };
    const parent = await loadPlan(cwd, parentPlan).catch(() => null);
    if (parent?.attrs.classification !== "PROJECT") return { kind: "ready" };

    const existing = await findEpicManualQaSection(cwd, parentPlan, args.planName);
    if (existing.exists) {
        emitStatus(
            args,
            buildValidationUserMessage({ kind: "qa_ready", path: existing.relativePath, existed: true }),
            "info",
        );
        return { kind: "ready" };
    }

    let attempt = 1;
    for (;;) {
        emitStatus(args, buildValidationUserMessage({ kind: "qa_prepare", planName: args.planName }), "info");
        const userRequest = [
            "Prepare this Epic child's Manual QA checklist.",
            `Name: ${args.planName}`,
            "Classification: PLANNED_CHANGE",
            "",
            "Call qa_checklist_generated with the checklistMarkdown argument.",
            "The checklistMarkdown must start with this exact heading:",
            `Manual verification steps for ${args.planName}`,
            "It must contain 1 to 6 unchecked checklist items.",
            "Do not finish with ordinary text instead of the tool call.",
            "",
            "### Source context",
            args.planContent,
        ].join("\n");
        const tool = createQaChecklistGeneratedTool({
            projectRoot: cwd,
            epicPlanName: parentPlan,
            childPlanName: args.planName,
            childHeading: firstMarkdownHeading(args.planContent, args.planName),
        });
        let outcome;
        try {
            outcome = await args.session.runIsolatedAgentSession({
                kind: "manual_qa",
                agentName: AGENTS.OPERATOR,
                userRequest,
                cwd,
                customTools: [tool as unknown as OpaqueToolDefinition],
                sessionManager: args.session.createInMemorySessionManager(cwd),
            });
        } catch (caught) {
            const error = caught instanceof Error ? caught : new Error(String(caught));
            outcome = {
                kind: "manual_qa" as const,
                outcome: "operational_failure" as const,
                failure: classifyValidationOperationalError({
                    source: "provider",
                    kind: "legacy_text",
                    operation: "agent_session",
                    message: error.message,
                }),
            };
        }
        if (outcome.outcome === "recorded" || outcome.outcome === "already_present") {
            emitStatus(
                args,
                buildValidationUserMessage({
                    kind: "qa_ready",
                    path: outcome.relativePath,
                    existed: outcome.outcome === "already_present",
                }),
                "info",
            );
            return { kind: "ready" };
        }
        if (outcome.outcome === "operational_failure") {
            const decision = decideValidationRecovery({
                failure: outcome.failure,
                attempt,
                policy: readValidationRetryPolicy(projectRoot),
                nextPhase: "delivery",
            });
            await recordOperationalRecoveryMetric(args, projectRoot, decision.result);
            if (decision.action === "retry") {
                emitStatus(args, decision.result.message, "warning");
                const wait = await waitForValidationRetryWithSessionCancellation(args, decision.delayMs, "publication");
                if (wait === "completed") {
                    attempt += 1;
                    continue;
                }
            }
            emitStatus(args, decision.result.message, decision.action === "halt" ? "error" : "warning");
            return { kind: "blocked", outcome: operationalPhaseResult(args, projectRoot, outcome.failure, attempt) };
        }
        await logValidationFailure(new Error("Test note was not generated"), "test_note");
        emitStatus(args, validationUserMessage("publication_note_failed"), "warning");
        return { kind: "ready" };
    }
}

export async function runPublicationPhase(
    args: ValidationLoopArgs,
    context: PhaseContext,
    humanReviewMetadata: HumanReviewMetadata,
): Promise<PublicationOutcome> {
    const outcome = await withPlanLock(
        context.projectRoot,
        args.planName,
        async () => await runLockedPublicationPhase(args, context, humanReviewMetadata),
    );
    if (!outcome.recorded && await preparePublicationRevalidation(context.projectRoot, args.planName)) {
        emitStatus(args, PUBLICATION_REVALIDATION_MESSAGE);
        return {
            recorded: false,
            result: {
                kind: "paused",
                planName: args.planName,
                projectRoot: context.projectRoot,
                continueValidation: true,
                reason: PUBLICATION_REVALIDATION_MESSAGE,
            },
        };
    }
    return outcome;
}

async function runLockedPublicationPhase(
    args: ValidationLoopArgs,
    context: PhaseContext,
    humanReviewMetadata: HumanReviewMetadata,
): Promise<PublicationOutcome> {
    if (context.nonGitInPlace || !context.worktreeBranch) {
        const manualQa = await prepareEpicChildManualQaArtifact(
            args,
            context.executionCwd || context.projectRoot,
            context.projectRoot,
        );
        if (manualQa.kind === "blocked") return manualQa.outcome;
        const deliveryEvidence: DeliveryEvidence = context.nonGitInPlace
            ? { version: 1, mode: "non_git_in_place" }
            : null;
        await recordLifecycleEvent(args, context.projectRoot, "validation_passed", "reviewed", undefined, {
            executionMode: context.nonGitInPlace ? "non_git_in_place" : undefined,
            deliveryEvidence,
            ...humanReviewMetadata,
        });
        await runPostVerificationHandoffs(args, context.executionCwd || context.projectRoot);
        return { recorded: true, result: await buildVerifiedResult(args, context.projectRoot) };
    }

    // Review and artifact generation can outlive the phase's initial Plan read.
    // Reload the execution document under the publication lock before selecting
    // a target or sealing commits.
    const executionPlan = await loadPlan(context.executionCwd, args.planName);
    const requestedTarget = executionPlan?.attrs.targetBranch?.trim();
    const worktreeBaseBranch = requestedTarget
        ? await resolveTargetBranchName(context.projectRoot, requestedTarget)
        : context.worktreeBaseBranch;
    if (!worktreeBaseBranch) {
        const reason =
            `Target branch metadata is missing for worktree branch ${context.worktreeBranch}; Workflow Validation cannot publish Delivery Evidence without a concrete target branch.`;
        const failure = classifyValidationOperationalError({
            source: "validation_state",
            kind: "worktree_record_missing",
            operation: "publication",
            message: reason,
        });
        const outcome = operationalPhaseResult(args, context.projectRoot, failure, 1);
        if (outcome.result.recovery) {
            await recordOperationalRecoveryMetric(args, context.projectRoot, outcome.result.recovery);
        }
        return outcome;
    }

    // A remotely verified publication spends its execution attempt. The registry
    // entry remains the only publication authority until cleanup completes.
    const cleanupMergedWorktrees = true;
    const planPath = `docs/plans/${args.planName}.md`;
    // Captured once, as plain strings: the guards above narrowed both, but TypeScript
    // drops that narrowing inside the hoisted helpers below.
    const targetBranch: string = worktreeBaseBranch;
    const executionBranch: string = context.worktreeBranch;
    if (!context.worktreeId) {
        throw new Error(`Worktree publication for ${args.planName} requires an execution attempt id.`);
    }
    const worktreeId = context.worktreeId;
    const storedAttempt = worktreeId
        ? await findWorktreeRegistryEntryById(context.projectRoot, context.worktreeId, { migrate: false }).catch(() =>
            null
        )
        : null;
    let publicationAttempt: PublicationAttempt | null = storedAttempt?.publication ||
        await loadPublicationAttempt(context.projectRoot, worktreeId);
    if (publicationAttempt && publicationAttempt.targetBranch !== targetBranch) {
        const message = buildValidationUserMessage({
            kind: "publication_target_changed",
            targetBranch,
            savedTargetBranch: publicationAttempt.targetBranch,
        });
        emitStatus(args, message, "warning");
        return {
            recorded: false,
            result: { kind: "paused", planName: args.planName, projectRoot: context.projectRoot, reason: message },
        };
    }
    let epicResolution: EpicContinuationResolution | undefined;
    let repairMergeWorktreePath = publicationAttempt?.failure?.repairRoot;
    if (repairMergeWorktreePath) {
        const exists = await Deno.stat(repairMergeWorktreePath).then((value) => value.isDirectory).catch(() => false);
        if (!exists) repairMergeWorktreePath = undefined;
    }
    let agentRepairs = 0;
    // A restarted validation can inherit a repair checkout that is still inside
    // Git's merge transaction. Normalize it before attempting another merge.
    let pendingFinalizeFailure: PublicationFailure | undefined;
    if (repairMergeWorktreePath) {
        try {
            await finalizeMergeRepair(repairMergeWorktreePath);
        } catch (caught) {
            pendingFinalizeFailure = normalizePublicationFailure(
                caught instanceof Error ? caught : new Error(String(caught)),
            );
        }
    }
    let publicationOperationalAttempt = 1;

    for (;;) {
        const attempt = pendingFinalizeFailure
            ? { kind: "failed" as const, failure: pendingFinalizeFailure }
            : await attemptPublication();
        pendingFinalizeFailure = undefined;
        if (attempt.kind === "published") return attempt.outcome;

        const { failure } = attempt;
        const reason = failure.reason;
        // Publication may have already succeeded. The merge is irreversible, so an
        // error after the target ref moved is bookkeeping noise over finished work —
        // finish rather than dispatching an Agent to repair a conflict that is gone.
        const nextRepairMergeWorktreePath = getMergeWorktreePath(failure);
        if (nextRepairMergeWorktreePath) {
            repairMergeWorktreePath = nextRepairMergeWorktreePath;
        }
        const failureKind = getMergeFailureKind(failure);
        const operationalFailure = classifyValidationOperationalError({
            source: "git_publication",
            kind: publicationFailureKindFromMergeKind(failureKind),
            operation: "publication",
            message: reason,
        });
        const decision = decideValidationRecovery({
            failure: operationalFailure,
            attempt: publicationOperationalAttempt,
            correctionAttempt: agentRepairs + 1,
            policy: readValidationRetryPolicy(context.projectRoot),
            nextPhase: "delivery",
        });
        await recordOperationalRecoveryMetric(args, context.projectRoot, decision.result);

        if (decision.action === "retry") {
            emitStatus(args, decision.result.message, "warning");
            const wait = await waitForValidationRetryWithSessionCancellation(args, decision.delayMs, "publication");
            if (wait === "completed") {
                publicationOperationalAttempt += 1;
                continue;
            }
            return {
                recorded: false,
                result: {
                    kind: "paused",
                    planName: args.planName,
                    projectRoot: context.projectRoot,
                    reason: "Validation retry was canceled. Run this Plan again when you are ready.",
                    recovery: decision.result,
                },
            };
        }

        // A merge conflict is normal and fixable, so try the Agent first and retry
        // publication in the same call. Other publication errors need retry,
        // deterministic recovery, or a user action.
        if (decision.action === "correct" && agentRepairs < MAX_AGENT_MERGE_REPAIRS) {
            agentRepairs += 1;
            try {
                if (await dispatchMergeRepair(args, context, reason, failure)) continue;
            } catch (caught) {
                pendingFinalizeFailure = normalizePublicationFailure(
                    caught instanceof Error ? caught : new Error(String(caught)),
                );
                continue;
            }
        }

        if (decision.action === "halt") {
            emitStatus(args, decision.result.message, "error");
            return {
                recorded: false,
                result: {
                    kind: "failed",
                    planName: args.planName,
                    projectRoot: context.projectRoot,
                    reason: decision.result.message,
                    recovery: decision.result,
                },
            };
        }

        const pause = describeMergePause(args.planName, worktreeBaseBranch, failure, context);
        if (decision.action === "pause" && decision.result.recoveryClass !== "missing_information") {
            const retryPauseMessage = buildValidationUserMessage({
                kind: "user_action",
                whatHappened:
                    `Git could not publish "${args.planName}" to ${targetBranch} after ${publicationOperationalAttempt} automatic attempts.`,
                details: [reason, `Source branch: ${executionBranch}`, `Target branch: ${targetBranch}`],
                doThis:
                    `Restore the remote connection or wait for ${targetBranch} to stop changing, then run \`wld load-plan ${args.planName}\` and retry publication.`,
            });
            const recovery = { ...decision.result, message: retryPauseMessage };
            emitStatus(args, retryPauseMessage, "warning");
            return {
                recorded: false,
                result: {
                    kind: "paused",
                    planName: args.planName,
                    projectRoot: context.projectRoot,
                    reason: retryPauseMessage,
                    recovery,
                },
            };
        }
        if (!publicationFailureNeedsUserAction(failure)) {
            // A transient lock or interrupted transition can disappear immediately.
            // Retry once in-process; publicationArtifactsPrepared prevents completed
            // LLM handoffs from running again.
            if (publicationOperationalAttempt === 1) {
                publicationOperationalAttempt += 1;
                continue;
            }
            const blockedMessage = buildValidationUserMessage({
                kind: "publication_blocked",
                planName: args.planName,
                stage: failure.publicationStage || "git_publication",
                blockedByPlanLock: failure.blockedByPlanLock,
            });
            await logValidationFailure(new Error(failure.reason), failure.publicationStage || "git_publication");
            // The supervisor presents this pause and settles the progress panel.
            // Emitting here as well shows the same failure twice in the Session.
            return {
                recorded: false,
                result: {
                    kind: "paused",
                    planName: args.planName,
                    projectRoot: context.projectRoot,
                    reason: blockedMessage,
                },
            };
        }
        if (await pauseForUserAction(args, pause) === "retry") {
            // The user may have staged resolutions, left unstaged repair files, or
            // committed some/all of the repair themselves. Normalize every one of
            // those valid states before publication reads the repaired candidate.
            if (repairMergeWorktreePath) {
                try {
                    if (await finalizeMergeRepair(repairMergeWorktreePath)) continue;
                } catch (caught) {
                    pendingFinalizeFailure = normalizePublicationFailure(
                        caught instanceof Error ? caught : new Error(String(caught)),
                    );
                    continue;
                }
            }
            continue;
        }
        return {
            recorded: false,
            result: {
                kind: "paused",
                planName: args.planName,
                projectRoot: context.projectRoot,
                awaitingUserAction: true,
                // The execution Plan stays `validated`: tests and review are final,
                // while the registry keeps publication pending for a later retry.
                reason:
                    `${pause.whatHappened} ${pause.doThis} Run this Plan again when you are ready and RunWield will pick up at the merge.`,
            },
        };
    }

    async function attemptPublication(): Promise<
        { kind: "published"; outcome: PublicationOutcome } | { kind: "failed"; failure: PublicationFailure }
    > {
        try {
            return { kind: "published", outcome: await publishOnce() };
        } catch (caught) {
            const error = caught instanceof Error ? caught : new Error(String(caught));
            const failure = normalizePublicationFailure(error);
            // A source can change after this invocation sealed it. Recover in
            // the same validation loop, just as a fresh-process resume would.
            if (await preparePublicationRevalidation(context.projectRoot, args.planName)) {
                emitStatus(args, PUBLICATION_REVALIDATION_MESSAGE);
                return {
                    kind: "published",
                    outcome: {
                        recorded: false,
                        result: {
                            kind: "paused",
                            planName: args.planName,
                            projectRoot: context.projectRoot,
                            continueValidation: true,
                            reason: PUBLICATION_REVALIDATION_MESSAGE,
                        },
                    },
                };
            }
            if (publicationAttempt) {
                publicationAttempt = await failStoredPublication(context.projectRoot, publicationAttempt, {
                    kind: getMergeFailureKind(failure) || "publication_failed",
                    message: failure.reason,
                    ...(getMergeWorktreePath(failure) ? { repairRoot: getMergeWorktreePath(failure) } : {}),
                }).catch(() => publicationAttempt);
            }
            return { kind: "failed", failure };
        }
    }

    async function publishOnce(): Promise<PublicationOutcome> {
        const atStage = async <T>(stage: PublicationStage, action: () => Promise<T>): Promise<T> => {
            try {
                return await action();
            } catch (caught) {
                const error = caught instanceof Error ? caught : new Error(String(caught));
                throw annotatePublicationStage(error, stage);
            }
        };
        if (publicationAttempt) {
            publicationAttempt = await atStage(
                "git_publication",
                async () => await reconcileStoredPublication(context.projectRoot, publicationAttempt!),
            );
            if (publicationAttempt.phase === "cleanup_complete") {
                const cleanup = await cleanupStoredPublication(
                    context.projectRoot,
                    publicationAttempt,
                    args.workRecordMnemotecaPort,
                );
                if (cleanup.preservedFiles) {
                    emitStatus(
                        args,
                        buildValidationUserMessage({
                            kind: "publication_files_preserved",
                            path: cleanup.preservedFiles,
                        }),
                    );
                }
                return {
                    recorded: true,
                    result: await buildVerifiedResult(
                        args,
                        context.projectRoot,
                        undefined,
                        targetBranch,
                        publicationAttempt,
                    ),
                };
            }
        }
        if (!publicationAttempt) {
            await atStage(
                "candidate_checkpoint",
                async () => await ensureRunWieldOwnedGitignoreBlock(context.executionCwd),
            );
            const targetHeadAtSeal = await args.git.branchHead(context.projectRoot, targetBranch);
            const candidate = await atStage("candidate_checkpoint", async () =>
                await checkpointExecutionWorktree({
                    worktreePath: context.executionCwd,
                    branch: executionBranch,
                    planName: args.planName,
                    planDescription: args.triageMeta?.summary,
                    mergeTargetRef: targetHeadAtSeal,
                }));
            publicationAttempt = await startPublicationAttempt({
                projectRoot: context.projectRoot,
                attemptId: worktreeId,
                planName: args.planName,
                targetBranch,
                executionBranch,
                executionCwd: context.executionCwd,
                validatedCommit: candidate.executionCommit,
                targetHeadAtSeal,
            });
        }

        if (publicationAttempt.phase === "candidate_sealed") {
            const manualQa = await atStage(
                "artifact_preparation",
                async () => await prepareEpicChildManualQaArtifact(args, context.executionCwd, context.projectRoot),
            );
            if (manualQa.kind === "blocked") return manualQa.outcome;
            const deliveryEvidence: WorktreeDeliveryEvidence = {
                version: 1,
                mode: "worktree_merge",
                executionCommit: publicationAttempt.validatedCommit,
                targetBranch,
                targetHeadBeforeMerge: publicationAttempt.targetHeadAtSeal,
            };
            const staging = await atStage(
                "lifecycle_staging",
                async () =>
                    await stageValidationPassedInExecutionWorktree({
                        projectRoot: context.projectRoot,
                        executionCwd: context.executionCwd,
                        planName: args.planName,
                        details: {
                            triageMeta: args.triageMeta,
                            executionMode: "worktree",
                            deliveryEvidence,
                            cleanupMergedWorktrees,
                            ...humanReviewMetadata,
                        },
                    }),
            );
            await atStage(
                "artifact_preparation",
                async () => await runPostVerificationHandoffs(args, context.executionCwd, true),
            );
            const artifactCandidate = await atStage("candidate_sealing", async () =>
                await checkpointExecutionWorktree({
                    worktreePath: context.executionCwd,
                    branch: executionBranch,
                    planName: args.planName,
                    planDescription: args.triageMeta?.summary,
                    mergeTargetRef: publicationAttempt?.targetHeadAtSeal,
                    publicationAttemptId: publicationAttempt?.attemptId,
                    publicationPlanPaths: staging.planPaths.length > 0 ? staging.planPaths : [planPath],
                }));
            publicationAttempt = await advanceStoredPublication(
                context.projectRoot,
                publicationAttempt,
                "artifacts_committed",
                {
                    artifactCommit: artifactCandidate.executionCommit,
                    planPaths: staging.planPaths.length > 0 ? staging.planPaths : [planPath],
                },
            );
        }

        const artifactCommit = publicationAttempt.artifactCommit;
        if (!artifactCommit) throw new Error(`Publication artifacts are missing for ${args.planName}.`);
        const planPaths = publicationAttempt.planPaths || [planPath];
        if (!epicResolution && shouldContinueParentEpicAfterValidation(args.triageMeta)) {
            epicResolution = await import("./epic-continuation.ts").then(({ resolveEpicContinuation }) =>
                resolveEpicContinuation({
                    cwd: context.executionCwd,
                    completedPlanName: args.planName,
                    completedStatus: "validated",
                })
            );
        }
        if (publicationAttempt.phase !== "publication_verified") {
            await atStage("git_publication", async () =>
                await publishExecutionWorktreeIsolated({
                    projectRoot: context.projectRoot,
                    executionCwd: context.executionCwd,
                    executionBranch,
                    targetBranch,
                    planName: args.planName,
                    planDescription: args.triageMeta?.summary,
                    sealedExecutionCommit: artifactCommit,
                    allowedPlanPaths: planPaths,
                    publicationRoot: publicationAttempt?.publicationRoot,
                    repairedPublicationRoot: repairMergeWorktreePath || undefined,
                    recordedTargetBaseCommit: publicationAttempt?.targetBaseCommit,
                    onIntegrated: async (evidence) => {
                        if (!publicationAttempt) throw new Error("Publication attempt disappeared before integration.");
                        publicationAttempt = await advanceStoredPublication(
                            context.projectRoot,
                            publicationAttempt,
                            "target_integrated",
                            evidence,
                        );
                    },
                    onPublished: async (evidence) => {
                        if (!publicationAttempt) throw new Error("Publication attempt disappeared before publication.");
                        publicationAttempt = await advanceStoredPublication(
                            context.projectRoot,
                            publicationAttempt,
                            "target_published",
                            evidence,
                        );
                    },
                    onVerified: async () => {
                        if (!publicationAttempt) {
                            throw new Error("Publication attempt disappeared before verification.");
                        }
                        publicationAttempt = await advanceStoredPublication(
                            context.projectRoot,
                            publicationAttempt,
                            "publication_verified",
                            { verifiedAt: new Date().toISOString() },
                        );
                    },
                    onProgress: (phase) => {
                        const message = buildValidationUserMessage({
                            kind: "publication_progress",
                            phase,
                            targetBranch,
                        });
                        if (phase === "preparing") {
                            emitProgress(
                                args,
                                message,
                                "info",
                                { outcome: "running", stage: "merge", checks: { merge: "running" } },
                            );
                            return;
                        }
                        emitStatus(args, message);
                    },
                }));
        }
        emitStatus(
            args,
            buildValidationUserMessage({ kind: "publication_progress", phase: "cleanup", targetBranch }),
        );
        await args.session.handoffVerifiedPublication(context.projectRoot);
        const cleanup = await cleanupStoredPublication(
            context.projectRoot,
            publicationAttempt,
            args.workRecordMnemotecaPort,
        );
        publicationAttempt = cleanup.attempt;
        if (cleanup.preservedFiles) {
            emitStatus(
                args,
                buildValidationUserMessage({ kind: "publication_files_preserved", path: cleanup.preservedFiles }),
            );
        }
        if (!cleanup.complete) {
            emitStatus(
                args,
                buildValidationUserMessage({
                    kind: "publication_cleanup_incomplete",
                    targetBranch,
                    worktreePath: cleanup.worktreeKept ? context.executionCwd : undefined,
                    worktreeBranch: cleanup.branchKept ? context.worktreeBranch : undefined,
                    details: cleanup.details,
                }),
                "warning",
            );
            return {
                recorded: true,
                result: await buildVerifiedResult(
                    args,
                    context.projectRoot,
                    epicResolution,
                    targetBranch,
                    publicationAttempt,
                ),
            };
        }
        return {
            recorded: true,
            result: await buildVerifiedResult(
                args,
                context.projectRoot,
                epicResolution,
                targetBranch,
                publicationAttempt,
            ),
        };
    }
}

export async function runPostVerificationHandoffs(
    args: ValidationLoopArgs,
    projectRoot: string,
    pendingPublication = false,
): Promise<void> {
    if (!isPlannedChangeClassification(args.triageMeta?.classification)) return;
    await args.session.runPostVerificationHandoffs({
        planName: args.planName,
        planContent: args.planContent,
        projectRoot,
        mnemotecaPort: args.workRecordMnemotecaPort,
        pendingPublication,
    });
}

export async function buildVerifiedResult(
    args: ValidationLoopArgs,
    projectRoot: string,
    epicResolution?: import("./epic-continuation.ts").EpicContinuationResolution,
    targetBranch?: string,
    publication?: PublicationAttempt,
): Promise<ValidationPhaseResult> {
    const workRecordFailed = publication
        ? await publishedWorkRecordFailed(projectRoot, publication)
        : (await resolveTargetedWorkRecordSource(projectRoot, args.planName)).source?.attrs.workRecord?.status ===
            "failed";
    if (workRecordFailed && publication) await retainPublishedWorkRecordSource(projectRoot, publication);
    const message = buildValidationUserMessage({ kind: "verified", planName: args.planName, targetBranch }) +
        (workRecordFailed
            ? " Work Record failed. Retry this Plan from the completion menu or use wld wr retry <plan-name>. The wld wr backfill command regenerates missing or failed records across completed Plans."
            : "");
    // The run is over, so its position must not outlive it — a Plan reopened later
    // has to start from what the Plan durably says, not from where this one ended.
    args.session.clearPosition(args.planName);
    // Close the panel out on the way past. Without this the last thing the user
    // sees is a merge still "running", on a run that finished successfully.
    const current = args.session.getCurrentProgress();
    const sealed = publication ? await readPublishedDeliverySources(projectRoot, publication) : undefined;
    const local = sealed ? undefined : await loadPlan(projectRoot, args.planName);
    const recordingOwner = sealed?.workRecordOwner ||
        (!publication ? (await resolveTargetedWorkRecordSource(projectRoot, args.planName)).source : undefined);
    const deliveredAttrs = sealed?.delivered.attrs || local?.attrs || args.triageMeta;
    const evidence = await readDeliveryEvidence(
        projectRoot,
        args.planName,
        publication?.attemptId || args.triageMeta.worktreeId || "in-place",
    );
    const publicationArtifact = publication ? await savePublicationEvidence(projectRoot, publication) : null;
    if (publicationArtifact) evidence.artifacts.push(publicationArtifact);
    const planArtifact = publication && sealed
        ? await saveDeliveredPlanEvidence(projectRoot, publication, sealed.delivered.markdown)
        : null;
    if (planArtifact) evidence.artifacts.push(planArtifact);
    const recordPath = recordingOwner?.attrs.workRecord?.path;
    const recordMarkdown = publication && recordPath
        ? await readPublishedRecordMarkdown(projectRoot, publication, recordPath)
        : null;
    const recordArtifact = publication && recordMarkdown
        ? await saveDeliveredWorkRecordEvidence(projectRoot, publication, recordMarkdown)
        : null;
    if (recordArtifact) evidence.artifacts.push(recordArtifact);
    const deliveryReport = buildDeliveryReport({
        planName: args.planName,
        attrs: {
            ...deliveredAttrs,
            workRecord: publication
                ? (recordArtifact ? { ...recordingOwner?.attrs.workRecord, path: recordArtifact.path } : undefined)
                : recordingOwner?.attrs.workRecord,
        },
        planPath: !publication && local?.path ? relative(projectRoot, local.path).replaceAll("\\", "/") : undefined,
        publication,
        evidence,
        guidedReview: getGuidedReviewMode(projectRoot),
        codeReview: getCodeReviewMode(projectRoot),
        workRecordFailed,
        semanticRequired: isPlannedChangeClassification(args.triageMeta.classification),
    });
    if (current) {
        emitStatus(
            args,
            message,
            workRecordFailed ? "warning" : "success",
            completeProgressRecord(
                // This path is reached only after the durable validation gates
                // and publication proof succeeded. Session display state can
                // still describe an earlier failed or canceled attempt.
                updateProgressRecord(current, {
                    deliveryReport,
                    workRecordFailed,
                    workRecordPlanName: args.planName,
                    checks: {
                        ci: "passed",
                        semanticReview: isPlannedChangeClassification(args.triageMeta.classification)
                            ? "passed"
                            : "skipped",
                        humanReview: args.triageMeta.humanReviewDecision === "approved" ? "passed" : "skipped",
                        merge: targetBranch ? "passed" : "skipped",
                    },
                }),
                true,
                message,
            ),
        );
    }
    return {
        kind: "verified",
        planName: args.planName,
        projectRoot,
        classification: args.triageMeta?.classification,
        ...(shouldContinueParentEpicAfterValidation(args.triageMeta)
            ? { epicContinuation: { completedPlanName: args.planName, projectRoot, resolution: epicResolution } }
            : {}),
    };
}
