/**
 * @module shared/workflow
 * Plan-execution facade used by the plan_written tool, resume command, and
 * router triage flow.
 */

import {
    resolveExecutionOwner as resolveExecutionOwnerImpl,
    supportsPairExecution as supportsPairExecutionImpl,
} from "./execution-collaboration.ts";
import { runPlanningAgent as runPlanningAgentImpl } from "./planning-agent.ts";
import {
    executePlan as executePlanImpl,
    executePreparedPlanSegmentHandoff as executePreparedPlanSegmentHandoffImpl,
} from "./plan-executor.ts";

// Slicer-facing helpers are re-exported from the workflow facade for callers that should not import submodules.
export {
    beginSlicerContextPhase,
    createSlicerFinalizeTool,
    materializeSlicerDraft,
    openSlicerDecomposition,
    runSlicerAgent,
} from "./workflow-slicer.ts";
export { buildEngineerRequest, buildSlicerRequest } from "./workflow-prompts.ts";
export {
    extractAssistantOutput,
    readLatestPlanOutcome,
    readLatestReviewOutcome,
    readLatestTaskCompletedOutcome,
    readLatestTaskCompletedReport,
} from "./workflow-results.ts";
export { CollaborationStyles, PairCheckpointDecisions, PairPauseReasons } from "./execution-collaboration.ts";

import type { PlanFrontMatter } from "@runwield/plans";
import type { PlanExecutionPolicy } from "@runwield/plans/format";
import type { HostedSession } from "../session/hosted-session.ts";
import type { PlanWrittenEventPayload } from "@runwield/workflow/events";
import type { PlanExecutionResult, ExecutePlanOptions } from "./plan-executor.ts";
import type { RunPlanningAgentOptions } from "./planning-agent.ts";
import type { RuntimeTriageInput } from "../session/session-runtime.ts";

export type { PlanExecutionResult, ExecutePlanOptions } from "./plan-executor.ts";
export type { RunPlanningAgentOptions } from "./planning-agent.ts";
export type PlanOutcomeResult = PlanWrittenEventPayload;
export type PlanOutcome = PlanOutcomeResult["outcome"];
export type PreparedPlanSegmentHandoffOptions = Parameters<typeof executePreparedPlanSegmentHandoffImpl>[0];

export type ExecutionOwner = PlanExecutionPolicy["executionAgent"];

/** The facade forwards Runtime's partial inputs to the existing JS-compatible implementation. */
export interface WorkflowPlanningOptions extends Omit<Partial<RunPlanningAgentOptions>, "triageMeta"> {
    hostedSession: HostedSession;
    triageMeta?: RuntimeTriageInput;
}

export interface WorkflowExecutionOptions extends Omit<Partial<ExecutePlanOptions>, "triageMeta"> {
    hostedSession: HostedSession;
    triageMeta?: RuntimeTriageInput;
}

export function resolveExecutionOwner(meta: Partial<PlanFrontMatter>): ExecutionOwner {
    return resolveExecutionOwnerImpl(meta) as ExecutionOwner;
}

export function supportsPairExecution(hostedSession: HostedSession): boolean {
    return supportsPairExecutionImpl(hostedSession);
}

/**
 * Run a root Planner or Architect turn.
 *
 * Callers that already know which Plan the turn is about — `load-plan` resume
 * and re-review, Epic child continuation — pass it as `options.planName`. It is
 * recorded through `hostedSession.setWorkflowPlanName` before the turn starts so
 * a compacted planning session still has a pointer back to its draft.
 */
export function runPlanningAgent(options: WorkflowPlanningOptions): Promise<PlanOutcomeResult> {
    return runPlanningAgentImpl(options as RunPlanningAgentOptions);
}

export function executePlan(options: WorkflowExecutionOptions): Promise<PlanExecutionResult> {
    return executePlanImpl(options as ExecutePlanOptions);
}

export function executePreparedPlanSegmentHandoff(
    options: PreparedPlanSegmentHandoffOptions,
): Promise<PlanExecutionResult> {
    return executePreparedPlanSegmentHandoffImpl(options);
}

export type {
    ReviewOutcome,
    ReviewOutcomeResult,
    PlanOutcome as LegacyPlanOutcome,
    PlanOutcomeResult as LegacyPlanOutcomeResult,
    WorkflowTaskCompletedReport,
} from "./workflow-results.ts";
