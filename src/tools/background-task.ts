import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { HostedSession } from "../shared/session/hosted-session.js";
import { checkBashCommand, describeBashAllowedCommands } from "../shared/bash-command-policy.ts";
import type { BashAllowedCommands } from "../shared/bash-command-policy.ts";

const PARAMETERS = Type.Object(
    {
        action: Type.Enum(["start", "status", "cancel"]),
        command: Type.Optional(Type.String()),
        task_id: Type.Optional(Type.String()),
        timeout: Type.Optional(Type.Number({ description: "Optional positive timeout in seconds." })),
    },
    { additionalProperties: false },
);

/** Shell start requires the caller's effective bash authority. Controls do not. */
export function createBackgroundTaskTool(options: {
    hostedSession: HostedSession;
    cwd: string;
    allowShellStart: boolean;
    allowedCommands?: BashAllowedCommands;
}) {
    return defineTool({
        name: "background_task",
        label: "Background Task",
        description:
            "Start an independent shell command, or check or cancel a Session background task. A start is not a passed test; inspect the final result. " +
            describeBashAllowedCommands(options.allowedCommands),
        parameters: PARAMETERS,
        async execute(_toolCallId, params) {
            try {
                const { action, task_id, command, timeout } = params;
                if (action === "start") {
                    if (!options.allowShellStart) throw new Error("Shell start requires effective bash authority.");
                    if (!command?.trim() || task_id !== undefined) {
                        throw new Error("Start requires command and no task_id.");
                    }
                    if (
                        timeout !== undefined &&
                        (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2_147_483_647)
                    ) {
                        throw new Error("Timeout must be a positive finite number of seconds.");
                    }
                    checkBashCommand(command, options.allowedCommands);
                    const status = options.hostedSession.backgroundTasks.startShell({
                        command,
                        cwd: options.cwd,
                        ...(timeout === undefined ? {} : { timeoutMs: timeout * 1000 }),
                    });
                    return { content: [{ type: "text" as const, text: JSON.stringify(status) }], details: status };
                }
                if (!task_id || command !== undefined || timeout !== undefined) {
                    throw new Error(`${action} requires task_id and no command or timeout.`);
                }
                const status =
                    action === "cancel"
                        ? await options.hostedSession.backgroundTasks.cancel(task_id)
                        : options.hostedSession.backgroundTasks.status(task_id);
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
