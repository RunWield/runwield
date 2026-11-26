import { toolRegistry } from "@runwield/tools";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { HostedSession } from "@runwield/session-runtime/host";
import { checkBashCommand, describeBashAllowedCommands } from "../shared/bash-command-policy.ts";
import type { BashAllowedCommands } from "../shared/bash-command-policy.ts";

const backgroundTask = toolRegistry.get("background_task");

/** Shell start requires the caller's effective bash authority. Controls do not. */
export function createBackgroundTaskTool(options: {
    hostedSession: HostedSession;
    cwd: string;
    allowShellStart: boolean;
    allowedCommands?: BashAllowedCommands;
}) {
    return defineTool({
        ...backgroundTask.definition,

        description: backgroundTask.definition.description + describeBashAllowedCommands(options.allowedCommands),

        async execute(_toolCallId, params) {
            try {
                if (params.action === "start" && !options.allowShellStart) {
                    throw new Error("Shell start requires effective bash authority.");
                }
                const request = backgroundTask.prepare(params);
                if (request.action === "start") {
                    checkBashCommand(request.command, options.allowedCommands);
                    const status = options.hostedSession.backgroundTasks.startShell({
                        command: request.command,
                        cwd: options.cwd,
                        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
                    });
                    return { content: [{ type: "text" as const, text: JSON.stringify(status) }], details: status };
                }
                const status =
                    request.action === "cancel"
                        ? await options.hostedSession.backgroundTasks.cancel(request.taskId)
                        : options.hostedSession.backgroundTasks.status(request.taskId);
                return { content: [{ type: "text" as const, text: JSON.stringify(status) }], details: status };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return {
                    content: [{ type: "text" as const, text: `Background task failed: ${message}` }],
                    details: null,
                    isError: true,
                };
            }
        },
    });
}
