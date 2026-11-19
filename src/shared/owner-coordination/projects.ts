import { inspectProjectDirectory, requireDirectoryConfirmation } from "../project-directory.ts";
/**
 * @module shared/owner-coordination/projects
 * Registered Project lifecycle and health APIs for owner coordination.
 */

import { readdirSync, realpathSync, statSync } from "node:fs";
import { deleteProjectRegistration } from "./project-removal.ts";
import { basename, isAbsolute, resolve } from "node:path";

import type { SQLOutputValue } from "node:sqlite";
import type { DatabaseSync } from "../sqlite.ts";
import type { OwnerCoordinationDatabase } from "./database.ts";

export type ProjectLifecycle = "enabled" | "disabled" | "removed";
export type ProjectHealthStatus = "available" | "missing" | "not_directory" | "unreadable" | "canonical_mismatch";

export interface RegisteredProject {
    projectId: string;
    displayName: string;
    registeredRoot: string;
    currentRoot: string;
    lifecycle: ProjectLifecycle;
    createdAt: string;
    updatedAt: string;
    disabledAt: string | null;
    removedAt: string | null;
    restoredAt: string | null;
    relinkedAt: string | null;
}

export interface ProjectHealth {
    projectId: string;
    status: ProjectHealthStatus;
    lifecycle: ProjectLifecycle;
    registeredRoot: string;
    currentRoot: string;
    observedRealRoot: string | null;
    evidence: string[];
}

export interface ProjectClockOptions {
    now?: () => string;
}

export interface RegisterProjectOptions extends ProjectClockOptions {
    root: string;
    displayName?: string;
    directoryConfirmation?: string;
    idFactory?: () => string;
}

export interface RelinkProjectOptions extends Omit<RegisterProjectOptions, "root"> {
    projectId: string;
    newRoot: string;
}

export interface ProjectRootEvidence {
    enteredRoot: string;
    canonicalRoot: string;
    rootState: string;
}

interface EnsureProjectRootEvidenceOptions {
    projectId: string;
    enteredRoot: string;
    canonicalRoot: string;
    rootState: "current" | "historical";
    now: string;
    idFactory?: RegisterProjectOptions["idFactory"];
}

// node:sqlite does not infer selected columns; this view follows the projects schema.
interface ProjectRow extends Record<string, SQLOutputValue> {
    id: string;
    display_name: string;
    registered_root: string;
    current_root: string;
    lifecycle: ProjectLifecycle;
    created_at: string;
    updated_at: string;
    disabled_at: string | null;
    removed_at: string | null;
    restored_at: string | null;
    relinked_at: string | null;
}

function requireDatabase(value: unknown): OwnerCoordinationDatabase {
    if (!value || typeof value !== "object" || !("handle" in value)) throw new Error("Owner database is required");
    return value as OwnerCoordinationDatabase;
}

function isoNow(now?: ProjectClockOptions["now"]) {
    return now ? now() : new Date().toISOString();
}

function newId(idFactory?: RegisterProjectOptions["idFactory"]) {
    return idFactory ? idFactory() : crypto.randomUUID();
}

function requireAbsoluteRoot(root: unknown, field: string): string {
    if (typeof root !== "string" || !root.trim()) throw new Error(`${field} is required`);
    const enteredRoot = root.trim();
    if (!isAbsolute(enteredRoot)) throw new Error(`${field} must be an absolute path`);
    return resolve(enteredRoot);
}

function assertNoEnteredRootRetarget(
    db: DatabaseSync,
    enteredRoot: string,
    canonicalRoot: string,
    allowedProjectId?: string,
) {
    const rows = db
        .prepare("SELECT project_id, canonical_root FROM project_roots WHERE entered_root = ?")
        .all(enteredRoot);
    for (const row of rows) {
        if (row.canonical_root !== canonicalRoot) {
            throw new Error(`Project root path reuse or symlink retarget conflict: ${enteredRoot}`);
        }
        if (allowedProjectId && row.project_id !== allowedProjectId) {
            throw new Error(`Project root is already registered to another Project: ${enteredRoot}`);
        }
    }
}

function ensureProjectRootEvidence(db: DatabaseSync, options: EnsureProjectRootEvidenceOptions) {
    const existing = db
        .prepare("SELECT id, canonical_root FROM project_roots WHERE project_id = ? AND entered_root = ?")
        .get(options.projectId, options.enteredRoot);
    if (existing) {
        if (existing.canonical_root !== options.canonicalRoot) {
            throw new Error(`Project root path reuse or symlink retarget conflict: ${options.enteredRoot}`);
        }
        db.prepare("UPDATE project_roots SET root_state = ?, ended_at = ? WHERE id = ?").run(
            options.rootState,
            options.rootState === "current" ? null : options.now,
            existing.id,
        );
        return;
    }
    db.prepare(
        "INSERT INTO project_roots(id, project_id, entered_root, canonical_root, root_state, created_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
        newId(options.idFactory),
        options.projectId,
        options.enteredRoot,
        options.canonicalRoot,
        options.rootState,
        options.now,
        options.rootState === "current" ? null : options.now,
    );
}

function projectFromRow(row: ProjectRow): RegisteredProject {
    return {
        projectId: row.id,
        displayName: row.display_name,
        registeredRoot: row.registered_root,
        currentRoot: row.current_root,
        lifecycle: row.lifecycle,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        disabledAt: row.disabled_at,
        removedAt: row.removed_at,
        restoredAt: row.restored_at,
        relinkedAt: row.relinked_at,
    };
}

export function getProjectById(database: OwnerCoordinationDatabase, projectId: string): RegisteredProject | null {
    const db = requireDatabase(database).handle;
    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
    return row ? projectFromRow(row) : null;
}

export function registerProject(
    database: OwnerCoordinationDatabase,
    options: RegisterProjectOptions,
): RegisteredProject {
    const ownerDb = requireDatabase(database);
    const enteredRoot = requireAbsoluteRoot(options?.root, "Project root");
    const directory = inspectProjectDirectory(enteredRoot);
    requireDirectoryConfirmation(directory, options.directoryConfirmation);
    const canonicalRoot = directory.canonicalRoot;
    const displayName = options.displayName || basename(canonicalRoot) || canonicalRoot;
    return ownerDb.transaction(() => {
        const db = ownerDb.handle;
        assertNoEnteredRootRetarget(db, enteredRoot, canonicalRoot);
        const existingRoot = db
            .prepare(
                "SELECT DISTINCT projects.* FROM project_roots JOIN projects ON projects.id = project_roots.project_id WHERE project_roots.canonical_root = ? ORDER BY projects.created_at LIMIT 1",
            )
            .get(canonicalRoot);
        const now = isoNow(options.now);
        if (existingRoot) {
            const existingProjectId = String(existingRoot.id);
            ensureProjectRootEvidence(db, {
                projectId: existingProjectId,
                enteredRoot,
                canonicalRoot,
                rootState: canonicalRoot === existingRoot.current_root ? "current" : "historical",
                now,
                idFactory: options.idFactory,
            });
            return projectFromRow(
                db.prepare("SELECT * FROM projects WHERE id = ?").get(existingProjectId) as ProjectRow,
            );
        }

        const projectId = newId(options.idFactory);
        db.prepare(
            "INSERT INTO projects(id, display_name, registered_root, current_root, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, 'enabled', ?, ?)",
        ).run(projectId, displayName, enteredRoot, canonicalRoot, now, now);
        ensureProjectRootEvidence(db, {
            projectId,
            enteredRoot,
            canonicalRoot,
            rootState: "current",
            now,
            idFactory: options.idFactory,
        });
        return projectFromRow(db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow);
    });
}

export function listProjects(database: OwnerCoordinationDatabase): RegisteredProject[] {
    const db = requireDatabase(database).handle;
    return (db.prepare("SELECT * FROM projects ORDER BY display_name, created_at").all() as ProjectRow[]).map(
        projectFromRow,
    );
}

export function setProjectEnabled(
    database: OwnerCoordinationDatabase,
    projectId: string,
    enabled: boolean,
    options: ProjectClockOptions = {},
): RegisteredProject {
    const ownerDb = requireDatabase(database);
    return ownerDb.transaction(() => {
        const project = getProjectById(ownerDb, projectId);
        if (!project) throw new Error(`Project not found: ${projectId}`);
        const now = isoNow(options.now);
        ownerDb.handle
            .prepare("UPDATE projects SET lifecycle = ?, updated_at = ?, disabled_at = ? WHERE id = ?")
            .run(enabled ? "enabled" : "disabled", now, enabled ? null : now, projectId);
        return getProjectById(ownerDb, projectId)!;
    });
}

/**
 * Delete Workspace database records only; repository and Session files are untouched.
 */
export function removeProject(database: OwnerCoordinationDatabase, projectId: string): void {
    const ownerDb = requireDatabase(database);
    ownerDb.transaction(() => {
        if (!getProjectById(ownerDb, projectId)) throw new Error(`Project not found: ${projectId}`);
        deleteProjectRegistration(ownerDb.handle, projectId);
    });
}

export function relinkProject(database: OwnerCoordinationDatabase, options: RelinkProjectOptions): RegisteredProject {
    const ownerDb = requireDatabase(database);
    const enteredRoot = requireAbsoluteRoot(options?.newRoot, "New Project root");
    const directory = inspectProjectDirectory(enteredRoot);
    requireDirectoryConfirmation(directory, options.directoryConfirmation);
    const canonicalRoot = directory.canonicalRoot;
    return ownerDb.transaction(() => {
        const db = ownerDb.handle;
        const project = getProjectById(ownerDb, options.projectId);
        if (!project) throw new Error(`Project not found: ${options.projectId}`);
        assertNoEnteredRootRetarget(db, enteredRoot, canonicalRoot, options.projectId);
        const existingRoots = db
            .prepare("SELECT DISTINCT project_id FROM project_roots WHERE canonical_root = ?")
            .all(canonicalRoot);
        if (existingRoots.some((root) => root.project_id !== options.projectId)) {
            throw new Error(`Project root is already registered to another Project: ${canonicalRoot}`);
        }
        const now = isoNow(options.now);
        db.prepare(
            "UPDATE project_roots SET root_state = 'historical', ended_at = COALESCE(ended_at, ?) WHERE project_id = ?",
        ).run(now, options.projectId);
        ensureProjectRootEvidence(db, {
            projectId: options.projectId,
            enteredRoot,
            canonicalRoot,
            rootState: "current",
            now,
            idFactory: options.idFactory,
        });
        db.prepare(
            "UPDATE projects SET registered_root = ?, current_root = ?, display_name = ?, updated_at = ?, relinked_at = ? WHERE id = ?",
        ).run(enteredRoot, canonicalRoot, options.displayName || project.displayName, now, now, options.projectId);
        return getProjectById(ownerDb, options.projectId)!;
    });
}

export function listProjectRootEvidence(database: OwnerCoordinationDatabase, projectId: string): ProjectRootEvidence[] {
    const db = requireDatabase(database).handle;
    return db
        .prepare(
            "SELECT entered_root, canonical_root, root_state FROM project_roots WHERE project_id = ? ORDER BY root_state = 'current' DESC, created_at DESC",
        )
        .all(projectId)
        .map((row) => ({
            enteredRoot: String(row.entered_root),
            canonicalRoot: String(row.canonical_root),
            rootState: String(row.root_state),
        }));
}

export function getProjectHealth(database: OwnerCoordinationDatabase, projectId: string): ProjectHealth {
    const project = getProjectById(database, projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const evidence: string[] = [];

    let observedRealRoot: string | null = null;
    if (project.lifecycle === "removed") evidence.push("Project is removed and unavailable to Workspace.");
    if (project.lifecycle === "disabled") {
        evidence.push("Project is disabled and unavailable for new Workspace activity.");
    }
    let status: ProjectHealthStatus = "available";
    try {
        const stat = statSync(project.registeredRoot);
        if (!stat.isDirectory()) {
            status = "not_directory";
            evidence.push("Registered root exists but is not a directory.");
        } else {
            try {
                observedRealRoot = realpathSync.native(project.registeredRoot);
            } catch (error) {
                status = "unreadable";
                evidence.push(error instanceof Error ? error.message : "Registered root cannot be resolved.");
            }
            try {
                for (const _entry of readdirSync(project.registeredRoot)) break;
            } catch (error) {
                status = "unreadable";
                evidence.push(error instanceof Error ? error.message : "Registered root is not readable.");
            }
            if (observedRealRoot && observedRealRoot !== project.currentRoot) {
                status = "canonical_mismatch";
                evidence.push(`Registered root resolves to ${observedRealRoot}, expected ${project.currentRoot}.`);
            }
        }
    } catch (error) {
        if (error instanceof Error && "code" in error && ["EACCES", "EPERM"].includes(String(error.code))) {
            status = "unreadable";
            evidence.push(error.message);
        } else {
            status = "missing";
            evidence.push("Registered root is missing or cannot be statted.");
        }
    }
    return {
        projectId: project.projectId,
        status,
        lifecycle: project.lifecycle,
        registeredRoot: project.registeredRoot,
        currentRoot: project.currentRoot,
        observedRealRoot,
        evidence,
    };
}

export function requireEnabledProjectRoot(database: OwnerCoordinationDatabase, projectId: string): string {
    const project = getProjectById(database, projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    if (project.lifecycle !== "enabled") throw new Error(`Project is not enabled: ${projectId}`);
    const health = getProjectHealth(database, projectId);
    if (health.status !== "available") throw new Error(`Project root is not available: ${health.status}`);
    return project.currentRoot;
}
