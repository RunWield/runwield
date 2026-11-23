import type { GeneratedWorkRecordSections } from "./work-record-schema.ts";

export type ProcessIdentity = {
    key: string;
    startedAt?: string;
};

export type ReviewIssueStatus = "new" | "fix_claimed" | "fix_confirmed" | "fix_rejected";

export type LedgerItem = {
    /** Stable identity, e.g. "R1-2". Never reused or renumbered. */
    id: string;
    openedInRound: number;
    resolvedInRound: number | null;
    title: string;
    requirement: string;
    evidence: string;
    /** Optional only for checkpoints written before explicit issue states. */
    status?: ReviewIssueStatus;
    rejectionReason?: string;
};

export type ReviewLedger = {
    items: LedgerItem[];
    /** Monotonic counter backing identity assignment. */
    sequence: number;
};

type InteractionValue = string | number | boolean | null | InteractionMetadata | InteractionValue[];
export type InteractionMetadata = { [key: string]: InteractionValue | undefined };

type ValidationInteractionOption<Metadata> = {
    value: string;
    label: string;
    description?: string;
    _meta?: Metadata;
};

/** A validation interaction request. Checkpoints contain JSON metadata. */
export type ValidationInteractionRequest<Metadata = InteractionMetadata> = {
    id?: string;
    type:
        | "select"
        | "text"
        | "approval"
        | "link"
        | "plan_review"
        | "code_review"
        | "pair_checkpoint"
        | "plan_deviation_confirmation";
    prompt: string;
    options?: ValidationInteractionOption<Metadata>[];
    defaultValue?: string;
    placeholder?: string;
    allowEmpty?: boolean;
    toolCallId?: string;
    _meta?: Metadata;
};

/** A validation interaction response. Checkpoints contain JSON metadata. */
export type ValidationInteractionResponse<Metadata = InteractionMetadata> = {
    outcome: string;
    value?: string | boolean;
    valueLabel?: string;
    message?: string;
    _meta?: Metadata;
};

export type ValidationHostIdentity = {
    attemptId: string;
    generation: string;
};
export type ValidationDecisionIdentity = ValidationHostIdentity & {
    kind: "decision";
    key: string;
};
export type ValidationRepairIdentity = ValidationHostIdentity & {
    repairGeneration: string;
};
export const VALIDATION_CHECKPOINT_VERSION = 1;

export type ValidationCheckpointPhase = "mechanical" | "semantic" | "delivery";
export type ValidationCheckpointState = "ready" | "running" | "awaiting_repair" | "paused";

export type ValidationReviewState = {
    semanticRound: number;
    reviewLedger: ReviewLedger;
    repairBaselineTree: string;
    lastRepairReport?: string;
};

export type CiRunEvidence = {
    runId: string;
    candidateIdentity?: string;
};
export type PendingCiDecision = { ciAttempts: number; failureReason: string; evidence?: CiRunEvidence };
export type HostReviewerContinuation = { semanticRound: number; correctionCount: number; correction?: string };
export type PendingHostDecision = {
    kind: "decision";
    identity: ValidationDecisionIdentity;
    interaction: ValidationInteractionRequest;
};

export type PendingHostRepair = {
    kind: "repair";
    identity: ValidationRepairIdentity;
    repairGeneration: string;
    prompt: string;
    cwd: string;
    role: string;
};

export type PendingHostRecorder = {
    kind: "recorder";
    identity: ValidationHostIdentity;
    prompt: string;
    cwd: string;
    validationError?: string;
};

type HostDecisionChoices = Record<string, ValidationInteractionResponse>;

export type HostRecorderState = {
    recordId: string;
    request: PendingHostRecorder;
    invalidSubmissions: number;
    sections?: GeneratedWorkRecordSections;
    failure?: string;
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
    ownerIdentity?: ProcessIdentity;
    repairKind?: string;
    repairGeneration?: string;
    repairCompletedOperationId?: string;
    lastSettledOperationId?: string;
    reviewState?: ValidationReviewState;
    pendingHostDecision?: PendingHostDecision;
    hostDecisionChoices?: HostDecisionChoices;
    hostDecisionSequence?: number;
    pendingRepair?: PendingHostRepair;
    pendingCiDecision?: PendingCiDecision;
    hostReview?: HostReviewerContinuation;
    operationalAttempts?: number;
    publicationRepairs?: number;
    hostRecorder?: HostRecorderState;
    candidateIdentity?: string;
    updatedAt: string;
};

export function isValidationCheckpoint(value: Partial<ValidationCheckpoint>): value is ValidationCheckpoint {
    return (
        value.version === VALIDATION_CHECKPOINT_VERSION &&
        typeof value.attemptId === "string" &&
        value.attemptId.length > 0 &&
        typeof value.generation === "string" &&
        value.generation.length > 0 &&
        typeof value.expectedStatus === "string" &&
        ["mechanical", "semantic", "delivery"].includes(String(value.nextPhase)) &&
        ["ready", "running", "awaiting_repair", "paused"].includes(String(value.state)) &&
        typeof value.updatedAt === "string"
    );
}
