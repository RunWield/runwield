/** Native text clipboard writes shared by interactive copy actions. */
import process from "node:process";
import { getCwd } from "../constants.js";
import { captureForegroundProcess } from "./captured-process.ts";

/**
 * Copy text to the system clipboard using the platform-appropriate command.
 *
 * @returns True when the text was copied successfully.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
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
