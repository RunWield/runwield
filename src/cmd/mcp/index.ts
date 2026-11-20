import process from "node:process";
import type { SessionRuntime } from "../../shared/session/session-runtime.ts";
import type { UiAPI } from "../../ui/tui/api.ts";

interface McpCommandContext {
    sessionId?: string;
    sessionRuntime?: SessionRuntime;
    uiAPI?: UiAPI;
}

export async function runMcpCommand(argv: string[], context: McpCommandContext = {}): Promise<void> {
    if (context.sessionId && context.sessionRuntime && context.uiAPI) {
        const result = await context.sessionRuntime.runMcpCommand(context.sessionId, argv.join(" "));
        if (!result.ok) throw new Error(result.error || "MCP command failed.");
        for (const notification of result.notifications) context.uiAPI.appendSystemMessage(notification.message);
        return;
    }
    const first = argv[0] || "";
    if (first && first !== "--help" && first !== "-h" && first !== "help") {
        console.error(`[RunWield] Unknown shell MCP argument: ${first}. Use /mcp in a RunWield Session.`);
        process.exit(1);
    }
    console.log("MCP\n\nUse /mcp in a RunWield Session to inspect servers, or /mcp reconnect <server> to reconnect.");
}
