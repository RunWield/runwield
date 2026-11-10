/**
 * @module shared/workflow/execution-agent
 * The one place that turns a Plan's execution policy owner into the Agent
 * identity the runtime actually activates.
 *
 * A Plan says who owns its execution: `engineer` or `frontend-engineer`. Those
 * two values are durable — they live in Plan Front Matter, in
 * `ActiveExecutionWorkflow.executionAgent`, in worktree records, and in segment
 * handoff markers written by earlier RunWield versions. They never change.
 *
 * The Agent the user talks to during execution is a different thing. An
 * `engineer`-owned Plan runs under the workflow-only **Plan Engineer**, because
 * the selectable Engineer is the elastic QUICK_FIX helper and executes no Plans.
 * Resolving that here, once, is what keeps `plan-engineer` out of every durable
 * record: it is a runtime identity, never a policy value.
 */

import { AGENTS } from "../../constants.ts";
import type { ActiveExecutionWorkflow } from "../session/execution-workflow-session.ts";

/** The owner a Plan may name. This is what gets written down. */
export type PlanExecutionPolicyAgent = "engineer" | "frontend-engineer";

/** The Agent identity the runtime activates. This is never written down. */
export type PlanExecutionRuntimeAgent = "plan-engineer" | "frontend-engineer";

// `AGENTS` comes from a JSDoc-typed module, so its values widen to `string`.
// Naming the two runtime identities here keeps the resolver's return type exact.
const PLAN_ENGINEER: PlanExecutionRuntimeAgent = "plan-engineer";
const FRONTEND_ENGINEER: PlanExecutionRuntimeAgent = "frontend-engineer";

export function isPlanExecutionPolicyAgent(value: unknown): value is PlanExecutionPolicyAgent {
    return value === AGENTS.ENGINEER || value === AGENTS.FRONTEND_ENGINEER;
}

/** Whether an Agent identity is one of the two Plan executors. */
export function isPlanExecutionRuntimeAgent(value: unknown): value is PlanExecutionRuntimeAgent {
    return value === AGENTS.PLAN_ENGINEER || value === AGENTS.FRONTEND_ENGINEER;
}

/**
 * Resolve a Plan's canonical execution owner to the Agent the runtime activates.
 *
 * Every Plan launch, segment handoff, completion-ownership check, resume,
 * `/load-plan` restoration, compaction re-anchor, and display label goes through
 * here. An unrecognized owner resolves to Plan Engineer rather than throwing:
 * a Plan with a corrupt owner field should still execute under a Plan executor,
 * not fall back to the QUICK_FIX helper.
 */
export function resolvePlanExecutionRuntimeAgent(policyAgent: string | undefined | null): PlanExecutionRuntimeAgent {
    return policyAgent === AGENTS.FRONTEND_ENGINEER ? FRONTEND_ENGINEER : PLAN_ENGINEER;
}

/**
 * Resolve the Agent identity that owns an active workflow.
 *
 * A QUICK_FIX also records `executionAgent: "engineer"`, but it has no Plan and
 * belongs to the selectable Engineer. Distinguishing the two here is what stops
 * a Mechanical Validation repair from being handed to Plan Engineer.
 *
 * Returns null when the workflow records no owner at all.
 */
export function resolveActiveWorkflowRuntimeAgent(
    workflow: ActiveExecutionWorkflow | null | undefined,
): string | null {
    const owner = typeof workflow?.executionAgent === "string" ? workflow.executionAgent.trim() : "";
    if (!owner) return null;
    if (isQuickFixWorkflow(workflow)) return AGENTS.ENGINEER;
    return resolvePlanExecutionRuntimeAgent(owner);
}

/** Whether an active workflow is a no-Plan QUICK_FIX rather than Plan execution. */
export function isQuickFixWorkflow(workflow: ActiveExecutionWorkflow | null | undefined): boolean {
    return workflow?.triageMeta?.classification === "QUICK_FIX";
}
