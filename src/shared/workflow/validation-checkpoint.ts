/**
 * @module shared/workflow/validation-checkpoint
 * Durable continuation facts that Plan status alone cannot express.
 *
 * This record is the attempt-scoped authority for validation continuation. Session
 * workflow objects may project it for prompts and display, but a fresh process can
 * reconstruct the same phase, owner, open Review Issues, and repair receipt from
 * this record alone.
 */

import { normalizeLedger, type ReviewLedger } from "./review-ledger.ts";

export const VALIDATION_CHECKPOINT_VERSION = 1;

export type ValidationCheckpointPhase = "mechanical" | "semantic" | "delivery";
export type ValidationCheckpointState = "ready" | "running" | "awaiting_repair" | "paused";

export type ValidationReviewState = {
    semanticRound: number;
    reviewLedger: ReviewLedger;
    repairBaselineTree: string;
    lastRepairReport?: string;
};

export type ValidationCheckpoint = {
    version: 1;
    attemptId: string;
    generation: string;
    expectedStatus: string;
    nextPhase: ValidationCheckpointPhase;
    state: ValidationCheckpointState;
    ownerPid?: number;
    ownerHostname?: string;
    repairKind?: string;
    repairGeneration?: string;
    repairCompletedOperationId?: string;
    lastSettledOperationId?: string;
    reviewState?: ValidationReviewState;
    updatedAt: string;
};

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

export function isValidationCheckpoint(value: Partial<ValidationCheckpoint>): value is ValidationCheckpoint {
    return value.version === VALIDATION_CHECKPOINT_VERSION &&
        typeof value.attemptId === "string" && value.attemptId.length > 0 &&
        typeof value.generation === "string" && value.generation.length > 0 &&
        typeof value.expectedStatus === "string" &&
        ["mechanical", "semantic", "delivery"].includes(String(value.nextPhase)) &&
        ["ready", "running", "awaiting_repair", "paused"].includes(String(value.state)) &&
        typeof value.updatedAt === "string";
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
    repairKind?: string;
    repairGeneration?: string;
    repairCompletedOperationId?: string;
    lastSettledOperationId?: string;
    reviewState?: ValidationReviewState;
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
        ...(args.repairKind !== undefined ? { repairKind: args.repairKind } : {}),
        ...(args.repairGeneration !== undefined ? { repairGeneration: args.repairGeneration } : {}),
        ...(args.repairCompletedOperationId !== undefined
            ? { repairCompletedOperationId: args.repairCompletedOperationId }
            : {}),
        ...(args.lastSettledOperationId !== undefined ? { lastSettledOperationId: args.lastSettledOperationId } : {}),
        ...(args.reviewState !== undefined ? { reviewState: args.reviewState } : {}),
        updatedAt: new Date().toISOString(),
    };
}
