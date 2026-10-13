/**
 * @module plan-deviation
 * Confirmation tool for durable Plan requirement replacements.
 */

import { type Static, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ActiveExecutionWorkflow, HostedSession } from "../shared/session/hosted-session.js";
import { loadPlan, savePlan, StalePlanWriteError } from "../plan-store.js";
import { appendPlanDeviation, formatPlanDeviationForPrompt, type PlanDeviation } from "../shared/plan-deviations.ts";
import {
    requestHostedSessionInteraction,
    RuntimeInteractionOutcomes,
    RuntimeInteractionTypes,
    supportsHostedSessionInteraction,
} from "../shared/session/session-runtime-interactions.js";

const PARAMETERS = Type.Object({
    supersededRequirement: Type.String({
        minLength: 1,
        description: "Exact effective Plan requirement the user's instruction replaces.",
    }),
    replacementRequirement: Type.String({
        minLength: 1,
        description: "Exact replacement requirement the user is being asked to confirm.",
    }),
    reason: Type.Optional(Type.String({ minLength: 1, description: "Optional concise reason for the deviation." })),
}, { additionalProperties: false });

export type PlanDeviationParameters = Static<typeof PARAMETERS>;

export type PlanDeviationDetails =
    | { decision: "inactive"; reason: "plan_execution_inactive" | "missing_execution_context" }
    | { decision: "canceled"; reason: "deviation_confirmation_canceled" }
    | { decision: "unsupported"; reason: "plan_deviation_confirmation_unavailable" }
    | { decision: "stale"; reason: "plan_revision_changed" | "execution_context_changed" }
    | { decision: "recorded"; entry: PlanDeviation; alreadyCommitted: boolean };

type PlanDeviationResult = AgentToolResult<PlanDeviationDetails> & { terminate: boolean };

interface PlanDeviationToolOptions {
    hostedSession: HostedSession;
}

function deviationResult(text: string, details: PlanDeviationDetails, terminate = false): PlanDeviationResult {
    return { content: [{ type: "text", text }], details, terminate };
}

function isActiveExecutionWorkflow(
    workflow: ActiveExecutionWorkflow | null | undefined,
): workflow is ActiveExecutionWorkflow {
    return Boolean(
        workflow &&
            (workflow.executionAgent === "engineer" || workflow.executionAgent === "frontend-engineer") &&
            workflow.executionStarted !== false &&
            !workflow.pairPauseReason &&
            !workflow.pairStopRequested,
    );
}

function hasExecutionContext(workflow: ActiveExecutionWorkflow): boolean {
    return Boolean(workflow.planName && workflow.executionCwd);
}

function sameExecutionIdentity(before: ActiveExecutionWorkflow, after: ActiveExecutionWorkflow | null | undefined) {
    return Boolean(
        after &&
            before.planName === after.planName &&
            before.executionCwd === after.executionCwd &&
            before.worktreeId === after.worktreeId &&
            before.worktreeBranch === after.worktreeBranch &&
            before.executionMode === after.executionMode,
    );
}

export function createPlanDeviationTool({ hostedSession }: PlanDeviationToolOptions) {
    if (!hostedSession) throw new Error("createPlanDeviationTool: hostedSession is required");
    return defineTool<typeof PARAMETERS, PlanDeviationDetails>({
        name: "record_plan_deviation",
        label: "Record Plan Deviation",
        description:
            "Ask the user to confirm an execution instruction that replaces an effective Plan requirement, then persist the confirmed replacement in the authoritative execution Plan.",
        parameters: PARAMETERS,
        async execute(toolCallId, params, signal): Promise<PlanDeviationResult> {
            const workflow = hostedSession.getActiveExecutionWorkflow?.();
            if (!isActiveExecutionWorkflow(workflow)) {
                return deviationResult(
                    "Plan Deviation recording is inactive. The approved Plan still applies.",
                    { decision: "inactive", reason: "plan_execution_inactive" },
                );
            }
            if (!hasExecutionContext(workflow)) {
                return deviationResult(
                    "Plan Deviation recording needs an active execution Plan and checkout. Pause; no deviation was recorded.",
                    { decision: "inactive", reason: "missing_execution_context" },
                    true,
                );
            }
            const executionCwd = workflow.executionCwd || "";
            const planName = workflow.planName;

            const current = await loadPlan(executionCwd, planName);
            if (!current) {
                return deviationResult(
                    `Plan not found in the active execution checkout: ${planName}. Pause; no deviation was recorded.`,
                    { decision: "inactive", reason: "missing_execution_context" },
                    true,
                );
            }
            const existing = current.attrs.planDeviations?.find((entry) => entry.id === toolCallId);
            if (existing) {
                return deviationResult(
                    `This Plan Deviation was already recorded. Continue under it.\n\n${
                        formatPlanDeviationForPrompt(existing, 1)
                    }`,
                    { decision: "recorded", entry: existing, alreadyCommitted: true },
                );
            }

            if (!supportsHostedSessionInteraction(hostedSession, RuntimeInteractionTypes.PLAN_DEVIATION_CONFIRMATION)) {
                if (workflow.collaborationStyle === "pair") {
                    hostedSession.setActiveExecutionWorkflow({ ...workflow, pairPauseReason: "canceled" });
                }
                return deviationResult(
                    "This session cannot confirm Plan Deviations. Pause and ask the user to continue in a host that supports confirmation; no deviation was recorded.",
                    { decision: "unsupported", reason: "plan_deviation_confirmation_unavailable" },
                    true,
                );
            }

            const supersededRequirement = params.supersededRequirement.trim();
            const replacementRequirement = params.replacementRequirement.trim();
            const reason = params.reason?.trim();
            const response = await requestHostedSessionInteraction(
                hostedSession,
                {
                    type: RuntimeInteractionTypes.PLAN_DEVIATION_CONFIRMATION,
                    prompt: [
                        "Confirm this Plan Deviation before I treat it as authority.",
                        `Superseded requirement: ${supersededRequirement}`,
                        `Replacement requirement: ${replacementRequirement}`,
                        reason ? `Reason: ${reason}` : "",
                        "Confirmed text will be saved in the Plan and Work Record.",
                    ].filter(Boolean).join("\n\n"),
                    options: [
                        { value: "confirm", label: "Confirm Plan Deviation" },
                        { value: "cancel", label: "Cancel; keep the original Plan requirement" },
                    ],
                    toolCallId,
                    _meta: {
                        planName,
                        expectedRevision: current.revision,
                        supersededRequirement,
                        replacementRequirement,
                        ...(reason ? { reason } : {}),
                    },
                },
                signal,
                hostedSession.getManagedOperationCapability?.() || null,
            );

            const selectedConfirmation = response.outcome === RuntimeInteractionOutcomes.SELECTED &&
                response.value === "confirm";
            const canceledSelection = response.outcome === RuntimeInteractionOutcomes.SELECTED &&
                response.value === "cancel";
            if (response.outcome === RuntimeInteractionOutcomes.CANCELED || canceledSelection) {
                return deviationResult(
                    "Plan Deviation confirmation was canceled. The original Plan requirement still applies.",
                    { decision: "canceled", reason: "deviation_confirmation_canceled" },
                );
            }
            if (
                response.outcome === RuntimeInteractionOutcomes.UNSUPPORTED ||
                response.outcome === RuntimeInteractionOutcomes.BLOCKED
            ) {
                if (workflow.collaborationStyle === "pair") {
                    hostedSession.setActiveExecutionWorkflow({ ...workflow, pairPauseReason: "canceled" });
                }
                return deviationResult(
                    "Plan Deviation confirmation is unavailable. Pause; no deviation was recorded and the original Plan requirement still applies.",
                    { decision: "unsupported", reason: "plan_deviation_confirmation_unavailable" },
                    true,
                );
            }
            if (response.outcome !== RuntimeInteractionOutcomes.ACCEPTED && !selectedConfirmation) {
                return deviationResult(
                    "Plan Deviation was not accepted. The original Plan requirement still applies.",
                    { decision: "canceled", reason: "deviation_confirmation_canceled" },
                );
            }

            const latestWorkflow = hostedSession.getActiveExecutionWorkflow?.();
            if (!isActiveExecutionWorkflow(latestWorkflow) || !sameExecutionIdentity(workflow, latestWorkflow)) {
                return deviationResult(
                    "The active execution context changed before the Plan Deviation could be saved. Ask for confirmation again against the current Plan.",
                    { decision: "stale", reason: "execution_context_changed" },
                );
            }
            const latest = await loadPlan(executionCwd, planName);
            if (!latest || latest.revision !== current.revision) {
                return deviationResult(
                    "The Plan changed before the confirmed deviation could be saved. Reload the effective Plan and ask for confirmation again.",
                    { decision: "stale", reason: "plan_revision_changed" },
                );
            }
            const appended = appendPlanDeviation(latest.attrs.planDeviations, {
                id: toolCallId,
                supersededRequirement,
                replacementRequirement,
                ...(reason ? { reason } : {}),
                approvedAt: new Date().toISOString(),
            });
            try {
                await savePlan(
                    executionCwd,
                    planName,
                    latest.markdown,
                    { planDeviations: appended.entries },
                    { expectedRevision: latest.revision },
                );
            } catch (error) {
                if (error instanceof StalePlanWriteError) {
                    return deviationResult(
                        "The Plan changed before the confirmed deviation could be saved. Reload the effective Plan and ask for confirmation again.",
                        { decision: "stale", reason: "plan_revision_changed" },
                    );
                }
                throw error;
            }
            return deviationResult(
                `Plan Deviation recorded in the execution Plan. Reread the effective Plan projection and continue under this replacement.\n\n${
                    formatPlanDeviationForPrompt(appended.entry, 1)
                }`,
                { decision: "recorded", entry: appended.entry, alreadyCommitted: appended.alreadyCommitted },
            );
        },
    });
}
