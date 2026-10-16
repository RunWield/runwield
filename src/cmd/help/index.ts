import process from "node:process";
/**
 * @module cmd/help
 * Global and command-specific help command.
 */

import { parseArgs } from "../../shared/cli-args.ts";
import { CLI_BIN } from "../../constants.js";
import { getCliCommandDefinitions, getCommandDefinition, getSlashCommandDefinitions } from "../registry.js";

interface HelpCommandUi {
    appendSystemMessage(message: string, isError?: boolean): void;
}

interface HelpCommandOptions {
    uiAPI?: HelpCommandUi;
    slashSurface?: "tui" | "acp" | "workspace";
}

function formatGlobalHelp(slashSurface?: "tui" | "acp" | "workspace"): string {
    const lines = [
        "RunWield — Plan-by-Default Coding Harness",
        "",
        "Usage:",
        `  ${CLI_BIN} "<user request>"`,
        `  ${CLI_BIN} --continue "<optional message>"`,
        `  ${CLI_BIN} <command> [args]`,
        "",
        "Commands:",
    ];

    const commands = slashSurface ? getSlashCommandDefinitions(slashSurface) : getCliCommandDefinitions();
    const nameWidth = Math.max(...commands.map((command) => command.name.length));
    for (const command of commands) lines.push(`  ${command.name.padEnd(nameWidth)} ${command.summary}`);

    lines.push(
        "",
        "Global flags:",
        "  --continue, -c   Continue newest saved session (default startup route only)",
        "  --help, -h       Show global help or command help",
        "  --version, -v    Print version and target architecture",
        "  --mode acp       Start the ACP stdio adapter (stdout reserved for protocol frames)",
        "",
        "Help:",
        `  ${CLI_BIN} help`,
        `  ${CLI_BIN} help <command>`,
        `  ${CLI_BIN} --help <command>`,
        `  ${CLI_BIN} <command> --help`,
    );
    return lines.join("\n");
}

export function formatCommandHelp(commandName: string): string | null {
    const command = getCommandDefinition(commandName);
    if (!command) return null;

    const lines = [`Usage (${command.name}):`];
    for (const line of command.usage) lines.push(`  ${line}`);

    if (command.notes && command.notes.length > 0) {
        lines.push("", "Notes:");
        for (const note of command.notes) lines.push(`  - ${note}`);
    }

    return lines.join("\n");
}

export function printGlobalHelp(): void {
    console.log(formatGlobalHelp());
}

export function printCommandHelp(commandName: string): boolean {
    const message = formatCommandHelp(commandName);
    if (!message) return false;
    console.log(message);
    return true;
}

export async function runHelpCommand(argv: string[], options: HelpCommandOptions = {}): Promise<void> {
    await Promise.resolve();

    const parsed = parseArgs(argv, {
        boolean: ["help"],
        alias: { h: "help" },
    });
    const [commandName] = parsed._.map(String);

    if (options.uiAPI) {
        const message = commandName ? formatCommandHelp(commandName) : formatGlobalHelp(options.slashSurface);
        if (message) {
            options.uiAPI.appendSystemMessage(message);
            return;
        }
        options.uiAPI.appendSystemMessage(`[RunWield] Unknown command for help: ${commandName}`, true);
        return;
    }

    const found = commandName ? printCommandHelp(commandName) : false;
    if (!found && commandName) {
        console.error(`[RunWield] Unknown command for help: ${commandName}`);
        console.log();
        process.exit(1);
    }

    if (!commandName) printGlobalHelp();
}
