import {
    VALIDATION_CHECKPOINT_VERSION,
    type ValidationCheckpoint,
    type ValidationCheckpointPhase,
    type ValidationCheckpointState,
    type ValidationReviewState,
} from "@runwield/plans/controller-state";
import { normalizeLedger } from "./review-ledger.ts";

export function validationPhaseForStatus(
    status: string | undefined,
    passedPhase?: ValidationCheckpointPhase,
): ValidationCheckpointPhase | null {
    if (status === "implemented") return passedPhase === "semantic" ? "semantic" : "mechanical";
    if (status === "validated_ci") return "semantic";
    if (status === "reviewed") return "delivery";
    return null;
}

const VALIDATION_PHASE_ORDER: readonly ValidationCheckpointPhase[] = ["mechanical", "semantic", "delivery"];

/**
 * Whether a durable checkpoint can still own continuation for this attempt.
 * An earlier checkpoint keeps the attempt's identity — its generation, repair
 * receipt, and Review Issues — when the same attempt's Plan has moved ahead without
 * that phase settling. It does not move the Plan back: the engine runs the phase the
 * canonical status asks for, because that status is the durable proof that the
 * earlier phase's checks passed.
 */
export function validationCheckpointCanResume(
    checkpoint: ValidationCheckpoint | undefined,
    attemptId: string,
    currentStatus: string,
    currentPassedPhase?: ValidationCheckpointPhase,
): checkpoint is ValidationCheckpoint {
    if (!checkpoint || checkpoint.attemptId !== attemptId) return false;
    const currentPhase = validationPhaseForStatus(currentStatus, currentPassedPhase);
    const expectedPhase = validationPhaseForStatus(
        checkpoint.expectedStatus,
        checkpoint.expectedStatus === "implemented" ? checkpoint.nextPhase : undefined,
    );
    if (!currentPhase || expectedPhase !== checkpoint.nextPhase) return false;
    const rememberedIndex = VALIDATION_PHASE_ORDER.indexOf(checkpoint.nextPhase);
    const currentIndex = VALIDATION_PHASE_ORDER.indexOf(currentPhase);
    return rememberedIndex <= currentIndex;
}

/** Normalize durable review state before it is projected into a Session. */
export function readValidationReviewState(
    checkpoint: ValidationCheckpoint | null | undefined,
): ValidationReviewState | undefined {
    const state = checkpoint?.reviewState;
    if (!state || !Number.isInteger(state.semanticRound) || state.semanticRound < 1) return undefined;
    return {
        semanticRound: state.semanticRound,
        reviewLedger: normalizeLedger(state.reviewLedger),
        repairBaselineTree: typeof state.repairBaselineTree === "string" ? state.repairBaselineTree : "",
        ...(typeof state.lastRepairReport === "string" ? { lastRepairReport: state.lastRepairReport } : {}),
    };
}

export function makeValidationCheckpoint(args: {
    attemptId: string;
    generation: string;
    status: string;
    phase: ValidationCheckpointPhase;
    state: ValidationCheckpointState;
    ownerPid?: number;
    ownerHostname?: string;
    ownerIdentity?: ValidationCheckpoint["ownerIdentity"];
    repairKind?: string;
    repairGeneration?: string;
    repairCompletedOperationId?: string;
    lastSettledOperationId?: string;
    reviewState?: ValidationReviewState;
    pendingHostDecision?: ValidationCheckpoint["pendingHostDecision"];
    hostDecisionChoices?: ValidationCheckpoint["hostDecisionChoices"];
    hostDecisionSequence?: number;
    pendingRepair?: ValidationCheckpoint["pendingRepair"];
    pendingCiDecision?: ValidationCheckpoint["pendingCiDecision"];
    hostReview?: ValidationCheckpoint["hostReview"];
    operationalAttempts?: number;
    publicationRepairs?: number;
    hostRecorder?: ValidationCheckpoint["hostRecorder"];
    candidateIdentity?: string;
}): ValidationCheckpoint {
    return {
        version: VALIDATION_CHECKPOINT_VERSION,
        attemptId: args.attemptId,
        generation: args.generation,
        expectedStatus: args.status,
        nextPhase: args.phase,
        state: args.state,
        ...(args.ownerPid !== undefined ? { ownerPid: args.ownerPid } : {}),
        ...(args.ownerHostname !== undefined ? { ownerHostname: args.ownerHostname } : {}),
        ...(args.ownerIdentity !== undefined ? { ownerIdentity: args.ownerIdentity } : {}),
        ...(args.repairKind !== undefined ? { repairKind: args.repairKind } : {}),
        ...(args.repairGeneration !== undefined ? { repairGeneration: args.repairGeneration } : {}),
        ...(args.repairCompletedOperationId !== undefined
            ? { repairCompletedOperationId: args.repairCompletedOperationId }
            : {}),
        ...(args.lastSettledOperationId !== undefined ? { lastSettledOperationId: args.lastSettledOperationId } : {}),
        ...(args.reviewState !== undefined ? { reviewState: args.reviewState } : {}),
        ...(args.pendingHostDecision ? { pendingHostDecision: args.pendingHostDecision } : {}),
        ...(args.hostDecisionChoices ? { hostDecisionChoices: args.hostDecisionChoices } : {}),
        ...(args.hostDecisionSequence !== undefined ? { hostDecisionSequence: args.hostDecisionSequence } : {}),
        ...(args.pendingRepair ? { pendingRepair: args.pendingRepair } : {}),
        ...(args.pendingCiDecision ? { pendingCiDecision: args.pendingCiDecision } : {}),
        ...(args.hostReview ? { hostReview: args.hostReview } : {}),
        ...(args.operationalAttempts !== undefined ? { operationalAttempts: args.operationalAttempts } : {}),
        ...(args.publicationRepairs !== undefined ? { publicationRepairs: args.publicationRepairs } : {}),
        ...(args.hostRecorder ? { hostRecorder: args.hostRecorder } : {}),
        ...(args.candidateIdentity !== undefined ? { candidateIdentity: args.candidateIdentity } : {}),
        updatedAt: new Date().toISOString(),
    };
}
