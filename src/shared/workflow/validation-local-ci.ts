/**
 * @module shared/workflow/validation-local-ci
 *
 * Runs the project's own validation command and captures its output.
 *
 * Output is captured as a bounded tail rather than buffered whole: a failing
 * build can emit far more than is useful, and the end is the part that explains
 * the failure. The captured streams report whether they were truncated so the
 * reader is never shown a partial log as if it were complete.
 */

import {
    getCustomSetting,
    getExactProjectCustomSetting,
    setCustomSetting,
    setExactProjectCustomSetting,
} from "../settings.js";
import { spawnForegroundShell } from "../foreground-process.ts";
import { captureValidationSettingsWrite, recordValidationSettingsWrite } from "../worktree-project-context.ts";
import {
    captureProcessStreamTail,
    formatCapturedProcessOutput,
    PROCESS_STREAM_OUTPUT_LIMIT_BYTES,
} from "./process-output.ts";
import {
    emitHostedSessionRuntimeEvent,
    emitSystemStatus,
    normalizeRuntimeToolResult,
    RuntimeEventTypes,
} from "../session/session-runtime-events.js";
import { describeRuntimeTool } from "../session/tool-event-title.js";
import { requestHostedSessionInteraction, RuntimeInteractionTypes } from "../session/session-runtime-interactions.js";
import { buildValidationUserMessage } from "./validation-user-messages.ts";
import { classifyValidationOperationalError } from "./validation-operational-errors.ts";

const VALIDATION_STREAM_OUTPUT_LIMIT_BYTES = PROCESS_STREAM_OUTPUT_LIMIT_BYTES;

export type ValidationCommandSettingsPolicy = "ordinary-project" | "exact-project";

/** Resolve the command, seeding a missing exact checkout setting from the project preference. */
export async function resolveValidationCommand(
    projectRoot: string,
    settingsPolicy: ValidationCommandSettingsPolicy = "ordinary-project",
): Promise<string> {
    const existingCommand =
        settingsPolicy === "exact-project"
            ? getExactProjectCustomSetting("verification_command", projectRoot)
            : getCustomSetting("verification_command", "project", projectRoot);
    if (typeof existingCommand === "string" && existingCommand.trim()) {
        return existingCommand;
    }

    // Init and ordinary settings writes belong to the primary checkout. A fresh
    // execution worktree may predate that write (or the settings are uncommitted).
    // Seed only the command, keeping checkout-local repairs authoritative.
    if (settingsPolicy === "exact-project") {
        const projectCommand = getCustomSetting("verification_command", "project", projectRoot);
        if (typeof projectCommand === "string" && projectCommand.trim()) {
            const settingsWrite = await captureValidationSettingsWrite(projectRoot);
            setExactProjectCustomSetting("verification_command", projectCommand, projectRoot);
            await recordValidationSettingsWrite(settingsWrite, projectCommand);
            return projectCommand;
        }
    }
    return "";
}

/** Save a user answer as a project preference and, when required, in the execution checkout. */
export async function saveValidationCommand(
    projectRoot: string,
    command: string,
    settingsPolicy: ValidationCommandSettingsPolicy = "ordinary-project",
): Promise<void> {
    const newCommand = command.trim();
    const settingsWrite = await captureValidationSettingsWrite(projectRoot);
    // Save it in both places so repair/resume retains it and the repair Agent can
    // inspect or correct the exact command that failed in its own checkout.
    await setCustomSetting("verification_command", newCommand, "project", projectRoot);
    if (settingsPolicy === "exact-project") {
        setExactProjectCustomSetting("verification_command", newCommand, projectRoot);
    }
    await recordValidationSettingsWrite(settingsWrite, newCommand);
}

async function askForValidationCommand(
    hostedSession: import("../session/hosted-session.js").HostedSession,
    projectRoot: string,
    settingsPolicy: ValidationCommandSettingsPolicy,
): Promise<string> {
    emitSystemStatus(hostedSession, buildValidationUserMessage({ kind: "validation_command_missing" }));
    const response = await requestHostedSessionInteraction(
        hostedSession,
        {
            type: RuntimeInteractionTypes.TEXT,
            prompt: buildValidationUserMessage({ kind: "validation_command_prompt" }),
            allowEmpty: false,
        },
        undefined,
        hostedSession.getManagedOperationCapability?.() || null,
    );
    const userInput = response.outcome === "text" ? String(response.value || "") : "";

    if (!userInput) {
        return "";
    }

    const newCommand = userInput.trim();
    await saveValidationCommand(projectRoot, newCommand, settingsPolicy);

    emitSystemStatus(
        hostedSession,
        buildValidationUserMessage({ kind: "validation_command_saved", command: newCommand }),
    );
    return newCommand;
}

/** Spawns the local validation step. */
export type LocalCIResult =
    | { kind: "completed"; exitCode: number; output: string; timedOut?: boolean }
    | { kind: "canceled"; output: string }
    | {
          kind: "operational_failure";
          failure: import("./validation-operational-errors.ts").ValidationOperationalFailure;
          output: string;
      };

export type ValidationCommandResult = LocalCIResult | { kind: "command_missing" };

export interface ValidationCommandOptions {
    cwd: string;
    settingsPolicy?: ValidationCommandSettingsPolicy;
    signal?: AbortSignal;
    /** Observe the selected command before it starts; this does not replace execution. */
    onCommandStart?: (command: string) => void;
}

export interface LocalCIOptions {
    hostedSession: import("../session/hosted-session.js").HostedSession;
    cwd: string;
    settingsPolicy?: ValidationCommandSettingsPolicy;
}

export interface LocalCIPort {
    run(args: LocalCIOptions): Promise<LocalCIResult>;
}

/** Run configured validation without a Session, prompt, or runtime events. */
export async function runValidationCommand({
    cwd,
    settingsPolicy = "ordinary-project",
    signal,
    onCommandStart,
}: ValidationCommandOptions): Promise<ValidationCommandResult> {
    if (!cwd) throw new Error("runValidationCommand: cwd is required");
    const command = await resolveValidationCommand(cwd, settingsPolicy);
    if (signal?.aborted) return { kind: "canceled", output: "Validation canceled." };
    if (!command) return { kind: "command_missing" };

    onCommandStart?.(command);
    try {
        // The foreground-process module owns the wrapper shell's process group,
        // so cancellation terminates the whole CI tree and settles its pipes.
        const shell = spawnForegroundShell({ command, cwd, signal });
        const [outcome, stdout, stderr] = await Promise.all([
            shell.done,
            captureProcessStreamTail(shell.stdout, VALIDATION_STREAM_OUTPUT_LIMIT_BYTES),
            captureProcessStreamTail(shell.stderr, VALIDATION_STREAM_OUTPUT_LIMIT_BYTES),
        ]);
        const canceled = outcome.terminatedBy !== null;
        const output = canceled
            ? `${formatCapturedProcessOutput(stdout, stderr)}\nValidation canceled.\n`
            : formatCapturedProcessOutput(stdout, stderr);
        if (canceled) return { kind: "canceled", output };
        return { kind: "completed", exitCode: outcome.exitCode ?? 1, output };
    } catch (error) {
        const canceled = signal?.aborted;
        const reason = error instanceof Error ? error.message : String(error);
        const output = canceled ? "Validation canceled." : `Failed to spawn validation process: ${reason}`;
        if (canceled) return { kind: "canceled", output };
        return {
            kind: "operational_failure",
            output,
            failure: classifyValidationOperationalError({
                source: "local_process",
                kind: "process_start_failed",
                operation: "local_ci",
                message: output,
            }),
        };
    }
}

export async function runLocalCI({
    hostedSession,
    cwd,
    settingsPolicy = "ordinary-project",
}: LocalCIOptions): Promise<LocalCIResult> {
    if (!cwd) throw new Error("runLocalCI: cwd is required");
    if (!hostedSession) throw new Error("runLocalCI: hostedSession is required");
    const toolCallId = `validation-ci-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const interactionId = `validation-ci:${toolCallId}`;
    const abortController = new AbortController();
    hostedSession.addActiveInteraction(interactionId, { abortController });
    try {
        let runtimeTool: ReturnType<typeof describeRuntimeTool> | undefined;
        let startTime = 0;
        const commandOptions: ValidationCommandOptions = {
            cwd,
            settingsPolicy,
            signal: abortController.signal,
            onCommandStart(command) {
                runtimeTool = describeRuntimeTool("bash", { command });
                emitHostedSessionRuntimeEvent(hostedSession, {
                    type: RuntimeEventTypes.TOOL_START,
                    toolCallId,
                    ...runtimeTool,
                    args: { command },
                });
                startTime = Date.now();
            },
        };
        let result = await runValidationCommand(commandOptions);
        if (result.kind === "command_missing") {
            const command = await askForValidationCommand(hostedSession, cwd, settingsPolicy);
            if (abortController.signal.aborted) return { kind: "canceled", output: "Validation canceled." };
            if (command) result = await runValidationCommand(commandOptions);
        }
        if (result.kind === "command_missing") {
            const output =
                "RunWield could not auto-detect a build or test command for this repository. Set a validation command and retry.";
            return {
                kind: "operational_failure",
                output,
                failure: classifyValidationOperationalError({
                    source: "local_process",
                    kind: "command_missing",
                    operation: "local_ci",
                    message: output,
                }),
            };
        }
        if (runtimeTool) {
            const output =
                result.kind === "operational_failure" ||
                (result.kind === "canceled" && result.output === "Validation canceled.")
                    ? `${result.output}\n`
                    : result.output.trim()
                      ? result.output
                      : "(no output)\n";
            emitHostedSessionRuntimeEvent(hostedSession, {
                type: RuntimeEventTypes.TOOL_END,
                toolCallId,
                ...runtimeTool,
                ...normalizeRuntimeToolResult(output),
                isError: result.kind !== "completed" || result.exitCode !== 0,
                durationMs: Date.now() - startTime,
            });
        }
        return result;
    } finally {
        // Covers command setup as well as the process tree and output streams.
        // Reached only after the process tree and both streams have settled, so
        // Escape cannot unregister the interaction while a descendant still runs.
        hostedSession.removeActiveInteraction(interactionId);
    }
}

export const systemLocalCIPort: LocalCIPort = { run: runLocalCI };
