import type { Project } from "./model.ts";

export function buildDigest(project: Project): string {
    const notes = project.notes.map((note) => note.trim()).filter(Boolean);
    return `${project.title}: ${notes.length ? notes.join("; ") : "No updates"}`;
}
