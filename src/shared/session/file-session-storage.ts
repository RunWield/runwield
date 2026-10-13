/**
 * @module shared/session/file-session-storage
 * Durable paths, Project identity, and atomic manifest persistence.
 */

import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, renameSync, statSync } from "node:fs";
import { ensurePrivateDir, writeJsonAtomically } from "../private-json-file.ts";
export { ensurePrivateDir, writeJsonAtomically } from "../private-json-file.ts";
import { encodeCwdForSessionDir } from "./session-directory-name.ts";
import type { FileSessionManifest, FileSessionProject } from "./file-session-store-types.ts";

export const FILE_SESSION_STORE_VERSION = 1;
const FILE_SESSION_METADATA_DIR = ".runwield";
const FILE_SESSION_BUNDLES_DIR = "session-bundles";

export function isoNow(now?: () => string): string {
    return now ? now() : new Date().toISOString();
}

function deterministicProjectId(root: string): string {
    const digest = createHash("sha256").update(root).digest("hex");
    return `local-${digest.slice(0, 32)}`;
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

function metadataDir(sessionDir: string): string {
    return join(sessionDir, FILE_SESSION_METADATA_DIR);
}

function projectPath(sessionDir: string): string {
    return join(metadataDir(sessionDir), "project.json");
}

function bundlesDir(sessionDir: string): string {
    return join(metadataDir(sessionDir), FILE_SESSION_BUNDLES_DIR);
}

export function bundleDir(sessionDir: string, runwieldSessionId: string): string {
    return join(bundlesDir(sessionDir), runwieldSessionId);
}

export function manifestPath(sessionDir: string, runwieldSessionId: string): string {
    return join(bundleDir(sessionDir, runwieldSessionId), "manifest.json");
}

export function lockPath(sessionDir: string, runwieldSessionId: string): string {
    return join(bundleDir(sessionDir, runwieldSessionId), "session.lock");
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
    return join(baseDir, encodeCwdForSessionDir(canonicalRoot));
}

export function sessionDirForManifestPath(path: string): string {
    return dirname(dirname(dirname(dirname(path))));
}

export function ensureProject(
    baseDir: string,
    root: string,
    now?: () => string,
    idFactory?: () => string,
): FileSessionProject {
    if (!root || !isAbsolute(root)) throw new Error("Project root must be absolute");
    const enteredRoot = resolve(root);
    const stat = statSync(enteredRoot);
    if (!stat.isDirectory()) throw new Error("Project root must be a directory");
    const canonicalRoot = realpathSync.native(enteredRoot);
    const existing = listProjectsFromDisk(baseDir).find((project) =>
        resolve(project.currentRoot) === resolve(canonicalRoot) || resolve(project.registeredRoot) === enteredRoot
    );
    if (existing) return existing;
    const sessionDir = sessionDirForRoot(baseDir, canonicalRoot);
    ensurePrivateDir(sessionDir);
    const path = projectPath(sessionDir);
    if (pathExists(path)) {
        const project = readJson<FileSessionProject>(path);
        if (resolve(project.currentRoot) !== resolve(canonicalRoot)) {
            throw new Error("Session project identity does not match this directory");
        }
        return project;
    }
    const timestamp = isoNow(now);
    const project: FileSessionProject = {
        projectId: idFactory ? idFactory() : deterministicProjectId(canonicalRoot),
        displayName: basename(enteredRoot) || enteredRoot,
        registeredRoot: enteredRoot,
        currentRoot: canonicalRoot,
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
    return project;
}

export function listProjectsFromDisk(baseDir: string): FileSessionProject[] {
    const projects: FileSessionProject[] = [];
    try {
        for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const path = projectPath(join(baseDir, entry.name));
            if (!pathExists(path)) continue;
            try {
                projects.push(readJson<FileSessionProject>(path));
            } catch {
                // A damaged Project record is not guessed at during a global scan.
            }
        }
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    return projects.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function findProject(baseDir: string, projectId: string): FileSessionProject | null {
    return listProjectsFromDisk(baseDir).find((project) => project.projectId === projectId) || null;
}

export function rootEvidence(project: FileSessionProject) {
    return [{
        enteredRoot: project.registeredRoot,
        canonicalRoot: project.currentRoot,
        rootState: "current",
    }];
}

export function catalogedSession(manifest: FileSessionManifest) {
    const first = manifest.segments[0];
    const current = manifest.segments.find((segment) => segment.segmentId === manifest.currentSegmentId) ||
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

export function recoveryDescriptorPath(transcriptPath: string): string {
    return `${transcriptPath}.runwield.json`;
}

function writeRecoveryDescriptors(manifest: FileSessionManifest): void {
    for (const segment of manifest.segments) {
        try {
            writeJsonAtomically(recoveryDescriptorPath(segment.transcriptPath), manifest);
        } catch {
            // The primary manifest is already durable. A later successful
            // checkpoint will refresh all redundant recovery descriptors.
        }
    }
}

function restoreManifestsFromRecoveryDescriptors(sessionDir: string): void {
    const recoverable = new Map<string, FileSessionManifest>();
    try {
        for (const entry of readdirSync(sessionDir, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith(".jsonl.runwield.json")) continue;
            try {
                const candidate = readJson<FileSessionManifest>(join(sessionDir, entry.name));
                if (candidate.version !== FILE_SESSION_STORE_VERSION || !candidate.runwieldSessionId) continue;
                const previous = recoverable.get(candidate.runwieldSessionId);
                if (!previous || previous.updatedAt < candidate.updatedAt) {
                    recoverable.set(candidate.runwieldSessionId, candidate);
                }
            } catch {
                // Another descriptor for the same Session may still be valid.
            }
        }
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    for (const [runwieldSessionId, candidate] of recoverable) {
        const path = manifestPath(sessionDir, runwieldSessionId);
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
        writeJsonAtomically(path, candidate);
    }
}

export function listManifests(sessionDir: string): Array<{ path: string; manifest: FileSessionManifest }> {
    restoreManifestsFromRecoveryDescriptors(sessionDir);
    const manifests: Array<{ path: string; manifest: FileSessionManifest }> = [];
    try {
        for (const entry of readdirSync(bundlesDir(sessionDir), { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const path = manifestPath(sessionDir, entry.name);
            try {
                const manifest = readJson<FileSessionManifest>(path);
                if (manifest.version !== FILE_SESSION_STORE_VERSION || manifest.runwieldSessionId !== entry.name) {
                    continue;
                }
                manifests.push({ path, manifest });
            } catch {
                // Direct loads report damaged manifests. Global lists omit them
                // rather than inventing session identity from incomplete state.
            }
        }
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    return manifests;
}

export function findManifestById(
    baseDir: string,
    runwieldSessionId: string,
): { path: string; manifest: FileSessionManifest } | null {
    for (const project of listProjectsFromDisk(baseDir)) {
        const sessionDir = sessionDirForRoot(baseDir, project.currentRoot);
        const found = listManifests(sessionDir).find((item) => item.manifest.runwieldSessionId === runwieldSessionId);
        if (found) return found;
    }
    return null;
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
    readonly #projects = new Map<string, FileSessionProject>();

    constructor(baseDir: string) {
        this.#baseDir = baseDir;
    }

    rememberProject(project: FileSessionProject): void {
        this.#projects.set(project.projectId, { ...project });
    }

    remember(path: string, manifest: FileSessionManifest): void {
        this.#cacheManifest(path, manifest, manifestFingerprint(path));
    }

    #cacheManifest(path: string, manifest: FileSessionManifest, fingerprint: ManifestFingerprint): void {
        const previous = this.#manifests.get(manifest.runwieldSessionId);
        if (previous) {
            if (previous.path !== path) this.#manifestIdsByPath.delete(previous.path);
            for (const segment of previous.manifest.segments) {
                this.#manifestIdsByTranscriptPath.delete(resolve(segment.transcriptPath));
            }
        }
        this.#manifests.set(manifest.runwieldSessionId, { path, manifest: structuredClone(manifest), fingerprint });
        this.#manifestIdsByPath.set(path, manifest.runwieldSessionId);
        for (const segment of manifest.segments) {
            this.#manifestIdsByTranscriptPath.set(resolve(segment.transcriptPath), manifest.runwieldSessionId);
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
            return { path, manifest: structuredClone(cached.manifest) };
        }
        const manifest = readJson<FileSessionManifest>(path);
        if (manifest.version !== FILE_SESSION_STORE_VERSION) return null;
        this.#cacheManifest(path, manifest, fingerprint);
        return { path, manifest };
    }

    findByTranscriptPath(transcriptPath: string): { path: string; manifest: FileSessionManifest } | null {
        const resolvedTranscriptPath = resolve(transcriptPath);
        const cachedId = this.#manifestIdsByTranscriptPath.get(resolvedTranscriptPath);
        const cached = cachedId ? this.#manifests.get(cachedId) : undefined;
        if (cached) {
            const found = this.readPath(cached.path);
            if (
                found?.manifest.segments.some((segment) => resolve(segment.transcriptPath) === resolvedTranscriptPath)
            ) {
                return found;
            }
        }
        let recovery: FileSessionManifest;
        try {
            recovery = readJson<FileSessionManifest>(recoveryDescriptorPath(resolvedTranscriptPath));
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
            throw error;
        }
        if (
            recovery.version !== FILE_SESSION_STORE_VERSION ||
            !recovery.segments.some((segment) => resolve(segment.transcriptPath) === resolvedTranscriptPath)
        ) return null;
        const project = this.#project(recovery.projectId);
        if (!project) return null;
        const path = manifestPath(sessionDirForRoot(this.#baseDir, project.currentRoot), recovery.runwieldSessionId);
        const found = this.readPath(path);
        if (found) return found;
        writeManifest(recovery, path);
        this.remember(path, recovery);
        return { path, manifest: structuredClone(recovery) };
    }

    resolve(
        runwieldSessionId: string,
        projectId?: string,
    ): { path: string; manifest: FileSessionManifest } | null {
        const cached = this.#manifests.get(runwieldSessionId);
        if (cached) return this.#readRestoringPath(cached.path);
        if (projectId) {
            const project = this.#project(projectId);
            if (!project) return null;
            const path = manifestPath(sessionDirForRoot(this.#baseDir, project.currentRoot), runwieldSessionId);
            const found = this.#readRestoringPath(path);
            if (!found || found.manifest.projectId !== projectId) return null;
            return found;
        }
        const found = findManifestById(this.#baseDir, runwieldSessionId);
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

    #project(projectId: string): FileSessionProject | null {
        const cached = this.#projects.get(projectId);
        if (cached) return { ...cached };
        const project = findProject(this.#baseDir, projectId);
        if (!project) return null;
        this.rememberProject(project);
        return project;
    }
}

export function writeManifest(manifest: FileSessionManifest, path: string): void {
    manifest.updatedAt = new Date().toISOString();
    writeJsonAtomically(path, manifest);
    writeRecoveryDescriptors(manifest);
}
