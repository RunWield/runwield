import { recoverWindowsRename } from "./native-file-replace-windows.ts";
import { platform } from "node:process";
import fsPromises, { open as fsOpen, lstat as fsLstat, mkdir as fsMkdir } from "node:fs/promises";
import { type Stats } from "node:fs";
import { dirname, join } from "node:path";
export async function info(path: string): Promise<Stats | null> {
    try {
        return await fsLstat(path);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }
}

export async function syncDirectory(path: string): Promise<void> {
    // Match runtime layout publication: Windows does not support directory fsync.
    if (platform === "win32") return;
    const directory = await fsOpen(path, "r");
    try {
        await directory.sync();
    } finally {
        await directory.close();
    }
}

export async function writeAtomic(path: string, bytes: Uint8Array, onlyIfMissing = false): Promise<void> {
    await fsMkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    const file = await fsOpen(temporary, "wx", 0o600);
    try {
        await file.writeFile(bytes);
        await file.sync();
    } finally {
        await file.close();
    }
    try {
        if (onlyIfMissing) {
            try {
                // Atomic no-replace publication; never overwrite a concurrent writer.
                await fsPromises.link(temporary, path);
            } catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
            }
        } else {
            try {
                await fsPromises.rename(temporary, path);
            } catch (error) {
                if (!(error instanceof Error && recoverWindowsRename(error, temporary, path))) throw error;
            }
        }
        await syncDirectory(dirname(path));
    } finally {
        await fsPromises.rm(temporary).catch((error) => {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        });
    }
}

async function digest(bytes: Uint8Array): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
    return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function preserve(path: string, bytes: Uint8Array, archiveRoot: string): Promise<void> {
    const pathKey = await digest(new TextEncoder().encode(path));
    const versionKey = await digest(bytes);
    const directory = join(archiveRoot, pathKey, versionKey);
    await writeAtomic(join(directory, "contents"), bytes);
    await writeAtomic(join(directory, "source-path.txt"), new TextEncoder().encode(path));
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
