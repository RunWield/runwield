/**
 * @module shared/session/root-session
 * Root interactive session lifecycle helpers (persisted in ~/.wld/sessions).
 */

import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { open, readdir, realpath, stat as fsStat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, SEPARATOR } from "@std/path";
import { encodeCwdForSessionDir } from "./session-directory-name.ts";
export { encodeCwdForSessionDir } from "./session-directory-name.ts";
import { requireLocalSessionWriter } from "../remote/personal-resources.ts";
import { getHomeDir } from "../../constants.js";

/**
 * Resolve the root RunWield sessions base directory.
 *
 * @returns {string}
 */
export function getRunWieldSessionsBaseDir() {
    requireLocalSessionWriter();
    const home = getHomeDir() || "~";
    return join(home, ".wld", "sessions");
}

/**
 * @param {string} cwd
 * @returns {string}
 */
function canonicalizeCwd(cwd) {
    let canonicalCwd = resolve(cwd);
    try {
        canonicalCwd = realpathSync.native(canonicalCwd);
    } catch {
        // A not-yet-created cwd still gets a stable absolute locator.
    }
    return canonicalCwd;
}

/**
 * Resolve RunWield root session directory for a cwd.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function getRunWieldSessionDir(cwd) {
    return join(getRunWieldSessionsBaseDir(), encodeCwdForSessionDir(canonicalizeCwd(cwd)));
}

/**
 * Resolve the image-artifact directory for a persisted root session.
 *
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {string}
 */
export function getRunWieldSessionImageDir(cwd, sessionId) {
    return join(getRunWieldSessionDir(cwd), `${sessionId}_images`);
}

/**
 * Resolve the memory-backup artifact directory for a persisted root session.
 *
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {string}
 */
export function getRunWieldSessionMemoryBackupDir(cwd, sessionId) {
    return join(getRunWieldSessionDir(cwd), `${sessionId}_memory-backups`);
}

/**
 * Ensure a directory exists.
 *
 * @param {string} dir
 */
function ensureDir(dir) {
    mkdirSync(dir, { recursive: true });
}

/**
 * @typedef {"new" | "continue"} RootSessionStartMode
 */

/**
 * Create or continue the persisted root session manager.
 *
 * @param {RootSessionStartMode} mode
 * @param {string} cwd
 * @returns {Promise<import('@earendil-works/pi-coding-agent').SessionManager>}
 */
export async function createRootSessionManager(mode, cwd) {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const canonicalCwd = canonicalizeCwd(cwd);
    const sessionDir = getRunWieldSessionDir(canonicalCwd);
    ensureDir(sessionDir);

    const manager = mode === "continue"
        ? SessionManager.continueRecent(canonicalCwd, sessionDir)
        : SessionManager.create(canonicalCwd, sessionDir);
    return installSessionPersistence(manager);
}

/** @param {import('@earendil-works/pi-coding-agent').SessionManager} sessionManager */
function getSessionManagerFileContents(sessionManager) {
    const header = sessionManager.getHeader?.();
    const entries = sessionManager.getEntries?.();
    if (!header || !Array.isArray(entries)) return null;
    return [header, ...entries].map((entry) => `${JSON.stringify(entry)}\n`).join("");
}

/**
 * @param {import('@earendil-works/pi-coding-agent').SessionManager} sessionManager
 * @returns {import('@earendil-works/pi-coding-agent').SessionManager}
 */
function installSessionPersistence(sessionManager) {
    function rewriteFile() {
        const transcriptPath = sessionManager.getSessionFile?.();
        const contents = getSessionManagerFileContents(sessionManager);
        if (!transcriptPath || contents === null) return;
        writeFileSync(transcriptPath, contents);
    }

    /** @param {import('@earendil-works/pi-coding-agent').SessionEntry} entry */
    function persist(entry) {
        const transcriptPath = sessionManager.getSessionFile?.();
        if (!transcriptPath) return;
        try {
            statSync(transcriptPath);
            writeFileSync(transcriptPath, `${JSON.stringify(entry)}\n`, { flag: "a" });
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
            const contents = getSessionManagerFileContents(sessionManager);
            if (contents === null) return;
            writeFileSync(transcriptPath, contents, { flag: "wx" });
        }
        Reflect.set(sessionManager, "flushed", true);
    }

    return new Proxy(sessionManager, {
        get(target, property, receiver) {
            if (property === "_rewriteFile") return rewriteFile;
            if (property === "_persist") return persist;
            return Reflect.get(target, property, receiver);
        },
    });
}

/** @param {any} sessionManager @param {string} transcriptPath */
async function ensureCreatedSessionTranscriptFile(sessionManager, transcriptPath) {
    try {
        const stat = await fsStat(transcriptPath);
        if (stat.isFile()) return;
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const header = sessionManager.getHeader?.();
    const entries = sessionManager.getEntries?.();
    if (!header || !Array.isArray(entries)) {
        throw new Error(`Created Session transcript was not persisted: ${transcriptPath}`);
    }
    const contents = [header, ...entries].map((entry) => `${JSON.stringify(entry)}\n`).join("");
    await writeFile(transcriptPath, contents, { flag: "wx" });
    if ("flushed" in sessionManager) sessionManager.flushed = true;
    const stat = await fsStat(transcriptPath);
    if (!stat.isFile()) throw new Error(`Created Session transcript was not persisted: ${transcriptPath}`);
}

/** @param {string} cwd @param {any} sessionManager */
export async function resolveCreatedRootSessionPath(cwd, sessionManager) {
    const piSessionId = sessionManager.getSessionId?.();
    if (!piSessionId) throw new Error("The Session could not be persisted");
    const sessions = await listPersistedRootSessions(cwd);
    const match = sessions.find((session) => session.id === piSessionId);
    if (match?.path) return match.path;
    const transcriptPath = sessionManager.getSessionFile?.();
    const sessionDir = getRunWieldSessionDir(cwd);
    if (
        !transcriptPath || typeof transcriptPath !== "string" || !isAbsolute(transcriptPath) ||
        !isPathInside(transcriptPath, sessionDir) || !basename(transcriptPath).includes(piSessionId)
    ) {
        throw new Error(`Created Session transcript was not found: ${piSessionId}`);
    }
    await ensureCreatedSessionTranscriptFile(sessionManager, transcriptPath);
    return transcriptPath;
}

/**
 * @typedef {Object} PersistedRootSessionInfo
 * @property {string} id
 * @property {string} path
 * @property {string} cwd
 * @property {Date | string | number} [modified]
 * @property {number} [messageCount]
 * @property {string} [firstMessage]
 * @property {string} [name]
 */

/**
 * @typedef {Object} ResolvePersistedRootSessionOptions
 * @property {string} cwd
 * @property {string} sessionId
 * @property {string} [sessionPath]
 * @property {string} [sessionDir]
 * @property {string} [managedProjectRoot]
 * @property {string} [managedSegmentCwd]
 */

/**
 * @typedef {Object} ResolvedPersistedRootSession
 * @property {string} cwd
 * @property {string} sessionDir
 * @property {string} sessionId
 * @property {string} sessionPath
 * @property {PersistedRootSessionInfo | null} info
 */

/** @param {string} path @param {string} baseDir */
export function isPathInside(path, baseDir) {
    const child = relative(resolve(baseDir), resolve(path));
    return child === "" || (child !== ".." && !child.startsWith(`..${SEPARATOR}`) && !isAbsolute(child));
}

/** @param {string} path @param {string} baseDir */
async function assertRealPathInside(path, baseDir) {
    const realPath = await realpath(path);
    const realBase = await realpath(baseDir);
    if (!isPathInside(realPath, realBase)) {
        throw new Error("Persisted session path resolves outside the RunWield session directory for cwd");
    }
}

/** @param {unknown} value */
function getManagerCwd(value) {
    if (!value || typeof value !== "object" || !("getCwd" in value) || typeof value.getCwd !== "function") return "";
    const cwd = value.getCwd();
    return typeof cwd === "string" ? cwd : "";
}

/**
 * @typedef {Object} RootSessionLocatorClassification
 * @property {"uncataloged" | "managed" | "blocked"} kind
 * @property {string} [reason]
 * @property {import('../owner-coordination/sessions.js').CatalogedSession} [session]
 * @property {{ projectId: string, cwd: string }} [project]
 * @property {CatalogSafeRootSessionLocator} [locator]
 */

/** @param {string} child @param {string} parent */
function isSameOrInsidePath(child, parent) {
    return isPathInside(resolve(child), resolve(parent));
}

/**
 * Resolve a root Session locator through the file-backed Session catalog before
 * any Pi SessionManager API is used.
 *
 * @param {{ cwd: string, sessionId?: string, sessionPath?: string, ownerCoordinationStore?: ReturnType<typeof import('./file-session-store.ts').openFileSessionStore> | null, allowCatalog?: boolean }} options
 * @returns {Promise<RootSessionLocatorClassification>}
 */
export async function classifyRootSessionLocator(options) {
    if (!options?.cwd || !isAbsolute(options.cwd)) {
        return { kind: "blocked", reason: "invalid_cwd" };
    }
    const store = options.ownerCoordinationStore || null;
    if (!store) return { kind: "blocked", reason: "session_store_unavailable" };
    let realCwd;
    try {
        realCwd = await realpath(options.cwd);
    } catch {
        realCwd = resolve(options.cwd);
    }
    const projects = store.listSessionProjects();
    if (projects.length === 0) {
        return { kind: "uncataloged", reason: "session_catalog_empty" };
    }
    const requestedCwd = resolve(options.cwd);
    /** @type {Array<{ projectId: string, lifecycle: string, currentRoot: string }>} */
    const exactCurrentProjects = [];
    /** @type {Array<{ projectId: string, lifecycle: string, currentRoot: string }>} */
    const canonicalCurrentProjects = [];
    /** @type {Array<{ projectId: string, lifecycle: string, currentRoot: string }>} */
    const exactHistoricalProjects = [];
    /** @type {Array<{ projectId: string, lifecycle: string, currentRoot: string }>} */
    const canonicalHistoricalProjects = [];
    for (const project of projects) {
        const roots = store.listProjectRootEvidence(project.projectId);
        const exactCurrent = roots.some((root) =>
            root.rootState === "current" && requestedCwd === resolve(root.enteredRoot)
        );
        const canonicalCurrent = roots.some((root) =>
            root.rootState === "current" && isSameOrInsidePath(realCwd, root.canonicalRoot)
        );
        const exactHistorical = roots.some((root) =>
            root.rootState === "historical" && requestedCwd === resolve(root.enteredRoot)
        );
        const canonicalHistorical = roots.some((root) =>
            root.rootState === "historical" && isSameOrInsidePath(realCwd, root.canonicalRoot)
        );
        if (exactCurrent) exactCurrentProjects.push(project);
        else if (canonicalCurrent) canonicalCurrentProjects.push(project);
        if (exactHistorical) exactHistoricalProjects.push(project);
        else if (canonicalHistorical) canonicalHistoricalProjects.push(project);
    }
    const currentProjects = exactCurrentProjects.length > 0 ? exactCurrentProjects : canonicalCurrentProjects;
    const historicalProjects = exactHistoricalProjects.length > 0
        ? exactHistoricalProjects
        : canonicalHistoricalProjects;
    if (currentProjects.length > 1 || historicalProjects.length > 1) {
        return { kind: "blocked", reason: "locator_conflict" };
    }
    if (currentProjects.length === 0 && historicalProjects.length > 0) {
        return { kind: "blocked", reason: "historical_project_root" };
    }
    const project = currentProjects[0] || null;
    if (!project) return { kind: "uncataloged", reason: "session_project_absent" };
    const currentRoots = store.listProjectRootEvidence(project.projectId)
        .filter((root) =>
            root.rootState === "current" &&
            (isSameOrInsidePath(realCwd, root.canonicalRoot) || isSameOrInsidePath(requestedCwd, root.enteredRoot))
        );
    if (
        currentRoots.some((root) =>
            resolve(realCwd) !== resolve(root.canonicalRoot) && requestedCwd !== resolve(root.enteredRoot)
        )
    ) {
        return { kind: "blocked", reason: "nested_project_root" };
    }
    if (project.lifecycle !== "enabled") return { kind: "blocked", reason: "project_not_enabled" };
    try {
        store.requireSessionProjectRoot(project.projectId);
    } catch {
        return { kind: "blocked", reason: "project_root_unavailable" };
    }
    if (!options.sessionPath && !options.sessionId) {
        return { kind: "managed", project: { projectId: project.projectId, cwd: realCwd } };
    }
    if (!options.sessionPath && options.sessionId) {
        const cataloged = store.findSessionByLocator({ projectId: project.projectId, piSessionId: options.sessionId });
        if (!cataloged) return { kind: "blocked", reason: "session_path_required" };
        const inspected = store.inspectSessionActivation(cataloged.runwieldSessionId);
        if (!inspected.activation) return { kind: "blocked", reason: "missing_activation_row" };
        return { kind: "managed", session: cataloged, project: { projectId: project.projectId, cwd: realCwd } };
    }
    const requestedSessionPath = resolve(String(options.sessionPath));
    const projectRoot = store.requireSessionProjectRoot(project.projectId);
    const projectSessionDir = join(store.path, encodeCwdForSessionDir(canonicalizeCwd(projectRoot)));
    const catalogedByPath = store.findSessionByLocator({
        projectId: project.projectId,
        transcriptPath: requestedSessionPath,
    });
    const catalogedSegment = catalogedByPath
        ? store.listSessionTranscriptSegments(catalogedByPath.runwieldSessionId).find((segment) =>
            resolve(segment.transcriptPath) === requestedSessionPath
        )
        : null;
    const locatorSessionDir = isPathInside(requestedSessionPath, projectSessionDir)
        ? projectSessionDir
        : catalogedSegment
        ? getRunWieldSessionDir(catalogedSegment.transcriptCwd)
        : undefined;
    let locator;
    try {
        locator = await readCatalogSafeRootSessionLocator({
            cwd: options.cwd,
            sessionPath: requestedSessionPath,
            sessionDir: locatorSessionDir,
        });
    } catch {
        return { kind: "blocked", reason: "invalid_transcript_locator" };
    }
    const byPath = store.findSessionByLocator({ transcriptPath: locator.sessionPath });
    const byPi = store.findSessionByLocator({ projectId: project.projectId, piSessionId: locator.piSessionId });
    if (byPath && byPi && byPath.runwieldSessionId !== byPi.runwieldSessionId) {
        return { kind: "blocked", reason: "locator_conflict" };
    }
    if (!byPath && byPi && byPi.transcriptPath !== locator.sessionPath) {
        return { kind: "blocked", reason: "locator_conflict" };
    }
    let session = byPath || byPi || null;
    if (!session && options.allowCatalog !== false) {
        try {
            session = await store.ensureSessionCatalogRecord({
                projectId: project.projectId,
                piSessionId: locator.piSessionId,
                transcriptPath: locator.sessionPath,
                transcriptCwd: locator.headerCwd,
                headerVersion: locator.headerVersion,
                headerTimestamp: locator.headerTimestamp,
                source: "catalog",
            });
        } catch {
            return { kind: "blocked", reason: "catalog_unavailable" };
        }
    }
    if (!session) return { kind: "blocked", reason: "session_not_cataloged" };
    if (session.projectId !== project.projectId) return { kind: "blocked", reason: "locator_conflict" };
    const inspected = store.inspectSessionActivation(session.runwieldSessionId);
    if (!inspected.activation) return { kind: "blocked", reason: "missing_activation_row" };
    return { kind: "managed", session, project: { projectId: project.projectId, cwd: realCwd }, locator };
}

/**
 * List persisted RunWield root sessions for a cwd.
 *
 * @param {string} cwd
 * @returns {Promise<PersistedRootSessionInfo[]>}
 */
export async function listPersistedRootSessions(cwd) {
    if (!cwd || !isAbsolute(cwd)) throw new Error("listPersistedRootSessions requires an absolute cwd");
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const canonicalCwd = canonicalizeCwd(cwd);
    const enteredCwd = resolve(cwd);
    const sessionDir = getRunWieldSessionDir(canonicalCwd);
    const sessions = /** @type {PersistedRootSessionInfo[]} */ (await SessionManager.list(canonicalCwd, sessionDir));
    if (enteredCwd !== canonicalCwd) {
        const legacySessions =
            /** @type {PersistedRootSessionInfo[]} */ (await SessionManager.list(enteredCwd, sessionDir));
        const seen = new Set(sessions.map((session) => `${session.id}:${resolve(session.path)}`));
        for (const session of legacySessions) {
            const key = `${session.id}:${resolve(session.path)}`;
            if (!seen.has(key)) sessions.push(session);
        }
    }
    return sessions;
}

/**
 * Resolve a persisted RunWield root session by id or guarded file path.
 *
 * @param {ResolvePersistedRootSessionOptions} options
 * @returns {Promise<ResolvedPersistedRootSession>}
 */
export async function resolvePersistedRootSession(options) {
    if (!options?.cwd || !isAbsolute(options.cwd)) {
        throw new Error("resolvePersistedRootSession requires an absolute cwd");
    }
    if (!options.sessionId || typeof options.sessionId !== "string") {
        throw new Error("resolvePersistedRootSession requires a session id");
    }
    const canonicalCwd = canonicalizeCwd(options.cwd);
    const defaultSessionDir = getRunWieldSessionDir(canonicalCwd);
    const sessionDir = options.sessionDir ? resolve(options.sessionDir) : defaultSessionDir;
    const requestedPath = options.sessionPath ? resolve(options.sessionPath) : "";
    const usesManagedProjectSessionDir = resolve(sessionDir) !== resolve(defaultSessionDir);
    if (usesManagedProjectSessionDir) {
        if (!options.managedProjectRoot || !isAbsolute(options.managedProjectRoot)) {
            throw new Error("Cross-root persisted session path requires managed Project evidence");
        }
        if (!options.managedSegmentCwd || canonicalizeCwd(options.managedSegmentCwd) !== canonicalCwd) {
            throw new Error("Cross-root persisted session path requires managed segment evidence");
        }
        if (basename(sessionDir) !== encodeCwdForSessionDir(canonicalizeCwd(options.managedProjectRoot))) {
            throw new Error("Cross-root persisted session directory does not match managed Project evidence");
        }
    }
    if (requestedPath) {
        const locator = await readCatalogSafeRootSessionLocator({
            cwd: options.cwd,
            sessionDir,
            sessionPath: requestedPath,
        });
        if (locator.piSessionId !== options.sessionId) {
            throw new Error(`Persisted session not found for cwd: ${options.sessionId}`);
        }
        if (canonicalizeCwd(locator.headerCwd) !== canonicalCwd) {
            throw new Error(
                usesManagedProjectSessionDir
                    ? "Cross-root persisted session header does not match managed segment cwd"
                    : "Persisted session cwd does not match requested cwd",
            );
        }
        return {
            cwd: canonicalCwd,
            sessionDir,
            sessionId: locator.piSessionId,
            sessionPath: locator.sessionPath,
            info: {
                id: locator.piSessionId,
                path: locator.sessionPath,
                cwd: locator.headerCwd,
                modified: locator.modified || undefined,
            },
        };
    }

    const sessions = await listPersistedRootSessions(options.cwd);
    const match = sessions.find((session) => session.id === options.sessionId);
    if (!match) throw new Error(`Persisted session not found for cwd: ${options.sessionId}`);

    return {
        cwd: typeof match.cwd === "string" && isAbsolute(match.cwd) ? match.cwd : canonicalCwd,
        sessionDir,
        sessionId: match.id,
        sessionPath: resolve(match.path),
        info: match,
    };
}

/**
 * Open a persisted RunWield root session by id or guarded file path.
 *
 * @param {ResolvePersistedRootSessionOptions} options
 * @returns {Promise<{ sessionManager: import('@earendil-works/pi-coding-agent').SessionManager, resolved: ResolvedPersistedRootSession }>}
 */
export async function openPersistedRootSession(options) {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const resolved = await resolvePersistedRootSession(options);
    const sessionManager = SessionManager.open(resolved.sessionPath, resolved.sessionDir, resolved.cwd);
    if (canonicalizeCwd(getManagerCwd(sessionManager)) !== canonicalizeCwd(resolved.cwd)) {
        try {
            /** @type {{ dispose?: () => void }} */ (sessionManager).dispose?.();
        } catch {
            // Best-effort cleanup for rejected cross-cwd loads.
        }
        throw new Error("Persisted session cwd does not match requested cwd");
    }
    return { sessionManager: installSessionPersistence(sessionManager), resolved };
}

/**
 * @param {import('@earendil-works/pi-coding-agent').SessionManager | { getBranch?: Function, getEntries?: Function }} sessionManager
 * @returns {unknown[]}
 */
export function getRootSessionBranchEntries(sessionManager) {
    const entries = sessionManager?.getBranch?.() || sessionManager?.getEntries?.() || [];
    return Array.isArray(entries) ? entries : [];
}

/**
 * @typedef {Object} CatalogSafeRootSessionLocator
 * @property {string} cwd
 * @property {string} sessionDir
 * @property {string} sessionPath
 * @property {string} piSessionId
 * @property {string} headerCwd
 * @property {number | null} headerVersion
 * @property {string | null} headerTimestamp
 * @property {Date | null} modified
 */

/**
 * @typedef {Object} CatalogSafeLocatorDiagnostic
 * @property {string} sessionPath
 * @property {string} code
 * @property {string} message
 */

/**
 * Read only the first JSONL record from a persisted root Session file.
 * This helper intentionally avoids Pi SessionManager.open() so cataloging does
 * not migrate, rewrite, or otherwise mutate legacy transcripts.
 *
 * @param {{ cwd: string, sessionPath: string, sessionDir?: string, maxHeaderBytes?: number }} options
 * @returns {Promise<CatalogSafeRootSessionLocator>}
 */
export async function readCatalogSafeRootSessionLocator(options) {
    if (!options?.cwd || !isAbsolute(options.cwd)) {
        throw new Error("readCatalogSafeRootSessionLocator requires an absolute cwd");
    }
    const sessionDir = options.sessionDir || getRunWieldSessionDir(options.cwd);
    const sessionPath = resolve(options.sessionPath || "");
    if (!isPathInside(sessionPath, sessionDir)) {
        throw new Error("Persisted session path is outside the RunWield session directory for cwd");
    }
    if (!sessionPath.endsWith(".jsonl")) throw new Error("Persisted session path must be a JSONL file");
    await assertRealPathInside(sessionPath, sessionDir);
    const file = await open(sessionPath, "r");
    try {
        const fileInfo = await file.stat();
        const maxHeaderBytes = Math.max(128, options.maxHeaderBytes || 65536);
        const buffer = new Uint8Array(maxHeaderBytes);
        const { bytesRead } = await file.read(buffer);
        if (!bytesRead) throw new Error("Persisted session file is empty");
        const chunk = new TextDecoder().decode(buffer.subarray(0, bytesRead));
        const newlineIndex = chunk.indexOf("\n");
        if (newlineIndex === -1 && bytesRead >= maxHeaderBytes) {
            throw new Error("Persisted session header exceeds catalog limit");
        }
        const firstLine = (newlineIndex === -1 ? chunk : chunk.slice(0, newlineIndex)).trim();
        if (!firstLine) throw new Error("Persisted session header is empty");
        const header = JSON.parse(firstLine);
        if (!header || typeof header !== "object" || header.type !== "session") {
            throw new Error("Persisted session header is not a session record");
        }
        const piSessionId = typeof header.id === "string" ? header.id : "";
        const headerCwd = typeof header.cwd === "string" ? header.cwd : "";
        if (!piSessionId) throw new Error("Persisted session header is missing an id");
        if (!headerCwd || !isAbsolute(headerCwd)) {
            throw new Error("Persisted session header is missing an absolute cwd");
        }
        const match = basename(sessionPath).match(
            /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_(.+)\.jsonl$/,
        );
        if (!match || match[2] !== piSessionId) {
            throw new Error("Persisted session filename does not exactly match the Pi session id");
        }
        const headerTimestamp = typeof header.timestamp === "string" ? header.timestamp : null;
        if (headerTimestamp && match[1] !== headerTimestamp.replace(/[:.]/g, "-")) {
            throw new Error("Persisted session filename timestamp does not match the session header");
        }
        return {
            cwd: options.cwd,
            sessionDir: resolve(sessionDir),
            sessionPath,
            piSessionId,
            headerCwd,
            headerVersion: typeof header.version === "number" ? header.version : null,
            headerTimestamp: typeof header.timestamp === "string" ? header.timestamp : null,
            modified: fileInfo.mtime,
        };
    } finally {
        await file.close();
    }
}

/**
 * Enumerate catalog-safe metadata for persisted root Session JSONL files.
 * Invalid candidates are returned as diagnostics so callers can continue
 * cataloging valid transcripts.
 *
 * @typedef {Object} CatalogSafeRootSessionCandidate
 * @property {string} sessionPath
 * @property {Date | null} modified
 */

/**
 * Enumerate catalog-safe metadata for persisted root Session JSONL files.
 * Invalid candidates are returned as diagnostics so callers can continue
 * cataloging valid transcripts.
 *
 * @param {string} cwd
 * @param {{ sessionDir?: string, maxHeaderBytes?: number, recentLimit?: number }} [options]
 * @returns {Promise<{ locators: CatalogSafeRootSessionLocator[], diagnostics: CatalogSafeLocatorDiagnostic[] }>}
 */
export async function listCatalogSafeRootSessionLocators(cwd, options = {}) {
    if (!cwd || !isAbsolute(cwd)) throw new Error("listCatalogSafeRootSessionLocators requires an absolute cwd");
    const sessionDir = options.sessionDir || getRunWieldSessionDir(cwd);
    /** @type {CatalogSafeRootSessionLocator[]} */
    const locators = [];
    /** @type {CatalogSafeLocatorDiagnostic[]} */
    const diagnostics = [];
    /** @type {CatalogSafeRootSessionCandidate[]} */
    const candidates = [];
    const recentLimit = typeof options.recentLimit === "number" && Number.isFinite(options.recentLimit)
        ? Math.max(0, Math.floor(options.recentLimit))
        : null;
    try {
        for (const entry of await readdir(sessionDir, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
            const sessionPath = join(sessionDir, entry.name);
            if (recentLimit === null) {
                candidates.push({ sessionPath, modified: null });
                continue;
            }
            try {
                const fileInfo = await fsStat(sessionPath);
                candidates.push({ sessionPath, modified: fileInfo.mtime });
            } catch (error) {
                diagnostics.push({
                    sessionPath,
                    code: "invalid_locator",
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
    } catch (error) {
        if ((error instanceof Error && "code" in error && error.code === "ENOENT")) return { locators, diagnostics };
        throw error;
    }
    const candidatesToRead = recentLimit === null ? candidates : candidates.toSorted((left, right) => {
        const timeDifference = (right.modified?.getTime() || 0) - (left.modified?.getTime() || 0);
        return timeDifference || right.sessionPath.localeCompare(left.sessionPath);
    }).slice(0, recentLimit);
    for (const candidate of candidatesToRead) {
        try {
            locators.push(
                await readCatalogSafeRootSessionLocator({
                    cwd,
                    sessionDir,
                    sessionPath: candidate.sessionPath,
                    maxHeaderBytes: options.maxHeaderBytes,
                }),
            );
        } catch (error) {
            diagnostics.push({
                sessionPath: candidate.sessionPath,
                code: "invalid_locator",
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }
    locators.sort((a, b) => a.sessionPath.localeCompare(b.sessionPath));
    return { locators, diagnostics };
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function toDisplayText(value) {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
        return value.map((block) => {
            if (!block || typeof block !== "object") return "";
            const typedBlock =
                /** @type {{ type?: string, text?: string, name?: string, input?: unknown, content?: unknown }} */ (
                    block
                );

            if (typedBlock.type === "text") return typedBlock.text || "";
            if (typedBlock.type === "tool_use") {
                return `[tool_use:${typedBlock.name || "unknown"}] ${JSON.stringify(typedBlock.input || {})}`;
            }
            if (typedBlock.type === "tool_result") {
                const contentText = toDisplayText(typedBlock.content || "");
                return `[tool_result] ${contentText}`;
            }
            return JSON.stringify(block);
        }).join("\n");
    }

    if (value === null || value === undefined) return "";
    return String(value);
}

/**
 * Export current session branch as linear JSONL (Pi-like behavior).
 *
 * @param {import('@earendil-works/pi-coding-agent').SessionManager} sessionManager
 * @param {string} [outputPath]
 * @returns {string}
 */
export function exportRootSessionToJsonl(sessionManager, outputPath) {
    const filePath = resolve(outputPath || `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
    ensureDir(dirname(filePath));

    const header = {
        type: "session",
        id: sessionManager.getSessionId(),
        timestamp: new Date().toISOString(),
        cwd: sessionManager.getCwd(),
    };

    const branchEntries = sessionManager.getBranch();
    const lines = [JSON.stringify(header)];

    let prevId = null;
    for (const entry of branchEntries) {
        const linearEntry = { ...entry, parentId: prevId };
        lines.push(JSON.stringify(linearEntry));
        prevId = entry.id;
    }

    writeFileSync(filePath, `${lines.join("\n")}\n`);
    return filePath;
}

/**
 * Export current session branch to a simple HTML transcript.
 *
 * @param {import('@earendil-works/pi-coding-agent').SessionManager} sessionManager
 * @param {string} [outputPath]
 * @returns {Promise<string>}
 */
export async function exportRootSessionToHtml(sessionManager, outputPath) {
    const filePath = resolve(outputPath || `session-${new Date().toISOString().replace(/[:.]/g, "-")}.html`);
    ensureDir(dirname(filePath));

    const entries = sessionManager.getBranch();
    let skipNextNamedInvocation = "";
    const rows = entries.flatMap((entry) => {
        const timestamp = entry.timestamp || "";

        if (entry.type === "message") {
            const role = entry.message?.role || "unknown";
            const message = /** @type {{ content?: unknown }} */ (entry.message);
            const textValue = toDisplayText(message.content || "");
            if (skipNextNamedInvocation && role === "user" && textValue === skipNextNamedInvocation) {
                skipNextNamedInvocation = "";
                return [];
            }
            skipNextNamedInvocation = "";
            const text = escapeHtml(textValue);
            return [
                `<section class=\"entry message ${escapeHtml(role)}\"><header>${escapeHtml(timestamp)} — ${
                    escapeHtml(role)
                }</header><pre>${text}</pre></section>`,
            ];
        }

        const customEntry =
            /** @type {{ type?: string, customType?: string, data?: { compactInvocation?: string } }} */ (
                entry
            );
        const namedInvocationData = customEntry.data;
        const namedInvocationText =
            customEntry.type === "custom" && customEntry.customType === "runwield.named_invocation" &&
                typeof namedInvocationData?.compactInvocation === "string"
                ? namedInvocationData.compactInvocation
                : "";
        if (namedInvocationText) {
            skipNextNamedInvocation = namedInvocationText;
            const text = escapeHtml(namedInvocationText);
            return `<section class=\"entry message user\"><header>${
                escapeHtml(timestamp)
            } — user</header><pre>${text}</pre></section>`;
        }

        if (entry.type === "custom_message") {
            const text = escapeHtml(toDisplayText(entry.content || ""));
            return `<section class=\"entry custom\"><header>${escapeHtml(timestamp)} — custom_message:${
                escapeHtml(entry.customType || "")
            }</header><pre>${text}</pre></section>`;
        }

        if (entry.type === "compaction") {
            return `<section class=\"entry system\"><header>${escapeHtml(timestamp)} — compaction</header><pre>${
                escapeHtml(entry.summary || "")
            }</pre></section>`;
        }

        if (entry.type === "branch_summary") {
            return `<section class=\"entry system\"><header>${escapeHtml(timestamp)} — branch_summary</header><pre>${
                escapeHtml(entry.summary || "")
            }</pre></section>`;
        }

        if (entry.type === "model_change") {
            const text = `${entry.provider || ""}/${entry.modelId || ""}`;
            return `<section class=\"entry meta\"><header>${escapeHtml(timestamp)} — model_change</header><pre>${
                escapeHtml(text)
            }</pre></section>`;
        }

        if (entry.type === "thinking_level_change") {
            return `<section class=\"entry meta\"><header>${
                escapeHtml(timestamp)
            } — thinking_level_change</header><pre>${escapeHtml(entry.thinkingLevel || "")}</pre></section>`;
        }

        return `<section class=\"entry meta\"><header>${escapeHtml(timestamp)} — ${
            escapeHtml(entry.type || "entry")
        }</header><pre>${escapeHtml(JSON.stringify(entry, null, 2))}</pre></section>`;
    }).join("\n");

    const title = `RunWield Session Export — ${sessionManager.getSessionId()}`;
    const html = [
        "<!doctype html>",
        "<html lang='en'>",
        "<head>",
        '  <meta charset="utf-8" />',
        `  <title>${escapeHtml(title)}</title>`,
        "  <style>",
        "    body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#111;color:#eee;padding:24px;line-height:1.4}",
        "    h1{font-size:18px;margin:0 0 16px}",
        "    .meta{color:#aaa;margin-bottom:16px}",
        "    .entry{border:1px solid #333;border-radius:8px;padding:12px;margin:0 0 12px;background:#1a1a1a}",
        "    .entry header{font-size:12px;color:#9ca3af;margin-bottom:8px}",
        "    .entry.message.user{border-color:#2563eb}",
        "    .entry.message.assistant{border-color:#16a34a}",
        "    .entry.custom,.entry.system{border-color:#7c3aed}",
        "    pre{white-space:pre-wrap;word-break:break-word;margin:0}",
        "  </style>",
        "</head>",
        "<body>",
        `  <h1>${escapeHtml(title)}</h1>`,
        `  <div class=\"meta\">cwd: ${escapeHtml(sessionManager.getCwd())}</div>`,
        rows,
        "</body>",
        "</html>",
        "",
    ].join("\n");

    await writeFile(filePath, html);
    return filePath;
}
