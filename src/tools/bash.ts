import { platform } from "node:process";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { checkBashCommand, describeBashAllowedCommands } from "../shared/bash-command-policy.ts";
import type { BashAllowedCommands } from "../shared/bash-command-policy.ts";
import { findWindowsBashPath } from "../shared/windows-bash.ts";

interface BashShellOptions {
    shellPath?: string;
    commandPrefix?: string;
}

/** Preserve Pi's shell execution contract and reject restricted commands before execution. */
export function createRunWieldBashToolDefinition(
    cwd: string,
    allowedCommands?: BashAllowedCommands,
    shellOptions?: BashShellOptions,
) {
    const shellPath = shellOptions?.shellPath || (platform === "win32" ? findWindowsBashPath() : undefined);
    const base = createBashToolDefinition(cwd, { ...shellOptions, shellPath });
    if (allowedCommands === undefined) return base;
    return {
        ...base,
        description: `${base.description}\n${describeBashAllowedCommands(allowedCommands)}`,
        promptSnippet: `${base.promptSnippet || base.description} ${describeBashAllowedCommands(allowedCommands)}`,
        execute: async (...args: Parameters<typeof base.execute>) => {
            checkBashCommand(args[1].command, allowedCommands);
            return await base.execute(...args);
        },
    };
}
