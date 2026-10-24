import type { Project, ProjectCatalog } from "./model.ts";

export async function collectProjects(catalog: ProjectCatalog): Promise<Project[]> {
    return (await catalog.page()).items;
}
