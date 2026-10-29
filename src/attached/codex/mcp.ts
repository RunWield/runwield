import { runAttachedMcpServer as runSharedAttachedMcpServer, type AttachedAdapterManifest } from "../mcp.ts";

/** Codex's installed launch metadata overrides the descriptor used for direct development launches. */
export async function runAttachedMcpServer(
    projectRoot: string,
    version: string,
    adapter: AttachedAdapterManifest = { version: "0.1.0", adapterContract: 1 },
): Promise<void> {
    await runSharedAttachedMcpServer(projectRoot, version, "codex", adapter);
}
