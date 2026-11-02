import { Type } from "typebox";
import { type AgentToolResult, defineTool } from "@earendil-works/pi-coding-agent";
import { appendEpicManualQaSection } from "../shared/epic-artifacts.ts";
import { publishWorkflowToolEvent } from "../shared/workflow/workflow-tool-events.ts";
import type { HostedSession } from "../shared/session/hosted-session.js";

const TOOL_PARAMS = Type.Object(
    {
        checklistMarkdown: Type.String({
            minLength: 1,
            description:
                "Markdown checklist starting with 'Manual verification steps for <child plan>' and 1 to 6 unchecked items.",
        }),
    },
    { additionalProperties: false },
);

type QaChecklistGeneratedDetails = {
    outcome: "recorded" | "already_present" | "rejected";
    relativePath?: string;
    reason?: string;
};

type QaChecklistGeneratedResult = AgentToolResult<QaChecklistGeneratedDetails>;

export type QaChecklistGeneratedToolOptions = {
    projectRoot: string;
    epicPlanName: string;
    childPlanName: string;
    childHeading: string;
    hostedSession?: HostedSession;
};

export function createQaChecklistGeneratedTool(options: QaChecklistGeneratedToolOptions) {
    const tool = defineTool<typeof TOOL_PARAMS, QaChecklistGeneratedDetails>({
        name: "qa_checklist_generated",
        exposure: "model-only",
        label: "QA Checklist Generated",
        description:
            "Record this Epic child's Manual QA checklist in the Epic artifact. This tool is advisory only: failure never changes verification status.",
        parameters: TOOL_PARAMS,
        async execute(toolCallId, params): Promise<QaChecklistGeneratedResult> {
            try {
                const result = await appendEpicManualQaSection({
                    projectRoot: options.projectRoot,
                    epicPlanName: options.epicPlanName,
                    childPlanName: options.childPlanName,
                    childHeading: options.childHeading,
                    checklistMarkdown: params.checklistMarkdown,
                });
                const details = { outcome: result.status, relativePath: result.relativePath };
                if (options.hostedSession) {
                    publishWorkflowToolEvent({
                        hostedSession: options.hostedSession,
                        toolCallId,
                        kind: "qa_checklist_generated",
                        payload: {
                            outcome: result.status,
                            qaName: options.childPlanName,
                            artifactPath: result.relativePath,
                        },
                    });
                }
                return {
                    content: [
                        {
                            type: "text",
                            text:
                                result.status === "already_present"
                                    ? `Manual QA checklist already exists in ${result.relativePath}.`
                                    : `Manual QA checklist recorded in ${result.relativePath}.`,
                        },
                    ],
                    details,
                };
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                return {
                    content: [{ type: "text", text: `Manual QA checklist was not recorded: ${reason}` }],
                    details: { outcome: "rejected", reason },
                };
            }
        },
    });
    Object.assign(tool, { __runwieldQaChecklistOptions: options });
    return tool;
}
