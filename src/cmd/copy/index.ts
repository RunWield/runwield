import { copyToClipboard } from "../../shared/clipboard-text.ts";
/**
 * @module cmd/copy
 * Command to copy the last assistant message to the clipboard.
 */

import { theme } from "../../ui/theme/theme.js";
import type { CommandContext } from "../registry.js";

/**
 * Handle the /copy command.
 */
export async function runCopyCommand(_argv: string[], options: CommandContext = {}): Promise<void> {
    if (!options?.uiAPI) {
        console.error("The /copy command is only available inside an interactive session.");
        return;
    }

    const { uiAPI, sessionRuntime, sessionId } = options;
    if (!sessionRuntime || !sessionId) {
        uiAPI.appendSystemMessage("Error: No active agent session.");
        return;
    }

    const text = await sessionRuntime.getLastAssistantText(sessionId);
    if (text && typeof text === "object" && text.ok === false) {
        uiAPI.appendSystemMessage(
            `Error: Last assistant text is unavailable (${text.error || "managed_read_blocked"}).`,
        );
        return;
    }
    if (!text || typeof text !== "string") {
        uiAPI.appendSystemMessage("Nothing to copy — no assistant message found.");
        return;
    }

    const copied = await copyToClipboard(text);
    if (copied) {
        const charCount = text.length.toLocaleString();
        uiAPI.appendSystemMessage(theme.fg("dim", `Copied last assistant message (${charCount} chars) to clipboard.`));
    } else {
        uiAPI.appendSystemMessage(
            theme.fg("dim", "Could not copy to clipboard. No clipboard utility found (pbcopy/xclip/xsel/clip)."),
        );
    }
}
