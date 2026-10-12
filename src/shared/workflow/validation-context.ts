/**
 * @module shared/workflow/validation-context
 * Phase-context resolution and shared lifecycle/metric helpers for the
 * session-independent engine.
 *
 * `resolvePhaseContext` turns a loop call into the concrete execution facts a phase
 * runs against; the front-matter readers and the lifecycle recorder are the engine's
 * read/write surface onto the durable Plan.
 */

import { extractYaml } from "../front-matter.ts";
import { AGENTS } from "../../constants.js";
import { recordWorkflowMetric } from "./metrics.js";
import { recordPlanEvent } from "./plan-lifecycle.js";
import { resolveValidationExecutionContext } from "./execution-context.ts";
import { normalizeLedger } from "./review-ledger.ts";
import type { ValidationPhaseName } from "./validation-ports.ts";
import type {
    HumanReviewMetadata,
    PhaseContext,
    PlanEvent,
    PlanEventStatus,
    PlanFrontMatter,
    RecordPlanEventArgs,
    RecordPlanEventResult,
    SemanticRoundState,
    ValidationLoopArgs,
    ValidationPhaseResult,
} from "./validation-types.ts";
import type { ValidationWorkflowState } from "./validation-ports.ts";
import { emitHalted } from "./validation-emit.ts";
import { buildValidationUserMessage } from "./validation-user-messages.ts";
import { readValidationReviewState } from "./validation-checkpoint.ts";

export async function resolvePhaseContext(
    args: ValidationLoopArgs,
): Promise<{ kind: "ok"; context: PhaseContext } | { kind: "blocked"; result: ValidationPhaseResult }> {
    const projectRoot = getProjectRoot(args);
    const activeWorkflow = args.session.getActiveWorkflow();
    const resolution = await resolveValidationExecutionContext({
        projectRoot,
        planName: args.planName,
        triageMeta: args.triageMeta,
        explicitContext: args.executionContext,
        activeWorkflow,
    });
    if (resolution.kind === "blocked") {
        // Say it out loud. This path used to record the failure and return, emitting
        // nothing: the workflow ended mid-run with no message, which is the exact
        // shape of a strand — the user watches an Agent finish and then nothing
        // happens, ever.
        emitHalted(
            args,
            buildValidationUserMessage({ kind: "context_blocked", planName: args.planName }),
            resolution.message,
        );
        await recordLifecycleEvent(
            args,
            projectRoot,
            "validation_failed",
            args.triageMeta.status as PlanEventStatus,
            resolution.message,
        );
        return {
            kind: "blocked",
            result: { kind: "failed", planName: args.planName, projectRoot, reason: resolution.message },
        };
    }
    const context = resolution.context;
    const policyAgent = activeWorkflow?.executionAgent || args.executionContext?.executionAgent || AGENTS.ENGINEER;
    const executionAgent = policyAgent === AGENTS.FRONTEND_ENGINEER ? "frontend-engineer" : "engineer";
    const workflowBase: ValidationWorkflowState = {
        ...(activeWorkflow || {}),
        planName: args.planName,
        triageMeta: args.triageMeta,
        executionAgent,
        ...(activeWorkflow?.projectRoot || context.projectRoot !== args.session.cwd
            ? { projectRoot: context.projectRoot }
            : {}),
        executionCwd: context.executionCwd,
        validationContinuation: true,
        ...(context.executionMode === "worktree"
            ? {
                executionMode: "worktree",
                baselineTree: context.baselineTree,
                worktreeId: context.worktreeId,
                worktreeBranch: context.worktreeBranch,
                ...(context.worktreeBaseBranch ? { worktreeBaseBranch: context.worktreeBaseBranch } : {}),
            }
            : { executionMode: "non_git_in_place", nonGitInPlace: true }),
    };
    return {
        kind: "ok",
        context: {
            args,
            projectRoot: context.projectRoot,
            executionContext: context,
            baselineTree: context.executionMode === "worktree" ? context.baselineTree : undefined,
            executionCwd: context.executionCwd,
            executionAgent,
            worktreeId: context.executionMode === "worktree" ? context.worktreeId : undefined,
            worktreeBranch: context.executionMode === "worktree" ? context.worktreeBranch : undefined,
            worktreeBaseBranch: context.executionMode === "worktree" ? context.worktreeBaseBranch : undefined,
            nonGitInPlace: context.executionMode === "non_git_in_place",
            workflowBase,
        },
    };
}

export function getProjectRoot(args: ValidationLoopArgs): string {
    const activeWorkflow = args.session.getActiveWorkflow();
    const projectRoot = activeWorkflow?.projectRoot || args.executionContext?.projectRoot || args.session.cwd;
    if (!projectRoot) throw new Error("runValidationLoop: hostedSession or active workflow projectRoot is required");
    return projectRoot;
}

export async function recordMetric(
    _args: ValidationLoopArgs,
    cwd: string,
    metric: Parameters<typeof recordWorkflowMetric>[0],
): Promise<void> {
    await recordWorkflowMetric(metric, cwd);
}

export function readCiAttempts(meta: Partial<PlanFrontMatter>): number {
    return typeof meta.validationCiAttempts === "number" && meta.validationCiAttempts > 0
        ? meta.validationCiAttempts
        : 0;
}

export function readSemanticRound(meta: Partial<PlanFrontMatter>): number {
    return typeof meta.validationSemanticRounds === "number" && meta.validationSemanticRounds > 0
        ? meta.validationSemanticRounds
        : 0;
}

export function readSemanticRoundState(args: ValidationLoopArgs, context: PhaseContext): SemanticRoundState {
    const activeWorkflow = context.workflowBase;
    const durableReview = readValidationReviewState(
        args.validationCheckpoint || args.triageMeta.validationCheckpoint,
    );
    if (durableReview) {
        return {
            semanticRound: durableReview.semanticRound,
            reviewLedger: durableReview.reviewLedger,
            repairBaselineTree: durableReview.repairBaselineTree,
            lastRepairReport: durableReview.lastRepairReport || "",
        };
    }
    return {
        semanticRound: readSemanticRound(args.triageMeta),
        reviewLedger: normalizeLedger(activeWorkflow.reviewLedger),
        repairBaselineTree: typeof activeWorkflow.repairBaselineTree === "string"
            ? activeWorkflow.repairBaselineTree
            : "",
        lastRepairReport: typeof activeWorkflow.lastRepairReport === "string" ? activeWorkflow.lastRepairReport : "",
    };
}

export function hasFinalHumanReviewDecision(meta: Partial<PlanFrontMatter>): boolean {
    return meta.humanReviewDecision === "approved" || meta.humanReviewDecision === "skipped" ||
        meta.humanReviewDecision === "not_required";
}

export function preserveValidationContinuationState(args: ValidationLoopArgs, context: PhaseContext): void {
    // Resolving a phase temporarily clears the active workflow while it verifies
    // the execution context. A successful boundary is still the same execution:
    // semantic review needs its Plan/worktree identity even when this is the first
    // pass and there is no repair ledger yet. Restoring only workflows that happened
    // to carry repair metadata stranded ordinary CI -> review transitions at the
    // session cwd with no active owner.
    args.session.setActiveWorkflow({ ...context.workflowBase });
}

export function readHumanReviewMetadata(meta: Partial<PlanFrontMatter>): HumanReviewMetadata {
    return {
        humanReviewMode: meta.humanReviewMode || "none",
        humanReviewDecision: meta.humanReviewDecision || "not_required",
        humanReviewedAt: typeof meta.humanReviewedAt === "string" ? meta.humanReviewedAt : null,
    };
}

export async function recordLifecycleEvent(
    args: ValidationLoopArgs,
    projectRoot: string,
    event: PlanEvent,
    currentStatus: PlanEventStatus,
    failureReason?: string,
    extraDetails: Partial<RecordPlanEventArgs["details"]> = {},
): Promise<RecordPlanEventResult> {
    const activeWorkflow = args.session.getActiveWorkflow();
    const lifecycleCwd = activeWorkflow?.executionMode === "worktree" && activeWorkflow.executionCwd
        ? activeWorkflow.executionCwd
        : args.executionContext?.executionMode === "worktree" && args.executionContext.executionCwd
        ? args.executionContext.executionCwd
        : projectRoot;
    const result = await recordPlanEvent({
        cwd: lifecycleCwd,
        planName: args.planName,
        event,
        currentStatus,
        details: { triageMeta: args.triageMeta, failureReason, ...extraDetails },
    });
    return result;
}

/**
 * The phase that owns the status a lifecycle event moves a Plan to.
 *
 * Returns nothing for events that do not resolve to a validation phase — the
 * terminal ones, whose position is cleared rather than moved.
 */
export function phaseForRecordedStatus(event: PlanEvent): ValidationPhaseName | undefined {
    switch (event) {
        case "mechanical_validation_passed":
            return "semantic";
        case "semantic_review_passed":
            return "delivery";
        case "mechanical_validation_failed":
        case "semantic_review_feedback":
        case "validation_failed":
            return "mechanical";
        default:
            return undefined;
    }
}

export function getPlanAttrs(planContent: string): Partial<PlanFrontMatter> {
    try {
        const parsed = extractYaml(planContent) as { attrs?: Partial<PlanFrontMatter> };
        return parsed.attrs || {};
    } catch {
        return {};
    }
}
