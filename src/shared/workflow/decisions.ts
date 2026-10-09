/**
 * @module shared/workflow/decisions
 * Ephemeral Workflow Decision interpreters. These normalize raw tool/session
 * outcomes into semantic caller actions without mutating Plan Status.
 */

import type { TriageMeta } from "../../tools/plan-written.ts";
import type { PlanExecutionResult, PlanOutcomeResult } from "./workflow.js";

export type WorkflowDecisionKind =
    | "execute_plan"
    | "start_slicer"
    | "save_plan"
    | "run_validation"
    | "complete_session"
    | "stay_with_agent"
    | "halt";
export type WorkflowDecisionReason =
    | "plan_feedback"
    | "plan_review_canceled"
    | "missing_plan_declaration"
    | "execution_incomplete"
    | "execution_paused"
    | "execution_canceled"
    | "missing_execution_result"
    | "unknown_plan_outcome";

export interface WorkflowDecisionPayload {
    planName?: string;
    triageMeta?: Partial<TriageMeta>;
    reviewFeedback?: string;
    reviewImages?: PlanOutcomeResult["images"];
    agentName?: string;
    reason?: string;
    message?: string;
    error?: PlanExecutionResult["error"];
    pauseReason?: PlanExecutionResult["pauseReason"];
    checkpointId?: string;
}

export interface WorkflowDecision {
    kind: WorkflowDecisionKind;
    payload: WorkflowDecisionPayload;
}

export interface PostPlanningOptions {
    planningAgentName: string;
    fallbackTriageMeta?: TriageMeta;
}

export interface PostExecutionOptions {
    planName: string;
    triageMeta: TriageMeta;
    executionAgentName: string;
}

function decision(kind: WorkflowDecisionKind, payload: WorkflowDecisionPayload = {}): WorkflowDecision {
    return { kind, payload };
}

/** Build a sanitized metric payload for workflow decisions. */
export function summarizeWorkflowDecision(workflowDecision: WorkflowDecision) {
    const payload = workflowDecision.payload || {};
    return {
        kind: workflowDecision.kind,
        reason: payload.reason,
        planName: payload.planName,
        classification: (payload.triageMeta || {}).classification,
        nextAgent: payload.agentName,
    };
}

/** Normalize the planning phase outcome into a semantic decision for callers. */
export function decidePostPlanning(
    planOutcome: PlanOutcomeResult | null | undefined,
    { planningAgentName, fallbackTriageMeta }: PostPlanningOptions,
): WorkflowDecision {
    const outcome = planOutcome?.outcome || "no_call";

    if (outcome === "approved_execute") {
        if (!planOutcome?.planName) {
            return decision("stay_with_agent", {
                agentName: planningAgentName,
                reason: "missing_plan_declaration",
            });
        }

        const payload: WorkflowDecisionPayload = {
            planName: planOutcome.planName,
            triageMeta: planOutcome.triageMeta || fallbackTriageMeta || {},
        };
        if (planOutcome.feedback) payload.reviewFeedback = planOutcome.feedback;
        if (planOutcome.images?.length) payload.reviewImages = planOutcome.images;
        return decision("execute_plan", payload);
    }

    if (outcome === "approved_decompose") {
        if (!planOutcome?.planName) {
            return decision("stay_with_agent", {
                agentName: planningAgentName,
                reason: "missing_plan_declaration",
            });
        }

        const payload: WorkflowDecisionPayload = {
            planName: planOutcome.planName,
            triageMeta: planOutcome.triageMeta || fallbackTriageMeta || {},
        };
        if (planOutcome.feedback) payload.reviewFeedback = planOutcome.feedback;
        if (planOutcome.images?.length) payload.reviewImages = planOutcome.images;
        return decision("start_slicer", payload);
    }

    if (outcome === "saved") {
        return decision("save_plan", { planName: planOutcome?.planName });
    }

    if (outcome === "feedback") {
        return decision("stay_with_agent", {
            agentName: planningAgentName,
            reason: "plan_feedback",
        });
    }

    if (outcome === "canceled") {
        return decision("stay_with_agent", {
            agentName: planningAgentName,
            reason: "plan_review_canceled",
        });
    }

    if (outcome === "repair_required") {
        return decision("stay_with_agent", {
            agentName: planningAgentName,
            reason: "plan_feedback",
        });
    }

    if (outcome === "no_call") {
        return decision("stay_with_agent", {
            agentName: planningAgentName,
            reason: "missing_plan_declaration",
        });
    }

    return decision("halt", { reason: "unknown_plan_outcome" });
}

/**
 * Normalize execution results. The caller owns validation, repair prompts,
 * active-agent changes, and Plan Events.
 */
export function decidePostExecution(
    executionResult: PlanExecutionResult | null | undefined,
    { planName, triageMeta, executionAgentName }: PostExecutionOptions,
): WorkflowDecision {
    if (!executionResult) {
        return decision("halt", { reason: "missing_execution_result" });
    }

    if (executionResult.executionComplete) {
        return decision("run_validation", { planName, triageMeta });
    }

    if (executionResult.intentionalComplete) {
        return decision("complete_session", {
            planName,
            triageMeta,
            reason: executionResult.intentionalCompleteReason,
            message: executionResult.message,
        });
    }

    if (executionResult.canceled) {
        return decision("stay_with_agent", {
            agentName: executionAgentName,
            reason: "execution_canceled",
            error: executionResult.error,
        });
    }

    if (executionResult.paused) {
        return decision("stay_with_agent", {
            agentName: executionAgentName,
            reason: "execution_paused",
            pauseReason: executionResult.pauseReason,
            error: executionResult.error,
        });
    }

    if (executionResult.checkpointPending) {
        return decision("stay_with_agent", {
            agentName: executionAgentName,
            reason: "pair_checkpoint_pending",
            checkpointId: executionResult.checkpointId,
        });
    }

    return decision("stay_with_agent", {
        agentName: executionAgentName,
        reason: "execution_incomplete",
        error: executionResult.error,
    });
}
