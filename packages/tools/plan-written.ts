import type { Static } from "typebox";
import type { planWrittenDefinition } from "./definitions/plan-written.ts";

type PlanWrittenParameters = Static<typeof planWrittenDefinition.parameters>;

export type PlanWrittenExecutionPolicy = Pick<PlanWrittenParameters, "executionAgent" | "collaborationRecommendation">;

/** Accept a filename or docs/plans path before the Plan store checks the canonical name. */
export function normalizeSubmittedPlanName(value?: string): string {
    return String(value || "")
        .trim()
        .replace(/^docs\/plans\//i, "")
        .replace(/\.md$/i, "")
        .trim();
}

/** Collect only the policy values explicitly supplied. Existing Plan fields can survive an omission. */
export function collectExecutionPolicyOverrides(params: PlanWrittenExecutionPolicy): PlanWrittenExecutionPolicy {
    return {
        ...(params.executionAgent !== undefined ? { executionAgent: params.executionAgent } : {}),
        ...(params.collaborationRecommendation !== undefined
            ? { collaborationRecommendation: params.collaborationRecommendation }
            : {}),
    };
}
