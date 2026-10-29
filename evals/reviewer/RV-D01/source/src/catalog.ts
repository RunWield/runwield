import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Project } from "./model.ts";

export async function readProjects(root: string): Promise<Project[]> {
    return JSON.parse(await readFile(join(root, "projects.json"), "utf8"));
}
export async function saveProjects(root: string, projects: Project[]): Promise<void> {
    await writeFile(join(root, "projects.next.json"), JSON.stringify(projects, null, 2) + "\n");
    await rename(join(root, "projects.next.json"), join(root, "projects.json"));
}
