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

/**
 * @typedef {"approved_execute" | "approved_decompose" | "saved" | "feedback" | "canceled" | "repair_required" | "no_call"} PlanOutcome
 */

/**
 * @typedef {Object} PlanOutcomeResult
 * @property {PlanOutcome} outcome
 * @property {string} [planName]
 * @property {import('../../tools/plan-written.ts').TriageMeta} [triageMeta]
 * @property {string} [feedback]
 * @property {Array<{base64: string, mimeType: string}>} [images]
 */

/**
 * @typedef {Object} PlanExecutionResult
 * @property {boolean} repairRequired
 * @property {boolean} executionComplete
 * @property {boolean} [paused]
 * @property {boolean} [checkpointPending]
 * @property {string} [checkpointId]
 * @property {boolean} [canceled]
 * @property {boolean} [intentionalComplete]
 * @property {string} [intentionalCompleteReason]
 * @property {string} [message]
 * @property {string} [feedback]
 * @property {"stop"|"canceled"} [pauseReason]
 * @property {string} [error]
 * @property {string} [completionReport]
 * @property {import('../session/hosted-session.js').ActiveExecutionWorkflow} [executionContext]
 * @property {import('./execution-segment-handoff.ts').ExecutionSegmentContinuation} [executionSegmentHandoff]
 */

/**
 * @typedef {Object} FinalizePlanImplementationOptions
 * @property {string} projectRoot
 * @property {string} planName
 * @property {Partial<import('../../plan-store.js').PlanFrontMatter>} [triageMeta]
 * @property {import('../session/hosted-session.js').ActiveExecutionWorkflow | null | undefined} executionContext
 * @property {string} [executionReport]
 * @property {import('../session/hosted-session.js').HostedSession} [hostedSession]
 */

/**
 * @param {Partial<import('../../plan-store.js').PlanFrontMatter>} meta
 * @returns {"engineer"|"frontend-engineer"}
 */
export function resolveExecutionOwner(meta) {
    return /** @type {"engineer"|"frontend-engineer"} */ (resolveExecutionOwnerImpl(meta));
}

/**
 * @param {import('../session/hosted-session.js').HostedSession} hostedSession
 * @returns {boolean}
 */
export function supportsPairExecution(hostedSession) {
    return supportsPairExecutionImpl(hostedSession);
}

/**
 * Run a root Planner or Architect turn.
 *
 * Callers that already know which Plan the turn is about — `load-plan` resume
 * and re-review, Epic child continuation — pass it as `options.planName`. It is
 * recorded through `hostedSession.setWorkflowPlanName` before the turn starts so
 * a compacted planning session still has a pointer back to its draft.
 *
 * @param {*} options
 * @returns {Promise<PlanOutcomeResult>}
 */
export function runPlanningAgent(options) {
    return runPlanningAgentImpl(options);
}

/**
 * @param {FinalizePlanImplementationOptions} options
 * @returns {Promise<{ implementationCommit?: string }>}
 */
export function finalizePlanImplementation(options) {
    return finalizePlanImplementationImpl(options);
}

/**
 * @param {*} options
 * @returns {Promise<PlanExecutionResult>}
 */
export function executePlan(options) {
    return /** @type {Promise<PlanExecutionResult>} */ (executePlanImpl(options));
}

/**
 * @param {*} options
 * @returns {Promise<PlanExecutionResult>}
 */
export function executePreparedPlanSegmentHandoff(options) {
    return /** @type {Promise<PlanExecutionResult>} */ (executePreparedPlanSegmentHandoffImpl(options));
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function normalizeExecutionTargetBranch(value) {
    return normalizeExecutionTargetBranchImpl(value);
}

/**
 * @param {string | undefined} reusableBaseBranch
 * @param {string | undefined} targetBranch
 */
export function assertReusableWorktreeTargetMatches(reusableBaseBranch, targetBranch) {
    return assertReusableWorktreeTargetMatchesImpl(reusableBaseBranch, targetBranch);
}

/**
 * @param {*} options
 * @returns {Promise<import('../session/hosted-session.js').ActiveExecutionWorkflow>}
 */
export function startActiveExecutionWorkflow(options) {
    return /** @type {Promise<import('../session/hosted-session.js').ActiveExecutionWorkflow>} */ (startActiveExecutionWorkflowImpl(
        {
            ...options,
            cwd: options.cwd ?? options.hostedSession?.cwd,
            existingExecution: options.existingExecution ?? options.hostedSession?.getActiveExecutionWorkflow?.(),
        },
    ));
}
