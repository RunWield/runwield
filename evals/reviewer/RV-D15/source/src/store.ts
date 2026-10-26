import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Workspace } from "./model.ts";
import { validateIdentifier } from "./identifier.ts";

export async function saveWorkspace(root: string, workspace: Workspace): Promise<void> {
    validateIdentifier(workspace.id);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "workspace.json"), JSON.stringify(workspace));
}

export async function getWorkspace(root: string): Promise<Workspace | null> {
    try {
        return JSON.parse(await readFile(join(root, "workspace.json"), "utf8")) as Workspace;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }
}
