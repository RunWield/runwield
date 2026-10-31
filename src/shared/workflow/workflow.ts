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
import { finalizePlanImplementation as finalizePlanImplementationImpl } from "./implementation-checkpoint.ts";
import {
    executePlan as executePlanImpl,
    executePreparedPlanSegmentHandoff as executePreparedPlanSegmentHandoffImpl,
} from "./plan-executor.ts";
import {
    assertReusableWorktreeTargetMatches as assertReusableWorktreeTargetMatchesImpl,
    normalizeExecutionTargetBranch as normalizeExecutionTargetBranchImpl,
    startActiveExecutionWorkflow as startActiveExecutionWorkflowImpl,
} from "./execution-start.ts";

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
} from "./workflow-results.js";
export { CollaborationStyles, PairCheckpointDecisions, PairPauseReasons } from "./execution-collaboration.ts";

import type { PlanFrontMatter, PlanExecutionPolicy } from "../../plan-store.js";
import type { HostedSession, ActiveExecutionWorkflow } from "../session/hosted-session.js";
import type { PlanWrittenEventPayload } from "./workflow-tool-events.ts";
import type { PlanExecutionResult, ExecutePlanOptions } from "./plan-executor.ts";
import type { RunPlanningAgentOptions } from "./planning-agent.ts";
import type { RuntimeTriageInput } from "../session/session-runtime.ts";

export type { PlanExecutionResult, ExecutePlanOptions } from "./plan-executor.ts";
export type { RunPlanningAgentOptions } from "./planning-agent.ts";
export type PlanOutcomeResult = PlanWrittenEventPayload;
export type PlanOutcome = PlanOutcomeResult["outcome"];
export type FinalizePlanImplementationOptions = Parameters<typeof finalizePlanImplementationImpl>[0];
export type PreparedPlanSegmentHandoffOptions = Parameters<typeof executePreparedPlanSegmentHandoffImpl>[0];
export type StartActiveExecutionWorkflowOptions = Parameters<typeof startActiveExecutionWorkflowImpl>[0];

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

export interface PlanImplementationResult {
    implementationCommit?: string;
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

export function finalizePlanImplementation(
    options: FinalizePlanImplementationOptions,
): Promise<PlanImplementationResult> {
    return finalizePlanImplementationImpl(options);
}

export function executePlan(options: WorkflowExecutionOptions): Promise<PlanExecutionResult> {
    return executePlanImpl(options as ExecutePlanOptions);
}

export function executePreparedPlanSegmentHandoff(
    options: PreparedPlanSegmentHandoffOptions,
): Promise<PlanExecutionResult> {
    return executePreparedPlanSegmentHandoffImpl(options);
}

export function normalizeExecutionTargetBranch(value: unknown): string | undefined {
    return normalizeExecutionTargetBranchImpl(value);
}

export function assertReusableWorktreeTargetMatches(
    reusableBaseBranch: string | undefined,
    targetBranch: string | undefined,
) {
    return assertReusableWorktreeTargetMatchesImpl(reusableBaseBranch, targetBranch);
}

export function startActiveExecutionWorkflow(
    options: StartActiveExecutionWorkflowOptions,
): Promise<ActiveExecutionWorkflow> {
    return startActiveExecutionWorkflowImpl({
        ...options,
        cwd: options.cwd ?? options.hostedSession?.cwd,
        existingExecution: options.existingExecution ?? options.hostedSession?.getActiveExecutionWorkflow?.(),
    });
}
