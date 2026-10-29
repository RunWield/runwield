/**
 * @module triage-report
 * Custom tool for emitting a structured Triage Report.
 */

import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { HostedSession } from "../shared/session/hosted-session.js";
import { ROUTING_INTENTS, WORK_KINDS } from "../constants.js";
import { emitSystemStatus } from "../shared/session/session-runtime-events.js";
import { recordWorkflowMetric } from "../shared/workflow/metrics.js";
import { publishWorkflowToolEvent } from "../shared/workflow/workflow-tool-events.ts";
import { normalizeTriageOutcome, TRIAGE_COMPLEXITIES, type TriageOutcome } from "../shared/workflow/triage-outcome.ts";

const PARAMETERS = Type.Object({
    routingIntent: Type.Optional(
        StringEnum(ROUTING_INTENTS, {
            description:
                "Canonical Routing Intent. INQUIRY: direct informational answer. IDEATION: explicit brainstorming/research/interview/PRD work. OPERATION: direct non-code repository/environment operation. QUICK_FIX: bounded no-plan code implementation. PLANNED_CHANGE: reviewed executable planned work. FEATURE is accepted only as a legacy planned-change workflow label. PROJECT: architecture/Epic plan. Router calls should provide this field; legacy direct calls may provide classification instead.",
        }),
    ),
    classification: Type.Optional(
        StringEnum(ROUTING_INTENTS, {
            description:
                "Legacy compatibility field. Use routingIntent for new calls. FEATURE here is accepted and normalized to PLANNED_CHANGE.",
        }),
    ),
    complexity: StringEnum([...TRIAGE_COMPLEXITIES], {
        description: "How complex is this request?",
    }),
    summary: Type.String({
        description: "Brief summary of the request and why it should route there.",
    }),
    sessionName: Type.Optional(
        Type.String({
            description:
                "Optional short 3-6 word Session Name. If omitted, the Agent can name the Session later via set_session_name.",
        }),
    ),
    workKind: Type.Optional(
        StringEnum(WORK_KINDS, {
            description:
                "Optional Work Kind for PLANNED_CHANGE. BUG_FIX for planned bug fixes, FEATURE for new/enhanced functionality, REFACTOR for structural changes, MAINTENANCE for upkeep, DOCUMENTATION for documentation creation or substantial documentation updates.",
        }),
    ),
});

type TriageReportResult = AgentToolResult<TriageOutcome> & { terminate: boolean };

interface TriageReportToolOptions {
    hostedSession?: HostedSession | null;
}

export function createTriageReportTool({ hostedSession }: TriageReportToolOptions = {}) {
    return defineTool<typeof PARAMETERS, TriageOutcome>({
        name: "triage_report",
        label: "Routing Intent Report",
        description:
            "Submit your Routing Intent for the user's request. " +
            "You MUST call this tool exactly once after enough discovery to route the request. " +
            "Clearly operational or informational requests may need no codebase exploration before routing. " +
            "Do not output the Routing Intent as freeform text — use this tool.",
        parameters: PARAMETERS,
        async execute(toolCallId, params): Promise<TriageReportResult> {
            const details = normalizeTriageOutcome(params);
            if (!details) {
                throw new TypeError("triage_report requires a valid canonical routingIntent, complexity, and summary");
            }
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
