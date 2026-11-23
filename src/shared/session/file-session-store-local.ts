import { projects } from "@runwield/projects";
import { sessionStoragePath, sessionTranscriptStoragePath } from "@runwield/session-files";
import { createInitialSessionManifest } from "./file-session-catalog-manifest.ts";
import { requireLocalSessionWriter } from "../remote/personal-resources.ts";
import { openNativeFileLock } from "../native-file-lock.ts";
import { readFileSync, statSync } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createFileSessionControl } from "./file-session-control.ts";
import {
    getRunWieldSessionsBaseDir,
    listCatalogSafeRootSessionLocators,
    readCatalogSafeRootSessionLocator,
} from "./root-session.ts";
import { readLineage, reconstructManifestFromLineage } from "./file-session-lineage.ts";
import {
    catalogedSession,
    catalogLockPath,
    ensurePrivateDir,
    ensureProject,
    FileSessionManifestCache,
    isoNow,
    listManifests,
    listProjectsFromDisk,
    lockPath,
    manifestPath,
    readStoredProject,
    recoveryDescriptorPath,
    rootEvidence,
    relatedSessionProjects,
    sessionProjectMatches,
    sessionProjectView,
    sessionDirForManifestPath,
    sessionDirForSuccessor,
    type StoredSessionProject,
} from "./file-session-storage.ts";
import type {
    CatalogedTranscriptLocator,
    FileSessionStore,
    HeldFileLock,
    LocatedSegmentLineage,
    OpenFileSessionStoreOptions,
    SessionArtifactReference,
    SessionTranscriptSegment,
} from "./file-session-store-types.ts";

export type LocalFileSessionStore = Omit<FileSessionStore, "createRemoteSessionOwner" | "recoverRemoteSession">;
export { FILE_SESSION_STORE_VERSION } from "./file-session-storage.ts";

/**
 * Open the file-authoritative Session store. The store has no database and no
 * Workspace registration side effects.
 */
export function openLocalFileSessionStore(options: OpenFileSessionStoreOptions = {}): LocalFileSessionStore {
    requireLocalSessionWriter();
    const baseDir = projects.launch.accountStoragePath(options.baseDir || getRunWieldSessionsBaseDir());
    const storagePath = (path: string) => sessionStoragePath(path, baseDir);
    ensurePrivateDir(baseDir);
    const locks = new Map<string, HeldFileLock>();
    const manifests = new FileSessionManifestCache(baseDir);

    async function ensureCatalogRecord(
        locator: import("./file-session-store-types.ts").EnsureSessionCatalogOptions,
        activationOptions?: import("./file-session-store-types.ts").InitialSessionActivationOptions,
    ) {
        const transcriptDir = dirname(storagePath(locator.transcriptPath));
        const project = relatedSessionProjects(baseDir, locator.projectId).find(
            (item) => item.sessionDirectory === transcriptDir,
        );
        if (!project) throw new Error("Session project is unavailable");
        const sessionDir = project.sessionDirectory;
        const safe = await readCatalogSafeRootSessionLocator({
            cwd: locator.transcriptCwd,
            sessionDir,
            sessionPath: locator.transcriptPath,
        });
        const transcript = sessionTranscriptStoragePath(safe.sessionPath, baseDir);
        const catalogLock = openNativeFileLock(catalogLockPath(sessionDir, transcript));
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
                const lineageResult = readLineage(transcript);
                if (lineageResult.kind === "malformed") throw new Error(lineageResult.reason);
                if (lineageResult.kind === "valid") {
                    const lineageManifest = manifests.resolve(
                        lineageResult.lineage.runwieldSessionId,
                        locator.projectId,
                    );
                    if (!lineageManifest) throw new Error("Session lineage exists without a recoverable manifest");
                    session = catalogedSession(lineageManifest.manifest);
                } else {
                    const manifest = createInitialSessionManifest(project.projectId, safe, locator, options.now);
                    manifests.write(manifest, manifestPath(sessionDir, manifest.runwieldSessionId));
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

    async function listStoredProjectSessions(
        project: StoredSessionProject | null,
        sessionOptions: import("./file-session-store-types.ts").ListSessionOptions = {},
    ) {
        if (!project || project.remote) {
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
        const { projectId, sessionDirectory: sessionDir } = project;
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
                )
                    continue;
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
        const pageSize: number =
            typeof requestedPageSize === "number" && Number.isInteger(requestedPageSize) && requestedPageSize > 0
                ? Math.min(requestedPageSize, 100)
                : 30;
        const listedManifests = listManifests(sessionDir, sessionOptions.catalog === false, project).filter(
            (item) => item.manifest.projectId === projectId,
        );
        if (sessionOptions.catalog !== false) {
            for (const item of listedManifests) manifests.remember(item.path, item.manifest);
        }
        const sessions = listedManifests
            .map((item) => catalogedSession(item.manifest))
            .filter(
                (session) =>
                    sessionOptions.archiveState === "all" ||
                    (sessionOptions.archiveState === "archived" ? Boolean(session.archivedAt) : !session.archivedAt),
            )
            .sort(
                (left, right) =>
                    Date.parse(right.headerTimestamp || "") - Date.parse(left.headerTimestamp || "") ||
                    right.runwieldSessionId.localeCompare(left.runwieldSessionId),
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
    }

    const store: LocalFileSessionStore = {
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
            return ensureProject(baseDir, projectOptions.root, projectOptions.now || options.now);
        },
        listSessionProjects() {
            const local = listProjectsFromDisk(baseDir).filter((project) => !project.remote);
            return [...new Map(local.map((project) => [project.projectId, sessionProjectView(project)])).values()];
        },
        getSessionProjectById(projectId) {
            const project = relatedSessionProjects(baseDir, projectId).find((item) => !item.remote);
            return project ? sessionProjectView(project) : null;
        },
        listProjectRootEvidence(projectId) {
            const project = store.getSessionProjectById(projectId);
            return project ? rootEvidence(project) : [];
        },
        requireSessionProjectRoot(projectId) {
            const project = store.getSessionProjectById(projectId);
            if (!project) throw new Error("Session project is unavailable");
            const root = rootEvidence(project).find((item) => item.rootState === "current")?.enteredRoot;
            if (!root) throw new Error("Session project root is unavailable");
            const stat = statSync(root);
            if (!stat.isDirectory()) throw new Error("Session project root is unavailable");
            return root;
        },
        findSessionByLocator(locator) {
            if (locator.transcriptPath) {
                const found = manifests.findByTranscriptPath(locator.transcriptPath);
                if (!found) return null;
                const project = readStoredProject(baseDir, sessionDirForManifestPath(found.path));
                if (!project || project.remote || project.projectId !== found.manifest.projectId) return null;
                const segment = found.manifest.segments.find(
                    (candidate) =>
                        storagePath(candidate.transcriptPath) === storagePath(String(locator.transcriptPath)),
                );
                if (!segment) return null;
                if (locator.projectId && !sessionProjectMatches(baseDir, found.manifest.projectId, locator.projectId))
                    return null;
                if (locator.piSessionId && segment.piSessionId !== locator.piSessionId) return null;
                return catalogedSession(found.manifest);
            }
            const sessionProjects = (
                locator.projectId ? relatedSessionProjects(baseDir, locator.projectId) : listProjectsFromDisk(baseDir)
            ).filter((project) => !project.remote);
            for (const project of sessionProjects) {
                for (const item of listManifests(project.sessionDirectory, false, project)) {
                    if (item.manifest.projectId !== project.projectId) continue;
                    manifests.remember(item.path, item.manifest);
                    const segment = item.manifest.segments.find(
                        (candidate) => candidate.piSessionId === locator.piSessionId,
                    );
                    if (segment) return catalogedSession(item.manifest);
                }
            }
            return null;
        },
        getSessionById(runwieldSessionId, projectId) {
            const found = manifests.resolve(runwieldSessionId, projectId);
            if (!found) return null;
            const project = readStoredProject(baseDir, sessionDirForManifestPath(found.path));
            return project && !project.remote && project.projectId === found.manifest.projectId
                ? catalogedSession(found.manifest)
                : null;
        },
        readSessionManifest(runwieldSessionId, projectId) {
            return manifests.resolve(runwieldSessionId, projectId, true)?.manifest ?? null;
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
            const projects = relatedSessionProjects(baseDir, projectId);
            if (projects.length <= 1) return listStoredProjectSessions(projects[0] ?? null, sessionOptions);
            const listed = await Promise.all(
                projects.map((project) => listStoredProjectSessions(project, { ...sessionOptions, all: true })),
            );
            const diagnostics = listed.flatMap((result) => result.diagnostics);
            const byId = new Map<string, import("./file-session-store-types.ts").CatalogedSession>();
            const conflicts = new Set<string>();
            for (const session of listed.flatMap((result) => result.sessions)) {
                const prior = byId.get(session.runwieldSessionId);
                if (prior) conflicts.add(session.runwieldSessionId);
                else byId.set(session.runwieldSessionId, session);
            }
            for (const id of conflicts) {
                diagnostics.push({
                    code: "locator_conflict",
                    sessionPath: byId.get(id)!.transcriptPath,
                    message: "Conflicting Session identity claims",
                });
                byId.delete(id);
            }
            const sessions = [...byId.values()].sort((a, b) => b.lastCatalogedAt.localeCompare(a.lastCatalogedAt));
            const page = Math.max(0, sessionOptions.page ?? 0);
            const pageSize = Math.min(100, Math.max(1, sessionOptions.pageSize ?? 30));
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
            return (
                found.manifest.segments.find((segment) => segment.segmentId === found.manifest.currentSegmentId) || null
            );
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
                const manifest = manifests.requirePath(found.path);
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
                const manifest = manifests.requirePath(found.path);
                const current = manifest.segments.find((segment) => segment.segmentId === manifest.currentSegmentId);
                if (!current || current.segmentId !== sealOptions.segmentId || current.sealedAt) {
                    throw new Error("Segment is not current");
                }
                const evidence = sealOptions.evidence;
                if (!evidence) throw new Error("Sealed segment evidence is required");
                const bytes = readFileSync(sessionTranscriptStoragePath(current.transcriptPath, baseDir));
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
            const found = manifests.resolve(orphanOptions.runwieldSessionId, orphanOptions.projectId);
            if (!found) return [];
            const known = new Set(found.manifest.segments.map((segment) => storagePath(segment.transcriptPath)));
            const sessionDir = sessionDirForSuccessor(
                baseDir,
                found.path,
                found.manifest.projectId,
                orphanOptions.transcriptCwd,
            );
            const { locators } = await listCatalogSafeRootSessionLocators(orphanOptions.transcriptCwd, { sessionDir });
            const candidates = [];
            for (const locator of locators) {
                if (known.has(storagePath(locator.sessionPath))) continue;
                const lineageResult = readLineage(locator.sessionPath);
                const parentSegmentId = lineageResult.kind === "valid" ? lineageResult.lineage.parentSegmentId : null;
                if (
                    lineageResult.kind !== "valid" ||
                    lineageResult.lineage.runwieldSessionId !== orphanOptions.runwieldSessionId ||
                    !parentSegmentId
                )
                    continue;
                const lineage = lineageResult.lineage;
                const predecessor = found.manifest.segments.find((segment) => segment.segmentId === parentSegmentId);
                candidates.push({
                    runwieldSessionId: orphanOptions.runwieldSessionId,
                    projectId: found.manifest.projectId,
                    transcriptPath: sessionStoragePath(locator.sessionPath, predecessor?.transcriptPath ?? sessionDir),
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
            const transcript = path ? sessionTranscriptStoragePath(path, baseDir) : null;
            let successorExists = false;
            if (transcript) {
                try {
                    await stat(transcript);
                    successorExists = true;
                } catch (error) {
                    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
                }
            }
            if (!transcript || !successorExists) {
                return { state: "no_op_retry", transcriptPath: path, segmentId: null, reason: "successor_not_created" };
            }
            const committed = store
                .listSessionTranscriptSegments(rolloverOptions.runwieldSessionId)
                .find((segment) => storagePath(segment.transcriptPath) === transcript);
            if (committed) {
                return {
                    state: "database_ahead",
                    transcriptPath: path,
                    segmentId: committed.segmentId,
                    reason: "successor_is_in_manifest_without_matching_generation",
                };
            }
            const lineageResult = readLineage(transcript);
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
                  : {
                        state: "removable_orphan",
                        transcriptPath: path,
                        segmentId: null,
                        reason: "orphan_has_no_lineage",
                    };
        },
        async discardOrphanRolloverCandidate(orphanOptions) {
            const path = sessionTranscriptStoragePath(orphanOptions.transcriptPath, baseDir);
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
            const found = manifests.resolve(locator.runwieldSessionId, locator.projectId);
            if (!found) throw new Error("Session identity is unavailable");
            const sessionDir = sessionDirForSuccessor(
                baseDir,
                found.path,
                found.manifest.projectId,
                locator.transcriptCwd,
            );
            return await readCatalogSafeRootSessionLocator({
                cwd: locator.transcriptCwd,
                sessionDir,
                sessionPath: locator.transcriptPath,
            });
        },
        ...createFileSessionControl({ baseDir, locks, manifests, now: options.now }),
    };
    return store;
}
