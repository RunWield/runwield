/** Workspace project registrations and checkout history in the owner coordination database. */
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { SQLOutputValue } from "node:sqlite";
import {
    getOwnerCoordinationDatabasePath,
    isOwnerCoordinationDatabase,
    openOwnerCoordinationDatabase,
    type OpenOwnerDatabaseOptions,
    type OwnerCoordinationDatabase,
} from "@runwield/resources/owner-database";
import type { DatabaseSync } from "@runwield/resources/sqlite";
import { inspectProjectDirectoryForHome, requireDirectoryConfirmation } from "./directory.ts";
import {
    admitRegistrationIdentity,
    inspectProjectIdentity,
    inspectProjectStorage,
    isProjectId,
    parseProjectId,
    ProjectIdentityEntryRequired,
    resolveProjectLaunchContext,
    verifyExecutionAccountHome,
    type ProjectCloneChoice,
    type ProjectId,
    type ProjectLaunchContext,
} from "./identity.ts";

export type ProjectStatus = "active" | "inactive";
export type ProjectHealthStatus =
    "available" | "missing" | "not_directory" | "unreadable" | "canonical_mismatch" | "identity_mismatch";

export interface RegisteredProject {
    projectId: ProjectId;
    displayName: string;
    registeredRoot: string;
    currentRoot: string;
    status: ProjectStatus;
    createdAt: string;
    updatedAt: string;
    inactiveAt: string | null;
    removedAt: string | null;
    restoredAt: string | null;
    relinkedAt: string | null;
}

export interface ProjectHealth {
    projectId: ProjectId;
    status: ProjectHealthStatus;
    projectStatus: ProjectStatus;
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
    choice?: ProjectCloneChoice;
}

export interface RelinkProjectOptions extends Omit<RegisterProjectOptions, "root" | "choice"> {
    projectId: ProjectId;
    newRoot: string;
}

export interface ProjectRootEvidence {
    enteredRoot: string;
    canonicalRoot: string;
    rootState: "current" | "historical";
    displayName: string;
}

interface EnsureProjectRootEvidenceOptions {
    projectRowId: string;
    enteredRoot: string;
    canonicalRoot: string;
    rootState: "current" | "historical";
    displayName?: string;
    fallbackDisplayName?: string;
    now: string;
}

// node:sqlite does not infer selected columns; this view follows the projects schema.
interface ProjectRow extends Record<string, SQLOutputValue> {
    id: string;
    canonical_project_id: string | null;
    display_name: string;
    registered_root: string;
    current_root: string;
    lifecycle: string;
    created_at: string;
    updated_at: string;
    disabled_at: string | null;
    removed_at: string | null;
    restored_at: string | null;
    relinked_at: string | null;
}

function isoNow(now?: ProjectClockOptions["now"]) {
    return now ? now() : new Date().toISOString();
}

function requireAbsoluteRoot(root: string, field: string): string {
    if (typeof root !== "string" || !root.trim()) throw new Error(`${field} is required`);
    const enteredRoot = root.trim();
    if (!isAbsolute(enteredRoot)) throw new Error(`${field} must be an absolute path`);
    return resolve(enteredRoot);
}

function assertNoEnteredRootRetarget(
    db: DatabaseSync,
    enteredRoot: string,
    canonicalRoot: string,
    allowedProjectId?: ProjectId,
) {
    const rows = db
        .prepare(
            `SELECT COALESCE(projects.canonical_project_id, projects.id) AS project_id, project_roots.canonical_root
                  FROM project_roots JOIN projects ON projects.id = project_roots.project_id
                 WHERE project_roots.entered_root = ?`,
        )
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
        .prepare(
            `SELECT root.id, root.canonical_root
                    FROM project_roots AS root JOIN projects AS project ON project.id = root.project_id
                   WHERE root.entered_root = ?
                     AND (project.id = ? OR project.canonical_project_id =
                          (SELECT canonical_project_id FROM projects WHERE id = ?))
                   ORDER BY project.id = ? DESC, root.created_at, root.id LIMIT 1`,
        )
        .get(options.enteredRoot, options.projectRowId, options.projectRowId, options.projectRowId);
    if (existing) {
        if (existing.canonical_root !== options.canonicalRoot) {
            throw new Error(`Project root path reuse or symlink retarget conflict: ${options.enteredRoot}`);
        }
        db.prepare(
            "UPDATE project_roots SET root_state = ?, ended_at = ?, display_name = COALESCE(?, display_name) WHERE id = ?",
        ).run(
            options.rootState,
            options.rootState === "current" ? null : options.now,
            options.displayName || null,
            existing.id,
        );
        return;
    }
    db.prepare(
        "INSERT INTO project_roots(id, project_id, entered_root, canonical_root, root_state, display_name, created_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
        crypto.randomUUID(),
        options.projectRowId,
        options.enteredRoot,
        options.canonicalRoot,
        options.rootState,
        options.displayName || options.fallbackDisplayName || basename(options.canonicalRoot) || options.canonicalRoot,
        options.now,
        options.rootState === "current" ? null : options.now,
    );
}

// Keep the persisted status values compatible with existing owner databases.
function readProjectStatus(row: ProjectRow): ProjectStatus {
    switch (row.lifecycle) {
        case "enabled":
            return "active";
        case "disabled":
            return "inactive";
        default:
            throw new Error(`Invalid stored Project status for ${row.id}: ${row.lifecycle}`);
    }
}

function writeProjectStatus(status: ProjectStatus): "enabled" | "disabled" {
    switch (status) {
        case "active":
            return "enabled";
        case "inactive":
            return "disabled";
        default:
            throw new Error(`Invalid Project status: ${status}`);
    }
}

function canonicalProjectId(row: ProjectRow): string {
    return row.canonical_project_id ?? row.id;
}

function requireCanonicalProjectId(row: ProjectRow): ProjectId {
    const projectId = parseProjectId(canonicalProjectId(row));
    if (!projectId) throw new Error(`Invalid stored Project ID for ${row.id}`);
    return projectId;
}

function projectFromRow(row: ProjectRow): RegisteredProject {
    return {
        projectId: requireCanonicalProjectId(row),
        displayName: row.display_name,
        registeredRoot: row.registered_root,
        currentRoot: row.current_root,
        status: readProjectStatus(row),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        inactiveAt: row.disabled_at,
        removedAt: row.removed_at,
        restoredAt: row.restored_at,
        relinkedAt: row.relinked_at,
    };
}

/** Read committed checkout identity without mutating Workspace registration data. */
function observeLegacyProjectId(row: ProjectRow, context: ProjectLaunchContext): ProjectId | undefined {
    try {
        if (realpathSync.native(row.registered_root) !== row.current_root) return;
    } catch {
        return;
    }
    const inspection = inspectProjectIdentity(row.current_root, { context });
    return inspection.kind === "existing" ? inspection.identity.projectId : undefined;
}

function projectRows(db: DatabaseSync, context: ProjectLaunchContext, projectId?: string): ProjectRow[] {
    if (projectId !== undefined && !isProjectId(projectId)) return [];
    const rows = (
        projectId
            ? db
                  .prepare(
                      `SELECT * FROM projects
                           WHERE canonical_project_id = ? OR canonical_project_id IS NULL
                           ORDER BY created_at, id`,
                  )
                  .all(projectId)
            : db.prepare("SELECT * FROM projects ORDER BY created_at, id").all()
    ) as ProjectRow[];
    const observed = rows.map((row) => {
        if (row.canonical_project_id || row.lifecycle === "removed") return row;
        const observedId = observeLegacyProjectId(row, context);
        return observedId ? { ...row, canonical_project_id: observedId } : row;
    });
    return projectId ? observed.filter((row) => canonicalProjectId(row) === projectId) : observed;
}

/** Persist verified legacy bindings inside an explicit registry mutation. */
function reconcileLegacyProjectIdentities(db: DatabaseSync, context: ProjectLaunchContext) {
    const rows = db
        .prepare("SELECT * FROM projects WHERE canonical_project_id IS NULL AND lifecycle <> 'removed'")
        .all() as ProjectRow[];
    const bind = db.prepare("UPDATE projects SET canonical_project_id = ? WHERE id = ?");
    for (const row of rows) {
        const observedId = observeLegacyProjectId(row, context);
        if (observedId) bind.run(observedId, row.id);
    }
}

function primaryProject(rows: ProjectRow[], projectId: string): ProjectRow | undefined {
    return rows.find((row) => row.id === projectId) ?? rows[0];
}

function requireProjectedProject(db: DatabaseSync, context: ProjectLaunchContext, projectId: string): ProjectRow {
    const row = primaryProject(projectRows(db, context, projectId), projectId);
    if (!row) throw new Error(`Project not found: ${projectId}`);
    return row;
}

function getProjectRow(db: DatabaseSync, projectId: string): ProjectRow | undefined {
    if (!isProjectId(projectId)) return;
    return db
        .prepare(
            `SELECT * FROM projects
                        WHERE canonical_project_id = ? OR (canonical_project_id IS NULL AND id = ?)
                        ORDER BY id = ? DESC, created_at, id LIMIT 1`,
        )
        .get(projectId, projectId, projectId) as ProjectRow | undefined;
}

function requireProjectRow(db: DatabaseSync, projectId: string): ProjectRow {
    const row = getProjectRow(db, projectId);
    if (!row) throw new Error(`Project not found: ${projectId}`);
    return row;
}

function projectRowsAtRoot(db: DatabaseSync, canonicalRoot: string): ProjectRow[] {
    return db
        .prepare(
            `SELECT DISTINCT projects.* FROM project_roots
                         JOIN projects ON projects.id = project_roots.project_id
                        WHERE project_roots.canonical_root = ?`,
        )
        .all(canonicalRoot) as ProjectRow[];
}

type RegistrationBinding = Parameters<typeof admitRegistrationIdentity>[2];

function admitCheckout(
    root: string,
    context: ProjectLaunchContext,
    binding?: RegistrationBinding,
    choice?: ProjectCloneChoice,
): ProjectId {
    const result = admitRegistrationIdentity(root, context, binding, choice);
    if (result.kind !== "existing") throw new ProjectIdentityEntryRequired(result);
    return result.identity.projectId;
}

function verifyEnteredRoot(enteredRoot: string, canonicalRoot: string) {
    if (realpathSync.native(enteredRoot) !== canonicalRoot) {
        throw new Error(`Project root changed during registration: ${enteredRoot}`);
    }
}

function registerProject(
    database: OwnerCoordinationDatabase,
    context: ProjectLaunchContext,
    options: RegisterProjectOptions,
): RegisteredProject {
    const enteredRoot = requireAbsoluteRoot(options?.root, "Project root");
    const directory = inspectProjectDirectoryForHome(enteredRoot, context.executionAccountHome);
    requireDirectoryConfirmation(directory, options.directoryConfirmation);
    const canonicalRoot = directory.canonicalRoot;
    const displayName = options.displayName || basename(canonicalRoot) || canonicalRoot;
    return database.transaction(() => {
        const db = database.handle;
        reconcileLegacyProjectIdentities(db, context);
        verifyEnteredRoot(enteredRoot, canonicalRoot);
        assertNoEnteredRootRetarget(db, enteredRoot, canonicalRoot);
        const existingRoots = projectRowsAtRoot(db, canonicalRoot);
        const existingIds = new Set(existingRoots.map(canonicalProjectId));
        if (existingIds.size > 1) throw new Error(`Conflicting Project registrations for ${canonicalRoot}`);
        const existing = existingRoots[0];
        const previousId = existing && canonicalProjectId(existing);
        const binding: RegistrationBinding =
            previousId && isProjectId(previousId) && (existing.canonical_project_id || !options.choice)
                ? { projectId: previousId, kind: existing.canonical_project_id ? "existing" : "legacy" }
                : undefined;
        const projectId = admitCheckout(canonicalRoot, context, binding, options.choice);
        verifyEnteredRoot(enteredRoot, canonicalRoot);
        if (existing && existing.canonical_project_id === null) {
            db.prepare("UPDATE projects SET canonical_project_id = ? WHERE id = ?").run(projectId, existing.id);
        }

        const now = isoNow(options.now);
        const project = getProjectRow(db, projectId);
        if (project) {
            ensureProjectRootEvidence(db, {
                projectRowId: project.id,
                enteredRoot,
                canonicalRoot,
                rootState: canonicalRoot === project.current_root ? "current" : "historical",
                displayName: options.displayName,
                fallbackDisplayName: canonicalRoot === project.current_root ? project.display_name : undefined,
                now,
            });
            return projectFromRow(project);
        }

        db.prepare(
            `INSERT INTO projects(id, canonical_project_id, display_name, registered_root, current_root, lifecycle,
                                         created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'enabled', ?, ?)`,
        ).run(projectId, projectId, displayName, enteredRoot, canonicalRoot, now, now);
        ensureProjectRootEvidence(db, {
            projectRowId: projectId,
            enteredRoot,
            canonicalRoot,
            rootState: "current",
            displayName,
            now,
        });
        return projectFromRow(requireProjectRow(db, projectId));
    });
}

function listProjects(db: DatabaseSync, context: ProjectLaunchContext): RegisteredProject[] {
    const groups = new Map<ProjectId, ProjectRow[]>();
    for (const row of projectRows(db, context)) {
        const projectId = canonicalProjectId(row);
        if (!isProjectId(projectId)) continue;
        const group = groups.get(projectId);
        if (group) group.push(row);
        else groups.set(projectId, [row]);
    }
    return [...groups.entries()]
        .map(([projectId, rows]) => projectFromRow(primaryProject(rows, projectId)!))
        .sort(
            (left, right) =>
                left.displayName.localeCompare(right.displayName) || left.createdAt.localeCompare(right.createdAt),
        );
}

function setProjectStatus(
    database: OwnerCoordinationDatabase,
    context: ProjectLaunchContext,
    projectId: ProjectId,
    status: ProjectStatus,
    options: ProjectClockOptions = {},
): RegisteredProject {
    const storedStatus = writeProjectStatus(status);
    return database.transaction(() => {
        const db = database.handle;
        reconcileLegacyProjectIdentities(db, context);
        const canonicalId = canonicalProjectId(requireProjectRow(db, projectId));
        const now = isoNow(options.now);
        db.prepare(
            `UPDATE projects SET lifecycle = ?, updated_at = ?, disabled_at = ?
                     WHERE COALESCE(canonical_project_id, id) = ?`,
        ).run(storedStatus, now, status === "active" ? null : now, canonicalId);
        return projectFromRow(requireProjectRow(db, canonicalId));
    });
}

/** Delete Workspace database records; repository and Session files are untouched. */
function removeProject(database: OwnerCoordinationDatabase, context: ProjectLaunchContext, projectId: ProjectId): void {
    database.transaction(() => {
        const db = database.handle;
        reconcileLegacyProjectIdentities(db, context);
        const canonicalId = canonicalProjectId(requireProjectRow(db, projectId));
        // Legacy triggers allow deleting retired SQLite Session evidence only while removing its registration.
        db.prepare("UPDATE projects SET lifecycle = 'removed' WHERE COALESCE(canonical_project_id, id) = ?").run(
            canonicalId,
        );
        db.prepare(
            `DELETE FROM owner_session_operations
                     WHERE project_id = ? OR project_id IN (SELECT id FROM projects WHERE canonical_project_id = ?)`,
        ).run(canonicalId, canonicalId);
        for (const table of [
            "session_transcript_segment_state",
            "session_activation_state",
            "session_committed_generations",
            "session_transcript_segments",
            "session_transcript_locators",
            "runwield_sessions",
            "project_session_catalog_scans",
            "project_roots",
        ]) {
            db.prepare(
                `DELETE FROM ${table}
                         WHERE project_id IN (SELECT id FROM projects WHERE COALESCE(canonical_project_id, id) = ?)`,
            ).run(canonicalId);
        }
        db.prepare("DELETE FROM projects WHERE COALESCE(canonical_project_id, id) = ?").run(canonicalId);
    });
}

function relinkProject(
    database: OwnerCoordinationDatabase,
    context: ProjectLaunchContext,
    options: RelinkProjectOptions,
): RegisteredProject {
    const enteredRoot = requireAbsoluteRoot(options?.newRoot, "New Project root");
    const directory = inspectProjectDirectoryForHome(enteredRoot, context.executionAccountHome);
    requireDirectoryConfirmation(directory, options.directoryConfirmation);
    const canonicalRoot = directory.canonicalRoot;
    return database.transaction(() => {
        const db = database.handle;
        reconcileLegacyProjectIdentities(db, context);
        const project = requireProjectRow(db, options.projectId);
        const currentId = requireCanonicalProjectId(project);
        verifyEnteredRoot(enteredRoot, canonicalRoot);
        assertNoEnteredRootRetarget(db, enteredRoot, canonicalRoot, currentId);
        if (projectRowsAtRoot(db, canonicalRoot).some((root) => canonicalProjectId(root) !== currentId)) {
            throw new Error(`Project root is already registered to another Project: ${canonicalRoot}`);
        }
        const inspected = inspectProjectIdentity(canonicalRoot, { context });
        const wasMovedBeforeMigration =
            project.canonical_project_id === null &&
            inspected.kind === "existing" &&
            inspectProjectStorage(canonicalRoot, { context }).some(
                (binding) =>
                    binding.projectId === inspected.identity.projectId &&
                    binding.historicalRoots?.includes(project.current_root),
            );
        const preferredId = wasMovedBeforeMigration ? inspected.identity.projectId : currentId;
        const choice: ProjectCloneChoice | undefined =
            inspected.kind === "pending" && inspected.candidates.some((item) => item.projectId === preferredId)
                ? { kind: "link", projectId: preferredId, candidates: inspected.candidates }
                : undefined;
        const binding: RegistrationBinding = {
            projectId: preferredId,
            kind: project.canonical_project_id || wasMovedBeforeMigration ? "existing" : "legacy",
        };
        const projectId = admitCheckout(canonicalRoot, context, binding, choice);
        verifyEnteredRoot(enteredRoot, canonicalRoot);
        const now = isoNow(options.now);
        db.prepare(
            `UPDATE project_roots SET root_state = 'historical', ended_at = COALESCE(ended_at, ?)
                     WHERE project_id IN (SELECT id FROM projects WHERE COALESCE(canonical_project_id, id) = ?)`,
        ).run(now, currentId);
        ensureProjectRootEvidence(db, {
            projectRowId: project.id,
            enteredRoot,
            canonicalRoot,
            rootState: "current",
            displayName: options.displayName,
            fallbackDisplayName: project.display_name,
            now,
        });
        db.prepare(
            `UPDATE projects SET canonical_project_id = ?, registered_root = ?, current_root = ?,
                         display_name = ?, updated_at = ?, relinked_at = ? WHERE id = ?`,
        ).run(projectId, enteredRoot, canonicalRoot, options.displayName || project.display_name, now, now, project.id);
        return projectFromRow(requireProjectRow(db, projectId));
    });
}

function listProjectRootEvidence(
    db: DatabaseSync,
    context: ProjectLaunchContext,
    projectId: string,
): ProjectRootEvidence[] {
    const rows = projectRows(db, context, projectId);
    const project = primaryProject(rows, projectId);
    if (!project) return [];
    return db
        .prepare(
            `SELECT root.entered_root, root.canonical_root,
                    COALESCE(root.display_name, project.display_name) AS root_display_name,
                    CASE WHEN root.canonical_root = ? AND MAX(root.root_state = 'current')
                         THEN 'current' ELSE 'historical' END AS resolved_state
               FROM project_roots AS root JOIN projects AS project ON project.id = root.project_id
              WHERE root.project_id IN (SELECT value FROM json_each(?))
              GROUP BY root.entered_root, root.canonical_root, root_display_name
              ORDER BY resolved_state = 'current' DESC, MAX(root.created_at) DESC, root.entered_root, root_display_name`,
        )
        .all(project.current_root, JSON.stringify(rows.map((row) => row.id)))
        .map((row) => ({
            enteredRoot: String(row.entered_root),
            canonicalRoot: String(row.canonical_root),
            rootState: row.resolved_state === "current" ? "current" : "historical",
            displayName: String(row.root_display_name),
        }));
}

function inspectProjectHealth(row: ProjectRow, context: ProjectLaunchContext): ProjectHealth {
    const project = projectFromRow(row);
    const evidence: string[] = [];

    let observedRealRoot: string | null = null;
    if (project.status === "inactive") {
        evidence.push("Project is inactive and unavailable for new Workspace activity.");
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
    if (status === "available" && row.canonical_project_id) {
        const inspection = inspectProjectIdentity(project.currentRoot, { context });
        if (inspection.kind !== "existing" || inspection.identity.projectId !== row.canonical_project_id) {
            status = "identity_mismatch";
            evidence.push("The registered root no longer has this Project's identity.");
        }
    }
    return {
        projectId: project.projectId,
        status,
        projectStatus: project.status,
        registeredRoot: project.registeredRoot,
        currentRoot: project.currentRoot,
        observedRealRoot,
        evidence,
    };
}

function requireActiveProjectRoot(
    database: OwnerCoordinationDatabase,
    context: ProjectLaunchContext,
    projectId: string,
): string {
    const row = requireProjectedProject(database.handle, context, projectId);
    if (readProjectStatus(row) !== "active") throw new Error(`Project is inactive: ${projectId}`);
    const health = inspectProjectHealth(row, context);
    if (health.status !== "available") throw new Error(`Project root is not available: ${health.status}`);
    return row.current_root;
}

export interface ProjectRegistry {
    register(options: RegisterProjectOptions): RegisteredProject;
    list(): RegisteredProject[];
    /** Resolve a Workspace or persisted identifier after validating its Project ID syntax. */
    get(projectId: string): RegisteredProject | null;
    relink(options: RelinkProjectOptions): RegisteredProject;
    setStatus(projectId: ProjectId, status: ProjectStatus, options?: ProjectClockOptions): RegisteredProject;
    remove(projectId: ProjectId): void;
    listRootEvidence(projectId: string): ProjectRootEvidence[];
    getHealth(projectId: string): ProjectHealth;
    requireActiveRoot(projectId: string): string;
}

export interface OpenedProjectRegistry extends ProjectRegistry {
    close(): void;
}

const registryRoots = new WeakMap<ProjectRegistry, ProjectRegistry["requireActiveRoot"]>();

/** Resolve through an opened Projects registry's own account and database. */
export function requireRegisteredProjectRoot(registry: ProjectRegistry, projectId: ProjectId): string {
    const requireActiveRoot = registryRoots.get(registry);
    if (!requireActiveRoot) throw new Error("Project access requires a registry opened by Projects.");
    return requireActiveRoot(projectId);
}

type AccountHomeProof = Parameters<typeof verifyExecutionAccountHome>[0];

/** Pin registry storage without changing the Core owner identity's spelling. */
function captureRegistryHome(context: ProjectLaunchContext): AccountHomeProof {
    if (context.accountHomeDirectory || !context.executionAccountHome) return context;
    const directory = lstatSync(context.executionAccountHome, { throwIfNoEntry: false });
    if (!directory?.isDirectory()) return context;
    return {
        configuredExecutionAccountHome: context.configuredExecutionAccountHome ?? context.executionAccountHome,
        executionAccountHome: realpathSync(context.executionAccountHome),
        accountHomeDirectory: { device: directory.dev, inode: directory.ino },
    };
}

function bindRegistry(
    database: OwnerCoordinationDatabase,
    context: ProjectLaunchContext,
    homeProof: AccountHomeProof = context,
): ProjectRegistry {
    const usingRegistry = <Result>(operation: () => Result): Result => {
        verifyExecutionAccountHome(homeProof);
        return operation();
    };
    const db = database.handle;
    const registry: ProjectRegistry = {
        register: (options) => usingRegistry(() => registerProject(database, context, options)),
        list: () => usingRegistry(() => listProjects(db, context)),
        get: (projectId) =>
            usingRegistry(() => {
                const row = primaryProject(projectRows(db, context, projectId), projectId);
                return row ? projectFromRow(row) : null;
            }),
        relink: (options) => usingRegistry(() => relinkProject(database, context, options)),
        setStatus: (projectId, status, options) =>
            usingRegistry(() => setProjectStatus(database, context, projectId, status, options)),
        remove: (projectId) => usingRegistry(() => removeProject(database, context, projectId)),
        listRootEvidence: (projectId) => usingRegistry(() => listProjectRootEvidence(db, context, projectId)),
        getHealth: (projectId) =>
            usingRegistry(() => inspectProjectHealth(requireProjectedProject(db, context, projectId), context)),
        requireActiveRoot: (projectId) => usingRegistry(() => requireActiveProjectRoot(database, context, projectId)),
    };
    registryRoots.set(registry, registry.requireActiveRoot);
    return registry;
}

/** Bind Workspace registrations to the connection already used by other owner coordination services. */
export function bindProjectRegistry(database: OwnerCoordinationDatabase): ProjectRegistry {
    if (!isOwnerCoordinationDatabase(database)) {
        throw new Error("Workspace registrations require a RunWield owner coordination database.");
    }
    return bindRegistry(database, resolveProjectLaunchContext());
}

/** Open the Workspace registry and owner coordination services in the same verified account scope. */
export function openProjectOwnerCoordination(options: OpenOwnerDatabaseOptions = {}) {
    const context = resolveProjectLaunchContext();
    const homeProof = captureRegistryHome(context);
    const dbPath = options.dbPath || getOwnerCoordinationDatabasePath({ home: context.executionAccountHome });
    const database = openOwnerCoordinationDatabase({ ...options, dbPath });
    try {
        verifyExecutionAccountHome(homeProof);
        return {
            database,
            projects: bindRegistry(database, context, homeProof),
            projectIdForRowKey: (rowKey: string) => {
                verifyExecutionAccountHome(homeProof);
                const row = database.handle.prepare("SELECT * FROM projects WHERE id = ?").get(rowKey) as
                    ProjectRow | undefined;
                return (
                    row && parseProjectId(row.canonical_project_id ?? observeLegacyProjectId(row, context) ?? row.id)
                );
            },
            projectRowKeys: (projectId: string) => {
                verifyExecutionAccountHome(homeProof);
                return projectRows(database.handle, context, projectId).map((row) => row.id);
            },
            executionAccountHome: homeProof.executionAccountHome,
        };
    } catch (error) {
        database.close();
        throw error;
    }
}

/** Open Workspace registrations in the current launch account's owner coordination database. */
export function openProjectRegistry(): OpenedProjectRegistry {
    const { database, projects } = openProjectOwnerCoordination();
    return Object.assign(projects, { close: () => database.close() });
}
