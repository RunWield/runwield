/**
 * @module pair-checkpoint
 * Conversational checkpoints for Plan Pair Execution.
 */

import { toolRegistry, type PairCheckpointResolutionDecision } from "@runwield/tools";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ActiveExecutionWorkflow } from "@runwield/workflow/state";
import type { HostedSession } from "@runwield/session-runtime/host";
import {
    readCurrentPairCheckpoint,
    recordPairCheckpointReport,
    resolvePairCheckpoint,
} from "../shared/session/pair-checkpoint-session.ts";
import { recordWorkflowMetric } from "../shared/workflow/metrics.ts";

const pairCheckpoint = toolRegistry.get("pair_checkpoint");
const { definition } = pairCheckpoint;

export type PairCheckpointDetails =
    | { outcome: "inactive"; reason: "pair_execution_inactive" | "pair_execution_paused" }
    | { outcome: "rejected"; reason: string; checkpointId?: string }
    | { outcome: "reported"; checkpointId: string; checkpointNumber: number; final: boolean }
    | {
          outcome: "resolved";
          checkpointId: string;
          checkpointNumber: number;
          decision: PairCheckpointResolutionDecision;
          revisionDirection?: string;
      };

type PairCheckpointResult = AgentToolResult<PairCheckpointDetails> & { terminate: boolean };

interface PairCheckpointToolOptions {
    hostedSession: HostedSession;
}

function checkpointResult(text: string, details: PairCheckpointDetails, terminate = false): PairCheckpointResult {
    return { content: [{ type: "text", text }], details, terminate };
}

function clearPairPause(workflow: ActiveExecutionWorkflow): ActiveExecutionWorkflow {
    const next = { ...workflow };
    delete next.pairPauseReason;
    delete next.pairStopRequested;
    return next;
}

function nextWorkflowForDecision(
    workflow: ActiveExecutionWorkflow,
    decision: PairCheckpointResolutionDecision,
): ActiveExecutionWorkflow {
    const next = clearPairPause(workflow);
    if (decision === "switch_to_autonomous") {
        return { ...next, collaborationStyle: "autonomous", pairSwitchedToAutonomous: true };
    }
    if (decision === "stop") return { ...next, pairPauseReason: "stop", pairStopRequested: true };
    return next;
}

export function createPairCheckpointTool({ hostedSession }: PairCheckpointToolOptions) {
    if (!hostedSession) throw new Error("createPairCheckpointTool: hostedSession is required");
    return defineTool<typeof definition.parameters, PairCheckpointDetails>({
        ...definition,

        async execute(toolCallId, params): Promise<PairCheckpointResult> {
            const workflow = hostedSession.getActiveExecutionWorkflow?.();
            if (
                (workflow?.executionAgent !== "engineer" && workflow?.executionAgent !== "frontend-engineer") ||
                workflow.executionStarted === false ||
                workflow.collaborationStyle !== "pair"
            ) {
                return checkpointResult("Pair checkpoint is inactive; continue autonomously.", {
                    outcome: "inactive",
                    reason: "pair_execution_inactive",
                });
            }

            const action = pairCheckpoint.resolveAction(params);
            if (action === "report") {
                if (workflow.pairPauseReason || workflow.pairStopRequested) {
                    return checkpointResult(
                        "Pair Execution is stopped. Resolve the current checkpoint from a later user turn before reporting more work.",
                        { outcome: "inactive", reason: "pair_execution_paused" },
                        true,
                    );
                }
                const report = pairCheckpoint.prepareReport(params);
                if (!report) {
                    return checkpointResult("pair_checkpoint report rejected: summary is required.", {
                        outcome: "rejected",
                        reason: "summary_required",
                    });
                }
                try {
                    const checkpoint = recordPairCheckpointReport({ hostedSession, toolCallId, report });
                    return checkpointResult(
                        pairCheckpoint.formatReport(report, checkpoint.report.checkpointNumber),
                        {
                            outcome: "reported",
                            checkpointId: checkpoint.report.checkpointId,
                            checkpointNumber: checkpoint.report.checkpointNumber,
                            final: report.final,
                        },
                        true,
                    );
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    return checkpointResult(`pair_checkpoint report rejected: ${reason}.`, {
                        outcome: "rejected",
                        reason,
                    });
                }
            }

            const request = pairCheckpoint.prepareResolution(params);
            const current = readCurrentPairCheckpoint(hostedSession);
            if (!request.ok) {
                return checkpointResult(request.message, {
                    outcome: "rejected",
                    reason: request.reason,
                    ...(request.reason === "revision_direction_required"
                        ? { checkpointId: request.checkpointId }
                        : current
                          ? { checkpointId: current.report.checkpointId }
                          : {}),
                });
            }
            const { checkpointId, decision, revisionDirection } = request;
            const nextWorkflow = nextWorkflowForDecision(workflow, decision);
            const resolved = resolvePairCheckpoint({
                hostedSession,
                checkpointId,
                decision,
                workflow: nextWorkflow,
                ...(revisionDirection ? { revisionDirection } : {}),
            });
            if (!resolved.ok) {
                return checkpointResult(`pair_checkpoint resolve rejected: ${resolved.reason}.`, {
                    outcome: "rejected",
                    reason: resolved.reason,
                    checkpointId,
                });
            }
            hostedSession.setActiveExecutionWorkflow(nextWorkflow);
            await recordWorkflowMetric(
                {
                    category: "execution",
                    event: "pair_checkpoint_decided",
                    details: {
                        checkpointNumber: resolved.checkpoint.report.checkpointNumber,
                        decision,
                    },
                },
                hostedSession.cwd,
            );

            const text =
                decision === "revise"
                    ? `Apply the user's revision direction: ${revisionDirection}`
                    : decision === "continue"
                      ? resolved.checkpoint.report.report.final
                          ? "Final Pair checkpoint accepted. Call task_completed with the verified completion report."
                          : "Continue to the next coherent increment, then report a fresh Pair checkpoint."
                      : decision === "switch_to_autonomous"
                        ? "Continue autonomously. Pair checkpoints are no longer required; typed task completion remains required."
                        : "Stop Pair Execution now. Keep the Plan In Progress and preserve the work.";
            return checkpointResult(
                text,
                {
                    outcome: "resolved",
                    checkpointId,
                    checkpointNumber: resolved.checkpoint.report.checkpointNumber,
                    decision,
                    ...(revisionDirection ? { revisionDirection } : {}),
                },
                decision === "stop",
            );
        },
    });
}
