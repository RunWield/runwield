import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { HostedSession } from "../shared/session/hosted-session.js";
import { publishWorkflowToolEvent } from "../shared/workflow/workflow-tool-events.ts";

const parameters = Type.Object(
    {
        title: Type.String({ minLength: 1 }),
        summary: Type.String({ minLength: 1 }),
        outOfScope: Type.Optional(Type.String()),
        futurePlanningNotes: Type.Optional(Type.String()),
        supersessionProposals: Type.Optional(
            Type.Array(
                Type.Object({
                    recordId: Type.String({
                        pattern:
                            "^\\s*[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\\s*$",
                    }),
                    reason: Type.String({ minLength: 1 }),
                }),
            ),
        ),
    },
    { additionalProperties: false },
);

export function createWorkRecordCompletedTool(hostedSession: HostedSession) {
    return defineTool({
        name: "work_record_completed",
        label: "Work Record Completed",
        description: "Submit the completed Work Record sections.",
        parameters,
        execute(toolCallId, sections) {
            if (!sections.title.trim() || !sections.summary.trim()) {
                return Promise.resolve({
                    content: [{ type: "text", text: "Provide a non-empty title and summary." }],
                    details: { accepted: false },
                    terminate: false,
                });
            }
            publishWorkflowToolEvent({ hostedSession, toolCallId, kind: "work_record_completed", payload: sections });
            return Promise.resolve({
                content: [{ type: "text", text: "Work Record sections accepted." }],
                details: { accepted: true, ...sections },
                terminate: true,
            });
        },
    });
}
