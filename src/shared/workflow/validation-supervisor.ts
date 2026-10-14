import { loadPlan, resolvePlanExecutionPolicy, StalePlanWriteError, updatePlanFrontMatter } from "../../plan-store.js";
import { StaleControllerWriteError } from "./controller-registry.ts";
import { runPlansDoctor } from "../../cmd/plans/doctor.ts";
import { getLockHostname, isPidAlive } from "../process-liveness.ts";
import { findActiveByPlanName as findWorktreeByPlanName } from "../worktree-registry.js";
import { hostSemanticRepairPrompt, requestHostRepair } from "./validation-host-state.ts";
import { runValidationLoop } from "./validation-engine.ts";
import { type ValidationLoopArgs, type WorkflowValidationResult } from "./validation-types.ts";
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
import { validationUserMessage } from "./validation-user-messages.ts";
import { resolvePhaseContext } from "./validation-context.ts";
import { getWorktreeReviewDiff } from "./git-snapshot.ts";
import { claimReviewFixes, renderOpenItems } from "./review-ledger.ts";
import { PLAN_STATUSES } from "./plan-lifecycle.js";
import { resolveWorkflowPlanLocation } from "./plan-location.ts";
import { resolvePrimaryCheckoutRoot } from "../primary-checkout.ts";
import {
    sameHostIdentity,
    ValidationHostRejected,
    ValidationHostWait,
    type ValidationHostResume,
} from "./validation-host-contract.ts";
import process from "node:process";
/**
 * @module shared/workflow/validation-supervisor
 * The sole production owner for planned-change validation and resume.
 */

export type ValidationTrigger =
    | "execution_completion"
    | "task_completion"
    | "load_plan"
    | "session_resume"
    | "repair"
    | "orchestrator"
    | "epic_child";

/** Canonical Plan state owned by the claimed validation attempt. */
export type ValidationAttemptClaim = {
    kind: "claimed";
    checkpoint: ValidationCheckpoint;
    planCwd: string;
    claimedFromState?: ValidationCheckpoint["state"];
    planContent: string;
    triageMeta: ValidationLoopArgs["triageMeta"];
};

export type RunValidationAttemptArgs = {
    hostResume?: ValidationHostResume;
    projectRoot: string;
    planName: string;
    trigger?: ValidationTrigger;
    taskCompletionId?: string;
    buildEngineArgs(claim: ValidationAttemptClaim): ValidationLoopArgs;
};

class ValidationAlreadyRunningError extends Error {}

type ClaimResult =
    | ValidationAttemptClaim
    | { kind: "active"; projectRoot: string }
    | { kind: "settled_completion"; projectRoot: string };

function checkpointRecord(
    value: import("../../plan-store.js").PlanFrontMatter["validationCheckpoint"],
): ValidationCheckpoint | undefined {
    if (!value || !isValidationCheckpoint(value)) return undefined;
    return value;
}

async function ownerIsAlive(checkpoint: ValidationCheckpoint): Promise<boolean> {
    if (!checkpoint.ownerPid || checkpoint.ownerHostname !== getLockHostname()) return false;
    return await isPidAlive(checkpoint.ownerPid);
}

async function validationPlanCwd(args: RunValidationAttemptArgs): Promise<string> {
    const projectRoot = args.projectRoot;
    // Validation's execution-context boundary verifies Git and repairs legacy
    // Plan IDs. Select its registered directory here without rejecting those
    // repairable IDs first, and never substitute a cached Session directory.
    const attempt = await findWorktreeByPlanName(projectRoot, args.planName);
    if (attempt) return attempt.path;
    return (await resolveWorkflowPlanLocation(projectRoot, args.planName)).documentRoot;
}

async function claimValidation(args: RunValidationAttemptArgs): Promise<ClaimResult> {
    const projectRoot = args.projectRoot;
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
        if (compatible && (await ownerIsAlive(prior))) {
            return { kind: "active", projectRoot };
        }
        const checkpoint = makeValidationCheckpoint({
            ...(compatible ? prior : {}),
            attemptId,
            generation: compatible ? prior.generation : crypto.randomUUID(),
            status: plan.attrs.status,
            phase: compatible ? prior.nextPhase : phase,
            state: "running",
            ownerPid: process.pid,
            ownerHostname: getLockHostname(),
            repairGeneration: compatible ? prior.repairGeneration : undefined,
            repairKind: compatible ? prior.repairKind : undefined,
            repairCompletedOperationId: compatible ? prior.repairCompletedOperationId : undefined,
            lastSettledOperationId: compatible ? prior.lastSettledOperationId : undefined,
            reviewState: compatible ? prior.reviewState : undefined,
        });
        try {
            await updatePlanFrontMatter(planCwd, args.planName, { validationCheckpoint: checkpoint }, plan.attrs, {
                expectedRevision: plan.revision,
                expectedControllerRevision: plan.controllerRevision,
            });
            return {
                kind: "claimed",
                checkpoint,
                planCwd,
                claimedFromState: compatible ? prior.state : undefined,
                planContent: plan.markdown,
                triageMeta: plan.attrs as ValidationLoopArgs["triageMeta"],
            };
        } catch (error) {
            if (!(error instanceof StalePlanWriteError || error instanceof StaleControllerWriteError) || attempt === 2)
                throw error;
        }
    }
    throw new Error("Could not claim validation.");
}

async function settleValidation(
    args: RunValidationAttemptArgs,
    checkpoint: ValidationCheckpoint,
    result: WorkflowValidationResult,
    planCwd: string,
): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const plan = await loadPlan(planCwd, args.planName);
        if (!plan) return;
        const current = checkpointRecord(plan.attrs.validationCheckpoint);
        if (
            current?.generation !== checkpoint.generation ||
            current.ownerPid !== checkpoint.ownerPid ||
            current.ownerHostname !== checkpoint.ownerHostname
        )
            return;
        const phase = validationPhaseForStatus(plan.attrs.status, plan.attrs.validationPhase);
        const validationCheckpoint =
            result.kind === "verified" || !phase
                ? null
                : makeValidationCheckpoint({
                      ...current,
                      ownerPid: undefined,
                      ownerHostname: undefined,
                      attemptId: plan.attrs.worktreeId || current.attemptId,
                      generation: current.generation,
                      status: plan.attrs.status,
                      phase,
                      state:
                          result.kind === "semantic_repair_handoff" || result.hostRequest?.kind === "repair"
                              ? "awaiting_repair"
                              : "paused",
                      repairKind: result.kind === "semantic_repair_handoff" ? "semantic" : current.repairKind,
                      repairGeneration:
                          result.kind === "semantic_repair_handoff"
                              ? current.repairGeneration || crypto.randomUUID()
                              : current.repairGeneration,
                      repairCompletedOperationId: current.repairCompletedOperationId,
                      lastSettledOperationId: result.retainTaskCompletionClaim
                          ? current.lastSettledOperationId
                          : args.taskCompletionId || current.lastSettledOperationId,
                      reviewState: current.reviewState,
                  });
        try {
            await updatePlanFrontMatter(planCwd, args.planName, { validationCheckpoint }, plan.attrs, {
                expectedRevision: plan.revision,
                expectedControllerRevision: plan.controllerRevision,
            });
            return;
        } catch (error) {
            if (!(error instanceof StalePlanWriteError || error instanceof StaleControllerWriteError) || attempt === 2)
                throw error;
        }
    }
}

type ValidationRepairCompletionOwner = {
    pid: number;
    hostname: string;
};

type ValidationRepairCompletionArgs = {
    projectRoot: string;
    planName: string;
    repairGeneration: string;
    report: string;
    /** An inline Session repair runs under the supervisor's existing claim. */
    owner?: ValidationRepairCompletionOwner;
};

/**
 * Commit a semantic repair's Agent claim before validation consumes it.
 *
 * The Agent report is evidence, not authority. This receipt only proves that the
 * exact checkpoint-owned repair turn called task_completed; CI and the Reviewer
 * still decide whether the work resolved anything.
 */
export async function recordValidationRepairCompletion(args: ValidationRepairCompletionArgs): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const plan = await loadPlan(args.projectRoot, args.planName);
        if (!plan) throw new Error(`Plan not found: ${args.planName}`);
        const checkpoint = checkpointRecord(plan.attrs.validationCheckpoint);
        if (!checkpoint || checkpoint.repairGeneration !== args.repairGeneration) {
            throw new Error("Semantic repair completion does not match the saved validation attempt.");
        }
        const ownedRepair =
            args.owner?.pid === process.pid &&
            args.owner.hostname === getLockHostname() &&
            checkpoint.ownerPid === args.owner.pid &&
            checkpoint.ownerHostname === args.owner.hostname;
        if ((await ownerIsAlive(checkpoint)) && !ownedRepair) throw new ValidationAlreadyRunningError();
        if (
            checkpoint.repairCompletedOperationId === args.repairGeneration ||
            checkpoint.lastSettledOperationId === args.repairGeneration
        )
            return;
        const reviewState = readValidationReviewState(checkpoint);
        const completed = makeValidationCheckpoint({
            ...checkpoint,
            ownerPid: ownedRepair ? checkpoint.ownerPid : undefined,
            ownerHostname: ownedRepair ? checkpoint.ownerHostname : undefined,
            pendingRepair: undefined,
            pendingCiDecision: undefined,
            pendingHostDecision: undefined,
            hostDecisionChoices: undefined,
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
            if (!(error instanceof StalePlanWriteError || error instanceof StaleControllerWriteError) || attempt === 2)
                throw error;
        }
    }
}

async function rebuildSemanticRepairHandoff(
    args: RunValidationAttemptArgs,
    checkpoint: ValidationCheckpoint,
    engineArgs: ValidationLoopArgs,
): Promise<WorkflowValidationResult> {
    const reviewState = readValidationReviewState(checkpoint);
    if (!reviewState || !checkpoint.repairGeneration) {
        return pausedResult(args, "validation_repair_evidence_missing", "mechanical");
    }
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
    if (engineArgs.hostTurn) {
        try {
            return await requestHostRepair(
                engineArgs,
                context,
                hostSemanticRepairPrompt(context, diffText, renderOpenItems(reviewState.reviewLedger)),
                "semantic",
            );
        } catch (error) {
            if (!(error instanceof ValidationHostWait)) throw error;
            return {
                kind: "host_request",
                planName: args.planName,
                projectRoot: context.projectRoot,
                hostRequest: error.request,
            };
        }
    }
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
    args: RunValidationAttemptArgs,
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
            : error.name === "PermissionDenied" ||
                ("code" in error && (error.code === "EACCES" || error.code === "EPERM"))
              ? "Validation could not access the project files. Check folder permissions, then retry."
              : "Validation paused before it could finish. Your changes are safe. Load this Plan to retry from the saved step.";
    return {
        kind: "paused",
        planName: args.planName,
        projectRoot: args.projectRoot,
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
    args: RunValidationAttemptArgs,
    code: string,
    phase?: ValidationCheckpoint["nextPhase"],
): WorkflowValidationResult {
    const message = validationUserMessage("retry_pause");
    return {
        kind: "paused",
        planName: args.planName,
        projectRoot: args.projectRoot,
        reason: message,
        recovery: retryValidationLater(code, message, phase),
    };
}

/** Reconcile canonical Plan state, claim one owner, run, and durably settle. */
export async function runValidationAttempt(args: RunValidationAttemptArgs): Promise<WorkflowValidationResult> {
    return await continueValidationAttempt({ ...args, projectRoot: resolvePrimaryCheckoutRoot(args.projectRoot) }, 0);
}

async function continueValidationAttempt(
    args: RunValidationAttemptArgs,
    retry: number,
): Promise<WorkflowValidationResult> {
    let claim: ValidationAttemptClaim | undefined;
    try {
        const projectRoot = args.projectRoot;
        if (args.hostResume?.kind === "decision") {
            const plan = await loadPlan(await validationPlanCwd(args), args.planName);
            const pending = plan?.attrs.validationCheckpoint?.pendingHostDecision;
            if (!pending || !sameHostIdentity(pending.identity, args.hostResume.identity)) {
                return {
                    kind: "failed",
                    planName: args.planName,
                    projectRoot,
                    reason: "Decision does not match the saved request.",
                };
            }
        }
        if (args.hostResume?.kind === "task_completed") {
            const cwd = await validationPlanCwd(args);
            const plan = await loadPlan(cwd, args.planName);
            const checkpoint = plan?.attrs.validationCheckpoint;
            const resume = args.hostResume;
            if (
                !checkpoint ||
                !sameHostIdentity(resume.identity, {
                    attemptId: checkpoint.attemptId,
                    generation: checkpoint.generation,
                    repairGeneration: checkpoint.repairGeneration || "",
                })
            ) {
                return {
                    kind: "failed",
                    planName: args.planName,
                    projectRoot,
                    reason: "Repair completion does not match the saved validation attempt.",
                };
            }
            if (await ownerIsAlive(checkpoint)) throw new ValidationAlreadyRunningError();
            if (checkpoint.lastSettledOperationId !== resume.identity.repairGeneration) {
                // The receipt proves the repair reported completion, not that validation
                // consumed it. A crash between receipt and claim must still run CI.
                await recordValidationRepairCompletion({
                    projectRoot: cwd,
                    planName: args.planName,
                    repairGeneration: resume.identity.repairGeneration,
                    report: resume.report,
                });
                args = { ...args, taskCompletionId: resume.identity.repairGeneration };
            } else if (plan?.attrs.status === "reviewed") {
                return { kind: "awaiting_delivery", planName: args.planName, projectRoot };
            } else if (checkpoint.pendingHostDecision) {
                return {
                    kind: "host_request",
                    planName: args.planName,
                    projectRoot,
                    hostRequest: checkpoint.pendingHostDecision,
                };
            } else if (checkpoint.nextPhase === "mechanical") {
                const message = validationUserMessage("completion_already_used");
                return {
                    kind: "paused",
                    planName: args.planName,
                    projectRoot,
                    reason: message,
                    recovery: { kind: "terminal", code: "task_completion_already_settled", message, action: "none" },
                };
            }
        }
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
        const engineArgs = {
            ...args.buildEngineArgs(claim),
            planName: args.planName,
            planContent: claim.planContent,
            triageMeta: claim.triageMeta,
            continuationPhase: claim.checkpoint.nextPhase,
            validationCheckpoint: claim.checkpoint,
        };
        if (
            engineArgs.hostTurn &&
            claim.checkpoint.repairCompletedOperationId &&
            claim.checkpoint.repairCompletedOperationId === claim.checkpoint.repairGeneration &&
            claim.checkpoint.repairCompletedOperationId !== claim.checkpoint.lastSettledOperationId
        ) {
            // A no-answer restart can also consume a ready receipt after process loss.
            args = { ...args, taskCompletionId: claim.checkpoint.repairCompletedOperationId };
        }
        const cachedWorkflow = engineArgs.session.getActiveWorkflow();
        const activeWorkflow =
            cachedWorkflow?.planName === args.planName && cachedWorkflow.worktreeId === claim.triageMeta.worktreeId
                ? cachedWorkflow
                : null;
        const durableReview = readValidationReviewState(claim.checkpoint);
        const registryEntry = await findWorktreeByPlanName(projectRoot, args.planName);
        const policy = resolvePlanExecutionPolicy(claim.triageMeta);
        engineArgs.session.setActiveWorkflow({
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
                      baselineTree:
                          registryEntry?.baseTree ||
                          claim.triageMeta.executionBaselineTree ||
                          engineArgs.executionContext?.baselineTree,
                      worktreeId:
                          registryEntry?.id || claim.triageMeta.worktreeId || engineArgs.executionContext?.worktreeId,
                      worktreeBranch:
                          registryEntry?.branch ||
                          claim.triageMeta.worktreeBranch ||
                          engineArgs.executionContext?.worktreeBranch,
                      worktreeBaseBranch:
                          registryEntry?.baseBranch ||
                          claim.triageMeta.worktreeBaseBranch ||
                          engineArgs.executionContext?.worktreeBaseBranch,
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
            if (engineArgs.hostTurn && claim.checkpoint.pendingRepair) {
                const result: WorkflowValidationResult = {
                    kind: "host_request",
                    planName: args.planName,
                    projectRoot,
                    hostRequest: claim.checkpoint.pendingRepair,
                };
                await settleValidation(args, claim.checkpoint, result, claim.planCwd);
                return result;
            }
            const result = await rebuildSemanticRepairHandoff(args, claim.checkpoint, engineArgs);
            await settleValidation(args, claim.checkpoint, result, claim.planCwd);
            return result;
        }
        let result: WorkflowValidationResult;
        try {
            result = await runValidationLoop({ ...engineArgs, executionContext: undefined });
        } catch (error) {
            if (error instanceof ValidationHostWait) {
                result = { kind: "host_request", planName: args.planName, projectRoot, hostRequest: error.request };
            } else if (error instanceof ValidationHostRejected) {
                result = { kind: "failed", planName: args.planName, projectRoot, reason: error.message };
            } else throw error;
        }
        await settleValidation(args, claim.checkpoint, result, claim.planCwd);
        return result;
    } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (error instanceof ValidationAlreadyRunningError) {
            const message = validationUserMessage("already_running");
            return {
                kind: "paused",
                planName: args.planName,
                projectRoot: args.projectRoot,
                reason: message,
                recovery: retryValidationLater("validation_owner_active", message),
            };
        }
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
            released &&
            retry < 2 &&
            (error instanceof StalePlanWriteError || error instanceof StaleControllerWriteError)
        ) {
            return await continueValidationAttempt(args, retry + 1);
        }
        return result;
    }
}
