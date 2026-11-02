/**
 * @module cmd/compact
 * Command to manually compact the session context.
 */

import { theme } from "../../ui/theme/theme.ts";
import type { CommandContext } from "../registry.js";

function notifyCompactionFinished(options: CommandContext) {
    try {
        const { notifyRunWieldEvent, sessionRuntime, sessionId } = options;
        if (!notifyRunWieldEvent || !sessionRuntime || !sessionId) return;
        const sessionName = sessionRuntime.getSessionSnapshot?.(sessionId)?.name || undefined;
        const result = notifyRunWieldEvent("compactionFinished", { sessionName });
        if (result && typeof result === "object" && "catch" in result && typeof result.catch === "function") {
            result.catch(() => {});
        }
    } catch {
        // Notification delivery is best-effort and must not affect compaction outcomes.
    }
}

/**
 * Handle compact command.
 */
export async function runCompactCommand(argv: string[], options: CommandContext = {}) {
    if (!options?.uiAPI) {
        console.error("The /compact command is only available inside an interactive session.");
        return "failed";
    }

    const { uiAPI, sessionRuntime, sessionId } = options;
    if (!sessionRuntime || !sessionId) {
        uiAPI.appendSystemMessage("Error: No active agent session.");
        return "failed";
    }

    const customInstructions = argv.join(" ").trim() || undefined;
    const instructionsNote = customInstructions ? `\n${theme.fg("dim", `Instructions: ${customInstructions}`)}` : "";

    uiAPI.appendSystemMessage(`Compacting context... ${theme.fg("dim", "(Esc to cancel)")}${instructionsNote}`);

    try {
        const result = await sessionRuntime.compactSession(sessionId, customInstructions, options.commandInvocationId);
        if (!result || typeof result.tokensBefore !== "number" || !Number.isFinite(result.tokensBefore)) {
            throw new Error("Nothing to compact");
        }

        // Pi-style report: print the generated summary plus the pre-compaction token count.
        const headerLines = [
            theme.fg("accent", "Session compacted."),
            `${theme.fg("dim", "Tokens before:")} ${result.tokensBefore.toLocaleString()}`,
            "",
        ];
        uiAPI.appendSystemMessage(headerLines.join("\n"));
        if (result.summary) {
            uiAPI.appendSystemMessage(result.summary);
        }
        return "succeeded";
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isCancelled = message === "Compaction cancelled" || message.includes("cancelled");

        if (isCancelled) {
            uiAPI.appendSystemMessage("Compaction cancelled.");
            return "canceled";
        } else if (message.includes("Nothing to compact")) {
            uiAPI.appendSystemMessage("Nothing to compact — the session doesn't have enough messages yet.");
        } else {
            uiAPI.appendSystemMessage(`Compaction failed: ${message}`);
        }
        return "failed";
    } finally {
        notifyCompactionFinished(options);
    }
}
