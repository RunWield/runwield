import { toolRegistry } from "@runwield/tools";
import { type AgentToolResult, defineTool } from "@earendil-works/pi-coding-agent";
import { workflowEpicArtifacts } from "../plan-store/index.ts";
import { workflowEvents } from "@runwield/workflow/events";
import type { HostedSession } from "../shared/session/hosted-session.ts";

const definition = toolRegistry.get("qa_checklist_generated").definition;

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
    const tool = defineTool<typeof definition.parameters, QaChecklistGeneratedDetails>({
        ...definition,

        async execute(toolCallId, params): Promise<QaChecklistGeneratedResult> {
            try {
                const artifacts = await workflowEpicArtifacts(options.projectRoot, options.epicPlanName);
                const result = await artifacts.appendManualQaSection(options.childPlanName, {
                    childHeading: options.childHeading,
                    checklistMarkdown: params.checklistMarkdown,
                });
                const details = { outcome: result.status, relativePath: result.relativePath };
                if (options.hostedSession) {
                    workflowEvents(options.hostedSession).publish({
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
