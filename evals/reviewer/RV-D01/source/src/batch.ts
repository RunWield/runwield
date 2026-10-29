import { readProjects, saveProjects } from "./catalog.ts";
import { buildDigest } from "./digest.ts";
import type { BatchResult } from "./model.ts";

export async function refreshDigests(root: string): Promise<BatchResult> {
    const projects = await readProjects(root);
    for (const project of projects) project.digest = buildDigest(project);
    await saveProjects(root, projects);
    return { updated: projects.map((project) => project.id) };
}
