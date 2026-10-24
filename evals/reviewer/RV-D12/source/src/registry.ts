import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RegistryEntry, RegistryData } from "./model.ts";
import { validateEntry } from "./model.ts";

export async function listRegistry(root: string): Promise<RegistryEntry[]> {
    let content: string;
    try {
        content = await readFile(join(root, "registry.json"), "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
    }
    const data: RegistryData = JSON.parse(content);
    return data.entries;
}
// The registration owner holds the registry lock for this read-modify-write.
export async function putEntry(root: string, entry: RegistryEntry): Promise<void> {
    validateEntry(entry);
    await mkdir(root, { recursive: true });
    const entries = await listRegistry(root);
    const next = entries.filter((previous) => previous.id !== entry.id).concat(entry);
    const file = join(root, "registry.json");
    const staged = join(root, "registry.pending");
    try {
        await writeFile(staged, JSON.stringify({ entries: next }));
        await rename(staged, file);
    } finally {
        await rm(staged, { force: true });
    }
}
