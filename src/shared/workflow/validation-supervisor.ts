/**
 * @module shared/workflow/validation-supervisor
 * The sole production owner for planned-change validation and resume.
 */

import { loadPlan, resolvePlanExecutionPolicy, StalePlanWriteError, updatePlanFrontMatter } from "../../plan-store.js";
import { StaleControllerWriteError } from "./controller-registry.ts";
import { runPlansDoctor } from "../../cmd/plans/doctor.ts";
import { getLockHostname, isPidAlive } from "../process-liveness.ts";
import { findActiveByPlanName as findWorktreeByPlanName } from "../worktree-registry.js";
import { createEngineValidationArgs, runValidationLoop, type ValidationLoopArgs } from "./validation.ts";
import {
    isValidationCheckpoint,
    makeValidationCheckpoint,
    readValidationReviewState,
    type ValidationCheckpoint,
    validationCheckpointCanResume,
    validationPhaseForStatus,
} from "./validation-checkpoint.ts";
import { retryValidationLater } from "./validation-recovery.ts";
import { logValidationFailure, ValidationStateError } from "./validation-state-errors.ts";
import type { WorkflowValidationResult } from "./validation-types.ts";
import { validationUserMessage } from "./validation-user-messages.ts";
import { emitProgress, emitStatus } from "./validation-emit.ts";
import { resolvePhaseContext } from "./validation-context.ts";
import { getWorktreeReviewDiff } from "./git-snapshot.ts";
import { claimReviewFixes, renderOpenItems } from "./review-ledger.ts";
import { PLAN_STATUSES } from "./plan-lifecycle.js";
import { resolveWorkflowPlanLocation } from "./plan-location.ts";
import { resolvePrimaryCheckoutRoot } from "../primary-checkout.ts";

export type ValidationTrigger =
    | "execution_completion"
    | "task_completion"
    | "load_plan"
    | "session_resume"
    | "repair"
    | "orchestrator"
    | "epic_child";

export type ContinueWorkflowValidationArgs = ValidationLoopArgs & {
    trigger?: ValidationTrigger;
    taskCompletionId?: string;
};

type ClaimResult =
    | {
        kind: "claimed";
        checkpoint: ValidationCheckpoint;
        planCwd: string;
        claimedFromState?: ValidationCheckpoint["state"];
        planContent: string;
        triageMeta: ValidationLoopArgs["triageMeta"];
    }
    | { kind: "active"; projectRoot: string }
    | { kind: "settled_completion"; projectRoot: string };

function checkpointRecord(value: import("../../plan-store.js").PlanFrontMatter["validationCheckpoint"]):
    | ValidationCheckpoint
    | undefined {
    if (!value || !isValidationCheckpoint(value)) return undefined;
    return value;
}

async function ownerIsAlive(checkpoint: ValidationCheckpoint): Promise<boolean> {
    if (checkpoint.state !== "running") return false;
    if (!checkpoint.ownerPid || checkpoint.ownerHostname !== getLockHostname()) return false;
    return await isPidAlive(checkpoint.ownerPid);
}

function validationProjectRoot(args: ContinueWorkflowValidationArgs): string {
    return resolvePrimaryCheckoutRoot(args.executionContext?.projectRoot || args.hostedSession.cwd);
}

async function validationPlanCwd(args: ContinueWorkflowValidationArgs): Promise<string> {
    const projectRoot = validationProjectRoot(args);
    // Validation's execution-context boundary verifies Git and repairs legacy
    // Plan IDs. Select its registered directory here without rejecting those
    // repairable IDs first, and never substitute a cached Session directory.
    const attempt = await findWorktreeByPlanName(projectRoot, args.planName);
    if (attempt) return attempt.path;
    return (await resolveWorkflowPlanLocation(projectRoot, args.planName)).documentRoot;
}

async function claimValidation(args: ContinueWorkflowValidationArgs): Promise<ClaimResult> {
    const projectRoot = validationProjectRoot(args);
    const planCwd = await validationPlanCwd(args);
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const plan = await loadPlan(planCwd, args.planName);
        if (!plan) throw new ValidationStateError("plan_missing");
        let phase = validationPhaseForStatus(plan.attrs.status, plan.attrs.validationPhase);
        if (!phase && plan.attrs.status === "validated" && planCwd !== projectRoot) {
            const pendingPublication = await findWorktreeByPlanName(projectRoot, args.planName);
            if (pendingPublication) phase = "delivery";
        }
        if (!phase) {
            if (!PLAN_STATUSES.includes(plan.attrs.status)) {
                throw new ValidationStateError("unknown_plan_status");
            }
            return { kind: "settled_completion", projectRoot };
        }
        const attemptId = plan.attrs.worktreeId || "in-place";
        const prior = checkpointRecord(plan.attrs.validationCheckpoint);
        const compatible = validationCheckpointCanResume(
            prior,
            attemptId,
            plan.attrs.status,
            plan.attrs.validationPhase,
        );
        if (compatible && args.taskCompletionId && prior.lastSettledOperationId === args.taskCompletionId) {
            return { kind: "settled_completion", projectRoot };
        }
        if (compatible && await ownerIsAlive(prior)) {
            return { kind: "active", projectRoot };
        }
        const checkpoint = makeValidationCheckpoint({
            attemptId,
            generation: compatible ? prior.generation : crypto.randomUUID(),
            status: plan.attrs.status,
            phase: compatible ? prior.nextPhase : phase,
            state: "running",
            ownerPid: Deno.pid,
            ownerHostname: getLockHostname(),
            repairGeneration: compatible ? prior.repairGeneration : undefined,
            repairKind: compatible ? prior.repairKind : undefined,
            repairCompletedOperationId: compatible ? prior.repairCompletedOperationId : undefined,
            lastSettledOperationId: compatible ? prior.lastSettledOperationId : undefined,
            reviewState: compatible ? prior.reviewState : undefined,
        });
        try {
            await updatePlanFrontMatter(
                planCwd,
                args.planName,
                { validationCheckpoint: checkpoint },
                plan.attrs,
                { expectedRevision: plan.revision, expectedControllerRevision: plan.controllerRevision },
            );
            return {
                kind: "claimed",
                checkpoint,
                planCwd,
                claimedFromState: compatible ? prior.state : undefined,
                planContent: plan.markdown,
                triageMeta: plan.attrs as ValidationLoopArgs["triageMeta"],
            };
        } catch (error) {
            if (
                !(error instanceof StalePlanWriteError || error instanceof StaleControllerWriteError) || attempt === 2
            ) throw error;
        }
    }
    throw new Error("Could not claim validation.");
}

async function settleValidation(
    args: ContinueWorkflowValidationArgs,
    checkpoint: ValidationCheckpoint,
    result: WorkflowValidationResult,
    planCwd: string,
): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const plan = await loadPlan(planCwd, args.planName);
        if (!plan) return;
        const current = checkpointRecord(plan.attrs.validationCheckpoint);
        if (current?.generation !== checkpoint.generation) return;
        const phase = validationPhaseForStatus(plan.attrs.status, plan.attrs.validationPhase);
        const validationCheckpoint = result.kind === "verified" || !phase ? null : makeValidationCheckpoint({
            attemptId: plan.attrs.worktreeId || current.attemptId,
            generation: current.generation,
            status: plan.attrs.status,
            phase,
            state: result.kind === "semantic_repair_handoff" ? "awaiting_repair" : "paused",
            repairKind: result.kind === "semantic_repair_handoff" ? "semantic" : current.repairKind,
            repairGeneration: result.kind === "semantic_repair_handoff"
                ? current.repairGeneration || crypto.randomUUID()
                : current.repairGeneration,
            repairCompletedOperationId: current.repairCompletedOperationId,
            lastSettledOperationId: result.retainTaskCompletionClaim
                ? current.lastSettledOperationId
                : args.taskCompletionId || current.lastSettledOperationId,
            reviewState: current.reviewState,
        });
        try {
            await updatePlanFrontMatter(
                planCwd,
                args.planName,
                { validationCheckpoint },
                plan.attrs,
                { expectedRevision: plan.revision, expectedControllerRevision: plan.controllerRevision },
            );
            return;
        } catch (error) {
            if (
                !(error instanceof StalePlanWriteError || error instanceof StaleControllerWriteError) || attempt === 2
            ) throw error;
        }
    }
}

/**
 * Commit a semantic repair's Agent claim before validation consumes it.
 *
 * The Agent report is evidence, not authority. This receipt only proves that the
 * exact checkpoint-owned repair turn called task_completed; CI and the Reviewer
 * still decide whether the work resolved anything.
 */
export async function recordValidationRepairCompletion(args: {
    projectRoot: string;
    planName: string;
    repairGeneration: string;
    report: string;
}): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const plan = await loadPlan(args.projectRoot, args.planName);
        if (!plan) throw new Error(`Plan not found: ${args.planName}`);
        const checkpoint = checkpointRecord(plan.attrs.validationCheckpoint);
        if (!checkpoint || checkpoint.repairGeneration !== args.repairGeneration) {
            throw new Error("Semantic repair completion does not match the saved validation attempt.");
        }
        if (checkpoint.repairCompletedOperationId === args.repairGeneration && checkpoint.state === "ready") return;
        const reviewState = readValidationReviewState(checkpoint);
        const completed = makeValidationCheckpoint({
            attemptId: checkpoint.attemptId,
            generation: checkpoint.generation,
            status: plan.attrs.status,
            phase: "mechanical",
            state: "ready",
            repairKind: checkpoint.repairKind,
            repairGeneration: checkpoint.repairGeneration,
            repairCompletedOperationId: args.repairGeneration,
            lastSettledOperationId: checkpoint.lastSettledOperationId,
            reviewState: reviewState
                ? {
                    ...reviewState,
                    reviewLedger: claimReviewFixes(reviewState.reviewLedger),
                    lastRepairReport: args.report,
                }
                : undefined,
        });
        try {
            await updatePlanFrontMatter(
                args.projectRoot,
                args.planName,
                { validationCheckpoint: completed },
                plan.attrs,
                { expectedRevision: plan.revision, expectedControllerRevision: plan.controllerRevision },
            );
            return;
        } catch (error) {
            if (
                !(error instanceof StalePlanWriteError || error instanceof StaleControllerWriteError) || attempt === 2
            ) throw error;
        }
    }
}

async function rebuildSemanticRepairHandoff(
    args: ContinueWorkflowValidationArgs,
    checkpoint: ValidationCheckpoint,
): Promise<WorkflowValidationResult> {
    const reviewState = readValidationReviewState(checkpoint);
    if (!reviewState || !checkpoint.repairGeneration) {
        return pausedResult(args, "validation_repair_evidence_missing", "mechanical");
    }
    const engineArgs = createEngineValidationArgs({ ...args, validationCheckpoint: checkpoint });
    const phase = await resolvePhaseContext(engineArgs);
    if (phase.kind === "blocked") return phase.result;
    const context = phase.context;
    const diffText = await getWorktreeReviewDiff(context.executionCwd, context.worktreeBaseBranch || "");
    const activeWorkflow = {
        ...context.workflowBase,
        semanticRound: reviewState.semanticRound,
        reviewLedger: reviewState.reviewLedger,
        repairBaselineTree: reviewState.repairBaselineTree,
        lastRepairReport: reviewState.lastRepairReport,
        validationRepairGeneration: checkpoint.repairGeneration,
    };
    engineArgs.session.setActiveWorkflow(activeWorkflow);
    return {
        kind: "semantic_repair_handoff",
        planName: args.planName,
        projectRoot: context.projectRoot,
        reason: "Resuming the saved code-review repair.",
        semanticRepairHandoff: {
            semanticRound: reviewState.semanticRound,
            repairGeneration: checkpoint.repairGeneration,
            reviewLedger: reviewState.reviewLedger,
            repairBaselineTree: reviewState.repairBaselineTree,
            lastRepairReport: reviewState.lastRepairReport,
            diffText,
            findingsSection: renderOpenItems(reviewState.reviewLedger),
            activeWorkflow,
        },
    };
}

function operationalFailureResult(
    args: ContinueWorkflowValidationArgs,
    error: Error,
    phase?: ValidationCheckpoint["nextPhase"],
): WorkflowValidationResult {
    const canceled = error.name === "AbortError";
    const message = canceled
        ? "Validation stopped at your request. Load this Plan to continue."
        : error instanceof ValidationStateError && error.code === "plan_missing"
        ? "The Plan file could not be found. Restore it, then load the Plan to continue."
        : error instanceof ValidationStateError && error.code === "unknown_plan_status"
        ? "The saved Plan needs attention before validation can continue. Open the Plan and check its status."
        : error instanceof Deno.errors.PermissionDenied
        ? "Validation could not access the project files. Check folder permissions, then retry."
        : "Validation paused before it could finish. Your changes are safe. Load this Plan to retry from the saved step.";
    return {
        kind: "paused",
        planName: args.planName,
        projectRoot: validationProjectRoot(args),
        reason: message,
        retainTaskCompletionClaim: true,
        recovery: retryValidationLater(
            canceled ? "validation_canceled" : "validation_operation_interrupted",
            message,
            phase,
        ),
    };
}

function pausedResult(
    args: ContinueWorkflowValidationArgs,
    code: string,
    phase?: ValidationCheckpoint["nextPhase"],
): WorkflowValidationResult {
    const message = validationUserMessage("retry_pause");
    return {
        kind: "paused",
        planName: args.planName,
        projectRoot: validationProjectRoot(args),
        reason: message,
        recovery: retryValidationLater(code, message, phase),
    };
}

function presentPausedProgress(args: ContinueWorkflowValidationArgs, result: WorkflowValidationResult): void {
    if (result.kind !== "paused" || result.continueValidation) return;
    const engine = createEngineValidationArgs(args);
    const current = engine.session.getCurrentProgress();
    const message = result.reason || validationUserMessage("retry_pause");
    if (!current) {
        emitStatus(engine, message, "warning");
        return;
    }
    if (current.outcome !== "running") return;
    emitProgress(engine, message, "warning", {
        outcome: "paused",
        stage: "terminal",
        message,
        checks: {
            ci: current.checks.ci === "running" ? "canceled" : current.checks.ci,
            semanticReview: current.checks.semanticReview === "running" ? "canceled" : current.checks.semanticReview,
            humanReview: current.checks.humanReview === "running" ? "canceled" : current.checks.humanReview,
            merge: current.checks.merge === "running" ? "canceled" : current.checks.merge,
        },
    });
}

/** Reconcile canonical Plan state, claim one owner, run, and durably settle. */
export async function continueWorkflowValidation(
    args: ContinueWorkflowValidationArgs,
): Promise<WorkflowValidationResult> {
    return await continueValidationAttempt(args, 0);
}

async function continueValidationAttempt(
    args: ContinueWorkflowValidationArgs,
    retry: number,
): Promise<WorkflowValidationResult> {
    let claim: Extract<ClaimResult, { kind: "claimed" }> | undefined;
    try {
        const projectRoot = validationProjectRoot(args);
        // Repair provable RunWield bookkeeping before it can block validation. Doctor
        // never resets working changes or removes an unmerged worktree.
        await runPlansDoctor(projectRoot, true);
        const claimed = await claimValidation(args);
        if (claimed.kind === "active") {
            const message = validationUserMessage("already_running");
            return {
                kind: "paused",
                planName: args.planName,
                projectRoot: claimed.projectRoot,
                reason: message,
                recovery: retryValidationLater("validation_owner_active", message),
            };
        }
        if (claimed.kind === "settled_completion") {
            return {
                kind: "paused",
                planName: args.planName,
                projectRoot: claimed.projectRoot,
                reason: validationUserMessage("completion_already_used"),
                recovery: {
                    kind: "terminal",
                    code: "task_completion_already_settled",
                    message: validationUserMessage("completion_already_used"),
                    action: "none",
                },
            };
        }
        claim = claimed;
        const cachedWorkflow = args.hostedSession.getActiveExecutionWorkflow();
        const activeWorkflow = cachedWorkflow?.planName === args.planName &&
                cachedWorkflow.worktreeId === claim.triageMeta.worktreeId
            ? cachedWorkflow
            : null;
        const durableReview = readValidationReviewState(claim.checkpoint);
        const registryEntry = await findWorktreeByPlanName(projectRoot, args.planName);
        const policy = resolvePlanExecutionPolicy(claim.triageMeta);
        args.hostedSession.setActiveExecutionWorkflow({
            ...(activeWorkflow || {}),
            planName: args.planName,
            triageMeta: {
                ...claim.triageMeta,
                ...(registryEntry?.status && registryEntry.status !== "validated"
                    ? { worktreeStatus: registryEntry.status }
                    : {}),
                ...(registryEntry?.publication ? { publication: registryEntry.publication } : {}),
            },
            executionAgent: policy.ok ? policy.policy.executionAgent : "engineer",
            ...(registryEntry
                ? {
                    projectRoot,
                    executionMode: "worktree",
                    executionCwd: claim.planCwd,
                    baselineTree: registryEntry?.baseTree || claim.triageMeta.executionBaselineTree ||
                        args.executionContext?.baselineTree,
                    worktreeId: registryEntry?.id || claim.triageMeta.worktreeId || args.executionContext?.worktreeId,
                    worktreeBranch: registryEntry?.branch || claim.triageMeta.worktreeBranch ||
                        args.executionContext?.worktreeBranch,
                    worktreeBaseBranch: registryEntry?.baseBranch || claim.triageMeta.worktreeBaseBranch ||
                        args.executionContext?.worktreeBaseBranch,
                }
                : { executionMode: "non_git_in_place", executionCwd: claim.planCwd }),
            validationGeneration: claim.checkpoint.generation,
            ...(durableReview
                ? {
                    semanticRound: durableReview.semanticRound,
                    reviewLedger: durableReview.reviewLedger,
                    repairBaselineTree: durableReview.repairBaselineTree,
                    lastRepairReport: durableReview.lastRepairReport,
                }
                : {}),
            ...(claim.checkpoint.repairGeneration
                ? { validationRepairGeneration: claim.checkpoint.repairGeneration }
                : {}),
        });
        if (claim.claimedFromState === "awaiting_repair" && !args.taskCompletionId) {
            const result = await rebuildSemanticRepairHandoff(args, claim.checkpoint);
            await settleValidation(args, claim.checkpoint, result, claim.planCwd);
            return result;
        }
        const result = await runValidationLoop({
            ...args,
            planContent: claim.planContent,
            triageMeta: claim.triageMeta,
            executionContext: undefined,
            continuationPhase: claim.checkpoint.nextPhase,
            validationCheckpoint: claim.checkpoint,
        });
        await settleValidation(args, claim.checkpoint, result, claim.planCwd);
        if (result.kind === "verified") {
            args.hostedSession.clearActiveExecutionWorkflow();
        }
        presentPausedProgress(args, result);
        return result;
    } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        const result = operationalFailureResult(args, failure, claim?.checkpoint.nextPhase);
        let released = !claim;
        if (claim) {
            try {
                await settleValidation(args, claim.checkpoint, result, claim.planCwd);
                released = true;
            } catch (settlementError) {
                await logValidationFailure(
                    settlementError instanceof Error ? settlementError : new Error(String(settlementError)),
                    "pause",
                );
            }
        }
        await logValidationFailure(failure, "validation");
        // Only revision contention is safe to retry automatically. Reload the
        // canonical phase, never replay an Agent turn from its transcript.
        if (
            released && retry < 2 &&
            (error instanceof StalePlanWriteError || error instanceof StaleControllerWriteError)
        ) {
            return await continueValidationAttempt(args, retry + 1);
        }
        presentPausedProgress(args, result);
        return result;
    }
}

/**
 * Continue across successful phase boundaries until validation either finishes
 * or reaches a boundary that needs an Agent or the user. The execution Plan is
 * reloaded between phases because it is the durable phase authority once work
 * has started.
 */
export async function runWorkflowValidationToStableBoundary(
    initialArgs: ContinueWorkflowValidationArgs,
): Promise<WorkflowValidationResult> {
    let args = initialArgs;
    let result = await continueWorkflowValidation(args);
    // A resumed run can first consume its durable recovery checkpoint before
    // advancing through Mechanical Validation, semantic review, optional human
    // review, and publication. Bound the loop above that complete phase count;
    // explicit decisions below still stop immediately at Agent/user boundaries.
    for (let phase = 0; phase < 5; phase += 1) {
        if (result?.kind !== "paused" || !result.continueValidation) break;
        const planCwd = await validationPlanCwd(args);
        const plan = await loadPlan(planCwd, args.planName).catch(() => null);
        const status = String(plan?.attrs.status || "");
        if (!plan) break;
        if (
            status !== "validated_ci" && status !== "reviewed" &&
            !(status === "implemented" && plan.attrs.validationPhase === "semantic")
        ) break;
        args = {
            ...args,
            planContent: plan.markdown,
            triageMeta: plan.attrs as ContinueWorkflowValidationArgs["triageMeta"],
        };
        result = await continueWorkflowValidation(args);
    }
    return result;
}
