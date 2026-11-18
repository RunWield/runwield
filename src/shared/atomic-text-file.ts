import fs, { open as fsOpen, mkdir as fsMkdir, rm as fsRm, link as fsLink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { recoverWindowsRename } from "./native-file-replace-windows.ts";

/** @param {string} path */
export async function syncDirectory(path: string) {
    try {
        const dir = await fsOpen(path, "r");
        try {
            await dir.sync();
        } finally {
            await dir.close();
        }
    } catch {
        // Directory fsync is unavailable on some platforms/filesystems; atomic rename still protects torn writes.
    }
}

/**
 * @param {string} path
 * @param {string} content
 */
export async function atomicWriteTextFile(path: string, content: string) {
    await fsMkdir(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`);
    let file;
    try {
        file = await fsOpen(tmp, "wx");
        await file.writeFile(content);
        await file.sync();
        await file.close();
        file = undefined;
        try {
            await fs.rename(tmp, path);
        } catch (error) {
            if (!(error instanceof Error && recoverWindowsRename(error, tmp, path))) throw error;
        }
        await syncDirectory(dirname(path));
    } catch (error) {
        if (file) await file.close();
        await fsRm(tmp).catch(() => {});
        throw error;
    }
}

/**
 * Write text only when the target path is still absent. Unlike atomicWriteTextFile,
 * this never renames over a concurrently-created file, preserving external
 * evidence for callers that need create-if-absent semantics.
 * @param {string} path
 * @param {string} content
 */
export async function atomicWriteTextFileIfAbsent(path: string, content: string) {
    const parent = dirname(path);
    await fsMkdir(parent, { recursive: true });
    const temporaryPath = join(parent, `.rw-create-${crypto.randomUUID()}.tmp`);
    let file;
    try {
        file = await fsOpen(temporaryPath, "wx", 0o600);
        await file.writeFile(content);
        await file.sync();
        await file.close();
        file = undefined;
        // Linking a complete same-filesystem file publishes all bytes at once and
        // still fails when another writer already owns the target path.
        await fsLink(temporaryPath, path);
        await syncDirectory(parent);
    } catch (error) {
        if (file) await file.close();
        throw error;
    } finally {
        await fsRm(temporaryPath).catch(() => {});
    }
}
