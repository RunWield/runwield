/** CLI/browser command composition. Core uses the runtime registry without browser launch handlers. */
import type { CommandDefinition } from "./registry.js";
export * from "./registry.js";
import { commandRegistry as runtimeCommands, hasCommandSurface, COMMAND_NAMES } from "./registry.js";
import { runPlansCommand } from "./plans/index.ts";
import { runWorkspaceCommand } from "./workspace/index.ts";

export const commandRegistry: Record<string, CommandDefinition> = {
    ...runtimeCommands,
    [COMMAND_NAMES.PLANS]: { ...runtimeCommands[COMMAND_NAMES.PLANS], execute: runPlansCommand },
    [COMMAND_NAMES.WORKSPACE]: { ...runtimeCommands[COMMAND_NAMES.WORKSPACE], execute: runWorkspaceCommand },
};

/** @param {string | undefined} commandName */
export function getCommandDefinition(commandName: string | undefined) {
    if (!commandName) return undefined;
    return (
        commandRegistry[commandName] ||
        Object.values(commandRegistry).find((command) => command.aliases?.includes(commandName))
    );
}

export function getCliCommandDefinitions() {
    return Object.values(commandRegistry).filter((command) => hasCommandSurface(command, "cli"));
}

/** @param {"tui" | "acp" | "workspace"} [slashSurface] */
export function getSlashCommandDefinitions(slashSurface: "tui" | "acp" | "workspace" = "tui") {
    return Object.values(commandRegistry).filter((command) => hasCommandSurface(command, "slash", slashSurface));
}

/** @param {string | undefined} commandName @param {"tui" | "acp" | "workspace"} [slashSurface] */
export function getSlashCommandDefinition(
    commandName: string | undefined,
    slashSurface: "tui" | "acp" | "workspace" = "tui",
) {
    const command = getCommandDefinition(commandName);
    return command && hasCommandSurface(command, "slash", slashSurface) ? command : undefined;
}
