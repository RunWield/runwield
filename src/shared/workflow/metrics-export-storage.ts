/** Private local export storage. No observation payload is stored here. */
import { dirname, join } from "@std/path";
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
        if (Deno.statSync(path).isDirectory) return;
        throw new Error("Export storage is not a directory");
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    ensureExportDirectory(dirname(path));
    try {
        Deno.mkdirSync(path, { mode: 0o700 });
    } catch (error) {
        if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    }
    const parent = Deno.openSync(dirname(path), { read: true });
    try {
        parent.syncSync();
    } finally {
        parent.close();
    }
}

export function writeExportFile(path: string, content: string, append = false): void {
    ensureExportDirectory(dirname(path));
    const file = Deno.openSync(path, { create: true, write: true, append, truncate: !append, mode: 0o600 });
    try {
        if (Deno.build.os !== "windows") Deno.chmodSync(path, 0o600);
        const bytes = new TextEncoder().encode(content);
        let offset = 0;
        while (offset < bytes.length) offset += file.writeSync(bytes.subarray(offset));
        file.syncSync();
    } finally {
        file.close();
    }
    const parent = Deno.openSync(dirname(path), { read: true });
    try {
        parent.syncSync();
    } finally {
        parent.close();
    }
}

export function replaceExportFile(path: string, content: string): void {
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    writeExportFile(temporary, content);
    try {
        Deno.renameSync(temporary, path);
        const parent = Deno.openSync(dirname(path), { read: true });
        try {
            parent.syncSync();
        } finally {
            parent.close();
        }
    } finally {
        try {
            Deno.removeSync(temporary);
        } catch { /* renamed */ }
    }
}

export function tryExportLock(path: string): Deno.FsFile | null {
    ensureExportDirectory(dirname(path));
    const file = Deno.openSync(path, { read: true, write: true, create: true, mode: 0o600 });
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
