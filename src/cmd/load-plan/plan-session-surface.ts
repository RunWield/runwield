/**
 * @module cmd/load-plan/plan-session-surface
 * The command-local view of a runtime session, and the agent handoffs around it.
 *
 * load-plan never touches a core session object: it is handed a SessionRuntime
 * and builds the narrow surface below, so the command can only do what this
 * file lets it do.
 */

import { AGENTS, CLI_BIN } from "../../constants.js";
import { resolveActiveWorkflowRuntimeAgent } from "../../shared/workflow/execution-agent.ts";
import { setTerminalTitleForName } from "../../ui/tui/terminal-title.ts";
import { resetTuiState as resetTuiStateFn } from "../command-helpers.ts";
import {
    RuntimeInteractionOutcomes,
    RuntimeInteractionTypes,
} from "../../shared/session/session-runtime-interactions.js";
import type { SessionRuntime } from "../../shared/session/session-runtime.ts";
import type { UiAPI } from "../../ui/tui/types.js";
import type { PlanFrontMatter } from "../../plan-store.js";
import type { PlanApprovalAction } from "../../shared/workflow/plan-approval.ts";
import type { SequenceReviewDecision } from "../../shared/workflow/sequence-review.ts";
import type { ActiveExecutionWorkflow, PlanSessionSurface } from "./plan-session-types.ts";

/**
 * The review payload as it arrives from the runtime: unvalidated, so every
 * field below is checked before it is trusted.
 */
interface RawReviewPayload {
    approved?: unknown;
    feedback?: unknown;
    cancellationReason?: unknown;
    approvalAction?: PlanApprovalAction;
    planAttrs?: unknown;
    images?: unknown;
    remoteReview?: unknown;
    reviewerUrl?: unknown;
    spaceId?: unknown;
    serverUrl?: unknown;
    revision?: unknown;
    reused?: unknown;
    sequenceDecision?: SequenceReviewDecision;
}

/**
 * How the command runs agents.
 *
 * Required, not optional. An optional bag would let a caller replace an agent run
 * and leave this module choosing silently between a stand-in and the runtime;
 * because these must be supplied, the choice is made where it can be seen, and
 * this module substitutes nothing.
 */
export interface PlanAgentRunners {
    executePlan: PlanSessionSurface["executePlan"];
    runPlanningAgent: PlanSessionSurface["runPlanningAgent"];
    runValidation: PlanSessionSurface["runValidation"];
    runSlicerAgent: PlanSessionSurface["runSlicerAgent"];
}

/** Whether an error is the runtime's "managed session unavailable" signal. */
export function isManagedUnsupportedError(error: unknown): boolean {
    return error instanceof Error ? error.message === "managed_unsupported" : String(error) === "managed_unsupported";
}

/** Explain that lifecycle actions are unavailable without a managed session. */
export function buildManagedUnsupportedLoadPlanMessage(planName: string | null): string {
    const command = planName ? `${CLI_BIN} load-plan ${planName}` : `${CLI_BIN} load-plan <plan-name>`;
    return [
        "Cannot continue this Plan because RunWield could not attach the working Session.",
        "The Plan is open for reading, but actions such as planning, execution, validation, and status updates are not available in this Session.",
        `Try again from a fresh RunWield TUI or Workspace session with: ${command}`,
    ].join("\n");
}

/**
 * Build the command-local view of the public SessionRuntime surface. No core
 * session object or persistence manager crosses this boundary.
 */
export function createPlanSessionSurface(
    runtime: SessionRuntime,
    sessionId: string,
    runners: PlanAgentRunners,
): PlanSessionSurface {
    const snapshot = runtime.getSessionSnapshot(sessionId);
    if (!snapshot) throw new Error("load-plan requires an active runtime session");
    let activatedPlanName: string | null = null;
    return {
        id: sessionId,
        cwd: snapshot.cwd,
        getActiveAgentName: () => runtime.getRuntimeActiveAgentName(sessionId),
        getEffectiveAgentName: () => runtime.getEffectiveAgentName(sessionId),
        switchAgent: (agentName, options = {}) => runtime.switchAgent(sessionId, { agentName, ...options }),
        executePlan: runners.executePlan,
        runPlanningAgent: runners.runPlanningAgent,
        runValidation: runners.runValidation,
        runSlicerAgent: runners.runSlicerAgent,
        runEpicIntegrationGate: (epicPlanName) => runtime.runEpicIntegrationGate(sessionId, { epicPlanName }),
        runPlanAction: (request) => runtime.runPlanAction(sessionId, request),
        getActiveExecutionWorkflow: () => runtime.getRuntimeActiveExecutionWorkflow(sessionId),
        setActiveExecutionWorkflow: async (workflow) => {
            await runtime.setActiveExecutionWorkflow(sessionId, workflow);
        },
        replaceWithExecutionSession: async (workflow: ActiveExecutionWorkflow) => {
            await runtime.replaceSessionForExecutionFollowUp(sessionId, workflow);
        },
        clearActiveExecutionWorkflow: async () => {
            await runtime.clearActiveExecutionWorkflow(sessionId);
        },
        reviewPlan: async (meta) => {
            const response = await runtime.requestInteraction(sessionId, {
                type: RuntimeInteractionTypes.PLAN_REVIEW,
                prompt: `Review plan "${meta.planName}"`,
                _meta: { cwd: meta.documentRoot || snapshot.cwd, ...meta },
            });
            const responseAny = response as { _meta?: Record<string, unknown>; message?: unknown };
            const review = (responseAny._meta || {}) as RawReviewPayload;
            const hasReviewPayload = responseAny._meta && typeof responseAny._meta === "object" &&
                Object.keys(responseAny._meta).length > 0;
            const runtimeCanceled = response.outcome === RuntimeInteractionOutcomes.CANCELED && !hasReviewPayload;
            return {
                canceled: response.outcome === RuntimeInteractionOutcomes.CANCELED,
                cancellationReason: typeof review.cancellationReason === "string"
                    ? review.cancellationReason
                    : runtimeCanceled
                    ? "runtime_cancel"
                    : undefined,
                approved: review.approved === true || review.sequenceDecision?.approved === true,
                feedback: typeof review.feedback === "string"
                    ? review.feedback
                    : typeof review.sequenceDecision?.feedback === "string"
                    ? review.sequenceDecision.feedback
                    : undefined,
                approvalAction: review.approvalAction,
                planAttrs: review.planAttrs && typeof review.planAttrs === "object"
                    ? (review.planAttrs as PlanFrontMatter)
                    : undefined,
                images: Array.isArray(review.images) ? review.images : undefined,
                remoteReview: review.remoteReview === true,
                reviewerUrl: typeof review.reviewerUrl === "string" ? review.reviewerUrl : undefined,
                spaceId: typeof review.spaceId === "string" ? review.spaceId : undefined,
                serverUrl: typeof review.serverUrl === "string" ? review.serverUrl : undefined,
                revision: typeof review.revision === "string" ? review.revision : undefined,
                reused: typeof review.reused === "boolean" ? review.reused : undefined,
                sequenceDecision: review.sequenceDecision,
                message: typeof response.message === "string" ? response.message : undefined,
            };
        },
        activateForPlan: async (planName) => {
            // One-shot: menus can loop many times before the user chooses to
            // continue, and only the first continuation action should pay the
            // durable Session rename (and its terminal-title companion).
            if (activatedPlanName !== null) return;
            activatedPlanName = planName;
            setTerminalTitleForName(planName);
            await runtime.renameSession(sessionId, planName);
        },
    };
}

/**
 * Restore the agent that owned the session before load-plan command work.
 */
export async function restorePreviousAgentFlow(
    uiAPI: UiAPI,
    agentName: string,
    session: PlanSessionSurface,
): Promise<void> {
    resetTuiStateFn(undefined, uiAPI, undefined);
    const workflow = session.getActiveExecutionWorkflow?.() || null;
    // The workflow records the canonical Plan owner; the user talks to the
    // resolved runtime Agent, so restore that one.
    const executionAgent = resolveActiveWorkflowRuntimeAgent(workflow);
    if (executionAgent) {
        await session.switchAgent(executionAgent, workflow?.executionCwd ? { cwd: workflow.executionCwd } : {});
        return;
    }
    // A restore that switches to the Agent the Session already has changes
    // nothing but still costs a managed mutation: the switch hydrates and
    // publishes a new Session generation. Menus that never continued work must
    // exit without that durable side effect, so View/Cancel leaves the committed
    // evidence exactly as it was. The effective Agent covers dormant managed
    // Sessions too, where no runtime Agent is active but the persisted one is
    // already the restore target.
    if (session.getEffectiveAgentName() === agentName) return;
    await session.switchAgent(agentName);
}

/**
 * If a plan command was entered from Router, the plan owner should become the
 * follow-up agent. Otherwise restore the specialist the user was already using.
 */
export function selectPlanFlowRestoreAgent(initialAgentName: string, planAgentName: string): string {
    return initialAgentName === AGENTS.ROUTER ? planAgentName : initialAgentName;
}
