/**
 * @module shared/owner-coordination/projects
 * Registered Project lifecycle and health APIs for owner coordination.
 */

import { readdirSync, realpathSync, statSync } from "node:fs";
import { deleteProjectRegistration } from "./project-removal.ts";
import { basename, isAbsolute, resolve } from "@std/path";

/**
 * @typedef {'enabled' | 'disabled' | 'removed'} ProjectLifecycle
 */

/**
 * @typedef {'available' | 'missing' | 'not_directory' | 'unreadable' | 'canonical_mismatch'} ProjectHealthStatus
 */

/**
 * @typedef {Object} RegisteredProject
 * @property {string} projectId
 * @property {string} displayName
 * @property {string} registeredRoot
 * @property {string} currentRoot
 * @property {ProjectLifecycle} lifecycle
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string | null} disabledAt
 * @property {string | null} removedAt
 * @property {string | null} restoredAt
 * @property {string | null} relinkedAt
 */

/**
 * @typedef {Object} ProjectHealth
 * @property {string} projectId
 * @property {ProjectHealthStatus} status
 * @property {ProjectLifecycle} lifecycle
 * @property {string} registeredRoot
 * @property {string} currentRoot
 * @property {string | null} observedRealRoot
 * @property {string[]} evidence
 */

/** @param {unknown} value */
function requireDatabase(value) {
    if (!value || typeof value !== "object" || !("handle" in value)) throw new Error("Owner database is required");
    return /** @type {import('./database.js').OwnerCoordinationDatabase} */ (value);
}

/** @param {() => string} [now] */
function isoNow(now) {
    return now ? now() : new Date().toISOString();
}

/** @param {() => string} [idFactory] */
function newId(idFactory) {
    return idFactory ? idFactory() : crypto.randomUUID();
}

/**
 * @param {unknown} root
 * @param {string} field
 * @returns {string}
 */
function requireAbsoluteRoot(root, field) {
    if (typeof root !== "string" || !root.trim()) throw new Error(`${field} is required`);
    const enteredRoot = root.trim();
    if (!isAbsolute(enteredRoot)) throw new Error(`${field} must be an absolute path`);
    return resolve(enteredRoot);
}

/** @param {string} path */
function canonicalizeExistingDirectory(path) {
    let stat;
    try {
        stat = statSync(path);
    } catch (error) {
        throw new Error(`Project root is not available: ${path}`, { cause: error });
    }
    if (!stat.isDirectory()) throw new Error(`Project root must be a directory: ${path}`);
    return realpathSync.native(path);
}

/**
 * @param {import('../sqlite.ts').DatabaseSync} db
 * @param {string} enteredRoot
 * @param {string} canonicalRoot
 * @param {string} [allowedProjectId]
 */
function assertNoEnteredRootRetarget(db, enteredRoot, canonicalRoot, allowedProjectId) {
    const rows = db.prepare("SELECT project_id, canonical_root FROM project_roots WHERE entered_root = ?").all(
        enteredRoot,
    );
    for (const row of rows) {
        if (row.canonical_root !== canonicalRoot) {
            throw new Error(`Project root path reuse or symlink retarget conflict: ${enteredRoot}`);
        }
        if (allowedProjectId && row.project_id !== allowedProjectId) {
            throw new Error(`Project root is already registered to another Project: ${enteredRoot}`);
        }
    }
}

/**
 * @param {import('../sqlite.ts').DatabaseSync} db
 * @param {{ projectId: string, enteredRoot: string, canonicalRoot: string, rootState: 'current' | 'historical', now: string, idFactory?: () => string }} options
 */
function ensureProjectRootEvidence(db, options) {
    const existing = db.prepare(
        "SELECT id, canonical_root FROM project_roots WHERE project_id = ? AND entered_root = ?",
    ).get(options.projectId, options.enteredRoot);
    if (existing) {
        if (existing.canonical_root !== options.canonicalRoot) {
            throw new Error(`Project root path reuse or symlink retarget conflict: ${options.enteredRoot}`);
        }
        db.prepare(
            "UPDATE project_roots SET root_state = ?, ended_at = ? WHERE id = ?",
        ).run(options.rootState, options.rootState === "current" ? null : options.now, existing.id);
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

/** @param {any} row */
function projectFromRow(row) {
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

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {string} projectId
 * @returns {RegisteredProject | null}
 */
export function getProjectById(database, projectId) {
    const db = requireDatabase(database).handle;
    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
    return row ? projectFromRow(row) : null;
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {{ root: string, displayName?: string, idFactory?: () => string, now?: () => string }} options
 * @returns {RegisteredProject}
 */
export function registerProject(database, options) {
    const ownerDb = requireDatabase(database);
    const enteredRoot = requireAbsoluteRoot(options?.root, "Project root");
    const canonicalRoot = canonicalizeExistingDirectory(enteredRoot);
    const displayName = options.displayName || basename(canonicalRoot) || canonicalRoot;
    return ownerDb.transaction(() => {
        const db = ownerDb.handle;
        assertNoEnteredRootRetarget(db, enteredRoot, canonicalRoot);
        const existingRoot = db.prepare(
            "SELECT DISTINCT projects.* FROM project_roots JOIN projects ON projects.id = project_roots.project_id WHERE project_roots.canonical_root = ? ORDER BY projects.created_at LIMIT 1",
        ).get(canonicalRoot);
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
            return projectFromRow(db.prepare("SELECT * FROM projects WHERE id = ?").get(existingProjectId));
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
        return projectFromRow(db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId));
    });
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @returns {RegisteredProject[]}
 */
export function listProjects(database) {
    const db = requireDatabase(database).handle;
    return db.prepare("SELECT * FROM projects ORDER BY display_name, created_at").all().map(projectFromRow);
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {string} projectId
 * @param {boolean} enabled
 * @param {{ now?: () => string }} [options]
 * @returns {RegisteredProject}
 */
export function setProjectEnabled(database, projectId, enabled, options = {}) {
    const ownerDb = requireDatabase(database);
    return ownerDb.transaction(() => {
        const project = getProjectById(ownerDb, projectId);
        if (!project) throw new Error(`Project not found: ${projectId}`);
        const now = isoNow(options.now);
        ownerDb.handle.prepare(
            "UPDATE projects SET lifecycle = ?, updated_at = ?, disabled_at = ? WHERE id = ?",
        ).run(enabled ? "enabled" : "disabled", now, enabled ? null : now, projectId);
        return /** @type {RegisteredProject} */ (getProjectById(ownerDb, projectId));
    });
}

/**
 * Delete Workspace database records only; repository and Session files are untouched.
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {string} projectId
 * @returns {void}
 */
export function removeProject(database, projectId) {
    const ownerDb = requireDatabase(database);
    ownerDb.transaction(() => {
        if (!getProjectById(ownerDb, projectId)) throw new Error(`Project not found: ${projectId}`);
        deleteProjectRegistration(ownerDb.handle, projectId);
    });
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {{ projectId: string, newRoot: string, displayName?: string, idFactory?: () => string, now?: () => string }} options
 * @returns {RegisteredProject}
 */
export function relinkProject(database, options) {
    const ownerDb = requireDatabase(database);
    const enteredRoot = requireAbsoluteRoot(options?.newRoot, "New Project root");
    const canonicalRoot = canonicalizeExistingDirectory(enteredRoot);
    return ownerDb.transaction(() => {
        const db = ownerDb.handle;
        const project = getProjectById(ownerDb, options.projectId);
        if (!project) throw new Error(`Project not found: ${options.projectId}`);
        assertNoEnteredRootRetarget(db, enteredRoot, canonicalRoot, options.projectId);
        const existingRoots = db.prepare("SELECT DISTINCT project_id FROM project_roots WHERE canonical_root = ?").all(
            canonicalRoot,
        );
        if (existingRoots.some((root) => root.project_id !== options.projectId)) {
            throw new Error(`Project root is already registered to another Project: ${canonicalRoot}`);
        }
        const now = isoNow(options.now);
        db.prepare(
            "UPDATE project_roots SET root_state = 'historical', ended_at = COALESCE(ended_at, ?) WHERE project_id = ?",
        )
            .run(now, options.projectId);
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
        return /** @type {RegisteredProject} */ (getProjectById(ownerDb, options.projectId));
    });
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {string} projectId
 * @returns {Array<{ enteredRoot: string, canonicalRoot: string, rootState: string }>}
 */
export function listProjectRootEvidence(database, projectId) {
    const db = requireDatabase(database).handle;
    return db.prepare(
        "SELECT entered_root, canonical_root, root_state FROM project_roots WHERE project_id = ? ORDER BY root_state = 'current' DESC, created_at DESC",
    ).all(projectId).map((row) => ({
        enteredRoot: String(row.entered_root),
        canonicalRoot: String(row.canonical_root),
        rootState: String(row.root_state),
    }));
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {string} projectId
 * @returns {ProjectHealth}
 */
export function getProjectHealth(database, projectId) {
    const project = getProjectById(database, projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const evidence = [];
    /** @type {string | null} */
    let observedRealRoot = null;
    if (project.lifecycle === "removed") evidence.push("Project is removed and unavailable to Workspace.");
    if (project.lifecycle === "disabled") {
        evidence.push("Project is disabled and unavailable for new Workspace activity.");
    }
    let status = "available";
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
        status: /** @type {ProjectHealthStatus} */ (status),
        lifecycle: project.lifecycle,
        registeredRoot: project.registeredRoot,
        currentRoot: project.currentRoot,
        observedRealRoot,
        evidence,
    };
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {string} projectId
 * @returns {string}
 */
export function requireEnabledProjectRoot(database, projectId) {
    const project = getProjectById(database, projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    if (project.lifecycle !== "enabled") throw new Error(`Project is not enabled: ${projectId}`);
    const health = getProjectHealth(database, projectId);
    if (health.status !== "available") throw new Error(`Project root is not available: ${health.status}`);
    return project.currentRoot;
}
