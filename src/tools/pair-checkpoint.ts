/**
 * @module pair-checkpoint
 * Conversational checkpoints for Plan Pair Execution.
 */

import { toolRegistry } from "@runwield/tools";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ActiveExecutionWorkflow, HostedSession } from "../shared/session/hosted-session.ts";
import {
    type PairCheckpointDecision,
    type PairCheckpointReport,
    readCurrentPairCheckpoint,
    recordPairCheckpointReport,
    resolvePairCheckpoint,
} from "../shared/session/pair-checkpoint-session.ts";
import { recordWorkflowMetric } from "../shared/workflow/metrics.ts";

const definition = toolRegistry.get("pair_checkpoint").definition;

export type PairCheckpointDetails =
    | { outcome: "inactive"; reason: "pair_execution_inactive" | "pair_execution_paused" }
    | { outcome: "rejected"; reason: string; checkpointId?: string }
    | { outcome: "reported"; checkpointId: string; checkpointNumber: number; final: boolean }
    | {
          outcome: "resolved";
          checkpointId: string;
          checkpointNumber: number;
          decision: PairCheckpointDecision;
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

function formatReport(report: PairCheckpointReport, checkpointNumber: number): string {
    const lines = [
        `**Pair checkpoint ${checkpointNumber}${report.final ? " — final" : ""}.**`,
        "",
        "**Summary**",
        "",
        report.summary,
    ];
    if (report.route) lines.push("", "**Route**", "", report.route);
    if (report.state) lines.push("", "**State**", "", report.state);
    if (report.viewport) lines.push("", "**Viewport**", "", report.viewport);
    if (report.evidence?.length) {
        lines.push("", "**Evidence**", "", ...report.evidence.map((evidence) => `- ${evidence}`));
    }
    if (report.diagnostics) lines.push("", "**Diagnostics**", "", report.diagnostics);
    if (report.nextIncrement) lines.push("", "**Next increment**", "", report.nextIncrement);
    lines.push("", "Reply normally to ask a question, request a change, continue, stop, or switch to autonomous work.");
    return lines.join("\n");
}

function nextWorkflowForDecision(
    workflow: ActiveExecutionWorkflow,
    decision: PairCheckpointDecision,
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

            const action = params.action || (params.summary ? "report" : "resolve");
            if (action === "report") {
                if (workflow.pairPauseReason || workflow.pairStopRequested) {
                    return checkpointResult(
                        "Pair Execution is stopped. Resolve the current checkpoint from a later user turn before reporting more work.",
                        { outcome: "inactive", reason: "pair_execution_paused" },
                        true,
                    );
                }
                const summary = params.summary?.trim() || "";
                if (!summary) {
                    return checkpointResult("pair_checkpoint report rejected: summary is required.", {
                        outcome: "rejected",
                        reason: "summary_required",
                    });
                }
                const report: PairCheckpointReport = {
                    summary,
                    ...(params.route ? { route: params.route } : {}),
                    ...(params.state ? { state: params.state } : {}),
                    ...(params.viewport ? { viewport: params.viewport } : {}),
                    ...(params.evidence ? { evidence: [...params.evidence] } : {}),
                    ...(params.diagnostics ? { diagnostics: params.diagnostics } : {}),
                    ...(params.nextIncrement ? { nextIncrement: params.nextIncrement } : {}),
                    final: params.final === true,
                };
                try {
                    const checkpoint = recordPairCheckpointReport({ hostedSession, toolCallId, report });
                    return checkpointResult(
                        formatReport(report, checkpoint.report.checkpointNumber),
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

            const checkpointId = params.checkpointId?.trim() || "";
            const decision = params.decision;
            const current = readCurrentPairCheckpoint(hostedSession);
            if (!checkpointId || !decision) {
                return checkpointResult("pair_checkpoint resolve rejected: checkpointId and decision are required.", {
                    outcome: "rejected",
                    reason: "resolution_fields_required",
                    ...(current ? { checkpointId: current.report.checkpointId } : {}),
                });
            }
            const revisionDirection = params.revisionDirection?.trim() || "";
            if (decision === "revise" && !revisionDirection) {
                return checkpointResult("pair_checkpoint resolve rejected: revisionDirection is required for revise.", {
                    outcome: "rejected",
                    reason: "revision_direction_required",
                    checkpointId,
                });
            }
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
