/**
 * @module shared/workflow/validation-engine
 * The session-independent Workflow Validation engine: the phase loop, the
 * phase-selection gates, and the canonical Plan loader.
 *
 * The engine decides *what* validation does. It never touches Pi/session machinery
 * directly: everything session-shaped arrives through the
 * {@link ValidationSessionPort} argument, which SessionRuntime's `validation.ts`
 * builds from a HostedSession and the Attached coordinator will implement from its
 * own record. Plan Lifecycle, transitions, registry writes and locks stay direct
 * imports — they are RunWield's own machinery, never ports.
 */

import { canonicalPlanStatus, getDeclaredPlanStatus, loadPlan, PlanFrontMatterParseError } from "../../plan-store.js";
import { VALIDATION_PLAN_STATUSES } from "./plan-lifecycle.js";
import { getProjectRoot } from "./validation-context.ts";
import { emitStatus } from "./validation-emit.ts";
import { validationPhaseForStatus } from "./validation-checkpoint.ts";
import { validationPhasePauseMessage, validationUserMessage } from "./validation-user-messages.ts";
import { runMechanicalValidationPhase } from "./validation-mechanical.ts";
import { runSemanticReviewPhase, runValidatedReviewerPhase } from "./validation-semantic.ts";
import type { ValidationPhaseName } from "./validation-ports.ts";
import { classifyValidationOperationalError } from "./validation-operational-errors.ts";
import { decideValidationRecovery, readValidationRetryPolicy } from "./validation-recovery.ts";
import type { ValidationLoopArgs, ValidationPhaseResult, WorkflowValidationResult } from "./validation-types.ts";
import { MAX_PHASES_PER_CALL, PHASE_STATUS, VALIDATION_STATUS_ORDER } from "./validation-types.ts";
import { preparePublicationRevalidation, PUBLICATION_REVALIDATION_MESSAGE } from "./publication-revalidation.ts";

type PlanStatus = "implemented" | "validated_ci" | "reviewed" | "validated";
type PlanFrontMatter = import("../../plan-store.js").PlanFrontMatter;

/**
 * One phase for the Plan's current status. Reads canonical state; holds none.
 *
 * Exported for tests that assert a single phase boundary. Production callers use
 * {@link runValidationLoop}, which drives phases until the Plan stops moving.
 */
export async function runValidationPhase(args: ValidationLoopArgs): Promise<ValidationPhaseResult> {
    const recoveryPath = await preparePublicationRevalidation(getProjectRoot(args), args.planName);
    const canonicalPlan = await loadCanonicalValidationPlan(args);
    if (canonicalPlan.kind === "blocked") return canonicalPlan.result;
    const canonicalArgs: ValidationLoopArgs = {
        ...args,
        triageMeta: canonicalPlan.attrs as ValidationLoopArgs["triageMeta"],
        planContent: canonicalPlan.markdown,
        validationCheckpoint: canonicalPlan.attrs.validationCheckpoint || undefined,
        ...(recoveryPath ? { continuationPhase: undefined } : {}),
    };
    if (recoveryPath) {
        const workflow = args.session.getActiveWorkflow();
        if (workflow) {
            args.session.setActiveWorkflow({
                ...workflow,
                triageMeta: canonicalArgs.triageMeta,
                semanticRound: undefined,
                reviewLedger: undefined,
                repairBaselineTree: undefined,
                lastRepairReport: undefined,
                validationRepairGeneration: undefined,
                humanReviewCycle: undefined,
            });
        }
        emitStatus(args, PUBLICATION_REVALIDATION_MESSAGE);
    }
    const nextPhase = resolveNextPhase(canonicalArgs, canonicalPlan.status);
    switch (nextPhase) {
        case "mechanical":
            return await runMechanicalValidationPhase(canonicalArgs);
        case "semantic":
            return await runSemanticReviewPhase(canonicalArgs);
        case "delivery":
            return await runValidatedReviewerPhase(canonicalArgs);
    }
}

/**
 * Which phase runs next: the durable supervisor claim, or the canonical Plan.
 *
 * Session memory is not an authority. A new process or Session receives the same
 * phase from the Plan's validation checkpoint.
 *
 * The claim can only carry validation forward. A checkpoint that never settled still
 * names the phase it was running, while the Plan already records that the phase's
 * checks passed — the lifecycle event is the durable proof of that, and honouring the
 * older claim would mean undoing a status the Plan legitimately holds. Canonical
 * status wins there.
 */
function resolveNextPhase(
    args: ValidationLoopArgs,
    status: "implemented" | "validated_ci" | "reviewed" | "validated",
): ValidationPhaseName {
    const fromStatus: ValidationPhaseName = status === "validated"
        ? "delivery"
        : validationPhaseForStatus(status, args.triageMeta.validationPhase) || "mechanical";
    const claimed = args.continuationPhase;
    if (!claimed) return fromStatus;
    const claimedIndex = VALIDATION_STATUS_ORDER.indexOf(PHASE_STATUS[claimed]);
    return claimedIndex < VALIDATION_STATUS_ORDER.indexOf(PHASE_STATUS[fromStatus]) ? fromStatus : claimed;
}

/**
 * Run validation until it needs something it cannot supply.
 *
 * Each phase returns an explicit continuation or pause. Status determines where
 * a fresh invocation starts; a status write by itself never keeps this loop going.
 *
 * A completed check, accepted tool call, or explicit user decision authorizes
 * the next phase. Document revisions and presentation text never do.
 */
export async function runValidationLoop(args: ValidationLoopArgs): Promise<WorkflowValidationResult> {
    const projectRoot = getProjectRoot(args);
    let result: ValidationPhaseResult | undefined;
    let phaseArgs: ValidationLoopArgs = { ...args, codeReviewConversation: { history: [] } };
    for (let phase = 0; phase < MAX_PHASES_PER_CALL; phase += 1) {
        result = await runValidationPhase(phaseArgs);
        if (result.kind !== "paused") {
            // Verified/failed finish; a semantic repair handoff pauses outside this activated operation.
            if (result.kind !== "semantic_repair_handoff") args.session.clearPosition(args.planName);
            return result;
        }
        // A mechanical repair turn is not a completion signal. The repair Agent
        // must explicitly call task_completed before this invocation may run CI
        // again; otherwise a question or ordinary text response could advance the
        // Plan merely because failure-attempt bookkeeping changed Front Matter.
        if (result.awaitingTaskCompletion) return result;
        if (result.awaitingUserAction) return result;
        if (!result.continueValidation) return result;
        // The caller's execution context described the world before validation began.
        // It is worth checking against once — a caller pointing at the wrong worktree
        // must not be humoured — but every phase after the first runs in the workflow
        // validation itself established, and a repair legitimately rebuilds that. Held
        // any longer, the snapshot goes stale and its contradiction check ends the run:
        // a semantic repair would land, round two would never open, and the workflow
        // stopped without a word.
        phaseArgs = { ...phaseArgs, executionContext: undefined, continuationPhase: undefined };
    }
    const plan = await loadPlan(validationPlanCwd(phaseArgs, projectRoot), args.planName);
    const phase = validationPhaseForStatus(plan?.attrs.status, plan?.attrs.validationPhase);
    emitStatus(args, validationUserMessage("retry_pause"), "warning");
    return {
        kind: "paused",
        planName: args.planName,
        projectRoot,
        classification: plan?.attrs.classification,
        reason: validationPhasePauseMessage(phase || undefined),
    };
}

function canonicalOperationalResult(
    args: ValidationLoopArgs,
    projectRoot: string,
    source: Parameters<typeof classifyValidationOperationalError>[0],
): ValidationPhaseResult {
    const failure = classifyValidationOperationalError(source);
    const decision = decideValidationRecovery({
        failure,
        attempt: 1,
        policy: readValidationRetryPolicy(projectRoot),
        nextPhase: validationPhaseForStatus(args.triageMeta.status, args.triageMeta.validationPhase) || undefined,
    });
    return {
        kind: decision.action === "halt" ? "failed" : "paused",
        planName: args.planName,
        projectRoot,
        reason: decision.result.message,
        recovery: decision.result,
    };
}

export async function loadCanonicalValidationPlan(
    args: ValidationLoopArgs,
): Promise<
    | {
        kind: "ok";
        status: "implemented" | "validated_ci" | "reviewed" | "validated";
        attrs: PlanFrontMatter;
        markdown: string;
    }
    | { kind: "blocked"; result: ValidationPhaseResult }
> {
    const projectRoot = getProjectRoot(args);
    let plan;
    try {
        plan = await loadPlan(validationPlanCwd(args, projectRoot), args.planName);
    } catch (error) {
        if (!(error instanceof PlanFrontMatterParseError)) throw error;
        return {
            kind: "blocked",
            result: canonicalOperationalResult(args, projectRoot, {
                source: "policy",
                kind: "lifecycle_invariant",
                operation: "validation_state",
                message: error.message,
            }),
        };
    }
    if (!plan) {
        return {
            kind: "blocked",
            result: canonicalOperationalResult(args, projectRoot, {
                source: "validation_state",
                kind: "plan_missing",
                operation: "validation_state",
                message: `Plan not found: ${args.planName}`,
            }),
        };
    }
    const rawStatus = getPlanContentStatus(plan.markdown);
    if (rawStatus !== undefined && !canonicalPlanStatus(rawStatus)) {
        return {
            kind: "blocked",
            result: canonicalOperationalResult(args, projectRoot, {
                source: "validation_state",
                kind: "unknown_plan_status",
                operation: "validation_state",
                message: `Plan has unknown status: ${rawStatus}`,
            }),
        };
    }
    const status = plan.attrs.status;
    if (!VALIDATION_PLAN_STATUSES.includes(status as PlanStatus)) {
        return {
            kind: "blocked",
            result: canonicalOperationalResult(args, projectRoot, {
                source: "policy",
                kind: "lifecycle_invariant",
                operation: "validation_state",
                message: `Workflow Validation cannot run from Plan status "${status}".`,
            }),
        };
    }
    return {
        kind: "ok",
        status: status as "implemented" | "validated_ci" | "reviewed" | "validated",
        attrs: plan.attrs,
        markdown: plan.markdown,
    };
}

function validationPlanCwd(args: ValidationLoopArgs, projectRoot: string): string {
    const activeWorkflow = args.session.getActiveWorkflow();
    if (activeWorkflow?.executionMode === "worktree" && activeWorkflow.executionCwd) {
        return activeWorkflow.executionCwd;
    }
    if (args.executionContext?.executionMode === "worktree" && args.executionContext.executionCwd) {
        return args.executionContext.executionCwd;
    }
    return projectRoot;
}

export function getPlanContentStatus(planContent: string): string | undefined {
    return getDeclaredPlanStatus(planContent);
}
