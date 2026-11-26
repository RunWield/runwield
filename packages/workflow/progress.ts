import type { PlanStatus } from "@runwield/plans";
import {
    isValidationCheckpoint,
    type PendingHostDecision,
    type PendingHostRecorder,
    type PendingHostRepair,
    type ValidationCheckpoint,
    type ValidationHostIdentity,
} from "@runwield/plans/controller-state";
import { readPlanExecutionAttemptId, resolveWorkflowPlanLocation } from "../../src/plan-store/index.ts";
import { findActiveByPlanName, findByPlanId } from "../../src/shared/worktree-registry.ts";
import {
    validationCheckpointCanResume,
    validationPhaseForStatus,
} from "../../src/shared/workflow/validation-checkpoint.ts";
import type { WorkflowProgressFact } from "../../src/shared/workflow/workflow-presentation.ts";
import type { WorkflowLocation } from "./index.ts";
import { projectWorkflowActivity } from "./activity.ts";
import { hasApplicablePublicationReceipt } from "./publication-receipt.ts";

/** Identifies the review round and correction the host still needs to handle. */
interface PendingHostReview {
    kind: "reviewer";
    identity: ValidationHostIdentity;
    semanticRound: number;
    correctionCount: number;
}

/** Describes the validation checkpoint that this attempt can resume. */
export interface WorkflowValidationProgress {
    attemptId: string;
    generation: string;
    phase: ValidationCheckpoint["nextPhase"];
    state: ValidationCheckpoint["state"];
    updatedAt: string;
}

/** Summarizes a Plan's attempt, outstanding host work, and evidence of publication. */
export interface WorkflowProgress {
    planId?: string;
    status: PlanStatus;
    attemptId?: string;
    validation?: WorkflowValidationProgress;
    pendingAction?: PendingHostDecision | PendingHostRepair | PendingHostRecorder | PendingHostReview;
    facts: WorkflowProgressFact[];
    publication: "pending" | "confirmed" | "unconfirmed" | "none";
    registryUpdatedAt?: string;
}

function pendingAction(checkpoint: ValidationCheckpoint, phase: ValidationCheckpoint["nextPhase"] | null) {
    if (checkpoint.pendingHostDecision) return checkpoint.pendingHostDecision;
    if (checkpoint.pendingRepair) return checkpoint.pendingRepair;
    if (checkpoint.hostRecorder) {
        const recorder = checkpoint.hostRecorder;
        return recorder.sections || recorder.failure ? undefined : recorder.request;
    }
    if (checkpoint.hostReview && phase === "semantic") {
        const review: PendingHostReview = {
            kind: "reviewer",
            identity: { attemptId: checkpoint.attemptId, generation: checkpoint.generation },
            semanticRound: checkpoint.hostReview.semanticRound,
            correctionCount: checkpoint.hostReview.correctionCount,
        };
        return review;
    }
}

export async function readWorkflowProgress({
    cwd,
    planName,
    planId,
}: WorkflowLocation): Promise<WorkflowProgress | undefined> {
    const source = await resolveWorkflowPlanLocation(cwd, planName, { readOnly: true });
    const attrs = source.plan?.attrs;
    if (!attrs) return undefined;
    if (planId && attrs.planId !== planId) throw new Error("Workflow belongs to a different Plan.");
    if (source.plan?.readAvailability?.kind === "pending") throw new Error(source.plan.readAvailability.message);

    const registry = attrs.planId
        ? await findByPlanId(source.registryRoot, attrs.planId)
        : await findActiveByPlanName(source.registryRoot, planName);
    const activity = registry && projectWorkflowActivity(registry, attrs.planId);
    const attemptId =
        activity?.attemptId ||
        (attrs.planId && (await readPlanExecutionAttemptId(cwd, attrs.planId))) ||
        (attrs.executionMode === "non_git_in_place" ? "in-place" : undefined);
    const currentCheckpoint = attrs.validationCheckpoint;
    // Older and current in-place runs use the supervisor's "in-place" checkpoint ID.
    const validationAttemptId =
        activity?.attemptId || (attrs.executionMode === "non_git_in_place" ? "in-place" : attemptId);
    const checkpoint =
        validationAttemptId &&
        currentCheckpoint &&
        isValidationCheckpoint(currentCheckpoint) &&
        validationCheckpointCanResume(currentCheckpoint, validationAttemptId, attrs.status, attrs.validationPhase)
            ? currentCheckpoint
            : undefined;
    const facts: WorkflowProgressFact[] = [];
    if (checkpoint) {
        facts.push({
            kind: "validation_checkpoint",
            phase: checkpoint.nextPhase,
            state: checkpoint.state,
            repairKind: checkpoint.repairKind || null,
            updatedAt: checkpoint.updatedAt,
        });
    }
    const publication = activity?.publication;
    if (publication) {
        facts.push({
            kind: "publication",
            phase: publication.phase,
            failure: Boolean(publication.failure),
            message: publication.failure?.message || null,
            updatedAt: publication.updatedAt,
        });
    }
    if (activity) facts.push({ kind: "registry", status: activity.status, updatedAt: activity.updatedAt });
    return {
        planId: attrs.planId,
        status: attrs.status,
        attemptId,
        validation: checkpoint && {
            attemptId: checkpoint.attemptId,
            generation: checkpoint.generation,
            phase: checkpoint.nextPhase,
            state: checkpoint.state,
            updatedAt: checkpoint.updatedAt,
        },
        pendingAction:
            checkpoint && pendingAction(checkpoint, validationPhaseForStatus(attrs.status, attrs.validationPhase)),
        facts,
        registryUpdatedAt: activity?.updatedAt,
        publication: activity
            ? publication
                ? "pending"
                : "none"
            : hasApplicablePublicationReceipt(attrs) && attrs.status === "verified"
              ? "confirmed"
              : attrs.deliveryEvidence?.mode === "worktree_merge"
                ? "unconfirmed"
                : "none",
    };
}
