import { Type } from "@earendil-works/pi-ai";
import { defineTool, type SessionManager } from "@earendil-works/pi-coding-agent";
import type { HostedSession } from "../shared/session/hosted-session.js";
import { recordManualQaChecklistMessage } from "../shared/session/workflow-messages.ts";
import { emitAssistantMessage } from "../shared/session/session-runtime-events.js";
import { publishWorkflowToolEvent } from "../shared/workflow/workflow-tool-events.ts";

type ManualQaOptions = {
    hostedSession: HostedSession;
    name: string;
    classification: "QUICK_FIX" | "PLANNED_CHANGE";
};
const parameters = Type.Object({ checklistMarkdown: Type.String({ minLength: 1 }) }, { additionalProperties: false });

export function createManualQaCompletedTool(options: ManualQaOptions) {
    return defineTool({
        name: "manual_qa_completed",
        label: "Manual QA Completed",
        description: "Submit the manual verification checklist. Call once when the checklist is complete.",
        parameters,
        execute(toolCallId, params) {
            const text = params.checklistMarkdown.trim();
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
            publishWorkflowToolEvent({
                hostedSession: options.hostedSession,
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
