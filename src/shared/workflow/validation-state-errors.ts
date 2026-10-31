import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { join } from "node:path";
import { getHomeDir } from "../../constants.js";
import { remoteBackgroundTaskLogDirectory } from "../remote/background-task-logs.ts";

export type ValidationStateProblem = "plan_missing" | "unknown_plan_status";

export class ValidationStateError extends Error {
    constructor(readonly code: ValidationStateProblem) {
        super(code);
        this.name = "ValidationStateError";
    }
}

/** Diagnostics must never write over the TUI or prevent recovery. */
export async function logValidationFailure(error: Error, operation: string): Promise<void> {
    try {
        // Workflow diagnostics can carry Session context. In remote mode, keep
        // them with connection-owned transient output, not remote account history.
        const remoteLogs = remoteBackgroundTaskLogDirectory();
        const directory = remoteLogs ? join(remoteLogs, "debug") : join(getHomeDir(), ".wld", "debug");
        await fsMkdir(directory, { recursive: true });
        await fsWriteFile(
            join(directory, "validation-errors.jsonl"),
            JSON.stringify({
                at: new Date().toISOString(),
                operation,
                name: error.name,
                message: error.message,
                stack: error.stack,
            }) + "\n",
            { flag: "a" },
        );
    } catch {
        // A full disk or unavailable home must not mask the original failure.
    }
}
