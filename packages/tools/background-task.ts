import type { Static } from "typebox";
import type { backgroundTaskDefinition } from "./definitions/background-task.ts";

type BackgroundTaskParameters = Static<typeof backgroundTaskDefinition.parameters>;

export type PreparedBackgroundTask =
    { action: "start"; command: string; timeoutMs?: number } | { action: "cancel" | "status"; taskId: string };

/** Validate the fields for the selected action and convert a start timeout to milliseconds. */
export function prepareBackgroundTask(params: BackgroundTaskParameters): PreparedBackgroundTask {
    const { action, task_id, command, timeout } = params;
    if (action === "start") {
        if (!command?.trim() || task_id !== undefined) {
            throw new Error("Start requires command and no task_id.");
        }
        if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2_147_483_647)) {
            throw new Error("Timeout must be a positive finite number of seconds.");
        }
        return { action, command, ...(timeout === undefined ? {} : { timeoutMs: timeout * 1000 }) };
    }
    if (!task_id || command !== undefined || timeout !== undefined) {
        throw new Error(`${action} requires task_id and no command or timeout.`);
    }
    return { action, taskId: task_id };
}
