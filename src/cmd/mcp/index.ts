import process from "node:process";
import { runAgyCliMcpSetupPrompt } from "../../shared/session/backends/agy-cli/mcp-setup.ts";
import { runRunWieldMcpStdioTransport } from "../../shared/session/bridged-tools/stdio-transport.ts";
import type { SessionRuntime } from "../../shared/session/session-runtime.ts";
import type { UiAPI } from "../../ui/tui/types.js";

interface McpCommandContext {
    sessionId?: string;
    sessionRuntime?: SessionRuntime;
    uiAPI?: UiAPI;
}

function usageError(message: string): never {
    console.error(`[RunWield] ${message}`);
    console.error("Usage: wld mcp agy-cli [--setup]");
    process.exit(1);
}

function printMcpHelp(): void {
    console.log([
        "MCP",
        "",
        "Run a protocol-only MCP stdio adapter for an external CLI backend.",
        "",
        "Usage:",
        "  wld mcp agy-cli",
        "  wld mcp agy-cli --setup",
        "  wld mcp --help",
    ].join("\n"));
}

export async function runMcpCommand(argv: string[], context: McpCommandContext = {}): Promise<void> {
    if (context.sessionId && context.sessionRuntime && context.uiAPI) {
        if (argv[0] === "agy-cli") {
            context.uiAPI.appendSystemMessage("Use wld mcp agy-cli from a shell to run the stdio adapter.");
            return;
        }
        const result = await context.sessionRuntime.runMcpCommand(context.sessionId, argv.join(" "));
        if (!result.ok) throw new Error(result.error || "MCP command failed.");
        for (const notification of result.notifications) context.uiAPI.appendSystemMessage(notification.message);
        return;
    }
    const first = argv[0] || "";
    if (!first || first === "--help" || first === "-h" || first === "help") {
        printMcpHelp();
        return;
    }
    if (first !== "agy-cli") usageError(`Unknown MCP adapter: ${first}`);
    const options = argv.slice(1);
    if (options.length === 1 && options[0] === "--setup") {
        const code = await runAgyCliMcpSetupPrompt();
        if (code !== 0) process.exit(code);
        return;
    }
    if (options.length > 0) usageError(`Unknown MCP option: ${options[0]}`);
    await runRunWieldMcpStdioTransport();
}

export async function getMcpCompletions(argumentPrefix: string) {
    await Promise.resolve();
    const entries = [
        { value: "agy-cli", label: "agy-cli", description: "Run Antigravity CLI MCP stdio adapter" },
        { value: "--setup", label: "--setup", description: "Approve persistent Antigravity MCP setup" },
    ];
    return entries.filter((entry) => entry.value.startsWith(argumentPrefix));
}
