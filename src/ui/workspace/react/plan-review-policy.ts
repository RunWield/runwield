import type { PlanCollaborationRecommendation, PlanExecutionAgent } from "./review-types.ts";

/** Plan Front Matter fields the review surface reads to pick an execution owner and style. */
export type PlanReviewFrontmatter = {
    classification?: string;
    executionAgent?: string;
    collaborationRecommendation?: string;
    frontend?: boolean;
};

/** Execution policy already resolved by the workflow side and handed to the surface. */
export type PlanReviewPolicyFields = {
    executionAgent?: string;
    collaborationRecommendation?: string;
};

/** The parts of the review payload that carry execution policy. */
export type PlanReviewPolicyPayload = {
    classification?: string;
    executionAgent?: string;
    collaborationRecommendation?: string;
    frontmatter?: PlanReviewFrontmatter;
    executionPolicy?: PlanReviewPolicyFields;
};

export type PlanReviewExecutionPolicy = {
    classification: string;
    canSelectExecutionPolicy: boolean;
    executionAgent: PlanExecutionAgent;
    collaborationRecommendation: PlanCollaborationRecommendation;
};

export type PlanReviewExecutionPolicyChange =
    { field: "executionAgent"; value: string } | { field: "collaborationRecommendation"; value: string };

/**
 * Resolve the execution policy the review surface starts from.
 *
 * The workflow-supplied `executionPolicy` wins, then flat payload fields, then Plan Front Matter.
 * Pair is valid for either execution agent, so a stored recommendation is preserved as written;
 * only an absent or invalid recommendation falls back to autonomous. Host capability is decided
 * later by `selectRuntimeCollaborationStyle`, not here.
 */
export function readPlanReviewExecutionPolicy(
    payload: PlanReviewPolicyPayload | null | undefined,
    parsedFrontmatter: PlanReviewFrontmatter | null | undefined,
): PlanReviewExecutionPolicy {
    const frontmatter =
        payload?.frontmatter && typeof payload.frontmatter === "object" ? payload.frontmatter : parsedFrontmatter || {};
    const classification =
        readScalar(payload?.classification) || readScalar(frontmatter.classification) || "PLANNED_CHANGE";
    const executionPolicy =
        payload?.executionPolicy && typeof payload.executionPolicy === "object" ? payload.executionPolicy : {};
    const executionAgent =
        readExecutionAgent(executionPolicy.executionAgent) ||
        readExecutionAgent(payload?.executionAgent) ||
        readExecutionAgent(frontmatter.executionAgent) ||
        (frontmatter.frontend === true ? "frontend-engineer" : "engineer");
    const collaborationRecommendation =
        readCollaborationRecommendation(executionPolicy.collaborationRecommendation) ||
        readCollaborationRecommendation(payload?.collaborationRecommendation) ||
        readCollaborationRecommendation(frontmatter.collaborationRecommendation) ||
        "autonomous";
    return normalizePlanReviewExecutionPolicy({
        classification,
        canSelectExecutionPolicy: classification === "PLANNED_CHANGE",
        executionAgent,
        collaborationRecommendation,
    });
}

export function updatePlanReviewExecutionPolicy(
    current: PlanReviewExecutionPolicy,
    change: PlanReviewExecutionPolicyChange,
): PlanReviewExecutionPolicy {
    const next = { ...current };
    if (change.field === "executionAgent") {
        next.executionAgent = readExecutionAgent(change.value) || current.executionAgent;
    } else {
        next.collaborationRecommendation =
            readCollaborationRecommendation(change.value) || current.collaborationRecommendation;
    }
    return normalizePlanReviewExecutionPolicy(next);
}

export function buildPlanReviewExecutionPolicyPayload(policy: PlanReviewExecutionPolicy): PlanReviewPolicyFields {
    const normalized = normalizePlanReviewExecutionPolicy(policy);
    if (!normalized.canSelectExecutionPolicy) return {};
    return {
        executionAgent: normalized.executionAgent,
        collaborationRecommendation: normalized.collaborationRecommendation,
    };
}

function normalizePlanReviewExecutionPolicy(policy: PlanReviewExecutionPolicy): PlanReviewExecutionPolicy {
    return {
        classification: policy.classification,
        canSelectExecutionPolicy: policy.classification === "PLANNED_CHANGE",
        executionAgent: readExecutionAgent(policy.executionAgent) || "engineer",
        collaborationRecommendation:
            readCollaborationRecommendation(policy.collaborationRecommendation) || "autonomous",
    };
}

/** Front Matter values reach the browser quoted; strip one matching pair of quotes. */
function readScalar(value: string | undefined): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (
        trimmed.length >= 2 &&
        ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
    ) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

function readExecutionAgent(value: string | undefined): PlanExecutionAgent | undefined {
    const scalar = readScalar(value);
    return scalar === "engineer" || scalar === "frontend-engineer" ? scalar : undefined;
}

function readCollaborationRecommendation(value: string | undefined): PlanCollaborationRecommendation | undefined {
    const scalar = readScalar(value);
    return scalar === "autonomous" || scalar === "pair" ? scalar : undefined;
}
