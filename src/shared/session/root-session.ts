/**
 * @module shared/session/root-session
 * Root interactive session lifecycle helpers (persisted in ~/.wld/sessions).
 */

import type { SessionEntry, SessionHeader, SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "../jsonc.ts";
import type { RemoteSessionConnection } from "../remote/session-protocol.ts";
import type { RemoteSessionSaveBridge } from "../remote/session-save-bridge.ts";
import type {
    CatalogDiagnostic,
    CatalogedSession,
    FileSessionProject,
    FileSessionStore,
} from "./file-session-store.ts";
import type { MinimalSessionManagerLike } from "./hosted-session.ts";
import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { open, readdir, realpath, stat as fsStat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep as SEPARATOR } from "node:path";
import { encodeCwdForSessionDir } from "../project-directory-key.ts";
export { encodeCwdForSessionDir } from "../project-directory-key.ts";
import { requireLocalSessionWriter } from "../remote/personal-resources.ts";
import { getHomeDir } from "../../constants.ts";
import { parseRemoteSessionTranscript } from "../remote/session-protocol.ts";

export type RootSessionStartMode = "new" | "continue";

export type PersistedRootSessionInfo = Pick<SessionInfo, "id" | "path" | "cwd"> &
    Partial<Pick<SessionInfo, "messageCount" | "firstMessage" | "name">> & {
        modified?: Date | string | number;
    };

export interface ResolvePersistedRootSessionOptions {
    cwd: string;
    sessionId: string;
    sessionPath?: string;
    sessionDir?: string;
    managedProjectRoot?: string;
    managedSegmentCwd?: string;
}

export interface ResolvedPersistedRootSession {
    cwd: string;
    sessionDir: string;
    sessionId: string;
    sessionPath: string;
    info: PersistedRootSessionInfo | null;
}

interface OpenedPersistedRootSession {
    sessionManager: SessionManager;
    resolved: ResolvedPersistedRootSession;
}

interface ClassifyRootSessionLocatorOptions {
    cwd: string;
    sessionId?: string;
    sessionPath?: string;
    ownerCoordinationStore?: FileSessionStore | null;
    allowCatalog?: boolean;
}

interface RootSessionProjectLocator {
    projectId: string;
    cwd: string;
}

export interface RootSessionLocatorClassification {
    kind: "uncataloged" | "managed" | "blocked";
    reason?: string;
    session?: CatalogedSession;
    project?: RootSessionProjectLocator;
    locator?: CatalogSafeRootSessionLocator;
}

export interface CatalogSafeRootSessionLocator {
    cwd: string;
    sessionDir: string;
    sessionPath: string;
    piSessionId: string;
    headerCwd: string;
    headerVersion: number | null;
    headerTimestamp: string | null;
    modified: Date | null;
}

export type CatalogSafeLocatorDiagnostic = CatalogDiagnostic;
export type CatalogSafeRootSessionCandidate = Pick<CatalogSafeRootSessionLocator, "sessionPath" | "modified">;

interface CatalogSafeLocatorOptions {
    sessionDir?: string;
    maxHeaderBytes?: number;
}

interface ReadCatalogSafeLocatorOptions extends CatalogSafeLocatorOptions {
    cwd: string;
    sessionPath: string;
}

interface ListCatalogSafeLocatorsOptions extends CatalogSafeLocatorOptions {
    recentLimit?: number;
}

interface CatalogSafeLocatorList {
    locators: CatalogSafeRootSessionLocator[];
    diagnostics: CatalogSafeLocatorDiagnostic[];
}

interface RootSessionBranchReader<Entry> {
    getBranch?: () => Entry[];
    getEntries?: () => Entry[];
}

type RootSessionHeaderFields = Pick<SessionHeader, "type" | "id" | "cwd" | "timestamp" | "version">;
type RawRootSessionHeader = Partial<Record<keyof RootSessionHeaderFields, JsonValue>>;
type CreatedSessionTranscriptSource = Pick<MinimalSessionManagerLike, "getEntries"> &
    Partial<Pick<SessionManager, "getHeader">>;
type DisposableSessionManager = SessionManager & Pick<MinimalSessionManagerLike, "dispose">;

/**
 * Resolve the root RunWield sessions base directory.
 */
export function getRunWieldSessionsBaseDir() {
    requireLocalSessionWriter();
    const home = getHomeDir() || "~";
    return join(home, ".wld", "sessions");
}

function canonicalizeCwd(cwd: string) {
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
 */
export function getRunWieldSessionDir(cwd: string) {
    return join(getRunWieldSessionsBaseDir(), encodeCwdForSessionDir(canonicalizeCwd(cwd)));
}

/**
 * Resolve the image-artifact directory for a persisted root session.
 */
export function getRunWieldSessionImageDir(cwd: string, sessionId: string) {
    return join(getRunWieldSessionDir(cwd), `${sessionId}_images`);
}

/**
 * Resolve the memory-backup artifact directory for a persisted root session.
 */
export function getRunWieldSessionMemoryBackupDir(cwd: string, sessionId: string) {
    return join(getRunWieldSessionDir(cwd), `${sessionId}_memory-backups`);
}

/**
 * Ensure a directory exists.
 */
function ensureDir(dir: string) {
    mkdirSync(dir, { recursive: true });
}

/**
 * Create or continue the persisted root session manager.
 * @param directory Laptop-owned remote Project directory.
 */
export async function createRootSessionManager(
    mode: RootSessionStartMode,
    cwd: string,
    directory?: string,
): Promise<SessionManager> {
    requireLocalSessionWriter();
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const canonicalCwd = directory ? cwd : canonicalizeCwd(cwd);
    const sessionDir = directory || getRunWieldSessionDir(canonicalCwd);
    ensureDir(sessionDir);

    const manager =
        mode === "continue"
            ? SessionManager.continueRecent(canonicalCwd, sessionDir)
            : SessionManager.create(canonicalCwd, sessionDir);
    return installSessionPersistence(manager);
}

const remoteSessionBridges = new WeakMap<SessionManager, RemoteSessionSaveBridge>();

export function getRemoteSessionSaveBridge(manager: SessionManager | undefined) {
    return manager ? remoteSessionBridges.get(manager) : undefined;
}

/**
 * Hydrate only from the laptop owner. No Session file or remote transcript directory is created.
 * The caller owns the remote project identity and must discard this manager after any bridge fault.
 */
export async function createRemoteRootSessionManager(
    cwd: string,
    connection: RemoteSessionConnection,
): Promise<SessionManager> {
    const { RemoteSessionSaveBridge } = await import("../remote/session-save-bridge.ts");
    const bridge = new RemoteSessionSaveBridge(connection);
    try {
        const { CURRENT_SESSION_VERSION, SessionManager } = await import("@earendil-works/pi-coding-agent");
        if (CURRENT_SESSION_VERSION !== 3) bridge.fail(new Error("Incompatible Pi remote Session format"));
        const snapshot = bridge.request("hydrate");
        const entries = parseRemoteSessionTranscript(snapshot.contents);
        const manager = SessionManager.inMemory(cwd, undefined, entries);
        if (
            manager.getSessionFile() !== undefined ||
            manager.isPersisted() ||
            JSON.stringify([manager.getHeader(), ...manager.getEntries()]) !== JSON.stringify(entries) ||
            typeof Reflect.get(manager, "_persist") !== "function" ||
            typeof Reflect.get(manager, "_rewriteFile") !== "function"
        )
            bridge.fail(new Error("Incompatible Pi remote Session persistence contract"));
        const guarded = installSessionPersistence(manager, bridge);
        remoteSessionBridges.set(guarded, bridge);
        return guarded;
    } catch (error) {
        bridge.close();
        throw error;
    }
}

function getSessionManagerFileContents(sessionManager: SessionManager) {
    const header = sessionManager.getHeader?.();
    const entries = sessionManager.getEntries?.();
    if (!header || !Array.isArray(entries)) return null;
    return [header, ...entries].map((entry) => `${JSON.stringify(entry)}\n`).join("");
}

function installSessionPersistence(sessionManager: SessionManager, bridge?: RemoteSessionSaveBridge): SessionManager {
    function rewriteFile() {
        if (bridge) {
            bridge.assertHealthy();
            const contents = getSessionManagerFileContents(sessionManager);
            if (contents === null) return bridge.fail(new Error("Remote Session contents unavailable"));
            bridge.request("rewrite", contents);
            return;
        }
        const transcriptPath = sessionManager.getSessionFile?.();
        const contents = getSessionManagerFileContents(sessionManager);
        if (!transcriptPath || contents === null) return;
        writeFileSync(transcriptPath, contents);
    }

    function persist(entry: SessionEntry) {
        if (bridge) {
            bridge.assertHealthy();
            bridge.request("append", `${JSON.stringify(entry)}\n`);
            return;
        }
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

    const sessionId = sessionManager.getSessionId();
    const uncaptured = new Set([
        "newSession",
        "setSessionFile",
        "_setSessionFile",
        "_loadEntries",
        "createBranchedSession",
        "constructor",
        "forkFrom",
    ]);
    return new Proxy(sessionManager, {
        get(target, property, receiver) {
            // Pi disposal needs immutable identity, not access to the failed tree.
            if (bridge && property === "getSessionId") return () => sessionId;
            bridge?.assertHealthy();
            if (bridge && uncaptured.has(String(property))) {
                return () =>
                    bridge.fail(new Error(`Remote Session lifecycle path is not captured: ${String(property)}`));
            }
            const value: unknown =
                property === "_rewriteFile"
                    ? rewriteFile
                    : property === "_persist"
                      ? persist
                      : Reflect.get(target, property, receiver);
            if (!bridge || typeof value !== "function") return value;
            // Pi methods come through a reflective boundary with arbitrary arguments and return values.
            // Retained method references must also fail after a swallowed persistence error.
            const guarded = (...args: unknown[]): unknown => {
                bridge.assertHealthy();
                try {
                    return Reflect.apply(value, receiver, args);
                } catch (error) {
                    return bridge.fail(error instanceof Error ? error : new Error(String(error)));
                }
            };
            return guarded;
        },
        set(target, property, value, receiver) {
            bridge?.assertHealthy();
            return Reflect.set(target, property, value, receiver);
        },
        getPrototypeOf(target) {
            bridge?.assertHealthy();
            // Do not expose SessionManager's static file/fork constructors through the remote manager.
            return bridge ? null : Reflect.getPrototypeOf(target);
        },
    });
}

async function ensureCreatedSessionTranscriptFile(
    sessionManager: CreatedSessionTranscriptSource,
    transcriptPath: string,
) {
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

export async function resolveCreatedRootSessionPath(
    cwd: string,
    sessionManager: MinimalSessionManagerLike,
    directory?: string,
) {
    requireLocalSessionWriter();
    const piSessionId = sessionManager.getSessionId?.();
    if (!piSessionId) throw new Error("The Session could not be persisted");
    const sessions = directory ? [] : await listPersistedRootSessions(cwd);
    const match = sessions.find((session) => session.id === piSessionId);
    if (match?.path) return match.path;
    const transcriptPath = sessionManager.getSessionFile?.();
    const sessionDir = directory || getRunWieldSessionDir(cwd);
    if (
        !transcriptPath ||
        typeof transcriptPath !== "string" ||
        !isAbsolute(transcriptPath) ||
        !isPathInside(transcriptPath, sessionDir) ||
        !basename(transcriptPath).includes(piSessionId)
    ) {
        throw new Error(`Created Session transcript was not found: ${piSessionId}`);
    }
    await ensureCreatedSessionTranscriptFile(sessionManager, transcriptPath);
    return transcriptPath;
}

export function isPathInside(path: string, baseDir: string) {
    const child = relative(resolve(baseDir), resolve(path));
    return child === "" || (child !== ".." && !child.startsWith(`..${SEPARATOR}`) && !isAbsolute(child));
}

async function assertRealPathInside(path: string, baseDir: string) {
    const realPath = await realpath(path);
    const realBase = await realpath(baseDir);
    if (!isPathInside(realPath, realBase)) {
        throw new Error("Persisted session path resolves outside the RunWield session directory for cwd");
    }
}

function getManagerCwd(value: Pick<SessionManager, "getCwd">) {
    if (!value || typeof value !== "object" || !("getCwd" in value) || typeof value.getCwd !== "function") return "";
    const cwd = value.getCwd();
    return typeof cwd === "string" ? cwd : "";
}

function isSameOrInsidePath(child: string, parent: string) {
    return isPathInside(resolve(child), resolve(parent));
}

/**
 * Resolve a root Session locator through the file-backed Session catalog before
 * any Pi SessionManager API is used.
 */
export async function classifyRootSessionLocator(
    options: ClassifyRootSessionLocatorOptions,
): Promise<RootSessionLocatorClassification> {
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
    const exactCurrentProjects: FileSessionProject[] = [];
    const canonicalCurrentProjects: FileSessionProject[] = [];
    const exactHistoricalProjects: FileSessionProject[] = [];
    const canonicalHistoricalProjects: FileSessionProject[] = [];
    for (const project of projects) {
        const roots = store.listProjectRootEvidence(project.projectId);
        const exactCurrent = roots.some(
            (root) =>
                root.rootState === "current" &&
                (requestedCwd === resolve(root.enteredRoot) || realCwd === resolve(root.canonicalRoot)),
        );
        const canonicalCurrent = roots.some(
            (root) => root.rootState === "current" && isSameOrInsidePath(realCwd, root.canonicalRoot),
        );
        const exactHistorical = roots.some(
            (root) =>
                root.rootState === "historical" &&
                (requestedCwd === resolve(root.enteredRoot) || realCwd === resolve(root.canonicalRoot)),
        );
        const canonicalHistorical = roots.some(
            (root) => root.rootState === "historical" && isSameOrInsidePath(realCwd, root.canonicalRoot),
        );
        if (exactCurrent) exactCurrentProjects.push(project);
        else if (canonicalCurrent) canonicalCurrentProjects.push(project);
        if (exactHistorical) exactHistoricalProjects.push(project);
        else if (canonicalHistorical) canonicalHistoricalProjects.push(project);
    }
    const currentProjects = exactCurrentProjects.length > 0 ? exactCurrentProjects : canonicalCurrentProjects;
    const historicalProjects =
        exactHistoricalProjects.length > 0 ? exactHistoricalProjects : canonicalHistoricalProjects;
    if (currentProjects.length > 1 || historicalProjects.length > 1) {
        return { kind: "blocked", reason: "locator_conflict" };
    }
    if (currentProjects.length === 0 && historicalProjects.length > 0) {
        return { kind: "blocked", reason: "historical_project_root" };
    }
    const project = currentProjects[0] || null;
    if (!project) return { kind: "uncataloged", reason: "session_project_absent" };
    const currentRoots = store
        .listProjectRootEvidence(project.projectId)
        .filter(
            (root) =>
                root.rootState === "current" &&
                (isSameOrInsidePath(realCwd, root.canonicalRoot) || isSameOrInsidePath(requestedCwd, root.enteredRoot)),
        );
    if (
        currentRoots.some(
            (root) => resolve(realCwd) !== resolve(root.canonicalRoot) && requestedCwd !== resolve(root.enteredRoot),
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
        ? store
              .listSessionTranscriptSegments(catalogedByPath.runwieldSessionId)
              .find((segment) => resolve(segment.transcriptPath) === requestedSessionPath)
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
 */
export async function listPersistedRootSessions(cwd: string): Promise<PersistedRootSessionInfo[]> {
    if (!cwd || !isAbsolute(cwd)) throw new Error("listPersistedRootSessions requires an absolute cwd");
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const canonicalCwd = canonicalizeCwd(cwd);
    const enteredCwd = resolve(cwd);
    const sessionDir = getRunWieldSessionDir(canonicalCwd);
    const sessions = await SessionManager.list(canonicalCwd, sessionDir);
    if (enteredCwd !== canonicalCwd) {
        const legacySessions = await SessionManager.list(enteredCwd, sessionDir);
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
 */
export async function resolvePersistedRootSession(
    options: ResolvePersistedRootSessionOptions,
): Promise<ResolvedPersistedRootSession> {
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
 */
export async function openPersistedRootSession(
    options: ResolvePersistedRootSessionOptions,
): Promise<OpenedPersistedRootSession> {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const resolved = await resolvePersistedRootSession(options);
    const sessionManager: DisposableSessionManager = SessionManager.open(
        resolved.sessionPath,
        resolved.sessionDir,
        resolved.cwd,
    );
    if (canonicalizeCwd(getManagerCwd(sessionManager)) !== canonicalizeCwd(resolved.cwd)) {
        try {
            sessionManager.dispose?.();
        } catch {
            // Best-effort cleanup for rejected cross-cwd loads.
        }
        throw new Error("Persisted session cwd does not match requested cwd");
    }
    return { sessionManager: installSessionPersistence(sessionManager), resolved };
}

export function getRootSessionBranchEntries<Entry>(sessionManager: RootSessionBranchReader<Entry>): Entry[] {
    const entries = sessionManager?.getBranch?.() || sessionManager?.getEntries?.() || [];
    return Array.isArray(entries) ? entries : [];
}

/**
 * Read only the first JSONL record from a persisted root Session file.
 * This helper intentionally avoids Pi SessionManager.open() so cataloging does
 * not migrate, rewrite, or otherwise mutate legacy transcripts.
 */
export async function readCatalogSafeRootSessionLocator(
    options: ReadCatalogSafeLocatorOptions,
): Promise<CatalogSafeRootSessionLocator> {
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
        const header: RawRootSessionHeader | null = JSON.parse(firstLine);
        if (!header || typeof header !== "object" || header.type !== "session") {
            throw new Error("Persisted session header is not a session record");
        }
        const piSessionId = typeof header.id === "string" ? header.id : "";
        const headerCwd = typeof header.cwd === "string" ? header.cwd : "";
        if (!piSessionId) throw new Error("Persisted session header is missing an id");
        if (!headerCwd || !isAbsolute(headerCwd)) {
            throw new Error("Persisted session header is missing an absolute cwd");
        }
        const match = basename(sessionPath).match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_(.+)\.jsonl$/);
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
 */
export async function listCatalogSafeRootSessionLocators(
    cwd: string,
    options: ListCatalogSafeLocatorsOptions = {},
): Promise<CatalogSafeLocatorList> {
    if (!cwd || !isAbsolute(cwd)) throw new Error("listCatalogSafeRootSessionLocators requires an absolute cwd");
    const sessionDir = options.sessionDir || getRunWieldSessionDir(cwd);
    const locators: CatalogSafeRootSessionLocator[] = [];
    const diagnostics: CatalogSafeLocatorDiagnostic[] = [];
    const candidates: CatalogSafeRootSessionCandidate[] = [];
    const recentLimit =
        typeof options.recentLimit === "number" && Number.isFinite(options.recentLimit)
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
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return { locators, diagnostics };
        throw error;
    }
    const candidatesToRead =
        recentLimit === null
            ? candidates
            : candidates
                  .toSorted((left, right) => {
                      const timeDifference = (right.modified?.getTime() || 0) - (left.modified?.getTime() || 0);
                      return timeDifference || right.sessionPath.localeCompare(left.sessionPath);
                  })
                  .slice(0, recentLimit);
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
