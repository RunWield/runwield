import { toolRegistry } from "@runwield/tools";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { HostedSession } from "@runwield/session-runtime/host";
import { workflowEvents } from "@runwield/workflow/events";

const workRecordCompleted = toolRegistry.get("work_record_completed");

export function createWorkRecordCompletedTool(hostedSession: HostedSession) {
    return defineTool({
        ...workRecordCompleted.definition,

        execute(toolCallId, sections) {
            const problem = workRecordCompleted.validateSections(sections);
            if (problem) {
                return Promise.resolve({
                    content: [{ type: "text", text: problem }],
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
