import { toolRegistry } from "@runwield/tools";
import { defineTool, type SessionManager } from "@earendil-works/pi-coding-agent";
import { emitAssistantMessage, type HostedSession } from "@runwield/session-runtime/host";
import { recordManualQaChecklistMessage } from "../shared/session/workflow-messages.ts";
import { workflowEvents } from "@runwield/workflow/events";

const manualQa = toolRegistry.get("manual_qa_completed");

type ManualQaOptions = {
    hostedSession: HostedSession;
    name: string;
    classification: "QUICK_FIX" | "PLANNED_CHANGE";
};

export function createManualQaCompletedTool(options: ManualQaOptions) {
    return defineTool({
        ...manualQa.definition,

        execute(toolCallId, params) {
            const text = manualQa.prepareChecklist(params.checklistMarkdown);
            if (!text) {
                return Promise.resolve({
                    content: [{ type: "text" as const, text: "Provide the checklist." }],
                    details: { accepted: false },
                });
            }
            recordManualQaChecklistMessage(options.hostedSession.getRootSessionManager() as SessionManager | null, {
                agentName: "Operator",
                toolCallId,
                text,
                name: options.name,
                classification: options.classification,
            });
            emitAssistantMessage(options.hostedSession, "operator", text, {
                messageKind: "workflow",
                workflowMessage: "manual_qa_completed",
                toolCallId,
            });
            workflowEvents(options.hostedSession).publish({
                toolCallId,
                kind: "manual_qa_completed",
                payload: { checklistMarkdown: text },
            });
            return Promise.resolve({
                content: [{ type: "text", text: "Manual QA checklist saved." }],
                details: { accepted: true, checklistMarkdown: text },
                terminate: true,
            });
        },
    });
}
