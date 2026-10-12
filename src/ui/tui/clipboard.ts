/**
 * @module ui/tui/clipboard
 * Terminal UI integration for reading images from the system clipboard.
 */

import { createRemoteClipboardReader, type RemoteClipboardConnection } from "../../shared/remote/clipboard-bridge.ts";

export interface ClipboardImage {
    base64: string;
    mimeType: "image/png";
}

interface ClipboardCommandResult {
    success: boolean;
    stdout: Uint8Array;
}

export interface ClipboardSystemPort {
    os: typeof Deno.build.os;
    runCommand(command: string, args: string[]): Promise<ClipboardCommandResult>;
    makeTempFile(options: { prefix: string; suffix: string }): Promise<string>;
    remove(path: string): Promise<void>;
}

export interface ClipboardReader {
    hasClipboardImage(): Promise<boolean>;
    readClipboardImage(): Promise<ClipboardImage | null>;
}

const systemClipboardPort: ClipboardSystemPort = {
    os: Deno.build.os,
    async runCommand(command, args) {
        const result = await new Deno.Command(command, { args }).output();
        return { success: result.success, stdout: result.stdout };
    },
    makeTempFile: (options) => Deno.makeTempFile(options),
    remove: (path) => Deno.remove(path),
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

    async function readClipboardImage(): Promise<ClipboardImage | null> {
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

/** Laptop service must use this export, never the selected TUI reader. */
export const readSystemClipboardImage = systemClipboard.readClipboardImage;

let selectedClipboard: ClipboardReader = systemClipboard;
let remoteConfigured = false;

/** Select before TUI startup. Cleanup leaves the closed remote reader selected, fail-closed. */
export function configureRemoteClipboardConnection(connection: RemoteClipboardConnection): () => void {
    if (remoteConfigured) throw new Error("Remote clipboard connection is already configured");
    const reader = createRemoteClipboardReader(connection);
    selectedClipboard = reader;
    remoteConfigured = true;
    return () => reader.close();
}

export function hasClipboardImage(): Promise<boolean> {
    return selectedClipboard.hasClipboardImage();
}

export function readClipboardImage(): Promise<ClipboardImage | null> {
    return selectedClipboard.readClipboardImage();
}
