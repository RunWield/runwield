/** Private directories and durable JSON replacement using portable filesystem APIs. */
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { recoverWindowsRename } from "./native-file-replace-windows.ts";
import { randomUUID } from "node:crypto";

export function ensurePrivateDir(path: string): void {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    try {
        chmodSync(path, 0o700);
    } catch {
        // Creation mode remains the best available protection on this filesystem.
    }
}

function syncParent(path: string): void {
    try {
        const directory = openSync(dirname(path), "r");
        try {
            fsyncSync(directory);
        } finally {
            closeSync(directory);
        }
    } catch {
        // Some platforms do not permit directory fsync. The atomic rename still
        // prevents readers from observing a partially written JSON document.
    }
}

/** Replace a JSON document without exposing a partial write to readers. */
export function writeJsonAtomically<Value>(path: string, value: Value): void {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    ensurePrivateDir(dirname(path));
    const temporaryPath = `${path}.tmp-${randomUUID()}`;
    const file = openSync(temporaryPath, "wx", 0o600);
    try {
        const bytes = new TextEncoder().encode(text);
        let written = 0;
        while (written < bytes.byteLength) {
            const count = writeSync(file, bytes.subarray(written));
            if (count === 0) throw new Error("Atomic JSON write made no progress");
            written += count;
        }
        fsyncSync(file);
    } finally {
        closeSync(file);
    }
    try {
        renameSync(temporaryPath, path);
    } catch (error) {
        if (!(error instanceof Error && recoverWindowsRename(error, temporaryPath, path))) throw error;
    }
    syncParent(path);
}
