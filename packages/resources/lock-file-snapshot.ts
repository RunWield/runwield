import fsPromises from "node:fs/promises";
import { type NativeFileLock, type NativeLockSnapshot, openNativeFileLock } from "./native-file-lock.ts";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { platform, versions } from "node:process";
export type LockFileSnapshot = {
    text: string;
    mtime: number;
    size: number;
    token?: string;
    createdAt?: number;
    updatedAt?: number;
};

type LockFileDocument = {
    token?: string;
    createdAt?: number;
    createdAtMs?: number;
    updatedAt?: number;
    updatedAtMs?: number;
};

export async function readLockFileSnapshot(path: string): Promise<LockFileSnapshot | null> {
    try {
        const text = await fsReadFile(path, "utf8");
        if (platform === "win32" && versions.bun) {
            // Bun's floating-point Date conversion can round the last 100ns tick of a
            // millisecond upward. Match the native FILETIME reader's integer floor.
            const stat = await fsStat(path, { bigint: true });
            return lockFileSnapshotFromStat({
                text,
                size: Number(stat.size),
                mtime: Number(stat.mtimeNs / 1000000n),
            });
        }
        const stat = await fsStat(path);
        return lockFileSnapshotFromStat({ text, size: stat.size, mtime: stat.mtime.getTime() });
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }
}

export function lockFileSnapshotMatches(left: LockFileSnapshot, right: LockFileSnapshot): boolean {
    return (
        left.text === right.text &&
        left.mtime === right.mtime &&
        left.size === right.size &&
        left.token === right.token &&
        left.createdAt === right.createdAt &&
        left.updatedAt === right.updatedAt
    );
}

export async function removeLockFileIfSnapshotMatches(lockPath: string, snapshot: LockFileSnapshot): Promise<boolean> {
    let file: NativeFileLock;
    try {
        file = openNativeFileLock(lockPath, false);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
        throw error;
    }
    let closed = false;
    try {
        if (platform !== "win32" && !file.tryLockSync(true)) return false;
        const current = await readLockFileSnapshotFromFile(file);
        const pathCurrent = await readLockFileSnapshot(lockPath);
        if (
            !pathCurrent ||
            !lockFileSnapshotMatches(current, pathCurrent) ||
            !lockFileSnapshotMatches(current, snapshot)
        ) {
            return false;
        }
        if (platform === "win32") {
            file.close();
            closed = true;
        }
        await fsPromises.rm(lockPath).catch((error) => {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        });
        return true;
    } finally {
        if (!closed) file.close();
    }
}

function readLockFileSnapshotFromFile(file: NativeFileLock): LockFileSnapshot {
    return lockFileSnapshotFromStat(file.readSnapshotSync());
}

function lockFileSnapshotFromStat({ text, size, mtime }: NativeLockSnapshot): LockFileSnapshot {
    const parsed = parseLockFileDocument(text);
    return {
        text,
        mtime,
        size,
        ...(typeof parsed?.token === "string" ? { token: parsed.token } : {}),
        ...(typeof parsed?.createdAt === "number" ? { createdAt: parsed.createdAt } : {}),
        ...(typeof parsed?.createdAtMs === "number" ? { createdAt: parsed.createdAtMs } : {}),
        ...(typeof parsed?.updatedAt === "number" ? { updatedAt: parsed.updatedAt } : {}),
        ...(typeof parsed?.updatedAtMs === "number" ? { updatedAt: parsed.updatedAtMs } : {}),
    };
}

function parseLockFileDocument(text: string): LockFileDocument | null {
    try {
        const value: LockFileDocument = JSON.parse(text);
        return value;
    } catch {
        return null;
    }
}
