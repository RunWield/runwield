/** @module ui/workspace/server/owner-projects */

import { basename, resolve } from "node:path";
import type { RegisteredProject } from "../../../shared/owner-coordination/projects.js";

export interface OwnerProjectRecord {
    projectId: string;
    displayName?: string;
    registeredRoot?: string;
    currentRoot?: string;
    lifecycle?: string;
}

export interface OwnerProjectHealth {
    status: string;
    evidence?: string[];
}

export interface OwnerProjectStore {
    listProjects(): OwnerProjectRecord[];
    getProjectHealth(projectId: string): OwnerProjectHealth;
    requireEnabledProjectRoot(projectId: string): string;
    getProjectById(projectId: string): Pick<RegisteredProject, "currentRoot"> | null;
}

export interface OwnerProjectSession {
    transcriptCwd: string;
}

export type OwnerProjectView = ReturnType<typeof serializeOwnerProject>;

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

export function serializeOwnerProject(project: OwnerProjectRecord, health: OwnerProjectHealth) {
    return {
        projectId: project.projectId,
        displayName: project.displayName,
        rootLabel: sanitizeRootLabel(project.registeredRoot || project.currentRoot),
        lifecycle: project.lifecycle,
        healthStatus: health.status,
        healthEvidence: Array.isArray(health.evidence) ? health.evidence.map(sanitizeHealthEvidence) : [],
        enabled: project.lifecycle === "enabled" && health.status === "available",
    };
}

export function listOwnerProjects(store: Pick<OwnerProjectStore, "listProjects" | "getProjectHealth">) {
    return store.listProjects().map((project) =>
        serializeOwnerProject(project, store.getProjectHealth(project.projectId))
    );
}

export function requireOwnerProjectRoot(
    store: Pick<OwnerProjectStore, "requireEnabledProjectRoot">,
    projectId: string,
) {
    return store.requireEnabledProjectRoot(projectId);
}

/**
 * Workspace Project IDs and file-authoritative Session Project IDs belong to
 * different identity domains. Membership is the canonical Project root.
 */
export function sessionBelongsToOwnerProject(
    store: Pick<OwnerProjectStore, "getProjectById">,
    session: OwnerProjectSession,
    projectId: string,
) {
    const project = store.getProjectById(projectId);
    if (!project) return false;
    try {
        return resolve(Deno.realPathSync(session.transcriptCwd)) === resolve(Deno.realPathSync(project.currentRoot));
    } catch {
        return resolve(session.transcriptCwd) === resolve(project.currentRoot);
    }
}
