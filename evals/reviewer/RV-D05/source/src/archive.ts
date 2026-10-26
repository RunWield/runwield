import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Artifact } from "./model.ts";
import { containedFile } from "./paths.ts";

export async function listArtifacts(root: string): Promise<Artifact[]> {
    const entries = await readdir(root, { withFileTypes: true });
    const files: Artifact[] = [];
    for (const entry of entries) {
        if (entry.isFile()) files.push({ path: entry.name, bytes: (await stat(join(root, entry.name))).size });
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
}
export async function readArtifact(root: string, requested: string): Promise<string> {
    return readFile(await containedFile(root, requested), "utf8");
}
