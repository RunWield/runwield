import { AGENTS } from "../../constants.js";
import { resolvePlanExecutionPolicy } from "../../plan-store.js";
import { decidePostExecution } from "../../shared/workflow/decisions.ts";
import { validatePostExecutionDecision } from "./plan-execution.ts";
import { resolveWorkflowPlanLocation } from "../../shared/workflow/plan-location.ts";
import { RuntimeInteractionTypes } from "../../shared/session/session-runtime-interactions.js";
import type { LastPlanReviewReference } from "../../shared/session/file-session-store-types.ts";
import type { SessionRuntime } from "../../shared/session/session-runtime.ts";
import type { UiAPI } from "../../ui/tui/types.js";
import { createPlanSessionSurface } from "./plan-session-surface.ts";
import { getDirectPlanReviewEligibility, reviewLoadedPlanDirectly } from "./plan-review-flow.ts";
import type { DirectPlanReviewResult } from "./plan-review-flow.ts";

export interface ReopenPlanReviewResult {
    kind: "complete" | "unanswered" | "missing_plan" | "identity_mismatch" | "not_reviewable";
    message: string;
    url?: string;
    executionToStart?: DirectPlanReviewResult["executionToStart"];
}

/** Start execution only after the review's managed operation releases its Session writer. */
export async function startReopenedPlanExecution(
    runtime: SessionRuntime,
    sessionId: string,
    execution: NonNullable<DirectPlanReviewResult["executionToStart"]>,
): Promise<void> {
    const { options, fallbackPlanContent } = execution;
    const result = await runtime.executePlan(sessionId, options);
    const executionResult = {
        ...result,
        repairRequired: false,
        executionComplete: result.executionComplete === true,
    };
    const policy = resolvePlanExecutionPolicy(options.triageMeta || {});
    const decision = decidePostExecution(executionResult, {
        planName: options.planName,
        triageMeta: options.triageMeta || {},
        executionAgentName: policy.ok ? policy.policy.executionAgent : AGENTS.ENGINEER,
    });
    const surface = createPlanSessionSurface(runtime, sessionId, {
        executePlan: (request) => runtime.executePlan(sessionId, request),
        runPlanningAgent: (request) => runtime.runPlanningAgent(sessionId, request),
        runValidation: (request) => runtime.runValidation(sessionId, request),
        runSlicerAgent: (request) => runtime.runSlicerAgent(sessionId, request),
    });
    await validatePostExecutionDecision({
        executionDecision: decision,
        executionResult,
        fallbackPlanContent,
        continueWorkflowValidation: surface.runValidation,
        session: surface,
    });
}

/** Review the current saved document under the runtime's managed operation. */
export async function reopenSavedPlanReview(
    runtime: SessionRuntime,
    sessionId: string,
    reference: LastPlanReviewReference,
    notify: (message: string, isError?: boolean) => void,
): Promise<ReopenPlanReviewResult> {
    const projectRoot = runtime.getSessionProjectRoot(sessionId);
    if (!projectRoot) return { kind: "missing_plan", message: "This Session's project is unavailable." };
    let location: Awaited<ReturnType<typeof resolveWorkflowPlanLocation>>;
    try {
        location = await resolveWorkflowPlanLocation(projectRoot, reference.planName);
    } catch (error) {
        return {
            kind: "missing_plan",
            message: error instanceof Error ? error.message : `Plan ${reference.planName} is unavailable.`,
        };
    }
    const saved = location.plan;
    if (!saved) return { kind: "missing_plan", message: `Plan ${reference.planName} is no longer available.` };
    if (saved.attrs.planId !== reference.planId) {
        return {
            kind: "identity_mismatch",
            message: `Plan ${reference.planName} no longer has the reviewed identity.`,
        };
    }
    const eligibility = getDirectPlanReviewEligibility(saved);
    if (!eligibility.eligible) {
        return {
            kind: "not_reviewable",
            message: eligibility.message || `Plan ${reference.planName} cannot be reviewed in its current status.`,
        };
    }
    // The only UI operations used by direct review are notices and selections.
    // Route both through the Session so this is not tied to a terminal surface.
    const uiAPI: UiAPI = {
        appendSystemMessage: notify,
        promptSelect: async (title, options) => {
            const response = await runtime.requestInteraction(sessionId, {
                type: RuntimeInteractionTypes.SELECT,
                prompt: title,
                options: options.map(({ value, label, description }) => ({ value, label, description })),
            });
            return response.outcome === "selected" ? String(response.value) : null;
        },
        promptText: async (title, options) => {
            const response = await runtime.requestInteraction(sessionId, {
                type: RuntimeInteractionTypes.TEXT,
                prompt: title,
                ...options,
            });
            return response.outcome === "text" ? String(response.value) : null;
        },
        appendAgentMessageStart: () => ({ appendText: () => {} }),
        requestRender: () => {},
        showModelSelector: () => {},
        abortActivePrompt: () => {},
    };
    const surface = createPlanSessionSurface(runtime, sessionId, {
        executePlan: (options) => runtime.executePlan(sessionId, options),
        runPlanningAgent: (options) => runtime.runPlanningAgent(sessionId, options),
        runValidation: (options) => runtime.runValidation(sessionId, options),
        runSlicerAgent: (options) => runtime.runSlicerAgent(sessionId, options),
    });
    const outcome = await reviewLoadedPlanDirectly({
        projectRoot,
        plan: { ...saved, planName: reference.planName },
        agentName: reference.planningAgentName,
        activatePlanningAgent: false,
        deferExecution: true,
        uiAPI,
        executePlan: surface.executePlan,
        continueWorkflowValidation: surface.runValidation,
        runPlanningAgent: surface.runPlanningAgent,
        runSlicerAgent: surface.runSlicerAgent,
        session: surface,
    });
    return outcome.reviewUnanswered
        ? { kind: "unanswered", message: `Plan review ended without an answer. Use /plan-review to try again.` }
        : {
            kind: "complete",
            message: `Review finished for ${reference.planName}.`,
            executionToStart: outcome.executionToStart,
        };
}
