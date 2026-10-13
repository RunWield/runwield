/**
 * @module ui/tui/clipboard
 * Terminal UI integration for reading images from the system clipboard.
 */

import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import { getCwd } from "../../constants.js";
import { spawnForegroundProcess } from "../../shared/foreground-process.ts";

interface ClipboardCommandResult {
    success: boolean;
    stdout: Uint8Array;
}

export interface ClipboardSystemPort {
    os: string;
    runCommand(command: string, args: string[]): Promise<ClipboardCommandResult>;
    makeTempFile(options: { prefix: string; suffix: string }): Promise<string>;
    remove(path: string): Promise<void>;
}

export interface ClipboardReader {
    hasClipboardImage(): Promise<boolean>;
    readClipboardImage(): Promise<{ base64: string; mimeType: "image/png" } | null>;
}

const systemClipboardPort: ClipboardSystemPort = {
    os: platform === "win32" ? "windows" : platform,
    async runCommand(command, args) {
        const child = spawnForegroundProcess({ command, args, cwd: getCwd() });
        const [result, stdout] = await Promise.all([
            child.done,
            new Response(child.stdout).arrayBuffer(),
            new Response(child.stderr).arrayBuffer(),
        ]);
        return { success: result.exitCode === 0, stdout: new Uint8Array(stdout) };
    },
    async makeTempFile(options) {
        const path = join(tmpdir(), `${options.prefix}${crypto.randomUUID()}${options.suffix}`);
        await writeFile(path, "", { flag: "wx", mode: 0o600 });
        return path;
    },
    remove: (path) => unlink(path),
};

/** Compose clipboard behavior over the operating-system boundary. */
export function createClipboardReader(port: ClipboardSystemPort): ClipboardReader {
    async function hasClipboardImage(): Promise<boolean> {
        if (port.os !== "darwin") return false;

        const result = await port.runCommand("osascript", [
            "-e",
            `try
        the clipboard as «class PNGf»
        return "image"
      on error
        return "none"
      end try`,
        ]);
        return new TextDecoder().decode(result.stdout).trim() === "image";
    }

    async function readClipboardImage(): Promise<{ base64: string; mimeType: "image/png" } | null> {
        if (!await hasClipboardImage()) return null;

        const tempFile = await port.makeTempFile({
            prefix: "runwield-clipboard-",
            suffix: ".png",
        });
        const extractResult = await port.runCommand("osascript", [
            "-e",
            `set tempFile to "${tempFile}"
      set theImage to the clipboard as «class PNGf»
      set theFile to open for access POSIX file tempFile with write permission
      write theImage to theFile
      close access theFile`,
        ]);

        if (!extractResult.success) {
            await port.remove(tempFile).catch(() => {});
            return null;
        }

        try {
            const base64Result = await port.runCommand("base64", ["-i", tempFile]);
            if (base64Result.success) {
                return {
                    base64: new TextDecoder().decode(base64Result.stdout).replace(/\s+/g, ""),
                    mimeType: "image/png",
                };
            }
        } catch {
            // A missing or failing system encoder means clipboard image paste is unavailable.
        } finally {
            await port.remove(tempFile).catch(() => {});
        }

        return null;
    }

    return { hasClipboardImage, readClipboardImage };
}

const systemClipboard = createClipboardReader(systemClipboardPort);

export const hasClipboardImage = systemClipboard.hasClipboardImage;
export const readClipboardImage = systemClipboard.readClipboardImage;
