import { getCwd } from "../../constants.js";
import { captureForegroundProcess } from "../../shared/captured-process.ts";
import process from "node:process";
/**
 * @module cmd/copy
 * Command to copy the last assistant message to the clipboard.
 */

import { theme } from "../../ui/theme/theme.js";
import type { CommandContext } from "../registry.js";

/**
 * Copy text to the system clipboard using the platform-appropriate command.
 *
 * @returns True when the text was copied successfully.
 */
async function copyToClipboard(text: string): Promise<boolean> {
    const platform = process.platform;

    let command: string;
    let args: string[] = [];

    switch (platform) {
        case "darwin":
            command = "pbcopy";
            args = [];
            break;
        case "linux": {
            // Try xclip first, fall back to xsel
            try {
                const xclipCheck = captureForegroundProcess("which", { args: ["xclip"], cwd: getCwd() });
                const { success: hasXclip } = await xclipCheck;
                if (hasXclip) {
                    command = "xclip";
                    args = ["-selection", "clipboard"];
                    break;
                }
            } catch {
                // fall through
            }
            try {
                const xselCheck = captureForegroundProcess("which", { args: ["xsel"], cwd: getCwd() });
                const { success: hasXsel } = await xselCheck;
                if (hasXsel) {
                    command = "xsel";
                    args = ["--clipboard", "--input"];
                    break;
                }
            } catch {
                // fall through
            }
            return false;
        }
        case "win32":
            command = "clip";
            args = [];
            break;
        default:
            return false;
    }

    try {
        const { success } = await captureForegroundProcess(command, { args, cwd: getCwd(), stdinText: text });
        return success;
    } catch {
        return false;
    }
}

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
