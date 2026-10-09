/**
 * @module cmd/session
 * Command to show current session information.
 */

import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { CommandContext } from "../registry.js";

import { theme } from "../../ui/theme/theme.js";

type SessionCompactionSettings = ReturnType<SettingsManager["getCompactionSettings"]>;

/**
 * Handle session info command.
 */
export async function runSessionCommand(_argv: string[], options: CommandContext = {}): Promise<void> {
    if (!options?.uiAPI) {
        console.error("The /session command is only available inside an interactive session.");
        return;
    }

    const { uiAPI, sessionRuntime, sessionId: runtimeSessionId } = options;
    const info = sessionRuntime && runtimeSessionId ? await sessionRuntime.getSessionInfo(runtimeSessionId) : null;
    if (!info) {
        uiAPI.appendSystemMessage("Error: No active session.");
        return;
    }
    if (info && typeof info === "object" && info.ok === false) {
        uiAPI.appendSystemMessage(`Error: Session info is unavailable (${info.error || "managed_read_blocked"}).`);
        return;
    }

    const {
        compactionCount,
        userMessages,
        assistantMessages,
        toolCalls,
        toolResults,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
    } = info;

    const totalMessages = userMessages + assistantMessages;
    const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

    const sessionName = info.name;
    const sessionFile = info.file;
    const sessionId = info.persistedId;
    // Runtime exposes only the enabled flag; the Pi settings include the token limits read below.
    const compactionSettings = info.compactionSettings as SessionCompactionSettings | null | undefined;
    const contextUsage = info.contextUsage;
    const contextWindow = contextUsage?.contextWindow;
    const autoThreshold = compactionSettings && typeof contextWindow === "number" && contextWindow > 0
        ? Math.max(0, contextWindow - compactionSettings.reserveTokens)
        : null;

    const lines = [];

    if (compactionCount > 0) {
        const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
        lines.push(`Session compacted ${times}`);
        lines.push("");
    }

    lines.push(theme.bold("Session Info"));
    lines.push("");
    if (sessionName) {
        lines.push(`${theme.fg("dim", "Name:")} ${sessionName}`);
    }
    lines.push(`${theme.fg("dim", "File:")} ${sessionFile}`);
    lines.push(`${theme.fg("dim", "ID:")} ${sessionId}`);
    lines.push("");

    lines.push(theme.bold("Messages"));
    lines.push(`${theme.fg("dim", "User:")} ${userMessages}`);
    lines.push(`${theme.fg("dim", "Assistant:")} ${assistantMessages}`);
    lines.push(`${theme.fg("dim", "Tool Calls:")} ${toolCalls}`);
    lines.push(`${theme.fg("dim", "Tool Results:")} ${toolResults}`);
    lines.push(`${theme.fg("dim", "Total:")} ${totalMessages}`);
    lines.push("");

    lines.push(theme.bold("Compaction"));
    const compactionTimes = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
    lines.push(`${theme.fg("dim", "Compacted:")} ${compactionTimes}`);
    if (compactionSettings) {
        lines.push(`${theme.fg("dim", "Auto-compact:")} ${compactionSettings.enabled ? "enabled" : "disabled"}`);
        lines.push(`${theme.fg("dim", "Reserve Tokens:")} ${compactionSettings.reserveTokens.toLocaleString()}`);
        lines.push(`${theme.fg("dim", "Keep Recent Tokens:")} ${compactionSettings.keepRecentTokens.toLocaleString()}`);
        if (autoThreshold !== null) {
            lines.push(`${theme.fg("dim", "Auto Threshold:")} ${autoThreshold.toLocaleString()}`);
        }
        if (contextUsage && typeof contextUsage.tokens === "number") {
            const percent = typeof contextUsage.percent === "number" ? ` (${contextUsage.percent.toFixed(1)}%)` : "";
            lines.push(
                `${
                    theme.fg("dim", "Current Context:")
                } ${contextUsage.tokens.toLocaleString()}/${contextUsage.contextWindow.toLocaleString()}${percent}`,
            );
        } else if (typeof contextWindow === "number" && contextWindow > 0) {
            lines.push(`${theme.fg("dim", "Current Context:")} unknown/${contextWindow.toLocaleString()}`);
        }
    } else {
        lines.push(`${theme.fg("dim", "Settings:")} unavailable until an agent session is active`);
    }
    lines.push("");

    lines.push(theme.bold("Tokens"));
    lines.push(`${theme.fg("dim", "Input:")} ${inputTokens.toLocaleString()}`);
    lines.push(`${theme.fg("dim", "Output:")} ${outputTokens.toLocaleString()}`);
    if (cacheReadTokens > 0) {
        lines.push(`${theme.fg("dim", "Cache Read:")} ${cacheReadTokens.toLocaleString()}`);
    }
    if (cacheWriteTokens > 0) {
        lines.push(`${theme.fg("dim", "Cache Write:")} ${cacheWriteTokens.toLocaleString()}`);
    }
    lines.push(`${theme.fg("dim", "Total:")} ${totalTokens.toLocaleString()}`);

    uiAPI.appendSystemMessage(lines.join("\n"));
}
