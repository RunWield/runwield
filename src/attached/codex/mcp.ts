import { runAttachedMcpServer as runSharedAttachedMcpServer, type AttachedAdapterManifest } from "../mcp.ts";
import plugin from "./plugin/.codex-plugin/plugin.json" with { type: "json" };
import descriptor from "./plugin/runwield-adapter.json" with { type: "json" };

/** Codex's installed launch metadata overrides the descriptor used for direct development launches. */
export async function runAttachedMcpServer(
    projectRoot: string,
    version: string,
    adapter: AttachedAdapterManifest = { ...plugin, ...descriptor },
): Promise<void> {
    await runSharedAttachedMcpServer(projectRoot, version, "codex", adapter);
}
