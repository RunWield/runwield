import { runAttachedMcpServer as runSharedAttachedMcpServer } from "../mcp.ts";
import plugin from "./plugin/.claude-plugin/plugin.json" with { type: "json" };
import adapter from "./plugin/runwield-adapter.json" with { type: "json" };

/** Preserve Claude's existing launch path while sharing all MCP framing. */
export async function runAttachedMcpServer(projectRoot: string, version: string): Promise<void> {
    await runSharedAttachedMcpServer(projectRoot, version, "claude-code", { ...plugin, ...adapter });
}
