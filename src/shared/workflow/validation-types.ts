/**
 * @module shared/workflow/validation-types
 * Shared engine-internal types and constants for the session-independent Workflow
 * Validation engine.
 *
 * The engine's sequencing and convergence policy lives here as data: the status
 * order, the phase-to-status map, and the round limits. The phases themselves live
 * in the phase modules; this module is what they agree on.
 */

import type { ReviewLedger } from "./review-ledger.ts";
import type { ResolvedValidationContext } from "./execution-context.ts";
import type { ValidationLocalCIPort, ValidationSessionPort, ValidationWorkflowState } from "./validation-ports.ts";
import type { ValidationCheckpoint, ValidationCheckpointPhase } from "./validation-checkpoint.ts";
import type { ValidationRecoveryResult } from "./validation-recovery.ts";

type PlanFrontMatter = import("../../plan-store.js").PlanFrontMatter;
type GitPort = import("../git-port.ts").GitPort;
type WorkRecordMnemotecaPort = import("../work-records/mnemoteca-port.ts").WorkRecordMnemotecaPort;
type RecordPlanEventArgs = Parameters<typeof import("./plan-lifecycle.js").recordPlanEvent>[0];
type RecordPlanEventResult = Awaited<ReturnType<typeof import("./plan-lifecycle.js").recordPlanEvent>>;
type EpicContinuationResolution = import("./epic-continuation.ts").EpicContinuationResolution;

/** The engine's result shape, mirroring the public entry's `WorkflowValidationResult`. */
export type WorkflowValidationResult = {
    kind: "verified" | "paused" | "failed" | "semantic_repair_handoff";
    planName: string;
    projectRoot: string;
    classification?: string;
    reason?: string;
    epicContinuation?: {
        completedPlanName: string;
        projectRoot: string;
        resolution?: EpicContinuationResolution;
    };
    semanticRepairHandoff?: SemanticRepairHandoff;
    recovery?: ValidationRecoveryResult;
    retainTaskCompletionClaim?: true;
    /** Set only after a completed check, accepted tool call, or explicit user decision. */
    continueValidation?: true;
};

export type SemanticRepairHandoff = {
    semanticRound: number;
    repairGeneration: string;
    reviewLedger: ReviewLedger;
    repairBaselineTree: string;
    lastRepairReport?: string;
    diffText: string;
    findingsSection: string;
    activeWorkflow: Partial<ValidationWorkflowState>;
};

export type ValidationPhaseResult = WorkflowValidationResult & {
    awaitingTaskCompletion?: true;
    awaitingUserAction?: true;
    retainTaskCompletionClaim?: true;
};

/** Triage metadata the engine reads Plan front matter through. */
export type TriageMeta = import("../../tools/plan-written.ts").TriageMeta;

type PlanStatus = "implemented" | "validated_ci" | "reviewed" | "validated";
type PlanEvent = RecordPlanEventArgs["event"];
type PlanEventStatus = RecordPlanEventArgs["currentStatus"];

export interface CodeReviewConversationEvent {
    type: "assistant_text_delta";
    delta: string;
    messageId: string;
    agentName: string;
}

export interface CodeReviewConversation {
    id: string;
    agentLabel: string;
    revision: number;
    events: CodeReviewConversationEvent[];
}

export interface CodeReviewConversationMessage {
    role: "user" | "agent";
    text: string;
}

export interface CodeReviewConversationState {
    conversation?: CodeReviewConversation;
    history: CodeReviewConversationMessage[];
}

/**
 * Everything one validation phase needs, assembled by the engine and the phase
 * modules. The session surface is the port; Plan Lifecycle, transitions, registry
 * and locks stay direct imports per the ownership heuristic.
 */
export type ValidationLoopArgs = {
    planName: string;
    planContent: string;
    triageMeta: TriageMeta;
    /** Presentation continuity across repair and CI; never validation authority. */
    codeReviewConversation?: CodeReviewConversationState;
    session: ValidationSessionPort;
    finalAgentName?: string;
    executionContext?: ValidationWorkflowState;
    git: GitPort;
    localCI: ValidationLocalCIPort;
    workRecordMnemotecaPort: WorkRecordMnemotecaPort;
    supportsSemanticRepairHandoff?: boolean;
    /** Durable phase claimed by the validation supervisor. */
    continuationPhase?: ValidationCheckpointPhase;
    /** Durable attempt record claimed by the validation supervisor. */
    validationCheckpoint?: ValidationCheckpoint;
};

/** The resolved execution facts a phase runs against. */
export type PhaseContext = {
    args: ValidationLoopArgs;
    projectRoot: string;
    executionContext: ResolvedValidationContext;
    baselineTree?: string;
    executionCwd: string;
    executionAgent: "engineer" | "frontend-engineer";
    worktreeId?: string;
    worktreeBranch?: string;
    worktreeBaseBranch?: string;
    nonGitInPlace: boolean;
    workflowBase: ValidationWorkflowState;
};

/** Durable semantic review state carried across pauses. */
export type SemanticRoundState = {
    semanticRound: number;
    reviewLedger: ReviewLedger;
    repairBaselineTree: string;
    lastRepairReport: string;
};

export type HumanReviewMetadata = {
    humanReviewMode: PlanFrontMatter["humanReviewMode"];
    humanReviewDecision: PlanFrontMatter["humanReviewDecision"];
    humanReviewedAt: string | null;
};

export type PublicationOutcome = {
    result: ValidationPhaseResult;
    recorded: boolean;
};

export type UserActionChoice =
    | "engineer_follow_up"
    | "retry"
    | "stop";

export type UserActionOption = {
    value: UserActionChoice;
    label: string;
    description?: string;
};

/** A pause for a decision only the user can make. */
export type UserActionPause = {
    /** One sentence, past tense: the thing that stopped. */
    whatHappened: string;
    /** One or two sentences, imperative: the user's move. */
    doThis: string;
    /** Optional paths or names the sentences refer to. */
    details?: string[];
    /** Optional choices. Defaults to Retry and Stop. */
    options?: UserActionOption[];
};

export type ReviewFeedbackImage = { base64: string; mimeType: string };

export type ReviewFeedbackRepairPacket = {
    diffText: string;
    findingsSection: string;
    repairKind: "semantic" | "human_feedback";
    reason: string;
    images?: ReviewFeedbackImage[];
    activeWorkflow?: Partial<ValidationWorkflowState>;
};

/** Independent automatic repair budgets. Keep these separate so each can be tuned. */
export const CI_REPAIR_CYCLES = 3;
export const SEMANTIC_REVIEW_CYCLES = 3;

/**
 * How many phases one call may drive. Validation has three, and a repair can send
 * the Plan back to the start, so this bounds a pathological ping-pong without
 * capping any real run.
 */
export const MAX_PHASES_PER_CALL = 12;

/** Validation's three statuses in the order the loop passes through them. */
export const VALIDATION_STATUS_ORDER = ["implemented", "validated_ci", "reviewed", "validated"];

/** The status a phase expects to find on the Plan it is about to run. */
export const PHASE_STATUS: Record<import("./validation-ports.ts").ValidationPhaseName, string> = {
    mechanical: "implemented",
    semantic: "validated_ci",
    delivery: "reviewed",
};

/** How many times an Agent may be sent at the same merge before the user is asked. */
export const MAX_AGENT_MERGE_REPAIRS = 2;

export type { PlanEvent, PlanEventStatus, PlanFrontMatter, PlanStatus, RecordPlanEventArgs, RecordPlanEventResult };
