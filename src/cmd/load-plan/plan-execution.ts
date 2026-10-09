/**
 * @module cmd/load-plan/plan-execution
 * Driving a Plan from approved through execution to validation.
 *
 * The Readiness Gate, the post-execution checkpoint, and the repair loop that
 * sits between them. Lifecycle writes go through `recordPlanEvent`; this module
 * decides *when* they happen, never how they are persisted.
 */

import { AGENTS, isPlannedChangeClassification } from "../../constants.js";
import { loadPlan, resolvePlanExecutionPolicy } from "../../plan-store.js";
import { isGitRepositoryRequiredError } from "../../shared/git.ts";
import { isProjectPlan, recordPlanEvent } from "../../shared/workflow/plan-lifecycle.js";
import { decidePostExecution } from "../../shared/workflow/decisions.ts";
import { finalizePlanImplementation } from "../../shared/workflow/workflow.js";
import { listCommitsTouchingPathsSince } from "../../shared/workflow/git-snapshot.ts";
import {
    type ExecutionContextCandidate,
    type ResolvedValidationContext,
    resolveValidationExecutionContext,
} from "../../shared/workflow/execution-context.ts";
import { formatCommitHeadsUp } from "./plan-presentation.ts";
import { reportInvalidRecoveryPolicy } from "./plan-recovery-worktree.ts";
import {
    buildValidationRecoveryNotice,
    buildValidationUserMessage,
} from "../../shared/workflow/validation-user-messages.ts";
import type { PlanFrontMatter } from "../../plan-store.js";
import type { UiAPI } from "../../ui/tui/types.js";
import type { PlanSessionSurface, RecoveryWorktreeContext, ReviewImage } from "./plan-session-types.ts";
import type { WorkflowDecision } from "../../shared/workflow/decisions.ts";
import type { WorkflowValidationResult } from "../../shared/workflow/validation-types.ts";

export type ValidationStartResult = false | WorkflowValidationResult | true;

/** The execution workflow the session is told about when execution starts. */
export interface ExecutionWorkflowState {
    planName: string;
    triageMeta: PlanFrontMatter;
    executionAgent: "engineer" | "frontend-engineer";
    projectRoot: string;
    executionStarted: boolean;
    executionMode?: "worktree" | "non_git_in_place";
    executionCwd?: string;
    baselineTree?: string;
    worktreeId?: string;
    worktreeBranch?: string;
    worktreeBaseBranch?: string;
    worktreeBaseRef?: string;
    worktreeBaseCommit?: string;
    nonGitInPlace?: boolean;
}

/** A Plan loaded far enough to execute. */
export interface ExecutablePlan {
    planName: string;
    body: string;
    markdown?: string;
    attrs: PlanFrontMatter;
}

export interface ConfirmAffectedPathChangesOptions {
    projectRoot: string;
    planName: string;
    triageMeta: Partial<PlanFrontMatter>;
    uiAPI: UiAPI;
}

export interface ValidatePostExecutionDecisionOptions {
    executionDecision: WorkflowDecision;
    executionResult: unknown;
    fallbackPlanContent: string;
    continueWorkflowValidation: PlanSessionSurface["runValidation"];
    session: PlanSessionSurface;
    uiAPI?: UiAPI;
}

export interface ExecutePostPlanningDecisionOptions {
    decision: WorkflowDecision;
    fallbackPlanContent: string;
    uiAPI: UiAPI;
    executePlan: PlanSessionSurface["executePlan"];
    continueWorkflowValidation: PlanSessionSurface["runValidation"];
    runSlicerAgent: PlanSessionSurface["runSlicerAgent"];
    session: PlanSessionSurface;
}

export interface ExecuteReadyPlanOptions {
    projectRoot: string;
    plan: ExecutablePlan;
    agentName: string;
    uiAPI: UiAPI;
    executePlan: PlanSessionSurface["executePlan"];
    continueWorkflowValidation: PlanSessionSurface["runValidation"];
    session: PlanSessionSurface;
    affectedPathsAlreadyConfirmed?: boolean;
}

/**
 * Warn when affected paths have changed after the plan timestamp, and confirm
 * before execution starts.
 *
 * @param {Object} opts
 * @param {string} opts.projectRoot
 * @param {string} opts.planName
 * @param {Partial<import('../../plan-store.js').PlanFrontMatter>} opts.triageMeta
 * @param {import('../../ui/tui/types.js').UiAPI} opts.uiAPI
 * @returns {Promise<boolean>}
 */
export async function confirmAffectedPathChangesBeforeExecution({
    projectRoot,
    planName,
    triageMeta,
    uiAPI,
}: ConfirmAffectedPathChangesOptions): Promise<boolean> {
    const affectedPaths = Array.isArray(triageMeta.affectedPaths) ? triageMeta.affectedPaths : [];
    const timestamp = triageMeta.updatedAt || triageMeta.createdAt;
    if (!timestamp || affectedPaths.length === 0) return true;

    let commits = [];
    try {
        commits = await listCommitsTouchingPathsSince(projectRoot, timestamp, affectedPaths);
    } catch (error) {
        if (isGitRepositoryRequiredError(error)) {
            uiAPI.appendSystemMessage(
                "Skipping affected path history check because this project is not a Git repository.",
                false,
                "RunWield",
            );
            return true;
        }
        const message = error instanceof Error ? error.message : String(error);
        uiAPI.appendSystemMessage(
            `Could not check affected path history before execution: ${message}`,
            true,
            "RunWield",
        );
        return true;
    }

    if (commits.length === 0) return true;

    const timestampLabel = triageMeta.updatedAt ? "updatedAt" : "createdAt";
    uiAPI.appendSystemMessage(
        [
            `Heads up: ${commits.length} commit(s) touched affected paths since this plan's ${timestampLabel} (${timestamp}).`,
            "",
            "Affected paths:",
            ...affectedPaths.map((path) => `  - ${path}`),
            "",
            "Commits:",
            ...formatCommitHeadsUp(commits),
        ].join("\n"),
        true,
        "RunWield",
    );

    const answer = await uiAPI.promptSelect(`Proceed with execution for "${planName}" anyway?`, [
        { value: "proceed", label: "Proceed with execution" },
        { value: "cancel", label: "Cancel" },
    ]);
    if (answer === "proceed") return true;
    uiAPI.appendSystemMessage("Execution canceled.", false, "RunWield");
    return false;
}

/**
 * @param {unknown} executionResult
 * @param {string} planName
 * @param {string} fallbackPlanContent
 * @param {import('../../plan-store.js').PlanFrontMatter} triageMeta
 * @param {PlanSessionSurface["runValidation"]} continueWorkflowValidation
 * @param {RecoveryWorktreeContext | null} worktreeContext
 * @param {PlanSessionSurface} session
 * @param {import('../../ui/tui/types.js').UiAPI} [uiAPI]
 * @returns {Promise<ValidationStartResult>}
 */
export async function validateCompletedExecution(
    executionResult: unknown,
    planName: string,
    fallbackPlanContent: string,
    triageMeta: PlanFrontMatter,
    continueWorkflowValidation: PlanSessionSurface["runValidation"],
    worktreeContext: RecoveryWorktreeContext | null,
    session: PlanSessionSurface,
    uiAPI?: UiAPI,
): Promise<ValidationStartResult> {
    const projectRoot = session.cwd;
    if (!(executionResult && typeof executionResult === "object" && "executionComplete" in executionResult)) {
        return false;
    }
    if (!/** @type {{ executionComplete?: boolean }} */ (executionResult).executionComplete) return false;
    const returnedExecutionContext = (executionResult as { executionContext?: ExecutionContextCandidate })
        .executionContext;
    const returnedExecutionCwd = returnedExecutionContext?.executionCwd;
    const authorityRoot = typeof returnedExecutionCwd === "string" && returnedExecutionCwd
        ? returnedExecutionCwd
        : worktreeContext?.path ||
            (triageMeta.executionMode === "worktree" && triageMeta.worktreePath
                ? triageMeta.worktreePath
                : projectRoot);
    let planContent = fallbackPlanContent;
    let effectiveMeta = triageMeta;
    let latestPlan = null;
    try {
        latestPlan = await loadPlan(authorityRoot, planName);
        planContent = latestPlan?.markdown || latestPlan?.body || fallbackPlanContent;
        if (latestPlan?.attrs) effectiveMeta = latestPlan.attrs;
    } catch {
        // Keep fallback content in tests or if the plan was removed.
    }
    const policy = resolvePlanExecutionPolicy(effectiveMeta);
    if (!policy.ok) {
        if (uiAPI) {
            reportInvalidRecoveryPolicy("validate", planName, policy.error, uiAPI);
            return false;
        }
        throw new Error(policy.error);
    }
    const explicitContext = returnedExecutionContext || {
        planName,
        triageMeta: effectiveMeta,
        executionMode: effectiveMeta.executionMode,
        baselineTree: effectiveMeta.executionBaselineTree || worktreeContext?.executionBaselineTree ||
            worktreeContext?.baseTree || worktreeContext?.baseCommit,
        worktreeId: worktreeContext?.id || effectiveMeta.worktreeId,
        worktreeBranch: worktreeContext?.branch || effectiveMeta.worktreeBranch,
        worktreeBaseBranch: worktreeContext?.baseBranch || effectiveMeta.worktreeBaseBranch,
        worktreeBaseRef: worktreeContext?.baseRef,
        worktreeBaseCommit: worktreeContext?.baseCommit,
        executionCwd: worktreeContext?.path || effectiveMeta.worktreePath,
        nonGitInPlace: effectiveMeta.executionMode === "non_git_in_place",
    };
    const buildWorkflow = (context: ExecutionContextCandidate | ResolvedValidationContext): ExecutionWorkflowState => {
        const workflow: ExecutionWorkflowState = {
            planName,
            triageMeta: effectiveMeta,
            executionAgent: policy.policy.executionAgent as "engineer" | "frontend-engineer",
            executionMode: context.executionMode as ExecutionWorkflowState["executionMode"],
            projectRoot,
            executionCwd: typeof context.executionCwd === "string" ? context.executionCwd : undefined,
            executionStarted: true,
        };
        if (context.executionMode === "non_git_in_place") workflow.nonGitInPlace = true;
        if (context.executionMode === "worktree") {
            workflow.baselineTree = typeof context.baselineTree === "string" ? context.baselineTree : undefined;
            workflow.worktreeId = typeof context.worktreeId === "string" ? context.worktreeId : undefined;
            workflow.worktreeBranch = typeof context.worktreeBranch === "string" ? context.worktreeBranch : undefined;
            workflow.worktreeBaseBranch = typeof context.worktreeBaseBranch === "string"
                ? context.worktreeBaseBranch
                : undefined;
            workflow.worktreeBaseRef = typeof context.worktreeBaseRef === "string"
                ? context.worktreeBaseRef
                : undefined;
            workflow.worktreeBaseCommit = typeof context.worktreeBaseCommit === "string"
                ? context.worktreeBaseCommit
                : undefined;
        }
        return workflow;
    };
    const initialWorkflow = buildWorkflow(explicitContext);
    const needsImplementationCheckpoint = isPlannedChangeClassification(effectiveMeta.classification) &&
        effectiveMeta.status !== "implemented" &&
        effectiveMeta.status !== "validated" && effectiveMeta.status !== "verified" &&
        effectiveMeta.status !== "user_verified";
    if (needsImplementationCheckpoint) {
        const completionReport = (executionResult as { completionReport?: unknown }).completionReport;
        // The Session is claimed only once validation work actually starts;
        // every blocked check above returns without renaming anything. The
        // operation is one-shot, so callers that already continued work (and
        // activated then) pay nothing here.
        await session.activateForPlan(planName);
        await session.setActiveExecutionWorkflow(initialWorkflow);
        try {
            await finalizePlanImplementation({
                projectRoot,
                planName,
                triageMeta: effectiveMeta,
                executionContext: initialWorkflow,
                executionReport: typeof completionReport === "string" ? completionReport : undefined,
            });
        } catch (error) {
            console.error("[RunWield] implementation_checkpoint_failed", error);
            if (uiAPI) {
                uiAPI.appendSystemMessage(
                    buildValidationUserMessage({ kind: "implementation_checkpoint_failed" }),
                    true,
                    "RunWield",
                );
                return false;
            }
            throw error;
        }
        try {
            latestPlan = await loadPlan(authorityRoot, planName);
            planContent = latestPlan?.markdown || latestPlan?.body || fallbackPlanContent;
            if (latestPlan?.attrs) effectiveMeta = latestPlan.attrs;
        } catch {
            // Keep the pre-checkpoint content/metadata in tests or if the Plan was removed.
        }
    }
    const resolution = await resolveValidationExecutionContext({
        projectRoot,
        planName,
        triageMeta: effectiveMeta,
        explicitContext,
    });
    if (resolution.kind === "blocked") {
        if (uiAPI) {
            uiAPI.appendSystemMessage(`Validation blocked: ${resolution.message}`, false, "RunWield");
            return false;
        }
        throw new Error(resolution.message);
    }
    if (resolution.restoredPlanFile && uiAPI) {
        uiAPI.appendSystemMessage(
            `Restored missing execution worktree Plan file from the canonical Project Plan: ${resolution.restoredPlanFile.relativePath}. Continuing Workflow Validation.`,
            false,
            "RunWield",
        );
    }
    for (const notice of resolution.selfHealNotices || []) {
        if (uiAPI) uiAPI.appendSystemMessage(buildValidationRecoveryNotice(notice), false, "RunWield");
    }
    const resolvedContext = resolution.context;
    const workflow = buildWorkflow(resolvedContext);
    // Same claim point as the checkpoint branch: only once the blocked checks
    // are behind us and the Workflow Validation run begins.
    await session.activateForPlan(planName);
    await session.setActiveExecutionWorkflow(workflow);
    const validationResult = await continueWorkflowValidation({
        planName,
        planContent,
        triageMeta: effectiveMeta,
        executionContext: workflow,
    });
    return validationResult || true;
}

/**
 * @param {Object} opts
 * @param {import('../../shared/workflow/decisions.ts').WorkflowDecision} opts.executionDecision
 * @param {unknown} opts.executionResult
 * @param {string} opts.fallbackPlanContent
 * @param {PlanSessionSurface["runValidation"]} opts.continueWorkflowValidation
 * @param {PlanSessionSurface} opts.session
 * @param {import('../../ui/tui/types.js').UiAPI} [opts.uiAPI]
 * @returns {Promise<ValidationStartResult>}
 */
export async function validatePostExecutionDecision({
    executionDecision,
    executionResult,
    fallbackPlanContent,
    continueWorkflowValidation,
    session,
    uiAPI,
}: ValidatePostExecutionDecisionOptions): Promise<ValidationStartResult> {
    if (executionDecision.kind !== "run_validation") return false;

    const planName = executionDecision.payload.planName as string;
    const triageMeta = executionDecision.payload.triageMeta as PlanFrontMatter;

    return await validateCompletedExecution(
        executionResult,
        planName,
        fallbackPlanContent,
        triageMeta,
        continueWorkflowValidation,
        null,
        session,
        uiAPI,
    );
}

/**
 * Execute an approved post-planning decision and run validation when execution
 * completes. Returns true when the decision was handled as execution.
 *
 * @param {Object} opts
 * @param {import('../../shared/workflow/decisions.ts').WorkflowDecision} opts.decision
 * @param {string} opts.fallbackPlanContent
 * @param {import('../../ui/tui/types.js').UiAPI} opts.uiAPI
 * @param {PlanSessionSurface["executePlan"]} opts.executePlan
 * @param {PlanSessionSurface["runValidation"]} opts.continueWorkflowValidation
 * @param {PlanSessionSurface["runSlicerAgent"]} opts.runSlicerAgent
 * @param {PlanSessionSurface} opts.session
 * @returns {Promise<boolean | "verified">}
 */
export async function executePostPlanningDecision({
    decision,
    fallbackPlanContent,
    uiAPI,
    executePlan,
    continueWorkflowValidation,
    runSlicerAgent,
    session,
}: ExecutePostPlanningDecisionOptions): Promise<boolean | "verified"> {
    const projectRoot = session.cwd;
    if (decision.kind === "start_slicer") {
        await runSlicerAgent({
            planName: /** @type {string} */ (decision.payload.planName),
            triageMeta: /** @type {import('../../plan-store.js').PlanFrontMatter} */ (
                decision.payload.triageMeta
            ),
            reviewFeedback: /** @type {string | undefined} */ (decision.payload.reviewFeedback),
            reviewImages: /** @type {Array<{base64: string, mimeType: string}> | undefined} */ (
                decision.payload.reviewImages
            ),
        });
        return true;
    }
    if (decision.kind !== "execute_plan") return false;

    const planName = decision.payload.planName as string;
    const triageMeta = decision.payload.triageMeta as PlanFrontMatter;
    const confirmed = await confirmAffectedPathChangesBeforeExecution({
        projectRoot,
        planName,
        triageMeta,
        uiAPI,
    });
    if (!confirmed) return true;

    const execRes = await executePlan({
        planName,
        triageMeta,
        reviewFeedback: decision.payload.reviewFeedback as string | undefined,
        reviewImages: decision.payload.reviewImages as ReviewImage[] | undefined,
    });
    const policy = resolvePlanExecutionPolicy(triageMeta);
    const executionDecision = decidePostExecution(execRes, {
        planName,
        triageMeta,
        executionAgentName: policy.ok ? policy.policy.executionAgent : AGENTS.ENGINEER,
    });
    const validationResult = await validatePostExecutionDecision({
        executionDecision,
        executionResult: execRes,
        fallbackPlanContent,
        continueWorkflowValidation,
        session,
        uiAPI,
    });
    return validationResult && typeof validationResult === "object" && validationResult.kind === "verified"
        ? "verified"
        : true;
}

/**
 * @param {import('../../shared/workflow/decisions.ts').WorkflowDecision} decision
 * @returns {boolean}
 */
export function shouldKeepPlanningAgentActive(decision: WorkflowDecision): boolean {
    return decision.kind === "stay_with_agent" || decision.kind === "start_slicer" || decision.kind === "halt";
}

/**
 * @param {{ planName: string, attrs: import('../../plan-store.js').PlanFrontMatter }} plan
 * @param {import('../../ui/tui/types.js').UiAPI} uiAPI
 * @returns {boolean}
 */
export function validatePlanExecutionPolicyForReadiness(plan: { attrs: PlanFrontMatter }, uiAPI: UiAPI): boolean {
    const policy = resolvePlanExecutionPolicy(plan.attrs);
    if (!policy.ok && policy.reason !== "project_epic") {
        uiAPI.appendSystemMessage(`Plan policy invalid: ${policy.error}`, true, "RunWield");
        return false;
    }
    return true;
}

/**
 * Run the Readiness Gate for an approved Plan.
 *
 * @param {string} projectRoot
 * @param {{ planName: string, path: string, attrs: import('../../plan-store.js').PlanFrontMatter }} plan
 * @param {import('../../ui/tui/types.js').UiAPI} uiAPI
 * @returns {Promise<boolean>}
 */
export async function prepareApprovedPlanForWork(
    projectRoot: string,
    plan: { planName: string; path?: string; attrs: PlanFrontMatter },
    uiAPI: UiAPI,
): Promise<boolean> {
    if (!validatePlanExecutionPolicyForReadiness(plan, uiAPI)) return false;
    if (isProjectPlan(plan.attrs)) {
        await recordPlanEvent({
            cwd: projectRoot,
            planName: plan.planName,
            event: "epic_readiness_passed",
            currentStatus: "approved",
            details: { triageMeta: plan.attrs },
        });
        plan.attrs.status = "ready_for_decomposition";
        uiAPI.appendSystemMessage(
            `PROJECT Epic ready for decomposition or child plan selection: ${plan.planName}`,
            false,
            "RunWield",
        );
        return false;
    }

    await recordPlanEvent({
        cwd: projectRoot,
        planName: plan.planName,
        event: "readiness_passed",
        currentStatus: "approved",
        details: { triageMeta: plan.attrs },
    });
    plan.attrs.status = "ready_for_work";
    return true;
}

/**
 * Execute a ready Plan and run validation if execution completes.
 *
 * @param {Object} opts
 * @param {string} opts.projectRoot
 * @param {{ planName: string, markdown?: string, body: string, attrs: import('../../plan-store.js').PlanFrontMatter }} opts.plan
 * @param {string} opts.agentName
 * @param {import('../../ui/tui/types.js').UiAPI} opts.uiAPI
 * @param {PlanSessionSurface["executePlan"]} opts.executePlan
 * @param {PlanSessionSurface["runPlanningAgent"]} opts.runPlanningAgent
 * @param {PlanSessionSurface["runValidation"]} opts.continueWorkflowValidation
 * @param {PlanSessionSurface} opts.session
 * @param {boolean} [opts.affectedPathsAlreadyConfirmed]
 * @returns {Promise<ValidationStartResult>}
 */
export async function executeReadyPlanWithRepair({
    projectRoot,
    plan,
    agentName,
    executePlan,
    continueWorkflowValidation,
    session,
    uiAPI,
    affectedPathsAlreadyConfirmed = false,
}: ExecuteReadyPlanOptions): Promise<ValidationStartResult> {
    const confirmed = affectedPathsAlreadyConfirmed || await confirmAffectedPathChangesBeforeExecution({
        projectRoot,
        planName: plan.planName,
        triageMeta: plan.attrs,
        uiAPI,
    });
    if (!confirmed) return false;

    // The final execution confirmation is behind us. Claim the managed Session
    // name immediately before Agent execution starts.
    await session.activateForPlan(plan.planName);
    const execRes = await executePlan({
        planName: plan.planName,
        triageMeta: plan.attrs,
    });
    const policy = resolvePlanExecutionPolicy(plan.attrs);
    const executionOwner = policy.ok ? policy.policy.executionAgent : agentName;
    const executionDecision = decidePostExecution(execRes, {
        planName: plan.planName,
        triageMeta: /** @type {import('../../tools/plan-written.ts').TriageMeta} */ (plan.attrs),
        executionAgentName: executionOwner,
    });
    return await validatePostExecutionDecision({
        executionDecision,
        executionResult: execRes,
        fallbackPlanContent: plan.markdown || plan.body || "",
        continueWorkflowValidation,
        session,
        uiAPI,
    });
}
