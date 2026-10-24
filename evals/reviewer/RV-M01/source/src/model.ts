export interface Project {
    id: string;
    archived: boolean;
}
export interface ProjectPage {
    items: Project[];
    nextCursor?: string;
}
export interface ProjectCatalog {
    page(cursor?: string): Promise<ProjectPage>;
}
