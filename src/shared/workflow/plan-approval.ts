import { projectPlanType } from "@runwield/plans/format";
/**
 * @module shared/workflow/plan-approval
 * Approval-intent contract shared by Plan Review transport and workflow routing.
 */

export interface PlanApprovalActions {
    readonly RUN: "run";
    readonly DECOMPOSE: "decompose";
    readonly LATER: "later";
}

export const PLAN_APPROVAL_ACTIONS: PlanApprovalActions = Object.freeze({
    RUN: "run",
    DECOMPOSE: "decompose",
    LATER: "later",
});

export type PlanApprovalAction = (typeof PLAN_APPROVAL_ACTIONS)[keyof typeof PLAN_APPROVAL_ACTIONS];

export interface PlanApprovalOptions {
    classification?: string | null;
    type?: string;
    action?: string | null;
}

function normalizePlanClassification(classification: string | null | undefined): "PROJECT" | "PLANNED_CHANGE" | "" {
    const value = String(classification || "")
        .trim()
        .replace(/^['\"]|['\"]$/g, "")
        .toUpperCase();
    if (value === "PROJECT" || value === "PLANNED_CHANGE") return value;
    return "";
}

function normalizeActionValue(action: string | null | undefined): string {
    return String(action || "")
        .trim()
        .toLowerCase();
}

/** Return the immediate approval action for a Plan Classification. */
export function primaryPlanApprovalActionForClassification(
    classification: string | null | undefined,
    type?: string,
): PlanApprovalAction {
    return projectPlanType({ classification: normalizePlanClassification(classification), type }) === "epic"
        ? PLAN_APPROVAL_ACTIONS.DECOMPOSE
        : PLAN_APPROVAL_ACTIONS.RUN;
}

/**
 * Safely normalize a browser approval action against trusted Plan Classification.
 * Missing, unknown, or classification-incompatible values intentionally become
 * `later` so approval never grants accidental immediate execution/decomposition.
 */
export function normalizePlanApprovalAction({ classification, type, action }: PlanApprovalOptions): PlanApprovalAction {
    const planClassification = normalizePlanClassification(classification);
    const requestedAction = normalizeActionValue(action);

    const projectType = projectPlanType({ classification: planClassification, type });
    if (requestedAction === PLAN_APPROVAL_ACTIONS.LATER) return PLAN_APPROVAL_ACTIONS.LATER;
    if (projectType === "epic" && requestedAction === PLAN_APPROVAL_ACTIONS.DECOMPOSE) {
        return PLAN_APPROVAL_ACTIONS.DECOMPOSE;
    }
    if (
        (planClassification === "PLANNED_CHANGE" || projectType === "sequence") &&
        requestedAction === PLAN_APPROVAL_ACTIONS.RUN
    ) {
        return PLAN_APPROVAL_ACTIONS.RUN;
    }
    return PLAN_APPROVAL_ACTIONS.LATER;
}

export function readPlanApprovalAction(action: string | null | undefined): PlanApprovalAction | undefined {
    const requestedAction = normalizeActionValue(action);
    if (requestedAction === PLAN_APPROVAL_ACTIONS.RUN) return PLAN_APPROVAL_ACTIONS.RUN;
    if (requestedAction === PLAN_APPROVAL_ACTIONS.DECOMPOSE) return PLAN_APPROVAL_ACTIONS.DECOMPOSE;
    if (requestedAction === PLAN_APPROVAL_ACTIONS.LATER) return PLAN_APPROVAL_ACTIONS.LATER;
    return undefined;
}
