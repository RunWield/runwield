/**
 * @module shared/session/file-session-storage
 * Durable paths, Project identity, and atomic manifest persistence.
 */

import { projects, type ProjectSessionStorageBinding } from "@runwield/projects";
import {
    FILE_SESSION_STORE_VERSION,
    listSessionManifestFiles,
    manifestPath,
    metadataDir,
    projectPath,
    readRecoveryDescriptors,
    recoveryDescriptorPath,
    sessionStoragePath,
    sessionTranscriptStoragePath,
} from "@runwield/session-files";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, renameSync, statSync } from "node:fs";
import { ensurePrivateDir, writeJsonAtomically } from "../private-json-file.ts";
export { ensurePrivateDir, writeJsonAtomically, writeTextAtomically } from "../private-json-file.ts";
import type {
    FileSessionManifest,
    FileSessionProject,
    RemoteSessionProjectBinding,
} from "./file-session-store-types.ts";
import type { RemoteHostIdentity, RemoteTarget } from "../remote/target.ts";

export {
    bundleDir,
    FILE_SESSION_STORE_VERSION,
    lockPath,
    manifestPath,
    recoveryDescriptorPath,
} from "@runwield/session-files";

export function isoNow(now?: () => string): string {
    return now ? now() : new Date().toISOString();
}

export function readJson<Value>(path: string): Value {
    return JSON.parse(readFileSync(path, "utf8"));
}

export function pathExists(path: string): boolean {
    try {
        lstatSync(path);
        return true;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
    }
}

export function catalogLockPath(sessionDir: string, transcriptPath: string): string {
    const directory = join(metadataDir(sessionDir), "catalog-locks");
    ensurePrivateDir(directory);
    const canonicalPath = realpathSync.native(transcriptPath);
    const key = createHash("sha256").update(canonicalPath).digest("hex");
    return join(directory, `${key}.lock`);
}

export function sessionDirForRoot(baseDir: string, root: string): string {
    let canonicalRoot = resolve(root);
    try {
        canonicalRoot = realpathSync.native(canonicalRoot);
    } catch {
        // A not-yet-created root still gets a stable absolute locator.
    }
    return join(baseDir, projects.directory.sessionKey(canonicalRoot));
}

/** Current checkout writes and successor validation share the admitted storage selection. */
export function sessionDirForCheckout(baseDir: string, root: string): string {
    const binding = projects.storage
        .inspect(root)
        .find((item) => dirname(sessionStoragePath(item.sessionDirectory, baseDir)) === resolve(baseDir));
    if (binding) return sessionStoragePath(binding.sessionDirectory, baseDir);
    let canonicalRoot = resolve(root);
    try {
        canonicalRoot = realpathSync.native(canonicalRoot);
    } catch {
        // A removed execution checkout retains its historical absolute locator.
    }
    projects.storage.assertUnclaimedSessionRoot(canonicalRoot);
    return sessionDirForRoot(baseDir, canonicalRoot);
}

export function sessionDirForManifestPath(path: string): string {
    return dirname(dirname(dirname(dirname(path))));
}

export interface StoredSessionProject extends FileSessionProject {
    legacyProjectId?: string;
    sessionDirectory: string;
}

export function readStoredProject(
    baseDir: string,
    sessionDir: string,
    bindings?: ProjectSessionStorageBinding[],
): StoredSessionProject | null {
    const path = projectPath(sessionDir);
    if (!pathExists(path)) return null;
    const saved = readJson<FileSessionProject>(path);
    const ids = saved.remote
        ? [saved.remote.binding?.projectId ?? saved.projectId]
        : (bindings ?? projects.storage.sessionBindings())
              .filter(
                  (binding) =>
                      sessionStoragePath(binding.sessionDirectory, baseDir) === sessionDir &&
                      (saved.projectId === binding.sessionProjectId || saved.projectId === binding.projectId),
              )
              .map((binding) => binding.projectId);
    if (new Set(ids).size > 1) throw new Error("Conflicting Project identity claims for Session storage");
    const projectId = ids[0] ?? saved.projectId;
    const legacyProjectId = saved.legacyProjectId ?? (projectId !== saved.projectId ? saved.projectId : undefined);
    return { ...saved, projectId, ...(legacyProjectId ? { legacyProjectId } : {}), sessionDirectory: sessionDir };
}

/** Remote transcripts stay with their Session bundle. Local successors can follow the execution checkout. */
export function sessionDirForSuccessor(
    baseDir: string,
    manifestPath: string,
    projectId: string,
    transcriptCwd: string,
): string {
    const sessionDir = sessionDirForManifestPath(manifestPath);
    const project = readStoredProject(baseDir, sessionDir);
    if (!project || project.projectId !== projectId) throw new Error("Session project is unavailable");
    if (project.remote) return sessionDir;
    return sessionDirForCheckout(baseDir, transcriptCwd);
}

export function sessionProjectView({
    sessionDirectory: _sessionDirectory,
    legacyProjectId: _legacyProjectId,
    ...project
}: StoredSessionProject): FileSessionProject {
    return project;
}

export function ensureProject(baseDir: string, root: string, now?: () => string): FileSessionProject {
    if (!root || !isAbsolute(root)) throw new Error("Project root must be absolute");
    const enteredRoot = resolve(root);
    if (!statSync(enteredRoot).isDirectory()) throw new Error("Project root must be a directory");
    const canonicalRoot = realpathSync.native(enteredRoot);
    projects.storage.assertUnclaimedSessionRoot(canonicalRoot);
    const identity = projects.checkout.admitForStorage(canonicalRoot);
    const bindings = projects.storage
        .inspect(identity.checkoutRoot)
        .filter((item) => dirname(sessionStoragePath(item.sessionDirectory, baseDir)) === resolve(baseDir));
    const bound = bindings.find((item) => item.checkoutId === identity.checkoutId);
    const sessionDir = bound
        ? sessionStoragePath(bound.sessionDirectory, baseDir)
        : sessionDirForRoot(baseDir, canonicalRoot);
    const path = projectPath(sessionDir);
    const existing = readStoredProject(baseDir, sessionDir, bindings);
    if (existing) {
        if (existing.remote || (bound && existing.projectId !== identity.projectId))
            throw new Error("Bound Session project is unavailable");
        if (!bound && resolve(existing.currentRoot) !== canonicalRoot)
            throw new Error("Session project identity does not match this directory");
        if (existing.projectId !== identity.projectId) {
            const { sessionDirectory: _directory, ...saved } = existing;
            writeJsonAtomically(path, { ...saved, projectId: identity.projectId, legacyProjectId: existing.projectId });
        }
        if (bound) projects.storage.establishSession(identity.checkoutRoot, identity.projectId, bound.sessionDirectory);
        return { ...sessionProjectView(existing), projectId: identity.projectId };
    }
    if (bound && (bound.sessionStoreEstablished || listManifests(sessionDir, true).length))
        throw new Error("Bound Session project is unavailable");
    const timestamp = isoNow(now);
    const project: FileSessionProject = {
        projectId: identity.projectId,
        displayName: basename(enteredRoot) || enteredRoot,
        registeredRoot: bound && bound.root !== canonicalRoot ? bound.root : enteredRoot,
        currentRoot: bound?.root ?? canonicalRoot,
        lifecycle: "enabled",
        accessScope: "local_runtime",
        createdAt: timestamp,
        updatedAt: timestamp,
        disabledAt: null,
        removedAt: null,
        restoredAt: null,
        relinkedAt: null,
    };
    writeJsonAtomically(path, project);
    if (bound) projects.storage.establishSession(identity.checkoutRoot, identity.projectId, bound.sessionDirectory);
    return project;
}

export function remoteProjectRoot(target: RemoteTarget): string {
    const root = target.primaryRoot || target.gitRoot || target.cwd;
    if (!root.startsWith("/") || root.includes("\0")) throw new Error("Remote project root must be absolute");
    return root;
}

/** Register remote identity without resolving or inspecting its root on the laptop. */
export function ensureRemoteProject(
    baseDir: string,
    host: RemoteHostIdentity,
    target: RemoteTarget,
    now?: () => string,
    targetLabel?: string,
    binding?: RemoteSessionProjectBinding,
): FileSessionProject {
    const root = remoteProjectRoot(target);
    const identity = JSON.stringify([host.hostname, host.user, host.port, host.hostKeyFingerprint, root]);
    const storageKey = `remote-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
    const directory = join(baseDir, storageKey);
    const path = projectPath(directory);
    const existing = readStoredProject(baseDir, directory, []);
    if (existing) return existing;
    const projectId = binding?.projectId ?? storageKey;
    const timestamp = isoNow(now);
    const project: FileSessionProject = {
        projectId,
        displayName: root.split("/").filter(Boolean).at(-1) || root,
        registeredRoot: root,
        currentRoot: root,
        remote: { host: { ...host }, root, ...(binding ? { binding } : {}), ...(targetLabel ? { targetLabel } : {}) },
        lifecycle: "enabled",
        accessScope: "local_runtime",
        createdAt: timestamp,
        updatedAt: timestamp,
        disabledAt: null,
        removedAt: null,
        restoredAt: null,
        relinkedAt: null,
    };
    writeJsonAtomically(path, project);
    return readStoredProject(baseDir, directory, [])!;
}

export function sameRemoteHost(left: RemoteHostIdentity, right: RemoteHostIdentity): boolean {
    return (
        left.hostname === right.hostname &&
        left.user === right.user &&
        left.port === right.port &&
        left.hostKeyFingerprint === right.hostKeyFingerprint
    );
}

/** A missing historical binding never authorizes a different pathname. */
export function remoteSessionProjectMatches(
    project: FileSessionProject,
    target: RemoteTarget & { host: RemoteHostIdentity },
    binding?: RemoteSessionProjectBinding,
): boolean {
    const remote = project.remote;
    if (!remote || !sameRemoteHost(remote.host, target.host)) return false;
    if (!remote.binding) return remote.root === remoteProjectRoot(target);
    return Boolean(
        binding &&
        remote.binding.projectId === binding.projectId &&
        remote.binding.repositoryId === binding.repositoryId &&
        remote.binding.checkoutId === binding.checkoutId &&
        remote.binding.personalOwnerIdentity === binding.personalOwnerIdentity &&
        remote.binding.executionAccountHome === binding.executionAccountHome,
    );
}

/** Preserve the Session namespace and writer lock while updating its verified location. */
export function bindRemoteSessionProject(
    baseDir: string,
    project: FileSessionProject,
    target: RemoteTarget & { host: RemoteHostIdentity },
    binding: RemoteSessionProjectBinding,
    targetLabel: string,
): FileSessionProject {
    const directory = sessionDirForProject(baseDir, project);
    const path = projectPath(directory);
    const saved = readJson<FileSessionProject>(path);
    if (!saved.remote || !remoteSessionProjectMatches(saved, target, binding))
        throw new Error("Remote Session Project binding changed.");
    const root = remoteProjectRoot(target);
    if (saved.remote.binding && saved.remote.root === root && saved.remote.targetLabel === targetLabel) return project;
    if (saved.projectId !== binding.projectId) {
        saved.legacyProjectId = saved.projectId;
        saved.projectId = binding.projectId;
    }
    saved.remote.binding = binding;
    saved.remote.root = root;
    saved.remote.targetLabel = targetLabel;
    saved.currentRoot = root;
    saved.updatedAt = isoNow();
    writeJsonAtomically(path, saved);
    return readStoredProject(baseDir, directory, [])!;
}

/** Retain a host answer without changing the project's canonical identity. */
export function recordRemoteHostAnswer(
    baseDir: string,
    project: FileSessionProject,
    host: RemoteHostIdentity,
    answer: "acceptedHosts" | "refusedHosts",
): void {
    const path = projectPath(sessionDirForProject(baseDir, project));
    const saved = readJson<FileSessionProject>(path);
    if (!saved.remote) throw new Error("Remote host answer requires a remote project");
    const hosts = saved.remote[answer] || [];
    if (hosts.some((prior) => sameRemoteHost(prior, host))) return;
    saved.remote[answer] = [...hosts, { ...host }];
    saved.updatedAt = isoNow();
    writeJsonAtomically(path, saved);
}

export function sessionDirForProject(baseDir: string, project: FileSessionProject): string {
    if ("sessionDirectory" in project && typeof project.sessionDirectory === "string") return project.sessionDirectory;
    return project.remote
        ? join(baseDir, project.legacyProjectId ?? project.projectId)
        : join(baseDir, projects.directory.sessionKey(resolve(project.currentRoot)));
}

export function listProjectsFromDisk(baseDir: string): StoredSessionProject[] {
    const stored: StoredSessionProject[] = [];
    let entries;
    try {
        entries = readdirSync(baseDir, { withFileTypes: true });
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
    }
    const bindings = projects.storage.sessionBindings();
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
            const project = readStoredProject(baseDir, join(baseDir, entry.name), bindings);
            if (project) stored.push(project);
        } catch {
            // A damaged Project record is not guessed at during a global scan.
        }
    }
    return stored.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function relatedSessionProjects(baseDir: string, projectId: string): StoredSessionProject[] {
    const stored = listProjectsFromDisk(baseDir);
    const canonicalId = stored.find((project) => project.legacyProjectId === projectId)?.projectId ?? projectId;
    return stored.filter((project) => project.projectId === canonicalId);
}

export function sessionProjectMatches(baseDir: string, actualId: string, requestedId: string): boolean {
    return (
        actualId === requestedId ||
        relatedSessionProjects(baseDir, requestedId).some(
            (project) => project.projectId === actualId || project.legacyProjectId === actualId,
        )
    );
}

function projectManifest(manifest: FileSessionManifest, project: StoredSessionProject | null): FileSessionManifest {
    if (project && project.legacyProjectId === manifest.projectId) {
        const previousProjectId = manifest.projectId;
        manifest.projectId = project.projectId;
        if (manifest.generation?.projectId === previousProjectId) manifest.generation.projectId = project.projectId;
        for (const segment of manifest.segments) {
            if (segment.projectId === previousProjectId) segment.projectId = project.projectId;
        }
    }
    return manifest;
}

export function rootEvidence(project: FileSessionProject) {
    const roots = projects.storage.sessionRoots(project.projectId);
    if (roots.length) {
        let registeredCanonical: string | undefined;
        try {
            registeredCanonical = realpathSync.native(project.registeredRoot);
        } catch {
            // Only a currently verified checkout can grant runtime access.
        }
        return roots.map((root) => ({
            enteredRoot: root === registeredCanonical ? project.registeredRoot : root,
            canonicalRoot: root,
            rootState: "current",
        }));
    }
    const owned = projects.storage.sessionBindings().some((binding) => binding.projectId === project.projectId);
    return [
        {
            enteredRoot: project.registeredRoot,
            canonicalRoot: project.currentRoot,
            rootState: owned ? "historical" : "current",
        },
    ];
}

export function catalogedSession(manifest: FileSessionManifest) {
    const first = manifest.segments[0];
    const current =
        manifest.segments.find((segment) => segment.segmentId === manifest.currentSegmentId) ||
        manifest.segments.at(-1);
    if (!first || !current) throw new Error("Session manifest has no transcript segment");
    return {
        runwieldSessionId: manifest.runwieldSessionId,
        projectId: manifest.projectId,
        displayName: manifest.displayName,
        archivedAt: manifest.archivedAt || null,
        source: manifest.source,
        piSessionId: current.piSessionId,
        transcriptPath: current.transcriptPath,
        transcriptCwd: manifest.transcriptCwd,
        headerVersion: current.headerVersion,
        headerTimestamp: current.headerTimestamp,
        firstCatalogedAt: first.firstCatalogedAt,
        lastCatalogedAt: manifest.updatedAt,
        planAssociations: (manifest.planAssociations || [])
            .filter((association) => association.committedGeneration !== null)
            .map((association) => ({ ...association })),
    };
}

function writeRecoveryDescriptors(manifest: FileSessionManifest, path: string): void {
    for (const segment of manifest.segments) {
        try {
            const transcript = sessionTranscriptStoragePath(segment.transcriptPath, path);
            writeJsonAtomically(recoveryDescriptorPath(transcript), manifest);
        } catch {
            // The primary manifest is already durable. A later successful
            // checkpoint will refresh all redundant recovery descriptors.
        }
    }
}

function recoveryProject(baseDir: string, manifest: FileSessionManifest): StoredSessionProject | null {
    const originalTranscript = manifest.segments[0]?.transcriptPath;
    const projects = relatedSessionProjects(baseDir, manifest.projectId);
    if (!originalTranscript) return projects[0] ?? null;
    const directory = dirname(sessionStoragePath(originalTranscript, baseDir));
    return (
        projects.find((project) => project.sessionDirectory === directory) ??
        (projects.length === 1 ? projects[0] : null)
    );
}

function restoreManifestsFromRecoveryDescriptors(sessionDir: string): void {
    for (const { runwieldSessionId, text } of readRecoveryDescriptors(sessionDir)) {
        const candidate: FileSessionManifest = JSON.parse(text);
        // Repair segments can live in a worktree's transcript directory. Their
        // recovery descriptors still belong to the original Project's bundle.
        const baseDir = dirname(sessionDir);
        const project = recoveryProject(baseDir, candidate);
        const ownerSessionDir = project
            ? sessionDirForProject(baseDir, project)
            : sessionDirForRoot(baseDir, candidate.transcriptCwd);
        const path = manifestPath(ownerSessionDir, runwieldSessionId);

        if (pathExists(path)) {
            try {
                const existing = readJson<FileSessionManifest>(path);
                if (existing.version === FILE_SESSION_STORE_VERSION) continue;
            } catch {
                const damagedPath = `${path}.damaged-${Date.now()}`;
                try {
                    renameSync(path, damagedPath);
                } catch {
                    continue;
                }
            }
        }
        writeJsonAtomically(path, projectManifest(candidate, project));
    }
}

export function listManifests(
    sessionDir: string,
    readOnly = false,
    project?: StoredSessionProject,
): Array<{ path: string; manifest: FileSessionManifest }> {
    if (!readOnly) restoreManifestsFromRecoveryDescriptors(sessionDir);
    return listSessionManifestFiles(sessionDir, readOnly).flatMap(({ path, text, hasPrimaryManifest }) => {
        const manifest: FileSessionManifest = JSON.parse(text);
        if (
            project &&
            !hasPrimaryManifest &&
            recoveryProject(dirname(sessionDir), manifest)?.sessionDirectory !== sessionDir
        )
            return [];
        return [{ path, manifest: project ? projectManifest(manifest, project) : manifest }];
    });
}

export function findManifestById(
    baseDir: string,
    runwieldSessionId: string,
    readOnly = false,
): { path: string; manifest: FileSessionManifest } | null {
    let result: { path: string; manifest: FileSessionManifest } | null = null;
    for (const project of listProjectsFromDisk(baseDir)) {
        const sessionDir = sessionDirForProject(baseDir, project);
        const found = listManifests(sessionDir, readOnly, project).find(
            (item) => item.manifest.runwieldSessionId === runwieldSessionId,
        );
        if (found && found.manifest.projectId === project.projectId) {
            if (result && result.path !== found.path) throw new Error("Conflicting Session identity claims");
            result = found;
        }
    }
    return result;
}

interface ManifestFingerprint {
    inode: number | null;
    modifiedAt: number | null;
    size: number;
}

interface CachedManifest {
    path: string;
    manifest: FileSessionManifest;
    fingerprint: ManifestFingerprint;
}

function manifestFingerprint(path: string): ManifestFingerprint {
    const stat = statSync(path);
    return {
        inode: stat.ino,
        modifiedAt: stat.mtime?.getTime() ?? null,
        size: stat.size,
    };
}

function sameManifestFingerprint(left: ManifestFingerprint, right: ManifestFingerprint): boolean {
    return left.inode === right.inode && left.modifiedAt === right.modifiedAt && left.size === right.size;
}

/**
 * Keeps the manifest locator and last parsed value for Sessions this process
 * has actually touched. Cache hits still stat that one manifest so changes
 * published by another RunWield surface remain visible without a catalog scan.
 */
export class FileSessionManifestCache {
    readonly #baseDir: string;
    readonly #manifests = new Map<string, CachedManifest>();
    readonly #manifestIdsByPath = new Map<string, string>();
    readonly #manifestIdsByTranscriptPath = new Map<string, string>();

    constructor(baseDir: string) {
        this.#baseDir = baseDir;
    }

    remember(path: string, manifest: FileSessionManifest): void {
        this.#cacheManifest(path, manifest, manifestFingerprint(path));
    }

    #cacheManifest(path: string, manifest: FileSessionManifest, fingerprint: ManifestFingerprint): void {
        const previous = this.#manifests.get(manifest.runwieldSessionId);
        if (previous) {
            if (previous.path !== path) this.#manifestIdsByPath.delete(previous.path);
            for (const segment of previous.manifest.segments) {
                this.#manifestIdsByTranscriptPath.delete(sessionStoragePath(segment.transcriptPath, this.#baseDir));
            }
        }
        this.#manifests.set(manifest.runwieldSessionId, { path, manifest: structuredClone(manifest), fingerprint });
        this.#manifestIdsByPath.set(path, manifest.runwieldSessionId);
        for (const segment of manifest.segments) {
            this.#manifestIdsByTranscriptPath.set(
                sessionStoragePath(segment.transcriptPath, this.#baseDir),
                manifest.runwieldSessionId,
            );
        }
    }

    readPath(path: string): { path: string; manifest: FileSessionManifest } | null {
        let fingerprint: ManifestFingerprint;
        try {
            fingerprint = manifestFingerprint(path);
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
            throw error;
        }
        const cachedId = this.#manifestIdsByPath.get(path);
        const cached = cachedId ? this.#manifests.get(cachedId) : undefined;
        if (cached && sameManifestFingerprint(cached.fingerprint, fingerprint)) {
            const manifest = structuredClone(cached.manifest);
            return { path, manifest: this.#projectManifest(manifest, path) };
        }
        const manifest = readJson<FileSessionManifest>(path);
        if (manifest.version !== FILE_SESSION_STORE_VERSION || manifest.runwieldSessionId !== basename(dirname(path)))
            return null;
        this.#cacheManifest(path, manifest, fingerprint);
        return { path, manifest: this.#projectManifest(manifest, path) };
    }

    findByTranscriptPath(transcriptPath: string): { path: string; manifest: FileSessionManifest } | null {
        const resolvedTranscriptPath = sessionStoragePath(transcriptPath, this.#baseDir);
        const cachedId = this.#manifestIdsByTranscriptPath.get(resolvedTranscriptPath);
        const cached = cachedId ? this.#manifests.get(cachedId) : undefined;
        if (cached) {
            const found = this.readPath(cached.path);
            if (
                found?.manifest.segments.some(
                    (segment) => sessionStoragePath(segment.transcriptPath, this.#baseDir) === resolvedTranscriptPath,
                )
            ) {
                return found;
            }
        }
        let recovery: FileSessionManifest;
        try {
            const transcript = sessionTranscriptStoragePath(resolvedTranscriptPath, this.#baseDir);
            recovery = readJson<FileSessionManifest>(recoveryDescriptorPath(transcript));
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
            throw error;
        }
        if (
            recovery.version !== FILE_SESSION_STORE_VERSION ||
            !recovery.segments.some(
                (segment) => sessionStoragePath(segment.transcriptPath, this.#baseDir) === resolvedTranscriptPath,
            )
        )
            return null;
        const project = recoveryProject(this.#baseDir, recovery);
        if (!project) return null;
        const path = manifestPath(sessionDirForProject(this.#baseDir, project), recovery.runwieldSessionId);
        const found = this.readPath(path);
        if (found) return found;
        projectManifest(recovery, project);
        writeManifest(recovery, path);
        this.remember(path, recovery);
        return { path, manifest: structuredClone(recovery) };
    }

    resolve(
        runwieldSessionId: string,
        projectId?: string,
        readOnly = false,
    ): { path: string; manifest: FileSessionManifest } | null {
        const cached = this.#manifests.get(runwieldSessionId);
        if (cached) {
            for (const project of listProjectsFromDisk(this.#baseDir)) {
                const otherPath = manifestPath(sessionDirForProject(this.#baseDir, project), runwieldSessionId);
                if (otherPath === cached.path || !pathExists(otherPath)) continue;
                const other = this.readPath(otherPath);
                if (other?.manifest.projectId === project.projectId)
                    throw new Error("Conflicting Session identity claims");
            }
            const found = readOnly ? this.readPath(cached.path) : this.#readRestoringPath(cached.path);
            return found && (!projectId || sessionProjectMatches(this.#baseDir, found.manifest.projectId, projectId))
                ? found
                : null;
        }
        if (projectId) {
            let result: { path: string; manifest: FileSessionManifest } | null = null;
            for (const project of relatedSessionProjects(this.#baseDir, projectId)) {
                const path = manifestPath(sessionDirForProject(this.#baseDir, project), runwieldSessionId);
                const found = readOnly ? this.readPath(path) : this.#readRestoringPath(path);
                if (!found || found.manifest.projectId !== project.projectId) continue;
                if (result && result.path !== found.path) throw new Error("Conflicting Session identity claims");
                result = found;
            }
            return result;
        }
        const found = findManifestById(this.#baseDir, runwieldSessionId, readOnly);
        if (!found) return null;
        this.remember(found.path, found.manifest);
        return { path: found.path, manifest: structuredClone(found.manifest) };
    }

    write(manifest: FileSessionManifest, path: string): void {
        writeManifest(manifest, path);
        this.remember(path, manifest);
    }

    #readRestoringPath(path: string): { path: string; manifest: FileSessionManifest } | null {
        try {
            const found = this.readPath(path);
            if (found) return found;
        } catch {
            // The targeted recovery below preserves the damaged manifest before
            // restoring it from transcript-adjacent evidence.
        }
        restoreManifestsFromRecoveryDescriptors(sessionDirForManifestPath(path));
        return this.readPath(path);
    }

    requirePath(path: string): FileSessionManifest {
        const found = this.readPath(path);
        if (!found) throw new Error("Session manifest is unavailable");
        return found.manifest;
    }

    #projectManifest(manifest: FileSessionManifest, path: string): FileSessionManifest {
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(manifest.projectId))
            return manifest;
        return projectManifest(manifest, readStoredProject(this.#baseDir, sessionDirForManifestPath(path)));
    }
}

export function writeManifest(manifest: FileSessionManifest, path: string): void {
    manifest.updatedAt = new Date().toISOString();
    writeJsonAtomically(path, manifest);
    writeRecoveryDescriptors(manifest, path);
}
