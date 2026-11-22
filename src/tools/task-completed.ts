/**
 * @module task-completed
 * Custom tool for execution agents to declare they have finished their current
 * task. This returns a terminal outcome that lets the orchestrator advance the
 * active workflow.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ActiveExecutionWorkflow, HostedSession } from "../shared/session/hosted-session.ts";
import { AGENTS } from "../constants.ts";
import { recordAcceptedTaskCompletion } from "../shared/session/task-completion-session.ts";
import { readRequestAttemptEntries } from "../shared/session/request-dispatch.ts";
import {
    clearPairCheckpoint,
    hasFinalPairAssent,
    readCurrentPairCheckpoint,
    recordPairCheckpointReport,
} from "../shared/session/pair-checkpoint-session.ts";
import { emitTaskCompletedMessage } from "../shared/session/workflow-messages.ts";
import { recordWorkflowMetric } from "../shared/workflow/metrics.ts";
import { resolveActiveWorkflowRuntimeAgent } from "../shared/workflow/execution-agent.ts";

import {
    toolRegistry,
    type TaskCompletedDetails,
    type TaskCompletedReportKind,
    type ToolParameters,
} from "@runwield/tools";

const taskCompleted = toolRegistry.get("task_completed");

type TaskCompletedResult = AgentToolResult<TaskCompletedDetails> & { terminate: boolean };

interface TaskCompletedToolOptions {
    hostedSession: HostedSession;
    agentName?: string;
    now?: () => number;
}

function normalizeAgentName(agentName: string): string {
    return agentName.trim().toLowerCase().replaceAll(" ", "-");
}

function isExecutionAgent(agentName: string): boolean {
    const normalized = normalizeAgentName(agentName);
    return normalized === "engineer" || normalized === "plan-engineer" || normalized === "frontend-engineer";
}

function isValidationRepairAgent(agentName: string): boolean {
    const normalized = normalizeAgentName(agentName);
    return normalized === AGENTS.REVIEWER_FEEDBACK_ENGINEER || normalized === "validation-repair-engineer";
}

function reportKindForAgent(agentName: string): TaskCompletedReportKind {
    if (normalizeAgentName(agentName) === "frontend-engineer") return "frontend-implementation";
    if (isExecutionAgent(agentName) || isValidationRepairAgent(agentName)) return "implementation";
    return "summary";
}

function isInitialPairCompletionCheckpoint(
    activeWorkflow: ActiveExecutionWorkflow | null | undefined,
): activeWorkflow is ActiveExecutionWorkflow {
    return Boolean(
        activeWorkflow &&
        activeWorkflow.collaborationStyle === "pair" &&
        activeWorkflow.validationContinuation !== true &&
        (activeWorkflow.executionAgent === "engineer" || activeWorkflow.executionAgent === "frontend-engineer"),
    );
}

export function createTaskCompletedTool({
    hostedSession,
    agentName = "agent",
    now = () => Date.now(),
}: TaskCompletedToolOptions) {
    if (!hostedSession) throw new Error("createTaskCompletedTool: hostedSession is required");
    const targetHostedSession = hostedSession;
    const definition = taskCompleted.define(reportKindForAgent(agentName));
    return defineTool<typeof definition.parameters, TaskCompletedDetails>({
        ...definition,
        async execute(_toolCallId, params: ToolParameters<"task_completed">, _signal): Promise<TaskCompletedResult> {
            await Promise.resolve();
            const activeWorkflow = targetHostedSession.getActiveExecutionWorkflow?.();
            const normalizedAgentName = normalizeAgentName(agentName);
            if (activeWorkflow?.executionStarted === false) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "task_completed rejected: active workflow execution has not started.",
                        },
                    ],
                    details: { outcome: "rejected", reason: "execution_not_started" },
                    terminate: false,
                };
            }
            if (activeWorkflow?.pairPauseReason) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `task_completed rejected: Pair Execution is paused (${activeWorkflow.pairPauseReason}); leave the Plan In Progress.`,
                        },
                    ],
                    details: { outcome: "rejected", reason: "pair_execution_paused" },
                    terminate: false,
                };
            }
            const completingOnBehalfOfOwner = isValidationRepairAgent(agentName);
            const runtimeOwner = resolveActiveWorkflowRuntimeAgent(activeWorkflow);
            if (runtimeOwner && runtimeOwner !== normalizedAgentName && !completingOnBehalfOfOwner) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `task_completed rejected: active workflow owner is ${runtimeOwner}, not ${normalizedAgentName}.`,
                        },
                    ],
                    details: { outcome: "rejected", reason: "wrong_execution_owner" },
                    terminate: false,
                };
            }
            const report = taskCompleted.normalizeReport(params.message);
            const browserPreflightOutcome =
                "browserPreflightOutcome" in params ? params.browserPreflightOutcome : undefined;
            if (
                isInitialPairCompletionCheckpoint(activeWorkflow) &&
                !hasFinalPairAssent(targetHostedSession, activeWorkflow)
            ) {
                const currentCheckpoint = readCurrentPairCheckpoint(targetHostedSession);
                if (currentCheckpoint?.report.report.final && !currentCheckpoint.resolution) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "Final Pair checkpoint is still pending. Wait for the user's direction before task completion.",
                            },
                        ],
                        details: { outcome: "rejected", reason: "pair_final_checkpoint_pending" },
                        terminate: true,
                    };
                }
                try {
                    const checkpoint = recordPairCheckpointReport({
                        hostedSession: targetHostedSession,
                        toolCallId: _toolCallId,
                        report: {
                            summary: report,
                            final: true,
                            ...(browserPreflightOutcome ? { browserPreflightOutcome } : {}),
                        },
                        timestampMs: now(),
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: [
                                    `**Pair checkpoint ${checkpoint.report.checkpointNumber} — final.**`,
                                    "",
                                    report,
                                    "",
                                    "Reply normally to ask a question, request a change, approve completion, stop, or switch to autonomous work.",
                                ].join("\n"),
                            },
                        ],
                        details: {
                            outcome: "pair_completion_checkpoint",
                            checkpointId: checkpoint.report.checkpointId,
                            checkpointNumber: checkpoint.report.checkpointNumber,
                            decision: "pending",
                        },
                        terminate: true,
                    };
                } catch {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "Final Pair checkpoint could not be recorded. Task completion was not accepted.",
                            },
                        ],
                        details: { outcome: "rejected", reason: "pair_checkpoint_context_unavailable" },
                        terminate: false,
                    };
                }
            }
            const cycle = activeWorkflow
                ? JSON.stringify([
                      runtimeOwner,
                      activeWorkflow.planName,
                      activeWorkflow.executionAttemptStartedAtMs,
                      activeWorkflow.validationGeneration,
                      activeWorkflow.validationRepairGeneration,
                      activeWorkflow.validationContinuation,
                  ])
                : `request:${
                      (targetHostedSession.getRootSessionManager()?.getBranch
                          ? readRequestAttemptEntries(
                                targetHostedSession.getRootSessionManager() as Parameters<
                                    typeof readRequestAttemptEntries
                                >[0],
                            )
                                .filter((entry) => entry.dispatchKind !== "background_task_result")
                                .at(-1)?.requestId
                          : null) ||
                      targetHostedSession.getActiveTurnId() ||
                      "standalone"
                  }`;
            const running = targetHostedSession.backgroundTasks.runningTasks();
            if (running.length && targetHostedSession.warnBackgroundCompletion(cycle)) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `task_completed rejected: Background Tasks still running:\n${running
                                .map((task) => `- ${task.task_id} (${task.kind})`)
                                .join(
                                    "\n",
                                )}\nUse background_task status or cancel to check them. Another eligible task_completed call cancels remaining tasks and accepts completion.`,
                        },
                    ],
                    details: { outcome: "rejected", reason: "background_tasks_pending" },
                    terminate: false,
                };
            }
            try {
                await targetHostedSession.settleBackgroundTasksForCompletion();
            } catch (error) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `task_completed rejected: background cleanup failed: ${String(error)}`,
                        },
                    ],
                    details: { outcome: "rejected", reason: "background_cleanup_failed" },
                    terminate: false,
                };
            }
            targetHostedSession.resetBackgroundCompletionWarning();
            const timestampMs = now();
            recordAcceptedTaskCompletion({
                hostedSession: targetHostedSession,
                toolCallId: _toolCallId,
                agentName: normalizedAgentName,
                report,
                timestampMs,
            });
            if (isInitialPairCompletionCheckpoint(activeWorkflow)) {
                clearPairCheckpoint(targetHostedSession, "task_completion_accepted", timestampMs);
            }
            emitTaskCompletedMessage(targetHostedSession, agentName, report, _toolCallId);
            await recordWorkflowMetric(
                {
                    category: "execution",
                    event: "task_completed",
                    agentName,
                    details: { hasMessage: Boolean(params.message) },
                },
                targetHostedSession.cwd,
            );
            const completedWorkflow = targetHostedSession.getActiveExecutionWorkflow?.() || activeWorkflow;
            if (
                normalizedAgentName === "frontend-engineer" &&
                completedWorkflow?.executionAgent === "frontend-engineer"
            ) {
                const startMs = completedWorkflow.executionAttemptStartedAtMs;
                const elapsedMs =
                    typeof startMs === "number" && Number.isFinite(startMs) && startMs >= 0
                        ? Math.max(0, Math.trunc(now() - startMs))
                        : undefined;
                await recordWorkflowMetric(
                    {
                        category: "execution",
                        event: "frontend_execution_completed",
                        details: {
                            phase: completedWorkflow.validationContinuation ? "validation_repair" : "implementation",
                            runtimeStyle: completedWorkflow.collaborationStyle || "autonomous",
                            checkpointCount: completedWorkflow.pairCheckpointCount || 0,
                            switchedToAutonomous: completedWorkflow.pairSwitchedToAutonomous === true,
                            capabilityLost: completedWorkflow.pairCapabilityLost === true,
                            browserPreflightOutcome,
                            elapsedMs,
                        },
                    },
                    targetHostedSession.cwd,
                );
            }

            return {
                content: [],
                details: {
                    outcome: "task_completed",
                    message: report,
                    ...(normalizedAgentName === "frontend-engineer" ? { browserPreflightOutcome } : {}),
                },
                terminate: true,
            };
        },
    });
}
