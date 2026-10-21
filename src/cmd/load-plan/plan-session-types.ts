/**
 * @module cmd/load-plan/plan-session-types
 * Shapes shared across the load-plan modules.
 *
 * These live apart from the modules that use them so a split of load-plan does
 * not have to choose one owner for a type several parts need.
 */

import type { PlanFrontMatter } from "../../plan-store.js";
import type { PlanApprovalAction } from "../../shared/workflow/plan-approval.ts";
import type { PlanActionRequest, PlanActionResult } from "../../shared/workflow/plan-actions.ts";
import type { SequenceReviewDecision, SequenceReviewDocument } from "../../shared/workflow/sequence-review.ts";
import type { EpicIntegrationGateResult } from "../../shared/workflow/epic-integration.ts";

export type ActiveExecutionWorkflow = import("../../shared/types.js").ActiveExecutionWorkflow;

/** An image attached to a review decision. */
export interface ReviewImage {
    base64: string;
    mimeType: string;
}

/** What a Plan review returns to the command. */
export interface PlanReviewOutcome {
    conversationTurn?: boolean;
    canceled: boolean;
    approved: boolean;
    feedback?: string;
    approvalAction?: PlanApprovalAction;
    planAttrs?: PlanFrontMatter;
    images?: ReviewImage[];
    remoteReview?: boolean;
    reviewerUrl?: string;
    spaceId?: string;
    serverUrl?: string;
    revision?: string;
    reused?: boolean;
    message?: string;
    sequenceDecision?: SequenceReviewDecision;
}

/** The metadata a review is opened with. */
export interface PlanReviewRequest {
    planningAgentName?: string;
    planName: string;
    planPath: string;
    triageMeta: Record<string, unknown>;
    documentRoot?: string;
    sequenceDocuments?: SequenceReviewDocument[];
}

/** Options accepted when switching the active agent. */
export interface SwitchAgentOptions {
    model?: string;
    cwd?: string;
    forceRebuild?: boolean;
}

/**
 * The command-local view of the public SessionRuntime surface.
 *
 * No core session object or persistence manager crosses this boundary.
 */
export interface PlanSessionSurface {
    id: string;
    cwd: string;
    getActiveAgentName: () => string | null;
    /**
     * The Agent the Session will have if no switch runs: the runtime-active
     * Agent, or the persisted Agent of a dormant managed Session. Restore uses
     * this to skip a switch that would change nothing, because even a no-op
     * switch hydrates and publishes a new Session generation.
     */
    getEffectiveAgentName: () => string | null;
    switchAgent: (agentName: string, options?: SwitchAgentOptions) => Promise<unknown>;
    // deno-lint-ignore no-explicit-any
    executePlan: (options: Record<string, any>) => Promise<any>;
    // deno-lint-ignore no-explicit-any
    runPlanningAgent: (options: Record<string, any>) => Promise<any>;
    // deno-lint-ignore no-explicit-any
    runValidation: (options: Record<string, any>) => Promise<any>;
    // deno-lint-ignore no-explicit-any
    runSlicerAgent: (options: Record<string, any>) => Promise<any>;
    runPlanAction?: (request: PlanActionRequest) => Promise<PlanActionResult>;
    getActiveExecutionWorkflow: () => ActiveExecutionWorkflow | null;
    setActiveExecutionWorkflow: (workflow: ActiveExecutionWorkflow) => Promise<void>;
    replaceWithExecutionSession: (workflow: ActiveExecutionWorkflow) => Promise<void>;
    clearActiveExecutionWorkflow: () => Promise<void>;
    reviewPlan: (meta: PlanReviewRequest) => Promise<PlanReviewOutcome>;
    /**
     * Claim the Session for continued work on a Plan: set the terminal title and
     * durably rename the Session, once. Menus may loop many times before the user
     * chooses to continue; only the first continuation action pays this cost.
     */
    activateForPlan: (planName: string) => Promise<void>;
    /** Run the integration gate on an Epic branch; absent where no live Session can run checks and review. */
    runEpicIntegrationGate?: (epicPlanName: string) => Promise<EpicIntegrationGateResult>;
}

/**
 * The worktree generation a Plan is recorded against, as recovery sees it.
 *
 * Every field is optional because recovery's whole job is handling Plans whose
 * recorded metadata is partial or stale.
 */
export interface RecoveryWorktreeContext {
    id?: string;
    path?: string;
    branch?: string;
    baseBranch?: string;
    status?: string;
    baseRef?: string;
    baseCommit?: string;
    baseTree?: string;
    executionBaselineTree?: string;
    publication?: import("../../shared/workflow/publication-attempt.ts").PublicationAttempt;
}
