import type { McpIntegrationServer } from "@runwield/pi-ai/mcp";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { getSettingsDir, getSettingsManager } from "../settings.ts";

export function mcpFixtureHost(cwd: string) {
    return { cwd, agentDir: getSettingsDir("global"), settingsManager: getSettingsManager(cwd) };
}

export function mcpFixtureServer(env: Record<string, string> = {}): McpIntegrationServer {
    return {
        name: "fixture",
        command: process.execPath,
        args: runtimeSourceArgs(["run", "-A", fileURLToPath(new URL("./fixture-server.ts", import.meta.url))]),
        env,
        source: "request",
    };
}
