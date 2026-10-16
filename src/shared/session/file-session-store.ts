/**
 * @module shared/session/file-session-store
 * File-authoritative Session identity, transcript-segment manifests, and
 * single-writer coordination for every local RunWield runtime.
 */

import { readFileSync, statSync } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { requireLocalSessionWriter } from "../remote/personal-resources.ts";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { openNativeFileLock } from "../native-file-lock.ts";
import { createFileSessionControl } from "./file-session-control.ts";
import {
    getRunWieldSessionsBaseDir,
    listCatalogSafeRootSessionLocators,
    readCatalogSafeRootSessionLocator,
} from "./root-session.js";
import { readLineage, reconstructManifestFromLineage } from "./file-session-lineage.ts";
import {
    catalogedSession,
    catalogLockPath,
    ensurePrivateDir,
    ensureProject,
    FILE_SESSION_STORE_VERSION,
    FileSessionManifestCache,
    findProject,
    isoNow,
    listManifests,
    listProjectsFromDisk,
    lockPath,
    manifestPath,
    readJson,
    recoveryDescriptorPath,
    rootEvidence,
    sessionDirForManifestPath,
    sessionDirForRoot,
} from "./file-session-storage.ts";
import type {
    CatalogedTranscriptLocator,
    FileSessionManifest,
    FileSessionStore,
    HeldFileLock,
    LocatedSegmentLineage,
    OpenFileSessionStoreOptions,
    SessionArtifactReference,
    SessionTranscriptSegment,
} from "./file-session-store-types.ts";

export type { FileSessionProject, FileSessionStore } from "./file-session-store-types.ts";
export { FILE_SESSION_STORE_VERSION } from "./file-session-storage.ts";

/**
 * Open the file-authoritative Session store. The store has no database and no
 * Workspace registration side effects.
 */
export function openFileSessionStore(options: OpenFileSessionStoreOptions = {}): FileSessionStore {
    requireLocalSessionWriter();
    const baseDir = options.baseDir || getRunWieldSessionsBaseDir();
    ensurePrivateDir(baseDir);
    const locks = new Map<string, HeldFileLock>();
    const manifests = new FileSessionManifestCache(baseDir);

    async function ensureCatalogRecord(
        locator: import("./file-session-store-types.ts").EnsureSessionCatalogOptions,
        activationOptions?: import("./file-session-store-types.ts").InitialSessionActivationOptions,
    ) {
        const project = store.getProjectById(locator.projectId);
        if (!project) throw new Error("Session project is unavailable");
        const sessionDir = sessionDirForRoot(baseDir, project.currentRoot);
        const safe = await readCatalogSafeRootSessionLocator({
            cwd: locator.transcriptCwd,
            sessionDir,
            sessionPath: locator.transcriptPath,
        });
        const catalogLock = openNativeFileLock(catalogLockPath(sessionDir, safe.sessionPath));
        if (!catalogLock.tryLockSync(true)) {
            catalogLock.close();
            throw new Error("Session migration is already running in another RunWield surface");
        }
        try {
            let session = store.findSessionByLocator({ transcriptPath: safe.sessionPath });
            if (!session && locator.source !== "created") {
                session = store.findSessionByLocator({ projectId: locator.projectId, piSessionId: safe.piSessionId });
            }
            if (!session) {
                const lineageResult = readLineage(safe.sessionPath);
                if (lineageResult.kind === "malformed") throw new Error(lineageResult.reason);
                if (lineageResult.kind === "valid") {
                    const lineageManifest = manifests.resolve(
                        lineageResult.lineage.runwieldSessionId,
                        locator.projectId,
                    );
                    if (!lineageManifest) throw new Error("Session lineage exists without a recoverable manifest");
                    session = catalogedSession(lineageManifest.manifest);
                } else {
                    const timestamp = isoNow(locator.now || options.now);
                    const runwieldSessionId = locator.idFactory ? locator.idFactory() : crypto.randomUUID();
                    const segmentId = `${runwieldSessionId}-segment-0`;
                    const segment: SessionTranscriptSegment = {
                        segmentId,
                        runwieldSessionId,
                        projectId: project.projectId,
                        piSessionId: safe.piSessionId,
                        transcriptPath: safe.sessionPath,
                        transcriptCwd: safe.headerCwd,
                        ordinal: 0,
                        kind: "planning",
                        sealedAt: null,
                        headerVersion: safe.headerVersion,
                        headerTimestamp: safe.headerTimestamp,
                        firstCatalogedAt: timestamp,
                        lastCatalogedAt: timestamp,
                        lineageParentSegmentId: null,
                        lineageParentPiSessionId: null,
                        lineageGroupKey: null,
                        lineageRecordedAt: null,
                        sealedByteLength: null,
                        sealedDigestHex: null,
                        sealedTerminalEntryId: null,
                    };
                    const manifest: FileSessionManifest = {
                        version: FILE_SESSION_STORE_VERSION,
                        runwieldSessionId,
                        projectId: project.projectId,
                        transcriptCwd: safe.headerCwd,
                        displayName: null,
                        source: locator.source || "catalog",
                        createdAt: timestamp,
                        updatedAt: timestamp,
                        currentSegmentId: segmentId,
                        fence: 0,
                        activation: {
                            state: "uninitialized",
                            phase: null,
                            ownerInstanceId: null,
                            ownerProcessKind: null,
                            operationId: null,
                            expectedGeneration: null,
                            expectedCurrentSegmentId: null,
                            acquiredAt: null,
                            blockedReason: null,
                            baselineByteLength: null,
                            baselineDigestHex: null,
                        },
                        generation: null,
                        segments: [segment],
                        artifacts: [],
                    };
                    manifests.write(manifest, manifestPath(sessionDir, runwieldSessionId));
                    session = catalogedSession(manifest);
                }
            }
            if (!activationOptions) return { session, segment: null, proof: null };
            const segment = store.getCurrentSessionSegment(session.runwieldSessionId);
            if (!segment) throw new Error("The Session transcript could not be prepared");
            const proof = store.acquireSessionActivation({
                ...activationOptions,
                runwieldSessionId: session.runwieldSessionId,
                projectId: session.projectId,
                expectedGeneration: null,
                expectedCurrentSegmentId: segment.segmentId,
            });
            return { session, segment, proof };
        } finally {
            catalogLock.unlockSync();
            catalogLock.close();
        }
    }

    const store: FileSessionStore = {
        path: baseDir,
        close() {
            for (const [operationId, held] of locks) {
                locks.delete(operationId);
                try {
                    held.file.unlockSync();
                } catch {
                    // Closing still releases the operating-system lock.
                }
                held.file.close();
            }
        },
        ensureRuntimeProject(projectOptions) {
            const project = ensureProject(
                baseDir,
                projectOptions.root,
                projectOptions.now || options.now,
                projectOptions.idFactory,
            );
            manifests.rememberProject(project);
            return project;
        },
        listSessionProjects() {
            return listProjectsFromDisk(baseDir);
        },
        listProjects() {
            return listProjectsFromDisk(baseDir);
        },
        getProjectById(projectId) {
            const project = findProject(baseDir, projectId);
            if (project) manifests.rememberProject(project);
            return project;
        },
        listProjectRootEvidence(projectId) {
            const project = findProject(baseDir, projectId);
            return project ? rootEvidence(project) : [];
        },
        requireSessionProjectRoot(projectId) {
            const project = findProject(baseDir, projectId);
            if (!project) throw new Error("Session project is unavailable");
            const info = statSync(project.registeredRoot);
            if (!info.isDirectory()) throw new Error("Session project root is unavailable");
            return project.registeredRoot;
        },
        findSessionByLocator(locator) {
            if (locator.transcriptPath) {
                const found = manifests.findByTranscriptPath(locator.transcriptPath);
                if (!found) return null;
                const segment = found.manifest.segments.find((candidate) =>
                    resolve(candidate.transcriptPath) === resolve(String(locator.transcriptPath))
                );
                if (!segment) return null;
                if (locator.projectId && found.manifest.projectId !== locator.projectId) return null;
                if (locator.piSessionId && segment.piSessionId !== locator.piSessionId) return null;
                return catalogedSession(found.manifest);
            }
            const projects = locator.projectId
                ? listProjectsFromDisk(baseDir).filter((project) => project.projectId === locator.projectId)
                : listProjectsFromDisk(baseDir);
            for (const project of projects) {
                for (const item of listManifests(sessionDirForRoot(baseDir, project.currentRoot))) {
                    manifests.rememberProject(project);
                    manifests.remember(item.path, item.manifest);
                    const segment = item.manifest.segments.find((candidate) =>
                        candidate.piSessionId === locator.piSessionId
                    );
                    if (segment) return catalogedSession(item.manifest);
                }
            }
            return null;
        },
        getSessionById(runwieldSessionId, projectId) {
            const found = manifests.resolve(runwieldSessionId, projectId);
            return found ? catalogedSession(found.manifest) : null;
        },
        async ensureSessionCatalogRecord(locator) {
            return (await ensureCatalogRecord(locator)).session;
        },
        async ensureSessionCatalogRecordAndAcquire(options) {
            const result = await ensureCatalogRecord(options.locator, options.activation);
            if (!result.segment || !result.proof) throw new Error("The Session writer lock could not be acquired");
            return { session: result.session, segment: result.segment, proof: result.proof };
        },
        async listProjectSessions(projectId, sessionOptions = {}) {
            const project = findProject(baseDir, projectId);
            if (!project) {
                return {
                    sessions: [],
                    diagnostics: [],
                    page: 0,
                    pageSize: 30,
                    total: 0,
                    hasNext: false,
                    hasPrevious: false,
                };
            }
            const sessionDir = sessionDirForRoot(baseDir, project.currentRoot);
            const diagnostics: Array<{ sessionPath: string; code: string; message: string }> = [];
            if (sessionOptions.catalog !== false) {
                const { locators, diagnostics: locatorDiagnostics } = await listCatalogSafeRootSessionLocators(
                    project.registeredRoot,
                    { sessionDir },
                );
                diagnostics.push(...locatorDiagnostics);

                const lineageGroups = new Map<string, LocatedSegmentLineage[]>();
                const locatorsByPiSessionId = new Map<string, CatalogedTranscriptLocator>();
                for (const locator of locators) locatorsByPiSessionId.set(locator.piSessionId, locator);
                const malformedLineagePaths = new Set<string>();
                for (const locator of locators) {
                    const lineageResult = readLineage(locator.sessionPath);
                    if (lineageResult.kind === "malformed") {
                        malformedLineagePaths.add(locator.sessionPath);
                        diagnostics.push({
                            sessionPath: locator.sessionPath,
                            code: "lineage_recovery_blocked",
                            message: lineageResult.reason,
                        });
                        continue;
                    }
                    if (lineageResult.kind === "absent") continue;
                    const lineage = lineageResult.lineage;
                    const group = lineageGroups.get(lineage.runwieldSessionId) || [];
                    group.push({ locator, lineage });
                    lineageGroups.set(lineage.runwieldSessionId, group);
                }
                for (const [runwieldSessionId, group] of lineageGroups) {
                    if (manifests.resolve(runwieldSessionId, projectId)) continue;
                    const representedPiIds = new Set(group.map((item) => item.locator.piSessionId));
                    for (const item of [...group]) {
                        const parentPiSessionId = item.lineage.parentPiSessionId;
                        const parentSegmentId = item.lineage.parentSegmentId;
                        if (!parentPiSessionId || !parentSegmentId || representedPiIds.has(parentPiSessionId)) continue;
                        const parentLocator = locatorsByPiSessionId.get(parentPiSessionId);
                        if (!parentLocator) continue;
                        const parentLineage = readLineage(parentLocator.sessionPath);
                        if (parentLineage.kind === "malformed") {
                            malformedLineagePaths.add(parentLocator.sessionPath);
                            continue;
                        }
                        if (parentLineage.kind === "valid") continue;
                        group.push({
                            locator: parentLocator,
                            lineage: {
                                runwieldSessionId,
                                segmentId: parentSegmentId,
                                parentSegmentId: null,
                                parentPiSessionId: null,
                                lineageGroupKey: item.lineage.lineageGroupKey,
                                kind: "planning",
                            },
                        });
                        representedPiIds.add(parentPiSessionId);
                    }
                    const recovered = reconstructManifestFromLineage(project, group, sessionOptions.now || options.now);
                    if (recovered) {
                        manifests.write(recovered, manifestPath(sessionDir, runwieldSessionId));
                    } else {
                        for (const item of group) {
                            diagnostics.push({
                                sessionPath: item.locator.sessionPath,
                                code: "lineage_recovery_blocked",
                                message: "This Session's transcript segments could not be ordered safely.",
                            });
                        }
                    }
                }
                for (const locator of locators) {
                    if (malformedLineagePaths.has(locator.sessionPath)) continue;
                    const lineageResult = readLineage(locator.sessionPath);
                    if (lineageResult.kind === "malformed") continue;
                    if (
                        lineageResult.kind === "valid" &&
                        !manifests.resolve(lineageResult.lineage.runwieldSessionId, projectId)
                    ) continue;
                    try {
                        await store.ensureSessionCatalogRecord({
                            projectId,
                            piSessionId: locator.piSessionId,
                            transcriptPath: locator.sessionPath,
                            transcriptCwd: locator.headerCwd,
                            headerVersion: locator.headerVersion,
                            headerTimestamp: locator.headerTimestamp,
                            source: "catalog",
                            idFactory: sessionOptions.idFactory,
                            now: sessionOptions.now,
                        });
                    } catch (error) {
                        diagnostics.push({
                            sessionPath: locator.sessionPath,
                            code: "catalog_failed",
                            message: error instanceof Error ? error.message : String(error),
                        });
                    }
                }
            }
            const requestedPage = sessionOptions.page;
            const page: number =
                typeof requestedPage === "number" && Number.isInteger(requestedPage) && requestedPage >= 0
                    ? requestedPage
                    : 0;
            const requestedPageSize = sessionOptions.pageSize;
            const pageSize: number = typeof requestedPageSize === "number" &&
                    Number.isInteger(requestedPageSize) && requestedPageSize > 0
                ? Math.min(requestedPageSize, 100)
                : 30;
            const listedManifests = listManifests(sessionDir);
            for (const item of listedManifests) manifests.remember(item.path, item.manifest);
            const sessions = listedManifests
                .map((item) => catalogedSession(item.manifest))
                .filter((session) =>
                    sessionOptions.archiveState === "all" ||
                    (sessionOptions.archiveState === "archived" ? Boolean(session.archivedAt) : !session.archivedAt)
                )
                .sort((left, right) =>
                    Date.parse(right.headerTimestamp || "") - Date.parse(left.headerTimestamp || "") ||
                    right.runwieldSessionId.localeCompare(left.runwieldSessionId)
                );
            const start = page * pageSize;
            return {
                sessions: sessionOptions.all ? sessions : sessions.slice(start, start + pageSize),
                diagnostics,
                page,
                pageSize,
                total: sessions.length,
                hasNext: start + pageSize < sessions.length,
                hasPrevious: page > 0 && start < sessions.length,
            };
        },
        async catalogProjectSessions(projectId, sessionOptions = {}) {
            const result = await store.listProjectSessions(projectId, { ...sessionOptions, catalog: true });
            return { cataloged: result.sessions, diagnostics: result.diagnostics };
        },
        listSessionTranscriptSegments(runwieldSessionId) {
            const found = manifests.resolve(runwieldSessionId);
            return found ? found.manifest.segments.map((segment) => ({ ...segment })) : [];
        },
        listSessionArtifacts(runwieldSessionId, projectId) {
            const found = manifests.resolve(runwieldSessionId, projectId);
            if (!found) return [];
            return (found.manifest.artifacts || []).map((artifact: SessionArtifactReference) => ({ ...artifact }));
        },
        listSessionPlanAssociations(runwieldSessionId, projectId) {
            const found = manifests.resolve(runwieldSessionId, projectId);
            if (!found) return [];
            return (found.manifest.planAssociations || [])
                .filter((association) => association.committedGeneration !== null)
                .map((association) => ({ ...association }));
        },
        getLastPlanReview(runwieldSessionId, projectId) {
            const found = manifests.resolve(runwieldSessionId, projectId);
            return found?.manifest.lastPlanReview ? { ...found.manifest.lastPlanReview } : null;
        },
        getCurrentSessionSegment(runwieldSessionId) {
            const found = manifests.resolve(runwieldSessionId);
            if (!found) return null;
            return found.manifest.segments.find((segment) => segment.segmentId === found.manifest.currentSegmentId) ||
                null;
        },
        async appendSessionTranscriptSegment(segmentOptions) {
            const found = manifests.resolve(segmentOptions.runwieldSessionId, segmentOptions.projectId);
            if (!found) throw new Error("Session identity is unavailable");
            const safe = await store.validateSuccessorSegmentLocator({
                ...segmentOptions,
                projectId: found.manifest.projectId,
            });
            const sessionDir = sessionDirForManifestPath(found.path);
            const file = openNativeFileLock(lockPath(sessionDir, found.manifest.runwieldSessionId));
            if (!file.tryLockSync(true)) {
                file.close();
                throw new Error("Session is open in another RunWield surface");
            }
            try {
                const manifest = readJson<FileSessionManifest>(found.path);
                const current = manifest.segments.find((segment) => segment.segmentId === manifest.currentSegmentId);
                if (!current?.sealedAt) throw new Error("Current segment is still writable");
                const now = isoNow(segmentOptions.now || options.now);
                const successor: SessionTranscriptSegment = {
                    segmentId: segmentOptions.idFactory ? segmentOptions.idFactory() : crypto.randomUUID(),
                    runwieldSessionId: manifest.runwieldSessionId,
                    projectId: manifest.projectId,
                    piSessionId: safe.piSessionId,
                    transcriptPath: safe.sessionPath,
                    transcriptCwd: safe.headerCwd,
                    ordinal: manifest.segments.length,
                    kind: segmentOptions.kind,
                    sealedAt: null,
                    headerVersion: safe.headerVersion,
                    headerTimestamp: safe.headerTimestamp,
                    firstCatalogedAt: now,
                    lastCatalogedAt: now,
                    lineageParentSegmentId: segmentOptions.lineageParentSegmentId ?? null,
                    lineageParentPiSessionId: segmentOptions.lineageParentPiSessionId ?? null,
                    lineageGroupKey: segmentOptions.lineageGroupKey ?? null,
                    lineageRecordedAt: now,
                    sealedByteLength: null,
                    sealedDigestHex: null,
                    sealedTerminalEntryId: null,
                };
                manifest.segments.push(successor);
                manifest.currentSegmentId = successor.segmentId;
                manifests.write(manifest, found.path);
                return successor;
            } finally {
                file.unlockSync();
                file.close();
            }
        },
        sealSessionTranscriptSegment(sealOptions) {
            const found = manifests.resolve(sealOptions.runwieldSessionId);
            if (!found) throw new Error("Session identity is unavailable");
            const sessionDir = sessionDirForManifestPath(found.path);
            const file = openNativeFileLock(lockPath(sessionDir, found.manifest.runwieldSessionId));
            if (!file.tryLockSync(true)) {
                file.close();
                throw new Error("Session is open in another RunWield surface");
            }
            try {
                const manifest = readJson<FileSessionManifest>(found.path);
                const current = manifest.segments.find((segment) => segment.segmentId === manifest.currentSegmentId);
                if (!current || current.segmentId !== sealOptions.segmentId || current.sealedAt) {
                    throw new Error("Segment is not current");
                }
                const evidence = sealOptions.evidence;
                if (!evidence) throw new Error("Sealed segment evidence is required");
                const bytes = readFileSync(current.transcriptPath);
                if (
                    bytes.byteLength !== evidence.byteLength ||
                    createHash("sha256").update(bytes).digest("hex") !== evidence.digestHex
                ) {
                    throw new Error("Sealed segment evidence does not match transcript");
                }
                const now = isoNow(sealOptions.now || options.now);
                current.sealedAt = now;
                current.sealedByteLength = evidence.byteLength;
                current.sealedDigestHex = evidence.digestHex;
                current.sealedTerminalEntryId = evidence.terminalEntryId ?? null;
                current.lastCatalogedAt = now;
                manifests.write(manifest, found.path);
                return { ...current };
            } finally {
                file.unlockSync();
                file.close();
            }
        },
        async findOrphanRolloverCandidates(orphanOptions) {
            const known = new Set(
                store.listSessionTranscriptSegments(orphanOptions.runwieldSessionId).map((segment) =>
                    resolve(segment.transcriptPath)
                ),
            );
            const found = manifests.resolve(orphanOptions.runwieldSessionId, orphanOptions.projectId);
            if (!found) return [];
            const sessionDir = sessionDirForManifestPath(found.path);
            const { locators } = await listCatalogSafeRootSessionLocators(orphanOptions.transcriptCwd, { sessionDir });
            const candidates = [];
            for (const locator of locators) {
                if (known.has(resolve(locator.sessionPath))) continue;
                const lineageResult = readLineage(locator.sessionPath);
                const parentSegmentId = lineageResult.kind === "valid" ? lineageResult.lineage.parentSegmentId : null;
                if (
                    lineageResult.kind !== "valid" ||
                    lineageResult.lineage.runwieldSessionId !== orphanOptions.runwieldSessionId ||
                    !parentSegmentId
                ) continue;
                const lineage = lineageResult.lineage;
                candidates.push({
                    runwieldSessionId: orphanOptions.runwieldSessionId,
                    projectId: orphanOptions.projectId,
                    transcriptPath: resolve(locator.sessionPath),
                    transcriptCwd: locator.headerCwd,
                    piSessionId: locator.piSessionId,
                    parentSegmentId,
                    parentPiSessionId: lineage.parentPiSessionId ?? null,
                    lineageGroupKey: lineage.lineageGroupKey ?? null,
                });
            }
            return candidates;
        },
        async inspectSegmentRolloverRecovery(rolloverOptions) {
            const path = rolloverOptions.successorTranscriptPath
                ? resolve(rolloverOptions.successorTranscriptPath)
                : null;
            let successorExists = false;
            if (path) {
                try {
                    await stat(path);
                    successorExists = true;
                } catch (error) {
                    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
                }
            }
            if (!path || !successorExists) {
                return { state: "no_op_retry", transcriptPath: path, segmentId: null, reason: "successor_not_created" };
            }
            const committed = store.listSessionTranscriptSegments(rolloverOptions.runwieldSessionId)
                .find((segment) => resolve(segment.transcriptPath) === path);
            if (committed) {
                return {
                    state: "database_ahead",
                    transcriptPath: path,
                    segmentId: committed.segmentId,
                    reason: "successor_is_in_manifest_without_matching_generation",
                };
            }
            const lineageResult = readLineage(path);
            return lineageResult.kind === "valid"
                ? {
                    state: "recoverable_orphan",
                    transcriptPath: path,
                    segmentId: lineageResult.lineage.segmentId,
                    reason: "orphan_lineage_valid",
                }
                : lineageResult.kind === "malformed"
                ? {
                    state: "database_ahead",
                    transcriptPath: path,
                    segmentId: null,
                    reason: "orphan_lineage_malformed",
                }
                : { state: "removable_orphan", transcriptPath: path, segmentId: null, reason: "orphan_has_no_lineage" };
        },
        async discardOrphanRolloverCandidate(orphanOptions) {
            const path = resolve(orphanOptions.transcriptPath);
            if (store.findSessionByLocator({ transcriptPath: path })) {
                throw new Error("Committed Session transcript cannot be discarded");
            }
            const lineageResult = readLineage(path);
            if (
                lineageResult.kind !== "valid" ||
                lineageResult.lineage.runwieldSessionId !== orphanOptions.runwieldSessionId
            ) {
                throw new Error("Rollover candidate lineage changed");
            }
            await unlink(path);
            try {
                await unlink(recoveryDescriptorPath(path));
            } catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
            }
        },
        async validateSuccessorSegmentLocator(locator) {
            const project = findProject(baseDir, locator.projectId);
            if (!project) throw new Error("Session project is unavailable");
            return await readCatalogSafeRootSessionLocator({
                cwd: locator.transcriptCwd,
                sessionDir: sessionDirForRoot(baseDir, locator.transcriptCwd),
                sessionPath: locator.transcriptPath,
            });
        },
        ...createFileSessionControl({ locks, manifests, now: options.now }),
    };
    return store;
}
