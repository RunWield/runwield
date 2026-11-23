import { projects, type ProjectHealth, type ProjectRegistry, type RegisteredProject } from "@runwield/projects";
import { realpathSync } from "node:fs";
/** @module ui/workspace/server/owner-projects */

import { basename, resolve } from "node:path";

export interface OwnerProjectStore {
    projects: Pick<ProjectRegistry, "list" | "getHealth" | "requireActiveRoot" | "get">;
}

export interface OwnerProjectSession {
    projectId?: string;
    transcriptCwd: string;
}

export type OwnerProjectView = Omit<ReturnType<typeof serializeOwnerProject>, "projectId"> & { projectId: string };

export function sanitizeRootLabel(root: string | undefined) {
    const base = basename(String(root || ""));
    return base || "registered Project";
}

function sanitizeHealthEvidence(evidence: string) {
    const text = String(evidence || "");
    if (/resolves to .*expected /.test(text)) {
        return "Registered root resolves somewhere unexpected; relink this Project root.";
    }
    if (/[/\\]|[A-Za-z]:/.test(text)) return "Project health check reported a local filesystem issue.";
    return text;
}

export function serializeOwnerProject(project: RegisteredProject, health: ProjectHealth) {
    return {
        projectId: project.projectId,
        displayName: project.displayName,
        rootLabel: sanitizeRootLabel(project.registeredRoot || project.currentRoot),
        status: project.status,
        healthStatus: health.status,
        healthEvidence: health.evidence.map(sanitizeHealthEvidence),
    };
}

export function listOwnerProjects(store: { projects: Pick<ProjectRegistry, "list" | "getHealth"> }) {
    return store.projects
        .list()
        .map((project) => serializeOwnerProject(project, store.projects.getHealth(project.projectId)));
}

export function requireOwnerProjectRoot(
    store: { projects: Pick<ProjectRegistry, "requireActiveRoot"> },
    projectId: string,
) {
    return store.projects.requireActiveRoot(projectId);
}

/**
 * Saved Sessions can predate stable Project IDs. Their admitted storage
 * binding or canonical root still establishes membership.
 */
export function sessionBelongsToOwnerProject(
    store: { projects: Pick<ProjectRegistry, "get"> },
    session: OwnerProjectSession,
    projectId: string,
) {
    const project = store.projects.get(projectId);
    if (!project) return false;
    if (session.projectId === project.projectId) return true;
    const bindings = projects.storage.inspect(project.currentRoot);
    if (bindings.length) return bindings.some((binding) => binding.sessionProjectId === session.projectId);
    try {
        return (
            resolve(realpathSync.native(session.transcriptCwd)) === resolve(realpathSync.native(project.currentRoot))
        );
    } catch {
        return resolve(session.transcriptCwd) === resolve(project.currentRoot);
    }
}
