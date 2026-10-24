import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

export async function withRegistryLock<T>(root: string, action: () => Promise<T>): Promise<T> {
    await mkdir(root, { recursive: true });
    const lock = join(root, ".registry-lock");
    try {
        await mkdir(lock);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new Error("Registry busy");
        throw error;
    }
    try {
        return await action();
    } finally {
        await rm(lock, { recursive: true });
    }
}
