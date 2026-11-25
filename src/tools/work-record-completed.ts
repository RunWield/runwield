import { toolRegistry } from "@runwield/tools";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { HostedSession } from "../shared/session/hosted-session.ts";
import { workflowEvents } from "@runwield/workflow/events";

const definition = toolRegistry.get("work_record_completed").definition;

export function createWorkRecordCompletedTool(hostedSession: HostedSession) {
    return defineTool({
        ...definition,

        execute(toolCallId, sections) {
            if (!sections.title.trim() || !sections.summary.trim()) {
                return Promise.resolve({
                    content: [{ type: "text", text: "Provide a non-empty title and summary." }],
                    details: { accepted: false },
                    terminate: false,
                });
            }
            workflowEvents(hostedSession).publish({ toolCallId, kind: "work_record_completed", payload: sections });
            return Promise.resolve({
                content: [{ type: "text", text: "Work Record sections accepted." }],
                details: { accepted: true, ...sections },
                terminate: true,
            });
        },
    });
}
