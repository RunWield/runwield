import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, parse, resolve, sep } from "node:path";

export const FILE_SESSION_STORE_VERSION = 1;

type JsonValue = null | boolean | number | string | JsonRecord | JsonValue[];
interface JsonRecord {
    [key: string]: JsonValue;
}

export interface SessionManifestFile {
    path: string;
    text: string;
    runwieldSessionId: string;
    projectId: string | undefined;
    updatedAt: string | undefined;
    hasPrimaryManifest: boolean;
    originalTranscriptPath: string | undefined;
}

export interface SessionProjectEvidence {
    projectId: string;
    currentRoot: string;
    remote: boolean;
}

interface SessionAccountPath {
    home: string;
    suffix: string;
}

function sessionAccountPath(path: string): SessionAccountPath | undefined {
    const marker = `${sep}.wld${sep}sessions`;
    const start = path.endsWith(marker) ? path.length - marker.length : path.lastIndexOf(`${marker}${sep}`);
    if (start < 0) return undefined;
    const { root } = parse(path);
    return { home: start < root.length ? root : path.slice(0, start), suffix: path.slice(start + 1) };
}

/** Use the store's spelling for equivalent account homes. Leave the Session path suffix lexical. */
export function sessionStoragePath(path: string, storePath: string): string {
    const absolute = resolve(path);
    const entered = sessionAccountPath(absolute);
    const store = sessionAccountPath(resolve(storePath));
    if (!entered || !store || entered.home === store.home) return absolute;
    try {
        if (realpathSync.native(entered.home) === realpathSync.native(store.home)) {
            return join(store.home, entered.suffix);
        }
    } catch (error) {
        if (!(error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")))
            throw error;
    }
    return absolute;
}

/** Keep I/O in the Session store's account if a saved HOME alias has been retargeted. */
export function sessionTranscriptStoragePath(path: string, storePath: string): string {
    const storagePath = sessionStoragePath(path, storePath);
    const transcriptHome = sessionAccountPath(storagePath)?.home;
    const storeHome = sessionAccountPath(resolve(storePath))?.home;
    if (transcriptHome && storeHome && transcriptHome !== storeHome) {
        throw new Error("Persisted session path belongs to a different execution account home");
    }
    return storagePath;
}

export function metadataDir(sessionDir: string): string {
    return join(sessionDir, ".runwield");
}

export function projectPath(sessionDir: string): string {
    return join(metadataDir(sessionDir), "project.json");
}

function readJsonRecord(text: string): JsonRecord | null {
    const value: JsonValue = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function readSessionProjectEvidence(path: string): SessionProjectEvidence | null {
    const value = readJsonRecord(readFileSync(path, "utf8"));
    if (!value || typeof value.projectId !== "string" || typeof value.currentRoot !== "string") return null;
    return { projectId: value.projectId, currentRoot: value.currentRoot, remote: Boolean(value.remote) };
}

function bundlesDir(sessionDir: string): string {
    return join(metadataDir(sessionDir), "session-bundles");
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

const RECOVERY_SUFFIX = ".runwield.json";

export function recoveryDescriptorPath(transcriptPath: string): string {
    return `${transcriptPath}${RECOVERY_SUFFIX}`;
}

function readManifestFile(path: string): SessionManifestFile | null {
    const text = readFileSync(path, "utf8");
    const value = readJsonRecord(text);
    if (value?.version !== FILE_SESSION_STORE_VERSION || typeof value.runwieldSessionId !== "string") return null;
    const firstSegment = Array.isArray(value.segments) ? value.segments[0] : null;
    const originalTranscriptPath =
        firstSegment && typeof firstSegment === "object" && !Array.isArray(firstSegment)
            ? firstSegment.transcriptPath
            : undefined;
    return {
        path,
        text,
        runwieldSessionId: value.runwieldSessionId,
        projectId: typeof value.projectId === "string" ? value.projectId : undefined,
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
        hasPrimaryManifest: false,
        originalTranscriptPath: typeof originalTranscriptPath === "string" ? originalTranscriptPath : undefined,
    };
}

export function readRecoveryDescriptors(sessionDir: string): Iterable<SessionManifestFile> {
    const recoverable = new Map<string, SessionManifestFile>();
    try {
        for (const entry of readdirSync(sessionDir, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith(`.jsonl${RECOVERY_SUFFIX}`)) continue;
            try {
                const candidate = readManifestFile(join(sessionDir, entry.name));
                if (!candidate?.runwieldSessionId) continue;
                const previous = recoverable.get(candidate.runwieldSessionId);
                if (
                    !previous ||
                    (previous.updatedAt !== undefined &&
                        candidate.updatedAt !== undefined &&
                        previous.updatedAt < candidate.updatedAt)
                ) {
                    recoverable.set(candidate.runwieldSessionId, candidate);
                }
            } catch {
                // Another descriptor for the same Session may still be valid.
            }
        }
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    return recoverable.values();
}

/** Read Session evidence without restoring files or changing writer locks. */
export function listSessionManifestFiles(sessionDir: string, includeRecovery: boolean): SessionManifestFile[] {
    const manifests: SessionManifestFile[] = [];
    try {
        for (const entry of readdirSync(bundlesDir(sessionDir), { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const path = manifestPath(sessionDir, entry.name);
            try {
                const manifest = readManifestFile(path);
                if (manifest?.runwieldSessionId === entry.name)
                    manifests.push({ ...manifest, hasPrimaryManifest: true });
            } catch {
                // Direct loads report damaged manifests. Global lists omit them.
            }
        }
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (includeRecovery) {
        for (const candidate of readRecoveryDescriptors(sessionDir)) {
            if (!manifests.some((item) => item.runwieldSessionId === candidate.runwieldSessionId)) {
                manifests.push({ ...candidate, path: manifestPath(sessionDir, candidate.runwieldSessionId) });
            }
        }
    }
    return manifests;
}
