/**
 * @module shared/workflow/validation
 * Workflow Validation public entry point.
 *
 * The validation sequencing, convergence policy and gate predicates live in the
 * session-independent engine (`validation-engine.ts` and the phase modules); this
 * file is the Core Session runtime's composition root. It builds the session port
 * over the real HostedSession machinery (`validation-session-adapter.ts`) and
 * delegates, keeping the pre-split argument shape so existing callers and tests
 * import unchanged.
 */

import * as engine from "./validation-engine.ts";
import { runValidationAttempt, type ValidationTrigger } from "./validation-supervisor.ts";
import { loadPlan } from "../../plan-store.js";
import { findActiveByPlanName as findWorktreeByPlanName } from "../worktree-registry.js";
import { resolveWorkflowPlanLocation } from "./plan-location.ts";
import { resolvePrimaryCheckoutRoot } from "../primary-checkout.ts";
import { emitProgress, emitStatus } from "./validation-emit.ts";
import { getCurrentValidationProgress } from "./validation-progress.ts";
import { validationUserMessage } from "./validation-user-messages.ts";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { createValidationSessionPort } from "./validation-session-adapter.ts";
import type { SemanticReviewPort } from "./validation-session-adapter.ts";
import { runMechanicalValidation as runQuickFixMechanicalValidation } from "./validation-helpers.ts";
import type { ValidationSessionPort } from "./validation-ports.ts";
import type { ValidationPhaseResult, WorkflowValidationResult } from "./validation-types.ts";
import type { ValidationLoopArgs as EngineValidationLoopArgs } from "./validation-types.ts";
import type { LocalCIPort } from "./validation-local-ci.ts";
import type { ValidationCheckpoint, ValidationCheckpointPhase } from "./validation-checkpoint.ts";

export {
    loadManualQaPrompt,
    loadReviewerFeedbackEngineerDef,
    loadReviewerPrompt,
    runLocalCI,
    runManualQaChecklistPrompt,
    shouldContinueParentEpicAfterValidation,
    shouldRunWorkflowValidation,
    unaccountedOpenItems,
} from "./validation-helpers.ts";

export { type SemanticReviewPort, SYSTEM_SEMANTIC_REVIEW_PORT } from "./validation-session-adapter.ts";

export type { ValidationPhaseResult, WorkflowValidationResult } from "./validation-types.ts";

type PlanFrontMatter = import("../../plan-store.js").PlanFrontMatter;
type TriageMeta = import("../../tools/plan-written.ts").TriageMeta & Partial<PlanFrontMatter>;
type ActiveExecutionWorkflow = import("../session/hosted-session.js").ActiveExecutionWorkflow;
type HostedSession = import("../session/hosted-session.js").HostedSession;
type GitPort = import("../git-port.ts").GitPort;
type WorkRecordMnemotecaPort = import("../work-records/mnemoteca-port.ts").WorkRecordMnemotecaPort;

/**
 * The public loop arguments, unchanged from before the split.
 *
 * `hostedSession` stays required; the port is built internally. `semanticReviewPort`
 * stays injectable at the external Agent boundary. Fixtures must invoke real
 * workflow tools; returned transcripts cannot complete a workflow step.
 */
export type ValidationLoopArgs = {
    planName: string;
    planContent: string;
    triageMeta: TriageMeta;
    sessionManager?: SessionManager;
    hostedSession: HostedSession;
    finalAgentName?: string;
    executionContext?: ActiveExecutionWorkflow;
    git: GitPort;
    semanticReviewPort?: SemanticReviewPort;
    localCI: LocalCIPort;
    workRecordMnemotecaPort: WorkRecordMnemotecaPort;
    supportsSemanticRepairHandoff?: boolean;
    /** Durable phase selected by the validation supervisor. */
    continuationPhase?: ValidationCheckpointPhase;
    /** Durable attempt record selected by the validation supervisor. */
    validationCheckpoint?: ValidationCheckpoint;
};

export type ContinueWorkflowValidationArgs = ValidationLoopArgs & {
    trigger?: ValidationTrigger;
    taskCompletionId?: string;
};

type MechanicalValidationArgs = {
    sessionManager?: SessionManager;
    hostedSession?: HostedSession;
    cwd?: string;
    manualQaName?: string;
    manualQaContext?: string;
};

export const runMechanicalValidation = runQuickFixMechanicalValidation as (
    args: MechanicalValidationArgs,
    localCI: LocalCIPort,
) => Promise<{ passed: boolean; attempts: number; reason?: string }>;

/**
 * One phase for the Plan's current status.
 *
 * The phase dispatch itself lives in the engine; this wrapper builds the session
 * port and hands the call over.
 */
export async function runValidationPhase(args: ValidationLoopArgs): Promise<ValidationPhaseResult> {
    return await engine.runValidationPhase(createEngineValidationArgs(args));
}

/**
 * Run validation until it needs something it cannot supply.
 *
 * The loop body lives in the engine; this wrapper builds the session port and hands
 * the call over.
 */
export async function runValidationLoop(args: ValidationLoopArgs): Promise<WorkflowValidationResult> {
    return await engine.runValidationLoop(createEngineValidationArgs(args));
}

/**
 * Build the engine's arguments from the public shape.
 *
 * The port is constructed over the real HostedSession; the CI port is rebound so
 * the engine passes only the working directory and the real session stays bound
 * here at the composition root.
 */
export function createEngineValidationArgs(args: ValidationLoopArgs): EngineValidationLoopArgs {
    const session: ValidationSessionPort = createValidationSessionPort(args.hostedSession, {
        semanticReviewPort: args.semanticReviewPort,
    });
    return {
        planName: args.planName,
        planContent: args.planContent,
        triageMeta: args.triageMeta,
        session,
        finalAgentName: args.finalAgentName,
        executionContext: args.executionContext,
        git: args.git,
        localCI: {
            run: ({ cwd }) =>
                args.localCI.run({ hostedSession: args.hostedSession, cwd, settingsPolicy: "exact-project" }),
        },
        workRecordMnemotecaPort: args.workRecordMnemotecaPort,
        supportsSemanticRepairHandoff: args.supportsSemanticRepairHandoff,
        continuationPhase: args.continuationPhase,
        validationCheckpoint: args.validationCheckpoint,
    };
}

function validationProjectRoot(args: ContinueWorkflowValidationArgs): string {
    return resolvePrimaryCheckoutRoot(args.executionContext?.projectRoot || args.hostedSession.cwd);
}

async function validationPlanCwd(args: ContinueWorkflowValidationArgs): Promise<string> {
    const projectRoot = validationProjectRoot(args);
    const attempt = await findWorktreeByPlanName(projectRoot, args.planName);
    if (attempt) return attempt.path;
    return (await resolveWorkflowPlanLocation(projectRoot, args.planName)).documentRoot;
}

function presentPausedProgress(args: ContinueWorkflowValidationArgs, result: WorkflowValidationResult): void {
    if (result.kind !== "paused" || result.continueValidation) return;
    const engine = createEngineValidationArgs(args);
    const current = engine.session.getCurrentProgress();
    const message = result.reason || validationUserMessage("retry_pause");
    if (!current) {
        emitStatus(engine, message, "warning");
        return;
    }
    if (current.outcome !== "running") return;
    emitProgress(engine, message, "warning", {
        outcome: "paused",
        stage: "terminal",
        message,
        checks: {
            ci: current.checks.ci === "running" ? "canceled" : current.checks.ci,
            semanticReview: current.checks.semanticReview === "running" ? "canceled" : current.checks.semanticReview,
            humanReview: current.checks.humanReview === "running" ? "canceled" : current.checks.humanReview,
            merge: current.checks.merge === "running" ? "canceled" : current.checks.merge,
        },
    });
}

/** Compose the Core Session port over the shared validation attempt owner. */
export async function continueWorkflowValidation(
    args: ContinueWorkflowValidationArgs,
): Promise<WorkflowValidationResult> {
    const result = await runValidationAttempt({
        projectRoot: validationProjectRoot(args),
        planName: args.planName,
        trigger: args.trigger,
        taskCompletionId: args.taskCompletionId,
        buildEngineArgs: (claim) =>
            createEngineValidationArgs({
                ...args,
                planContent: claim.planContent,
                triageMeta: claim.triageMeta,
                continuationPhase: claim.checkpoint.nextPhase,
                validationCheckpoint: claim.checkpoint,
            }),
    });
    if (
        result.recovery?.code !== "validation_owner_active" &&
        result.recovery?.code !== "task_completion_already_settled"
    ) {
        const settledPlan = await loadPlan(await validationPlanCwd(args), args.planName);
        if (settledPlan) {
            const progress = getCurrentValidationProgress(args.hostedSession);
            const active = args.hostedSession.getActiveExecutionWorkflow();
            const triageMeta = settledPlan.attrs as TriageMeta;
            if (active) args.hostedSession.setActiveExecutionWorkflow({ ...active, triageMeta });
            args.hostedSession.setWorkflowExecutionContext?.({ planName: args.planName, triageMeta });
            if (progress) {
                args.hostedSession.replaceWorkflowContext?.(
                    {
                        ...args.hostedSession.getWorkflowContext(),
                        validationProgress: progress,
                    },
                    { persist: true },
                );
            }
        }
    }
    if (result.kind === "verified") args.hostedSession.clearActiveExecutionWorkflow();
    if (
        result.recovery?.code !== "validation_owner_active" &&
        result.recovery?.code !== "task_completion_already_settled"
    )
        presentPausedProgress(args, result);
    return result;
}

/**
 * Continue across successful phase boundaries until validation either finishes
 * or reaches a boundary that needs an Agent or the user. The execution Plan is
 * reloaded between phases because it is the durable phase authority once work
 * has started.
 */
export async function runWorkflowValidationToStableBoundary(
    initialArgs: ContinueWorkflowValidationArgs,
): Promise<WorkflowValidationResult> {
    let args = initialArgs;
    let result = await continueWorkflowValidation(args);
    // A resumed run can first consume its durable recovery checkpoint before
    // advancing through Mechanical Validation, semantic review, optional human
    // review, and publication. Bound the loop above that complete phase count;
    // explicit decisions below still stop immediately at Agent/user boundaries.
    for (let phase = 0; phase < 5; phase += 1) {
        if (result?.kind !== "paused" || !result.continueValidation) break;
        const planCwd = await validationPlanCwd(args);
        const plan = await loadPlan(planCwd, args.planName).catch(() => null);
        const status = String(plan?.attrs.status || "");
        if (!plan) break;
        if (
            status !== "validated_ci" &&
            status !== "reviewed" &&
            !(status === "implemented" && plan.attrs.validationPhase === "semantic")
        )
            break;
        args = {
            ...args,
            planContent: plan.markdown,
            triageMeta: plan.attrs as ContinueWorkflowValidationArgs["triageMeta"],
        };
        result = await continueWorkflowValidation(args);
    }
    return result;
}
