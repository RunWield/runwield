import { isEpicPlan, isProjectPlan } from "../project-plan.ts";
export { isEpicPlan, isProjectPlan, isSequencePlan } from "../project-plan.ts";
/**
 * @module shared/workflow/plan-lifecycle
 *
 * Central Plan Lifecycle state machine. Workflow callers should record Plan
 * Events here instead of mutating Plan Status directly.
 *
 * See docs/plan-lifecycle.md for the human-readable workflow.
 */

import { isPlannedChangeClassification } from "../../constants.js";
import {
    isPlanDependencySatisfiedStatus,
    normalizeDeliveryEvidence,
    normalizeExecutionMode,
} from "../../plan-format.ts";

/**
 * @typedef {"draft"|"approved"|"ready_for_decomposition"|"ready_for_work"|"in_progress"|"failed"|"implemented"|"validated_ci"|"reviewed"|"validated"|"verified"|"user_verified"|"closed_without_verification"|"on_hold"} PlanStatus
 */

/** @type {Record<PlanStatus, string>} */
const PLAN_STATUS_HELP_TEXT = {
    draft: "it is still a draft",
    approved: "it is approved",
    ready_for_decomposition: "it is ready to split into smaller work",
    ready_for_work: "it is ready for work",
    in_progress: "work has started",
    failed: "it failed",
    implemented: "the work is done",
    validated_ci: "the checks passed",
    reviewed: "code review passed",
    validated: "legacy validation completed",
    verified: "it was delivered",
    user_verified: "you approved it",
    closed_without_verification: "it was closed without validation",
    on_hold: "it is on hold",
};

/**
 * @param {PlanStatus} status
 * @returns {string}
 */
function describePlanStatus(status) {
    return PLAN_STATUS_HELP_TEXT[status] || status;
}

/**
 * @param {string} planName
 * @param {PlanStatus} currentStatus
 * @param {PlanStatus} canonicalStatus
 * @returns {string}
 */
export function buildStalePlanStatusMessage(planName, currentStatus, canonicalStatus) {
    return [
        `RunWield had old status data for Plan ${planName}.`,
        `It thought the Plan was at ${currentStatus} (${describePlanStatus(
            currentStatus,
        )}), but the saved Plan is at ${canonicalStatus} (${describePlanStatus(canonicalStatus)}).`,
        "What to do: run validation again for this Plan. RunWield will read the saved Plan and keep going.",
        "Do not reset your worktree.",
    ].join(" ");
}

/**
 * @typedef {"review_feedback"|"review_approved"|"readiness_passed"|"epic_readiness_passed"|"decomposition_finalized"|"execution_started"|"execution_failed"|"implementation_finished"|"mechanical_validation_failed"|"mechanical_validation_passed"|"semantic_review_feedback"|"semantic_review_passed"|"validation_failed"|"validation_passed"|"validation_invalidated"|"recovery_continue"|"recovery_reset"|"review_reopened"|"epic_done_enough"|"epic_children_delivered"|"epic_integration_passed"|"epic_integration_failed"|"epic_integration_stale"|"epic_publication_confirmed"|"manual_status_change"|"manual_closed_without_verification"|"manual_user_verified"|"plan_held"|"hold_resumed"|"hold_reset_to_draft"} PlanEvent
 */

/**
 * @typedef {Object} PlanEventDetails
 * @property {Partial<import('../../plan-store/index.ts').PlanFrontMatter>} [triageMeta]
 * @property {string} [epicDeliveryTargetBranch]
 * @property {boolean} [pendingPublication] - Prepare artifacts without claiming delivery
 * @property {string} [failureReason]
 * @property {string} [executionBaselineTree]
 * @property {string} [worktreeId]
 * @property {string} [worktreePath]
 * @property {string} [worktreeBranch]
 * @property {string} [worktreeBaseBranch]
 * @property {import('../../plan-store/index.ts').PlanFrontMatter['worktreeStatus']} [worktreeStatus]
 * @property {boolean} [nonGitInPlace]
 * @property {boolean} [cleanupMergedWorktrees]
 * @property {string} [executionReport]
 * @property {import('../../plan-store/index.ts').PlanFrontMatter['humanReviewMode']} [humanReviewMode]
 * @property {import('../../plan-store/index.ts').PlanFrontMatter['humanReviewDecision']} [humanReviewDecision]
 * @property {string|null} [humanReviewedAt]
 * @property {number} [validationCiAttempts]
 * @property {number} [validationSemanticRounds]
 * @property {"ci"} [mechanicalFailureKind]
 * @property {import('./validation-checkpoint.ts').ValidationCheckpoint|null} [validationCheckpoint]
 * @property {string} [epicDoneEnoughSummary]
 * @property {string} [integrationCommit] - Epic branch commit the integration gate checked
 * @property {string|null} [integrationReport] - Project-relative path of a failing integration gate report
 * @property {import('../../plan-store/index.ts').ExecutionMode} [executionMode]
 * @property {import('../../plan-store/index.ts').DeliveryEvidence} [deliveryEvidence]
 * @property {PlanStatus} [manualTargetStatus]
 * @property {string} [holdReason]
 * @property {string} [closedWithoutVerificationReason]
 * @property {string} [closedWithoutVerificationAt]
 * @property {string} [userVerificationNote]
 * @property {string} [holdStalenessBaseline]
 * @property {PlanStatus} [heldFromStatus]
 * @property {() => Date} [now]
 */

/** @type {PlanStatus[]} */
const MANUAL_BOARD_STATUSES = ["draft", "approved", "ready_for_work"];

/** @type {PlanStatus[]} */
const MANUAL_BOARD_SOURCE_STATUSES = [...MANUAL_BOARD_STATUSES, "in_progress", "implemented"];

/** @type {PlanStatus[]} */
export const PLAN_STATUSES = [
    "draft",
    "approved",
    "ready_for_decomposition",
    "ready_for_work",
    "in_progress",
    "failed",
    "implemented",
    "reviewed",
    "verified",
    "user_verified",
    "closed_without_verification",
    "on_hold",
];

/** @type {PlanStatus[]} */
export const ACTIVE_PLAN_STATUSES = [
    "draft",
    "approved",
    "ready_for_decomposition",
    "ready_for_work",
    "in_progress",
    "failed",
    "implemented",
    "reviewed",
];

/** @type {PlanStatus[]} */
export const VALIDATION_PLAN_STATUSES = ["implemented", "validated_ci", "reviewed", "validated"];

/** @param {string | undefined | null} status */
export function isInValidation(status) {
    return VALIDATION_PLAN_STATUSES.includes(/** @type {PlanStatus} */ (status));
}

/** @type {PlanStatus[]} */
export const CLOSED_PLAN_STATUSES = ["verified", "user_verified", "closed_without_verification"];

/** @type {PlanStatus[]} */
export const ON_HOLD_PLAN_STATUSES = ["on_hold"];

/** @param {string | undefined | null} status */
export function isRunWieldVerifiedPlanStatus(status) {
    return status === "validated" || status === "verified";
}

/** @param {string | undefined | null} status */
export function isUserVerifiedPlanStatus(status) {
    return status === "user_verified";
}

/** @param {string | undefined | null} status */
export function isTerminalPlanStatus(status) {
    return CLOSED_PLAN_STATUSES.includes(/** @type {any} */ (status));
}

/** @param {string | undefined | null} status */
export function isArchiveEligiblePlanStatus(status) {
    return isTerminalPlanStatus(status);
}

export { isPlanDependencySatisfiedStatus as isDependencySatisfiedPlanStatus };

const ALL_KNOWN_STATUSES = /** @type {PlanStatus[]} */ ([...PLAN_STATUSES, "validated_ci", "validated"]);

/** @type {Record<PlanEvent, PlanStatus[]>} */
const ALLOWED_FROM = {
    review_feedback: ["draft", "approved"],
    review_approved: ["draft", "approved"],
    readiness_passed: ["approved"],
    epic_readiness_passed: ["approved"],
    decomposition_finalized: ["approved", "ready_for_decomposition"],
    execution_started: ["ready_for_work"],
    execution_failed: ["in_progress"],
    implementation_finished: ["in_progress"],
    mechanical_validation_failed: ["implemented"],
    mechanical_validation_passed: ["implemented"],
    semantic_review_feedback: ["implemented", "validated_ci"],
    semantic_review_passed: ["implemented", "validated_ci"],
    validation_failed: ["implemented", "validated_ci", "reviewed"],
    validation_passed: ["reviewed"],
    recovery_continue: ["in_progress", "failed"],
    validation_invalidated: ["implemented", "validated_ci", "reviewed", "validated"],
    recovery_reset: ["in_progress", "failed", "implemented"],
    review_reopened: [
        "approved",
        "ready_for_decomposition",
        "ready_for_work",
        "in_progress",
        "failed",
        "implemented",
        "reviewed",
        "validated",
        "verified",
        "user_verified",
    ],
    epic_done_enough: ["ready_for_work", "implemented", "reviewed", "validated", "verified"],
    epic_children_delivered: ["ready_for_work"],
    epic_integration_passed: ["implemented"],
    epic_integration_failed: ["implemented"],
    epic_integration_stale: ["reviewed", "validated"],
    epic_publication_confirmed: ["reviewed"],
    manual_status_change: ALL_KNOWN_STATUSES,
    manual_closed_without_verification: ALL_KNOWN_STATUSES,
    manual_user_verified: ALL_KNOWN_STATUSES,
    plan_held: ALL_KNOWN_STATUSES,
    hold_resumed: ["on_hold"],
    hold_reset_to_draft: ["on_hold"],
};

/** Events that describe an Epic as a whole and never apply to an executable Plan. */
const EPIC_ONLY_EVENTS = new Set([
    "epic_done_enough",
    "epic_children_delivered",
    "epic_integration_passed",
    "epic_integration_failed",
    "epic_integration_stale",
    "epic_publication_confirmed",
]);

/** @type {Record<PlanEvent, PlanStatus>} */
const EVENT_STATUS = {
    review_feedback: "draft",
    review_approved: "approved",
    readiness_passed: "ready_for_work",
    epic_readiness_passed: "ready_for_decomposition",
    decomposition_finalized: "ready_for_work",
    execution_started: "in_progress",
    execution_failed: "failed",
    implementation_finished: "implemented",
    mechanical_validation_failed: "implemented",
    mechanical_validation_passed: "implemented",
    semantic_review_feedback: "implemented",
    semantic_review_passed: "reviewed",
    validation_failed: "implemented",
    validation_passed: "verified",
    recovery_continue: "ready_for_work",
    validation_invalidated: "implemented",
    recovery_reset: "ready_for_work",
    review_reopened: "draft",
    epic_done_enough: "closed_without_verification",
    epic_children_delivered: "implemented",
    epic_integration_passed: "reviewed",
    epic_integration_failed: "implemented",
    epic_integration_stale: "implemented",
    epic_publication_confirmed: "verified",
    manual_status_change: "draft",
    manual_closed_without_verification: "closed_without_verification",
    manual_user_verified: "user_verified",
    plan_held: "on_hold",
    hold_resumed: "draft",
    hold_reset_to_draft: "draft",
};

/**
 * @param {Date} date
 * @returns {string}
 */
function iso(date) {
    return date.toISOString();
}

/**
 * @param {string} status
 * @returns {status is PlanStatus}
 */
function isKnownPlanStatus(status) {
    return ALL_KNOWN_STATUSES.includes(/** @type {PlanStatus} */ (status));
}

/**
 * @param {PlanStatus} status
 * @param {import('../../plan-store/index.ts').PlanFrontMatterInput | undefined} attrs
 * @returns {boolean}
 */
function isManualBoardStatus(status, attrs) {
    return MANUAL_BOARD_SOURCE_STATUSES.includes(status) || (status === "ready_for_decomposition" && isEpicPlan(attrs));
}

/**
 * User attestation may close an ordinary board Plan or an already-partially-
 * validated Plan. It never converts RunWield validation history into proof:
 * `manual_user_verified` keeps that history and does not synthesize Delivery
 * Evidence or `verifiedAt`.
 *
 * @param {PlanStatus} status
 * @param {import('../../plan-store/index.ts').PlanFrontMatterInput | undefined} attrs
 * @returns {boolean}
 */
function isManualUserVerificationStatus(status, attrs) {
    return isManualBoardStatus(status, attrs) || status === "validated_ci" || status === "reviewed";
}

/**
 * @param {PlanStatus} status
 * @param {import('../../plan-store/index.ts').PlanFrontMatterInput | undefined} attrs
 * @returns {boolean}
 */
function isManualBoardTargetStatus(status, attrs) {
    return MANUAL_BOARD_STATUSES.includes(status) || (status === "ready_for_decomposition" && isEpicPlan(attrs));
}

/**
 * @param {PlanStatus} event
 */
function assertKnownHoldResumeStatus(event) {
    if (
        event === "on_hold" ||
        event === "verified" ||
        event === "user_verified" ||
        event === "closed_without_verification"
    ) {
        throw new Error(
            `Invalid Plan Lifecycle transition: hold_resumed cannot restore terminal/protected status "${event}".`,
        );
    }
}

/**
 * @param {PlanEvent} event
 * @param {PlanStatus} currentStatus
 */
function assertAllowedTransition(event, currentStatus) {
    const allowed = ALLOWED_FROM[event];
    if (!allowed.includes(currentStatus)) {
        throw new Error(
            `Invalid Plan Lifecycle transition: ${event} cannot apply to status "${currentStatus}". ` +
                `Allowed from: ${allowed.join(", ")}.`,
        );
    }
}

/**
 * @param {PlanStatus} currentStatus
 * @param {Partial<import('../../plan-store/index.ts').PlanFrontMatter> | undefined} attrs
 * @returns {PlanStatus[]}
 */
export function getAllowedManualPlanStatuses(currentStatus, attrs = {}) {
    if (!isManualBoardStatus(currentStatus, attrs)) return [];
    return isEpicPlan(attrs) ? [...MANUAL_BOARD_STATUSES, "ready_for_decomposition"] : [...MANUAL_BOARD_STATUSES];
}

/**
 * @param {PlanStatus} currentStatus
 * @param {PlanStatus} targetStatus
 * @param {Partial<import('../../plan-store/index.ts').PlanFrontMatter> | undefined} attrs
 * @returns {boolean}
 */
export function isManualBoardStatusChangeAllowed(currentStatus, targetStatus, attrs = {}) {
    return isManualBoardStatus(currentStatus, attrs) && isManualBoardTargetStatus(targetStatus, attrs);
}

/**
 * @param {PlanStatus} currentStatus
 * @param {Partial<import('../../plan-store/index.ts').PlanFrontMatter> | undefined} attrs
 * @returns {{ canCloseWithoutVerification: boolean, canUserVerify: boolean, canPutOnHold: boolean, canResumeFromHold: boolean, canResetToDraft: boolean, allowedManualTargetStatuses: PlanStatus[], blockedReasons: Record<string, string> }}
 */
export function getPlanLifecycleActionMetadata(currentStatus, attrs = {}) {
    /** @type {Record<string, string>} */
    const blockedReasons = {};
    const allowedManualTargetStatuses = getAllowedManualPlanStatuses(currentStatus, attrs).filter(
        (status) => status !== currentStatus,
    );
    const canCloseWithoutVerification = isManualBoardStatus(currentStatus, attrs);
    const canUserVerify = isManualUserVerificationStatus(currentStatus, attrs);
    const canPutOnHold =
        currentStatus !== "verified" &&
        currentStatus !== "user_verified" &&
        currentStatus !== "closed_without_verification" &&
        currentStatus !== "on_hold";
    const canResumeFromHold = currentStatus === "on_hold" && Boolean(attrs?.heldFromStatus);
    const canResetToDraft = currentStatus === "on_hold";

    if (!allowedManualTargetStatuses.length) {
        blockedReasons.move_status =
            currentStatus === "failed"
                ? "Failed Plans leave recovery through dedicated recovery workflow actions, not manual board movement."
                : "This status cannot be moved through generic board controls.";
    }
    if (!canCloseWithoutVerification) {
        blockedReasons.close_without_verification =
            "Only active manual board statuses can be closed without Workflow Validation.";
    }
    if (!canUserVerify) {
        blockedReasons.user_verify = "Only active or partially validated Plans can be marked User Verified.";
    }
    if (!canPutOnHold) {
        blockedReasons.put_on_hold = "Verified, closed, and already held Plans cannot be put on hold.";
    }
    if (currentStatus === "on_hold" && !attrs?.heldFromStatus) {
        blockedReasons.resume_from_hold = "This held Plan is missing heldFromStatus metadata.";
    } else if (!canResumeFromHold) {
        blockedReasons.resume_from_hold = "Only held Plans can be resumed.";
    }
    if (!canResetToDraft) blockedReasons.reset_to_draft = "Only held Plans can be reset to draft.";

    return {
        allowedManualTargetStatuses,
        canCloseWithoutVerification,
        canUserVerify,
        canPutOnHold,
        canResumeFromHold,
        canResetToDraft,
        blockedReasons,
    };
}

/**
 * @param {PlanStatus} currentStatus
 * @param {PlanEventDetails} details
 * @returns {PlanStatus}
 */
function getManualTargetStatus(currentStatus, details) {
    const target = details.manualTargetStatus;
    if (!target) {
        throw new Error("Invalid Plan Lifecycle transition: manual_status_change requires manualTargetStatus.");
    }
    if (!isKnownPlanStatus(target)) {
        throw new Error(`Invalid Plan Lifecycle transition: unknown manual target status "${target}".`);
    }
    if (!isManualBoardStatusChangeAllowed(currentStatus, target, details.triageMeta)) {
        throw new Error(
            `Invalid Plan Lifecycle transition: manual_status_change cannot move from "${currentStatus}" to "${target}".`,
        );
    }
    return target;
}

/**
 * @param {PlanEvent} event
 * @param {PlanStatus} currentStatus
 * @param {PlanEventDetails} details
 * @returns {Partial<import('../../plan-store/index.ts').PlanFrontMatter>}
 */
export function buildPlanEventUpdates(event, currentStatus, details = {}) {
    assertAllowedTransition(event, currentStatus);
    if (EPIC_ONLY_EVENTS.has(event) && !isProjectPlan(details.triageMeta)) {
        throw new Error(`Invalid Plan Lifecycle transition: ${event} can only apply to PROJECT Epic plans.`);
    }
    if (event === "epic_integration_passed" && !details.integrationCommit) {
        throw new Error("Invalid Plan Lifecycle transition: epic_integration_passed requires integrationCommit.");
    }

    const now = iso(details.now ? details.now() : new Date());
    const targetStatus =
        event === "manual_status_change" ? getManualTargetStatus(currentStatus, details) : EVENT_STATUS[event];
    /** @type {Partial<import('../../plan-store/index.ts').PlanFrontMatter>} */
    const updates = {
        ...(details.triageMeta || {}),
        status: targetStatus,
        updatedAt: now,
    };
    const clearsValidationCheckpoint =
        (event === "validation_passed" && !details.pendingPublication) ||
        (targetStatus === "implemented" && event !== "mechanical_validation_passed") ||
        event === "execution_started" ||
        event === "recovery_reset" ||
        event === "recovery_continue" ||
        event === "review_reopened" ||
        event === "hold_reset_to_draft" ||
        event === "manual_user_verified" ||
        event === "manual_closed_without_verification" ||
        event === "epic_done_enough" ||
        (event === "manual_status_change" && isTerminalPlanStatus(targetStatus));
    if (clearsValidationCheckpoint) {
        updates.validationCheckpoint = null;
    }

    if (
        targetStatus === "implemented" &&
        event !== "mechanical_validation_failed" &&
        event !== "mechanical_validation_passed" &&
        event !== "semantic_review_feedback"
    ) {
        updates.validationCiAttempts = 0;
        updates.validationSemanticRounds = 0;
    }

    if (event === "mechanical_validation_failed") {
        const currentAttempts =
            typeof details.triageMeta?.validationCiAttempts === "number" ? details.triageMeta.validationCiAttempts : 0;
        updates.validationCiAttempts = currentAttempts + 1;
        updates.validationSemanticRounds = 0;
        updates.failureReason = details.failureReason || "Mechanical Validation failed.";
        if (details.validationCheckpoint !== undefined) {
            updates.validationCheckpoint = details.validationCheckpoint;
        }
    }

    if (event === "mechanical_validation_passed") {
        updates.validationCiAttempts = 0;
        updates.failureReason = null;
        updates.failedAt = null;
    }

    if (event === "semantic_review_feedback") {
        const currentRounds =
            typeof details.triageMeta?.validationSemanticRounds === "number"
                ? details.triageMeta.validationSemanticRounds
                : 0;
        updates.validationSemanticRounds = currentRounds + 1;
        updates.validationCiAttempts = 0;
        updates.failureReason = details.failureReason || "Semantic Review requested changes.";
        // The open Review Issues and repair identity must commit with the status
        // move back to implemented. A later Session projection cannot fill this
        // in safely after the fact: the process may stop between these writes.
        if (details.validationCheckpoint !== undefined) {
            updates.validationCheckpoint = details.validationCheckpoint;
        }
    }

    if (
        [
            "execution_started",
            "implementation_finished",
            "semantic_review_feedback",
            "validation_failed",
            "recovery_reset",
            "review_reopened",
            "hold_reset_to_draft",
        ].includes(event)
    ) {
        updates.validationPhase = "mechanical";
        updates.validatedAt = null;
    }
    if (event === "mechanical_validation_passed") updates.validationPhase = "semantic";
    if (
        ["semantic_review_passed", "semantic_review_feedback"].includes(event) &&
        currentStatus === "implemented" &&
        details.triageMeta?.validationPhase !== "semantic"
    ) {
        throw new Error(
            `Invalid Plan Lifecycle transition: ${event} cannot apply to status "implemented" before CI passes.`,
        );
    }
    if (event === "semantic_review_passed") {
        updates.validationPhase = "delivery";
        updates.failureReason = null;
        updates.failedAt = null;
        updates.validationCheckpoint = details.validationCheckpoint ?? null;
    }

    if (event === "manual_closed_without_verification") {
        if (!isManualBoardStatus(currentStatus, details.triageMeta)) {
            throw new Error(
                `Invalid Plan Lifecycle transition: manual_closed_without_verification cannot apply to status "${currentStatus}".`,
            );
        }
        const reason =
            typeof details.closedWithoutVerificationReason === "string"
                ? details.closedWithoutVerificationReason.trim()
                : "";
        if (!reason) {
            throw new Error(
                "Invalid Plan Lifecycle transition: manual_closed_without_verification requires closedWithoutVerificationReason.",
            );
        }
        updates.status = "closed_without_verification";
        updates.closedWithoutVerificationReason = reason;
        updates.closedWithoutVerificationAt = details.triageMeta?.closedWithoutVerificationAt || now;
    }

    if (event === "manual_user_verified") {
        if (!isManualUserVerificationStatus(currentStatus, details.triageMeta)) {
            throw new Error(
                `Invalid Plan Lifecycle transition: manual_user_verified cannot apply to status "${currentStatus}".`,
            );
        }
        const note = typeof details.userVerificationNote === "string" ? details.userVerificationNote.trim() : "";
        if (!note) {
            throw new Error("Invalid Plan Lifecycle transition: manual_user_verified requires userVerificationNote.");
        }
        updates.status = "user_verified";
        updates.userVerifiedAt = details.triageMeta?.userVerifiedAt || now;
        updates.userVerificationNote = note;
    }

    if (event === "plan_held") {
        if (
            currentStatus === "validated" ||
            currentStatus === "verified" ||
            currentStatus === "user_verified" ||
            currentStatus === "closed_without_verification" ||
            currentStatus === "on_hold"
        ) {
            throw new Error(`Invalid Plan Lifecycle transition: plan_held cannot apply to status "${currentStatus}".`);
        }
        updates.heldFromStatus = currentStatus;
        updates.heldAt = now;
        updates.holdReason = details.holdReason;
        updates.holdStalenessBaseline = details.holdStalenessBaseline;
    }

    if (event === "hold_resumed") {
        const heldFromStatus = details.heldFromStatus;
        if (!heldFromStatus) {
            throw new Error("Invalid Plan Lifecycle transition: hold_resumed requires heldFromStatus.");
        }
        if (!isKnownPlanStatus(heldFromStatus)) {
            throw new Error(`Invalid Plan Lifecycle transition: unknown heldFromStatus "${heldFromStatus}".`);
        }
        assertKnownHoldResumeStatus(heldFromStatus);
        updates.status = heldFromStatus;
        updates.heldFromStatus = null;
        updates.heldAt = null;
        updates.holdReason = null;
        updates.holdStalenessBaseline = null;
    }

    if (event === "hold_reset_to_draft") {
        updates.documentWorktreeId = null;
        updates.heldFromStatus = null;
        updates.heldAt = null;
        updates.holdReason = null;
        updates.holdStalenessBaseline = null;
        updates.executionMode = null;
        updates.deliveryEvidence = null;
        updates.executionBaselineTree = null;
        updates.worktreeId = null;
        updates.worktreePath = null;
        updates.worktreeBranch = null;
        updates.worktreeBaseBranch = null;
        updates.worktreeStatus = null;
        updates.failureReason = null;
        updates.failedAt = null;
        updates.implementedAt = null;
        updates.validatedAt = null;
        updates.verifiedAt = null;
        updates.userVerifiedAt = null;
        updates.userVerificationNote = null;
        updates.closedWithoutVerificationReason = null;
        updates.closedWithoutVerificationAt = null;
        updates.humanReviewMode = null;
        updates.humanReviewDecision = null;
        updates.humanReviewedAt = null;
    }

    if (event === "manual_status_change") {
        if (targetStatus !== "implemented") {
            updates.implementedAt = null;
            updates.validatedAt = null;
            updates.verifiedAt = null;
            updates.userVerifiedAt = null;
            updates.userVerificationNote = null;
            updates.closedWithoutVerificationReason = null;
            updates.closedWithoutVerificationAt = null;
            updates.deliveryEvidence = null;
            updates.humanReviewMode = null;
            updates.humanReviewDecision = null;
            updates.humanReviewedAt = null;
        }

        if (targetStatus === "draft" || targetStatus === "approved" || targetStatus === "ready_for_decomposition") {
            updates.failureReason = null;
            updates.failedAt = null;
        }
    }

    if (event === "review_feedback") {
        updates.failureReason = null;
    }

    if (event === "review_approved") {
        updates.failureReason = null;
        updates.failedAt = null;
    }

    if (event === "readiness_passed" || event === "epic_readiness_passed" || event === "decomposition_finalized") {
        updates.failureReason = null;
        updates.failedAt = null;
        updates.verifiedAt = null;
        updates.userVerifiedAt = null;
        updates.userVerificationNote = null;
        updates.closedWithoutVerificationReason = null;
        updates.closedWithoutVerificationAt = null;
    }

    if (event === "execution_started") {
        updates.executionMode = details.nonGitInPlace ? "non_git_in_place" : "worktree";
        updates.deliveryEvidence = null;
        if (details.nonGitInPlace) {
            updates.executionBaselineTree = null;
            updates.worktreeId = null;
            updates.worktreePath = null;
            updates.worktreeBranch = null;
            updates.worktreeBaseBranch = null;
            updates.worktreeStatus = null;
        } else {
            if (details.triageMeta?.deliveryBranch) updates.deliveryBranch = details.worktreeBaseBranch;
            else updates.targetBranch = details.worktreeBaseBranch;
            updates.documentWorktreeId = details.worktreeId;
            updates.executionBaselineTree = details.executionBaselineTree;
            updates.worktreeId = details.worktreeId;
            updates.worktreePath = details.worktreePath;
            updates.worktreeBranch = details.worktreeBranch;
            updates.worktreeBaseBranch = details.worktreeBaseBranch;
            updates.worktreeStatus = details.worktreeStatus || "active";
        }
        updates.failureReason = null;
        updates.failedAt = null;
        updates.implementedAt = null;
        updates.validatedAt = null;
        updates.verifiedAt = null;
        updates.userVerifiedAt = null;
        updates.userVerificationNote = null;
        updates.closedWithoutVerificationReason = null;
        updates.closedWithoutVerificationAt = null;
        updates.executionReport = null;
        updates.humanReviewMode = null;
        updates.humanReviewDecision = null;
        updates.humanReviewedAt = null;
    }

    if (event === "execution_failed") {
        updates.worktreeStatus = "execution_failed";
        updates.failureReason = details.failureReason || "Execution failed before implementation finished.";
        updates.failedAt = now;
    }

    if (event === "implementation_finished") {
        updates.executionMode = details.nonGitInPlace ? "non_git_in_place" : details.executionMode || "worktree";
        if (!details.nonGitInPlace) {
            updates.executionBaselineTree = details.executionBaselineTree || updates.executionBaselineTree;
            updates.worktreeId = details.worktreeId || updates.worktreeId;
            updates.worktreePath = details.worktreePath || updates.worktreePath;
            updates.worktreeBranch = details.worktreeBranch || updates.worktreeBranch;
            updates.worktreeBaseBranch = details.worktreeBaseBranch || updates.worktreeBaseBranch;
            updates.worktreeStatus = "completed";
        }
        updates.implementedAt = now;
        updates.failedAt = null;
        updates.executionReport =
            typeof details.executionReport === "string" && details.executionReport.trim()
                ? details.executionReport.trim()
                : undefined;
    }

    if (event === "validation_failed") {
        // Validation state belongs to the Plan status/checkpoint. The worktree
        // registry separately owns attempt state and remains `completed` while a
        // finished implementation is repaired and revalidated. Do not duplicate
        // that mutable state in Plan front matter.
        updates.failureReason = details.failureReason || "Workflow Validation failed.";
        if (details.validationCheckpoint !== undefined) updates.validationCheckpoint = details.validationCheckpoint;
    }

    if (event === "epic_done_enough") {
        const completedAt = details.triageMeta?.epicDoneEnoughAt || now;
        updates.validatedAt = details.triageMeta?.validatedAt || completedAt;
        updates.userVerifiedAt = null;
        updates.userVerificationNote = null;
        updates.epicCompletionMode = "done_enough";
        updates.epicDoneEnoughAt = completedAt;
        updates.epicDoneEnoughSummary = details.epicDoneEnoughSummary || "Epic marked done enough for now.";
        updates.failureReason = null;
        updates.failedAt = null;
    }

    if (event === "epic_children_delivered") {
        updates.implementedAt = now;
        updates.failureReason = null;
        updates.failedAt = null;
    }

    if (event === "epic_integration_passed") {
        // The checked commit is the proof: a later Epic branch commit makes it stale.
        updates.validatedCommit = details.integrationCommit;
        updates.epicDeliveryTargetBranch =
            details.epicDeliveryTargetBranch ?? details.triageMeta?.epicDeliveryTargetBranch;
        updates.validatedAt = now;
        updates.epicIntegrationReport = null;
        updates.userVerifiedAt = null;
        updates.userVerificationNote = null;
        if (Object.hasOwn(details, "humanReviewMode")) updates.humanReviewMode = details.humanReviewMode;
        if (Object.hasOwn(details, "humanReviewDecision")) updates.humanReviewDecision = details.humanReviewDecision;
        if (Object.hasOwn(details, "humanReviewedAt")) updates.humanReviewedAt = details.humanReviewedAt ?? null;
        updates.failureReason = null;
        updates.failedAt = null;
    }

    if (event === "epic_publication_confirmed") {
        updates.verifiedAt = now;
    }

    if (event === "epic_integration_failed") {
        updates.failureReason = details.failureReason || "The Epic integration gate found problems.";
        updates.failedAt = now;
        updates.epicIntegrationReport = details.integrationReport ?? null;
        updates.validatedCommit = null;
    }

    if (event === "epic_integration_stale") {
        updates.validatedAt = null;
        updates.validatedCommit = null;
        updates.humanReviewMode = null;
        updates.humanReviewDecision = null;
        updates.humanReviewedAt = null;
    }

    if (event === "validation_passed") {
        if (details.pendingPublication) updates.status = "reviewed";
        const executionMode = normalizeExecutionMode(details.executionMode ?? updates.executionMode);
        const deliveryEvidence = normalizeDeliveryEvidence(details.deliveryEvidence);
        if (isPlannedChangeClassification(updates.classification)) {
            if (!executionMode) {
                throw new Error(
                    "Invalid Plan Lifecycle transition: planned change validation_passed requires executionMode.",
                );
            }
            if (!deliveryEvidence) {
                throw new Error(
                    "Invalid Plan Lifecycle transition: planned change validation_passed requires deliveryEvidence.",
                );
            }
            if (executionMode === "worktree" && deliveryEvidence.mode !== "worktree_merge") {
                throw new Error(
                    "Invalid Plan Lifecycle transition: worktree validation requires worktree Delivery Evidence.",
                );
            }
            if (executionMode === "non_git_in_place" && deliveryEvidence.mode !== "non_git_in_place") {
                throw new Error(
                    "Invalid Plan Lifecycle transition: non-Git validation requires non-Git Delivery Evidence.",
                );
            }
        }
        updates.executionMode = executionMode;
        updates.deliveryEvidence = deliveryEvidence;
        updates.validatedCommit = deliveryEvidence?.mode === "worktree_merge" ? deliveryEvidence.executionCommit : null;
        if (deliveryEvidence?.mode === "worktree_merge") {
            if (details.triageMeta?.deliveryBranch) updates.deliveryBranch = deliveryEvidence.targetBranch;
            else updates.targetBranch = deliveryEvidence.targetBranch;
        }
        // The registry remains the publication/recovery authority until the push is
        // confirmed. The validated Plan is immutable and must not retain a pointer
        // that would require another front-matter rewrite after publication.
        updates.executionBaselineTree = null;
        updates.worktreeId = null;
        updates.worktreePath = null;
        updates.worktreeBranch = null;
        updates.worktreeBaseBranch = null;
        updates.worktreeStatus = null;
        updates.validatedAt = now;
        updates.userVerifiedAt = null;
        updates.userVerificationNote = null;
        if (Object.hasOwn(details, "humanReviewMode")) updates.humanReviewMode = details.humanReviewMode;
        if (Object.hasOwn(details, "humanReviewDecision")) updates.humanReviewDecision = details.humanReviewDecision;
        if (Object.hasOwn(details, "humanReviewedAt")) updates.humanReviewedAt = details.humanReviewedAt ?? null;
        updates.failureReason = null;
        updates.failedAt = null;
    }

    if (event === "validation_invalidated") {
        updates.validationPhase = "mechanical";
        updates.validatedCommit = null;
        updates.deliveryEvidence = null;
        updates.validatedAt = null;
        updates.verifiedAt = null;
        updates.failureReason = null;
        updates.failedAt = null;
        updates.validationCiAttempts = 0;
        updates.validationSemanticRounds = 0;
        updates.humanReviewDecision = null;
        updates.humanReviewedAt = null;
        updates.worktreeStatus = "active";
    }

    if (event === "recovery_reset") {
        updates.executionMode = details.nonGitInPlace ? "non_git_in_place" : (details.executionMode ?? null);
        updates.deliveryEvidence = null;
        updates.worktreeId = details.worktreeId || updates.worktreeId;
        updates.worktreePath = details.worktreePath || updates.worktreePath;
        updates.worktreeBranch = details.worktreeBranch || updates.worktreeBranch;
        updates.worktreeBaseBranch = details.worktreeBaseBranch || updates.worktreeBaseBranch;
        updates.executionBaselineTree = details.executionBaselineTree || updates.executionBaselineTree;
        updates.worktreeStatus = details.worktreeStatus || updates.worktreeStatus || "abandoned";
        updates.failureReason = null;
        updates.failedAt = null;
        updates.implementedAt = null;
        updates.validatedAt = null;
        updates.verifiedAt = null;
        updates.userVerifiedAt = null;
        updates.userVerificationNote = null;
        updates.humanReviewMode = null;
        updates.humanReviewDecision = null;
        updates.humanReviewedAt = null;
    }

    if (event === "recovery_continue") {
        updates.failureReason = null;
        updates.failedAt = null;
        updates.implementedAt = null;
        updates.verifiedAt = null;
        updates.userVerifiedAt = null;
        updates.userVerificationNote = null;
        updates.deliveryEvidence = null;
        updates.humanReviewMode = null;
        updates.humanReviewDecision = null;
        updates.humanReviewedAt = null;
    }

    if (event === "review_reopened") {
        updates.documentWorktreeId = details.triageMeta?.worktreeId || details.triageMeta?.documentWorktreeId;
        updates.failureReason = null;
        updates.failedAt = null;
        updates.implementedAt = null;
        updates.verifiedAt = null;
        updates.userVerifiedAt = null;
        updates.userVerificationNote = null;
        updates.validatedAt = null;
        updates.deliveryEvidence = null;
        updates.humanReviewMode = null;
        updates.humanReviewDecision = null;
        updates.humanReviewedAt = null;
        // Replanning invalidates review evidence, not the implementation attempt.
        // Only explicit reset/abandon actions retire the registered worktree.
    }

    // A new execution or review must not retain the previous implementation's stamp.
    if (updates.deliveryEvidence === null) updates.validatedCommit = null;
    if (updates.verifiedAt === null || updates.validationPhase === "mechanical") updates.publicationReceipt = null;
    return updates;
}

/**
 * @param {string} status
 * @returns {boolean}
 */
export function isExecutablePlanStatus(status) {
    return status === "ready_for_work";
}

/**
 * Whether a review decision can be recorded from `status` as-is.
 *
 * Any other status means the Plan has already passed readiness or execution, so
 * recording a decision requires first invalidating its prior review evidence.
 * `review_reopened` preserves the implementation and its worktree. This lives
 * here, beside `ALLOWED_FROM`, because it is the same rule:
 * `review_approved` and `review_feedback` are legal only from these statuses,
 * and two modules keeping private copies of it is how the reopen came to run
 * twice, once against a stale status.
 *
 * @param {string} status
 * @returns {boolean}
 */
export function isPlanReviewableWithoutReopen(status) {
    return /** @type {readonly string[]} */ (ALLOWED_FROM.review_approved).includes(status);
}

// Compatibility surface: persistence is implemented only by the Plan owner.
export {
    recordPlanEvent,
    stageValidationPassedInExecutionWorktree,
    PlanLifecycleTransitionError,
} from "../../plan-store/index.ts";
