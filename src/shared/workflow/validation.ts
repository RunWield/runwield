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
            run: ({ cwd }) => {
                session.assertLive();
                return args.localCI.run({ hostedSession: args.hostedSession, cwd, settingsPolicy: "exact-project" });
            },
        },
        workRecordMnemotecaPort: args.workRecordMnemotecaPort,
        supportsSemanticRepairHandoff: args.supportsSemanticRepairHandoff,
        continuationPhase: args.continuationPhase,
        validationCheckpoint: args.validationCheckpoint,
    };
}
