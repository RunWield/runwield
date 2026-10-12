/** Controller-owned state. None of these fields belongs in a Plan document. */
import type { ValidationCheckpoint } from "./validation-checkpoint.ts";

export type WorktreeDeliveryEvidence = {
    version: 1;
    mode: "worktree_merge";
    executionCommit: string;
    targetBranch: string;
    targetHeadBeforeMerge: string;
};

export type NonGitDeliveryEvidence = {
    version: 1;
    mode: "non_git_in_place";
};

export type WorkflowControllerState = {
    updatedAt?: string;
    /** Document location may outlive execution, e.g. while revising a retired attempt. */
    documentWorktreeId?: string | null;
    executionMode?: "worktree" | "non_git_in_place" | null;
    validationCheckpoint?: ValidationCheckpoint | null;
    /** Passed phase owned by this Plan execution; reset whenever implementation changes. */
    validationPhase?: "mechanical" | "semantic" | "delivery";
    validationCiAttempts?: number;
    validationSemanticRounds?: number;
    failureReason?: string | null;
    failedAt?: string | null;
    implementedAt?: string | null;
    validatedAt?: string | null;
    verifiedAt?: string | null;
    publicationReceipt?: { validatedCommit: string; publishedCommit: string; targetBranch: string } | null;
    recordingSource?: { commit: string; planName: string; planId: string };
    publicationObservation?: {
        attemptId: string;
        eventId: string;
        historyEpoch?: string;
        coverage: "unverified" | "complete" | "incomplete";
    };
    executionReport?: string | null;
    humanReviewMode?: "none" | "ask" | "always" | null;
    humanReviewDecision?: "not_required" | "skipped" | "approved" | "changes_requested" | null;
    humanReviewedAt?: string | null;
    deliveryEvidence?: WorktreeDeliveryEvidence | NonGitDeliveryEvidence | null;
    holdStalenessBaseline?: string | null;
    collaborationState?: string;
    collaborationServerUrl?: string;
    collaborationSpaceId?: string;
    collaborationRevision?: number;
    collaborationBodyHash?: string;
    collaborationSyncedAt?: string;
};

export const CONTROLLER_STATE_FIELDS = [
    "updatedAt",
    "documentWorktreeId",
    "executionMode",
    "validationCheckpoint",
    "validationPhase",
    "validationCiAttempts",
    "validationSemanticRounds",
    "failureReason",
    "failedAt",
    "implementedAt",
    "validatedAt",
    "verifiedAt",
    "publicationReceipt",
    "recordingSource",
    "publicationObservation",
    "executionReport",
    "humanReviewMode",
    "humanReviewDecision",
    "humanReviewedAt",
    "deliveryEvidence",
    "holdStalenessBaseline",
    "collaborationState",
    "collaborationServerUrl",
    "collaborationSpaceId",
    "collaborationRevision",
    "collaborationBodyHash",
    "collaborationSyncedAt",
] as const satisfies readonly (keyof WorkflowControllerState)[];

/** These are a read-only view of the existing worktree registry, never another copy. */
export type WorkflowWorktreeContext = {
    worktreeId?: string | null;
    worktreePath?: string | null;
    worktreeBranch?: string | null;
    worktreeBaseBranch?: string | null;
    worktreeBaseCommit?: string | null;
    worktreeStatus?:
        | "none"
        | "planning"
        | "active"
        | "completed"
        | "execution_failed"
        | "validation_failed"
        | "merge_conflict"
        | "merged"
        | "abandoned"
        | null;
    executionBaselineTree?: string | null;
};

export const WORKTREE_CONTEXT_FIELDS = [
    "worktreeId",
    "worktreePath",
    "worktreeBranch",
    "worktreeBaseBranch",
    "worktreeBaseCommit",
    "worktreeStatus",
    "executionBaselineTree",
] as const satisfies readonly (keyof WorkflowWorktreeContext)[];

export const PLAN_RUNTIME_FIELDS = [...CONTROLLER_STATE_FIELDS, ...WORKTREE_CONTEXT_FIELDS] as const;

export function pickControllerState(source: Partial<WorkflowControllerState>): WorkflowControllerState {
    const result: WorkflowControllerState = {};
    for (const key of CONTROLLER_STATE_FIELDS) {
        if (!Object.hasOwn(source, key)) continue;
        const value = source[key] === null && ![
                "validationCheckpoint",
                "humanReviewMode",
                "humanReviewDecision",
                "humanReviewedAt",
            ].includes(key)
            ? undefined
            : source[key];
        Object.assign(result, { [key]: value });
    }
    return result;
}

export function stripRuntimeFields<T extends WorkflowControllerState & WorkflowWorktreeContext>(source: T): T {
    const result = { ...source };
    for (const key of PLAN_RUNTIME_FIELDS) delete result[key];
    return result;
}
