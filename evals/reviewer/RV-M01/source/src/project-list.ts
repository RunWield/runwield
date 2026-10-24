import type { ProjectCatalog, Project } from "./model.ts";
import type { ListingConfig } from "./settings.ts";
import { loadSettings } from "./settings.ts";
import { collectProjects } from "./pagination.ts";

export async function listProjects(catalog: ProjectCatalog, config: ListingConfig = {}): Promise<Project[]> {
    const settings = loadSettings(config);
    const projects = await collectProjects(catalog);
    return settings.filterEnabled ? projects.filter((project) => !project.archived) : projects;
}
