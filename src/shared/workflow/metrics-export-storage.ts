import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { openNativeFileLock, type NativeFileLock } from "../native-file-lock.ts";
import { syncParentDirectory, writeTextAtomically } from "../private-json-file.ts";
import { statSync, mkdirSync, chmodSync } from "node:fs";
import process from "node:process";
/** Private local export storage. No observation payload is stored here. */
import { dirname, join } from "node:path";
import { getHomeDir } from "../../constants.js";

export function metricsExportDirectory(): string {
    return join(getHomeDir(), ".wld", "metrics-export");
}

export function exportDestinationDirectory(destinationId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(destinationId)) throw new Error("Invalid destination ID");
    return join(metricsExportDirectory(), "destinations", destinationId);
}

export function ensureExportDirectory(path = metricsExportDirectory()): void {
    try {
        if (statSync(path).isDirectory()) return;
        throw new Error("Export storage is not a directory");
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    ensureExportDirectory(dirname(path));
    try {
        mkdirSync(path, { mode: 0o700 });
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    syncParentDirectory(path);
}

export function writeExportFile(path: string, content: string, append = false): void {
    ensureExportDirectory(dirname(path));
    const file = openSync(path, append ? "a" : "w", 0o600);
    try {
        if ((process.platform === "win32" ? "windows" : process.platform) !== "windows") chmodSync(path, 0o600);
        const bytes = new TextEncoder().encode(content);
        let offset = 0;
        while (offset < bytes.length) offset += writeSync(file, bytes.subarray(offset));
        fsyncSync(file);
    } finally {
        closeSync(file);
    }
    syncParentDirectory(path);
}

export function replaceExportFile(path: string, content: string): void {
    ensureExportDirectory(dirname(path));
    writeTextAtomically(path, content);
}

export function tryExportLock(path: string): NativeFileLock | null {
    ensureExportDirectory(dirname(path));
    const file = openNativeFileLock(path);
    if (file.tryLockSync(true)) return file;
    file.close();
    return null;
}

/** Serialize configuration edits and first creation of the host key across processes. */
export async function withExportConfigurationLock<T>(run: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new Error("lock_canceled");
    const deadline = Date.now() + 1000;
    let lock;
    while (!(lock = tryExportLock(join(metricsExportDirectory(), ".config.lock")))) {
        if (signal?.aborted) throw new Error("lock_canceled");
        if (Date.now() >= deadline) throw new Error("Export configuration is busy");
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    try {
        return await run();
    } finally {
        lock.close();
    }
}
