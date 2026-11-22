/**
 * @module triage-report
 * Custom tool for emitting a structured Triage Report.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { HostedSession } from "../shared/session/hosted-session.ts";
import { toolRegistry, type TriageOutcome } from "@runwield/tools";
import { emitSystemStatus } from "../shared/session/session-runtime-events.ts";
import { recordWorkflowMetric } from "../shared/workflow/metrics.ts";
import { publishWorkflowToolEvent } from "../shared/workflow/workflow-tool-events.ts";

type TriageReportResult = AgentToolResult<TriageOutcome> & { terminate: boolean };

interface TriageReportToolOptions {
    hostedSession?: HostedSession | null;
}

export function createTriageReportTool({ hostedSession }: TriageReportToolOptions = {}) {
    const tool = toolRegistry.get("triage_report");
    return defineTool<typeof tool.definition.parameters, TriageOutcome>({
        ...tool.definition,
        async execute(toolCallId, params): Promise<TriageReportResult> {
            const details = tool.report(params);
            const { routingIntent, complexity, summary, workKind } = details;

            try {
                hostedSession?.setWorkflowTriageContext?.({ routingIntent, complexity, summary });
            } catch (_caught) {
                // Footer-context persistence is fail-open and must not block triage.
            }

            const triageLines = [
                `Routing Intent: ${routingIntent}`,
                ...(workKind ? [`Work Kind: ${workKind}`] : []),
                `Complexity: ${complexity}`,
                `Summary: ${summary}`,
            ];
            if (hostedSession) {
                await recordWorkflowMetric(
                    {
                        category: "routing",
                        event: "triage_reported",
                        details: {
                            routingIntent,
                            complexity,
                            classification: details.classification,
                            workKind: details.workKind,
                        },
                    },
                    hostedSession.cwd,
                );
                publishWorkflowToolEvent({
                    hostedSession,
                    toolCallId,
                    kind: "triage_report",
                    payload: details,
                });
                if (!hostedSession.isAgentTransitioning()) hostedSession.beginAgentTransition();
            }
            emitSystemStatus(hostedSession || undefined, `\n\n${triageLines.join("\n")}`, { header: "Triage" });

            return {
                content: [
                    {
                        type: "text",
                        text: `Triage complete.`,
                    },
                ],
                details,
                terminate: true,
            };
        },
    });
}
