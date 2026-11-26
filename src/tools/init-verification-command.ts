import { toolRegistry } from "@runwield/tools";
import { type AgentToolResult, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { setCustomSetting } from "../shared/settings.ts";

const verificationTool = toolRegistry.get("init_save_verification_command");
const { definition } = verificationTool;

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

export function createInitVerificationCommandOperation(
    options: InitVerificationCommandOperationOptions,
): InitVerificationCommandOperation {
    let confirmedCommand: string | undefined;
    let confirmedSetupCommand: string | undefined;
    const tool = defineTool<typeof definition.parameters, InitVerificationCommandDetails>({
        ...definition,

        async execute(_toolCallId, params): Promise<InitVerificationCommandResult> {
            const prepared = verificationTool.prepare(params);
            if (!prepared.ok) return reject(prepared.reason);

            const { verificationCommand: command, setupCommand } = prepared;
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
