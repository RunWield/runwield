import { toolRegistry } from "@runwield/tools";
import { type AgentToolResult, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { setCustomSetting } from "../shared/settings.ts";

const definition = toolRegistry.get("init_save_verification_command").definition;

export const INIT_VERIFICATION_COMMAND_PLACEHOLDER = 'echo "verification not implemented yet"';

interface InitVerificationCommandDetails {
    outcome: "saved" | "rejected";
    verificationCommand?: string;
    setupCommand?: string;
    reason?: string;
}

type InitVerificationCommandResult = AgentToolResult<InitVerificationCommandDetails>;

export interface InitVerificationCommandOperation {
    tool: ToolDefinition;
    getConfirmedCommand(): string | undefined;
    getConfirmedSetupCommand(): string | undefined;
}

export interface InitVerificationCommandOperationOptions {
    projectRoot: string;
}

function reject(reason: string): InitVerificationCommandResult {
    return {
        content: [{ type: "text", text: `Project commands were not saved: ${reason}` }],
        details: { outcome: "rejected", reason },
    };
}

function resolveVerificationCommand(params: { command?: string; verificationNotImplemented?: boolean }): string | null {
    const command = params.command?.trim() || "";
    const usesPlaceholder = params.verificationNotImplemented === true;

    if (usesPlaceholder && command) return null;
    if (!usesPlaceholder && !command) return null;
    if (usesPlaceholder) return INIT_VERIFICATION_COMMAND_PLACEHOLDER;
    return command;
}

export function createInitVerificationCommandOperation(
    options: InitVerificationCommandOperationOptions,
): InitVerificationCommandOperation {
    let confirmedCommand: string | undefined;
    let confirmedSetupCommand: string | undefined;
    const tool = defineTool<typeof definition.parameters, InitVerificationCommandDetails>({
        ...definition,

        async execute(_toolCallId, params): Promise<InitVerificationCommandResult> {
            const hasVerification = params.command !== undefined || params.verificationNotImplemented !== undefined;
            const command = hasVerification ? resolveVerificationCommand(params) : undefined;
            const setupCommand = params.setupCommand?.trim();
            if (command === null || (!hasVerification && setupCommand === undefined)) {
                return reject(
                    "Provide a non-empty verification command or verificationNotImplemented true, a setupCommand (empty means no setup), or both resolved commands.",
                );
            }

            if (command !== undefined) {
                await setCustomSetting("verification_command", command, "project", options.projectRoot);
                confirmedCommand = command;
            }
            if (setupCommand !== undefined) {
                await setCustomSetting("worktree_setup_command", setupCommand, "project", options.projectRoot);
                confirmedSetupCommand = setupCommand;
            }
            return {
                content: [
                    {
                        type: "text",
                        text: [
                            ...(command !== undefined ? [`Saved project verification command: ${command}`] : []),
                            ...(setupCommand !== undefined
                                ? [`Saved project worktree setup command: ${setupCommand || "(no setup required)"}`]
                                : []),
                        ].join("\n"),
                    },
                ],
                details: {
                    outcome: "saved",
                    ...(command !== undefined ? { verificationCommand: command } : {}),
                    ...(setupCommand !== undefined ? { setupCommand } : {}),
                },
            };
        },
    });

    return {
        tool,
        getConfirmedCommand: () => confirmedCommand,
        getConfirmedSetupCommand: () => confirmedSetupCommand,
    };
}

export const INIT_VERIFICATION_COMMAND_TOOL_NAME = definition.name;
