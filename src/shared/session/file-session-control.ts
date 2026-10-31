/**
 * @module shared/session/file-session-control
 * Operation-scoped writer locks, generation publication, and explicit recovery.
 */

import { readFileSync, openSync, closeSync, writeSync, fsyncSync } from "node:fs";
import { createHash } from "node:crypto";
import { openNativeFileLock } from "../native-file-lock.ts";
import { requireLocalSessionWriter } from "../remote/personal-resources.ts";
import { inspectRecoverableSessionTranscript } from "../remote/session-protocol.ts";
import { requestWorkspaceSearchRefresh } from "../workspace-search-refresh.ts";
import {
    activationView,
    assertProof,
    committedTranscriptMatches,
    generationView,
    idleActivation,
    markRecoveryAfterAbandonedWriter,
    reconcilePendingTranscriptMigration,
    releaseHeldLock,
    requireHeldLock,
} from "./file-session-activation-state.ts";
import {
    bundleDir,
    catalogedSession,
    ensurePrivateDir,
    FILE_SESSION_STORE_VERSION,
    FileSessionManifestCache,
    findProject,
    isoNow,
    lockPath,
    readJson,
    sessionDirForManifestPath,
    writeTextAtomically,
} from "./file-session-storage.ts";
import type {
    FileActivationProof,
    FileSessionManifest,
    FileSessionStore,
    HeldFileLock,
    ManifestPlanAssociation,
    SessionArtifactReference,
} from "./file-session-store-types.ts";

interface FileSessionControlOptions {
    baseDir: string;
    locks: Map<string, HeldFileLock>;
    manifests: FileSessionManifestCache;
    now?: () => string;
}

function stampPendingPlanAssociations(manifest: FileSessionManifest, generation: number): void {
    manifest.planAssociations = (manifest.planAssociations || []).map((association) =>
        association.committedGeneration === null ? { ...association, committedGeneration: generation } : association,
    );
}

function dropPendingPlanAssociations(manifest: FileSessionManifest): void {
    manifest.planAssociations = (manifest.planAssociations || []).filter(
        (association) => association.committedGeneration !== null,
    );
}

type FileSessionControl = Pick<
    FileSessionStore,
    | "readActiveSessionTranscript"
    | "writeActiveSessionTranscript"
    | "migrateActiveSessionTranscript"
    | "archiveSession"
    | "unarchiveSession"
    | "inspectSessionActivation"
    | "acquireSessionActivation"
    | "changeSessionActivationPhase"
    | "registerSessionArtifact"
    | "stagePlanAssociation"
    | "recordLastPlanReview"
    | "publishGenerationAndRelease"
    | "releaseUnchangedActivation"
    | "recoverSessionControl"
    | "markSessionReconcileRequired"
    | "markSessionUncertain"
    | "markSessionReconcileRequiredWithProof"
    | "commitSegmentRolloverAndPublish"
>;

export function createFileSessionControl(options: FileSessionControlOptions): FileSessionControl {
    const { locks, manifests } = options;

    function refreshLocalProject(manifest: FileSessionManifest): void {
        const project = findProject(options.baseDir, manifest.projectId);
        if (project && !project.remote) requestWorkspaceSearchRefresh(manifest.transcriptCwd);
    }

    function setArchiveState(runwieldSessionId: string, projectId: string | undefined, archived: boolean) {
        const found = manifests.resolve(runwieldSessionId, projectId);
        if (!found || (projectId && found.manifest.projectId !== projectId)) {
            throw new Error("Session identity is unavailable");
        }
        const file = openNativeFileLock(lockPath(sessionDirForManifestPath(found.path), runwieldSessionId));
        try {
            if (!file.tryLockSync(true)) throw new Error("Session is open in another RunWield surface");
            try {
                const manifest = readJson<FileSessionManifest>(found.path);
                if (
                    manifest.version !== FILE_SESSION_STORE_VERSION ||
                    manifest.runwieldSessionId !== runwieldSessionId ||
                    (projectId && manifest.projectId !== projectId)
                ) {
                    throw new Error("Session identity is unavailable");
                }
                if (manifest.activation.state === "active") {
                    markRecoveryAfterAbandonedWriter(manifest, isoNow(options.now));
                    manifests.write(manifest, found.path);
                }
                if (["uncertain", "reconcile_required"].includes(manifest.activation.state)) {
                    throw new Error(`Session requires recovery: ${manifest.activation.blockedReason || "unknown"}`);
                }
                if (Boolean(manifest.archivedAt) !== archived) {
                    manifest.archivedAt = archived ? isoNow(options.now) : null;
                    manifests.write(manifest, found.path);
                }
                return catalogedSession(manifest);
            } finally {
                file.unlockSync();
            }
        } finally {
            file.close();
        }
    }

    function activeTranscript(proof: FileActivationProof) {
        requireLocalSessionWriter();
        const held = requireHeldLock(locks, proof);
        const manifest = readJson<FileSessionManifest>(held.manifestPath);
        assertProof(manifest, proof);
        if (manifest.activation.pendingMigration) throw new Error("Session migration must settle before writing");
        if (manifest.runwieldSessionId !== proof.runwieldSessionId || manifest.projectId !== proof.projectId) {
            throw new Error("Session writer identity was rejected");
        }
        const segment = manifest.segments.find((item) => item.segmentId === manifest.currentSegmentId);
        if (!segment || segment.sealedAt || segment.segmentId !== proof.expectedCurrentSegmentId) {
            throw new Error("Session segment is not writable");
        }
        return segment.transcriptPath;
    }

    return {
        readActiveSessionTranscript(proof) {
            return readFileSync(activeTranscript(proof), "utf8");
        },
        writeActiveSessionTranscript(proof, contents, expectedDigestHex) {
            const path = activeTranscript(proof);
            const old = readFileSync(path);
            if (createHash("sha256").update(old).digest("hex") !== expectedDigestHex) {
                throw new Error("Session transcript evidence changed");
            }
            const bytes = new TextEncoder().encode(contents);
            const terminal = JSON.parse(contents.trimEnd().split("\n").at(-1) || "null");
            const append = bytes.length >= old.length && old.every((byte, index) => bytes[index] === byte);
            if (!append) {
                writeTextAtomically(path, contents);
            } else {
                const file = openSync(path, "a");
                try {
                    let offset = old.length;
                    while (offset < bytes.length) offset += writeSync(file, bytes.subarray(offset));
                    fsyncSync(file);
                } finally {
                    closeSync(file);
                }
            }
            const saved = readFileSync(path);
            if (saved.length !== bytes.length || !saved.every((byte, index) => byte === bytes[index])) {
                throw new Error("Session save bytes did not match");
            }
            return {
                byteLength: bytes.length,
                digestHex: createHash("sha256").update(bytes).digest("hex"),
                terminalEntryId: terminal?.type === "session" ? null : (terminal?.id ?? null),
            };
        },
        migrateActiveSessionTranscript(proof, contents, expectedDigestHex) {
            if (proof.phase !== "preparing") throw new Error("Session migration requires preparing phase");
            const path = activeTranscript(proof);
            const before = readFileSync(path);
            if (createHash("sha256").update(before).digest("hex") !== expectedDigestHex) {
                throw new Error("Session migration evidence changed");
            }
            const terminal = JSON.parse(contents.trimEnd().split("\n").at(-1) || "null");
            const held = requireHeldLock(locks, proof);
            const manifest = readJson<FileSessionManifest>(held.manifestPath);
            assertProof(manifest, proof);
            manifest.activation.pendingMigration = {
                beforeByteLength: before.length,
                beforeDigestHex: expectedDigestHex,
                after: {
                    byteLength: new TextEncoder().encode(contents).length,
                    digestHex: createHash("sha256").update(contents).digest("hex"),
                    terminalEntryId: terminal?.type === "session" ? null : (terminal?.id ?? null),
                },
                headerVersion: JSON.parse(contents.split("\n", 1)[0]).version,
            };
            // Intent is durable before the atomic replacement, so owner death cannot orphan the new digest.
            manifests.write(manifest, held.manifestPath);
            writeTextAtomically(path, contents);
            reconcilePendingTranscriptMigration(manifest, isoNow(options.now));
            manifests.write(manifest, held.manifestPath);
            return { ...proof, expectedGeneration: manifest.activation.expectedGeneration };
        },
        archiveSession(runwieldSessionId, projectId) {
            return setArchiveState(runwieldSessionId, projectId, true);
        },
        unarchiveSession(runwieldSessionId, projectId) {
            return setArchiveState(runwieldSessionId, projectId, false);
        },

        inspectSessionActivation(runwieldSessionId) {
            const found = manifests.resolve(runwieldSessionId);
            if (!found) return { activation: null, generation: null };
            let manifest = found.manifest;
            if (manifest.activation.state === "active" || manifest.activation.pendingMigration) {
                const sessionDir = sessionDirForManifestPath(found.path);
                const file = openNativeFileLock(lockPath(sessionDir, manifest.runwieldSessionId));
                try {
                    if (file.tryLockSync(true)) {
                        try {
                            manifest = readJson<FileSessionManifest>(found.path);
                            markRecoveryAfterAbandonedWriter(manifest, isoNow(options.now));
                            manifests.write(manifest, found.path);
                        } finally {
                            file.unlockSync();
                        }
                    }
                } finally {
                    file.close();
                }
            }
            return { activation: activationView(manifest), generation: generationView(manifest) };
        },

        acquireSessionActivation(activationOptions) {
            const found = manifests.resolve(activationOptions.runwieldSessionId, activationOptions.projectId);
            if (!found) throw new Error("Session identity is unavailable");
            const sessionDir = sessionDirForManifestPath(found.path);
            ensurePrivateDir(bundleDir(sessionDir, found.manifest.runwieldSessionId));
            const file = openNativeFileLock(lockPath(sessionDir, found.manifest.runwieldSessionId));
            if (!file.tryLockSync(true)) {
                file.close();
                throw new Error("Session is open in another RunWield surface");
            }
            const operationId =
                activationOptions.operationId ||
                (activationOptions.idFactory ? activationOptions.idFactory() : crypto.randomUUID());
            try {
                const manifest = readJson<FileSessionManifest>(found.path);
                const now = isoNow(activationOptions.now || options.now);
                markRecoveryAfterAbandonedWriter(manifest, now);
                if (
                    ["idle", "uninitialized"].includes(manifest.activation.state) &&
                    !committedTranscriptMatches(manifest)
                ) {
                    manifest.activation = {
                        ...idleActivation(manifest),
                        state: "reconcile_required",
                        blockedReason: "committed_transcript_evidence_changed",
                    };
                }
                if (["uncertain", "reconcile_required"].includes(manifest.activation.state)) {
                    manifests.write(manifest, found.path);
                    throw new Error(`Session requires recovery: ${manifest.activation.blockedReason || "unknown"}`);
                }
                const latestGeneration = manifest.generation?.generation ?? null;
                const expectedGeneration =
                    activationOptions.expectedGeneration === undefined
                        ? latestGeneration
                        : activationOptions.expectedGeneration;
                const expectedSegment =
                    activationOptions.expectedCurrentSegmentId === undefined
                        ? manifest.currentSegmentId
                        : activationOptions.expectedCurrentSegmentId;
                if (expectedGeneration !== latestGeneration) {
                    throw new Error("Session generation changed; refresh and retry");
                }
                if (expectedSegment !== manifest.currentSegmentId) {
                    throw new Error("Session segment changed; refresh and retry");
                }
                const phase = activationOptions.phase || "preparing";
                const bootstrap = manifest.activation.state === "uninitialized" && latestGeneration === null;
                if (!bootstrap && manifest.activation.state !== "idle") {
                    throw new Error("Session is not available for writing");
                }
                const current = manifest.segments.find((segment) => segment.segmentId === manifest.currentSegmentId);
                if (!current) throw new Error("Session transcript is unavailable");
                const baselineBytes = readFileSync(current.transcriptPath);
                manifest.fence += 1;
                manifest.activation = {
                    state: "active",
                    phase,
                    ownerInstanceId: activationOptions.ownerInstanceId,
                    ownerProcessKind: activationOptions.ownerProcessKind,
                    operationId,
                    expectedGeneration,
                    expectedCurrentSegmentId: expectedSegment,
                    acquiredAt: now,
                    blockedReason: null,
                    baselineByteLength: baselineBytes.byteLength,
                    baselineDigestHex: createHash("sha256").update(baselineBytes).digest("hex"),
                };
                manifests.write(manifest, found.path);
                const proof: FileActivationProof = {
                    runwieldSessionId: manifest.runwieldSessionId,
                    projectId: manifest.projectId,
                    ownerInstanceId: activationOptions.ownerInstanceId,
                    ownerProcessKind: activationOptions.ownerProcessKind,
                    operationId,
                    fence: manifest.fence,
                    phase,
                    expectedGeneration,
                    expectedCurrentSegmentId: expectedSegment,
                };
                locks.set(operationId, { file, manifestPath: found.path });
                return proof;
            } catch (error) {
                try {
                    file.unlockSync();
                } finally {
                    file.close();
                }
                throw error;
            }
        },

        changeSessionActivationPhase(proof, nextPhase) {
            const legal = new Set([
                "bootstrap:checkpointing",
                "preparing:hydrated",
                "hydrated:turning",
                "hydrated:checkpointing",
                "turning:checkpointing",
            ]);
            if (!legal.has(`${proof.phase}:${nextPhase}`)) {
                throw new Error(`Illegal Session writer phase transition: ${proof.phase} -> ${nextPhase}`);
            }
            const held = requireHeldLock(locks, proof);
            const manifest = readJson<FileSessionManifest>(held.manifestPath);
            assertProof(manifest, proof);
            manifest.activation.phase = nextPhase;
            manifests.write(manifest, held.manifestPath);
            return { ...proof, phase: nextPhase };
        },

        registerSessionArtifact(proof, artifactOptions) {
            const held = requireHeldLock(locks, proof);
            const manifest = readJson<FileSessionManifest>(held.manifestPath);
            assertProof(manifest, proof);
            const artifacts = manifest.artifacts || [];
            const existing = artifacts.find(
                (artifact) => artifact.kind === artifactOptions.kind && artifact.path === artifactOptions.path,
            );
            if (existing) return { ...existing };
            const artifact: SessionArtifactReference = {
                artifactId: artifactOptions.idFactory ? artifactOptions.idFactory() : crypto.randomUUID(),
                kind: artifactOptions.kind,
                path: artifactOptions.path,
                title: artifactOptions.title,
                registeredAt: isoNow(artifactOptions.now || options.now),
                registeredBy: artifactOptions.registeredBy,
                sourceSegmentId: artifactOptions.sourceSegmentId ?? manifest.currentSegmentId,
            };
            manifest.artifacts = [...artifacts, artifact];
            manifests.write(manifest, held.manifestPath);
            refreshLocalProject(manifest);
            return { ...artifact };
        },

        stagePlanAssociation(proof, entry) {
            const held = requireHeldLock(locks, proof);
            const manifest = readJson<FileSessionManifest>(held.manifestPath);
            assertProof(manifest, proof);
            const association: ManifestPlanAssociation = { ...entry, committedGeneration: null };
            manifest.planAssociations = [...(manifest.planAssociations || []), association];
            manifests.write(manifest, held.manifestPath);
            return { ...association };
        },

        recordLastPlanReview(proof, review) {
            const held = requireHeldLock(locks, proof);
            const manifest = readJson<FileSessionManifest>(held.manifestPath);
            assertProof(manifest, proof);
            if (!review.planId?.trim() || !review.planName?.trim() || !review.planningAgentName?.trim()) {
                throw new Error("Plan review requires a Plan ID, name, and planning Agent");
            }
            const reference = {
                planId: review.planId,
                planName: review.planName,
                planningAgentName: review.planningAgentName,
                requestedAt: isoNow(options.now),
            };
            manifest.lastPlanReview = reference;
            manifests.write(manifest, held.manifestPath);
            return { ...reference };
        },

        publishGenerationAndRelease(proof, evidence) {
            const held = requireHeldLock(locks, proof);
            try {
                const manifest = readJson<FileSessionManifest>(held.manifestPath);
                assertProof(manifest, proof);
                if (proof.phase !== "checkpointing") throw new Error("Session publication requires checkpointing");
                const expected = manifest.generation ? manifest.generation.generation + 1 : 0;
                if (evidence.generation !== expected) throw new Error(`Session generation must advance to ${expected}`);
                const currentSegmentId = evidence.currentSegmentId || proof.expectedCurrentSegmentId;
                if (currentSegmentId !== manifest.currentSegmentId) {
                    throw new Error("Current segment proof was rejected");
                }
                const now = isoNow(options.now);
                manifest.generation = {
                    runwieldSessionId: manifest.runwieldSessionId,
                    projectId: manifest.projectId,
                    generation: evidence.generation,
                    evidenceVersion: evidence.evidenceVersion || 1,
                    digestAlgorithm: evidence.digestAlgorithm || "sha256",
                    byteLength: evidence.byteLength,
                    terminalEntryId: evidence.terminalEntryId ?? null,
                    digestHex: evidence.digestHex,
                    operationId: proof.operationId,
                    fence: proof.fence,
                    currentSegmentId: manifest.currentSegmentId,
                    committedAt: now,
                };
                manifest.activation = idleActivation(manifest);
                stampPendingPlanAssociations(manifest, evidence.generation);
                manifests.write(manifest, held.manifestPath);
                refreshLocalProject(manifest);
                return { activation: activationView(manifest), generation: generationView(manifest) };
            } finally {
                releaseHeldLock(locks, proof);
            }
        },

        releaseUnchangedActivation(proof) {
            const held = requireHeldLock(locks, proof);
            try {
                const manifest = readJson<FileSessionManifest>(held.manifestPath);
                assertProof(manifest, proof);
                reconcilePendingTranscriptMigration(manifest, isoNow(options.now));
                manifest.activation = idleActivation(manifest);
                dropPendingPlanAssociations(manifest);
                manifests.write(manifest, held.manifestPath);
                return { activation: activationView(manifest), generation: generationView(manifest) };
            } finally {
                releaseHeldLock(locks, proof);
            }
        },

        recoverSessionControl(recoveryOptions) {
            const found = manifests.resolve(recoveryOptions.runwieldSessionId, recoveryOptions.projectId);
            if (!found) throw new Error("Session identity is unavailable");
            const sessionDir = sessionDirForManifestPath(found.path);
            const file = openNativeFileLock(lockPath(sessionDir, found.manifest.runwieldSessionId));
            if (!file.tryLockSync(true)) {
                file.close();
                throw new Error("Session is still open in another RunWield surface");
            }
            try {
                const manifest = readJson<FileSessionManifest>(found.path);
                if (manifest.fence !== recoveryOptions.expectedFence) {
                    throw new Error("Session recovery information changed; refresh and retry");
                }
                if ((manifest.generation?.generation ?? null) !== recoveryOptions.expectedGeneration) {
                    throw new Error("Session recovery generation changed; refresh and retry");
                }
                const expectedSegment = recoveryOptions.expectedCurrentSegmentId ?? manifest.currentSegmentId;
                if (expectedSegment !== manifest.currentSegmentId) {
                    throw new Error("Session recovery segment changed; refresh and retry");
                }
                let evidence = recoveryOptions.transcriptEvidence;
                const current = manifest.segments.find((segment) => segment.segmentId === manifest.currentSegmentId);
                if (!current) throw new Error("Session recovery transcript is unavailable");
                const bytes = readFileSync(current.transcriptPath);
                if (recoveryOptions.expectedGeneration === null) {
                    const baselineByteLength = manifest.activation.baselineByteLength;
                    const baselineDigestHex = manifest.activation.baselineDigestHex;
                    if (baselineByteLength === null || baselineByteLength === undefined || !baselineDigestHex) {
                        throw new Error("Initial Session recovery baseline is unavailable");
                    }
                    const baselineBytes = bytes.subarray(0, baselineByteLength);
                    if (
                        baselineBytes.byteLength !== baselineByteLength ||
                        createHash("sha256").update(baselineBytes).digest("hex") !== baselineDigestHex
                    ) {
                        throw new Error("Initial Session recovery baseline changed; recovery is blocked");
                    }
                } else {
                    const committed = manifest.generation;
                    if (!committed || bytes.byteLength < committed.byteLength) {
                        throw new Error("Committed Session recovery baseline is unavailable");
                    }
                    const committedBytes = bytes.subarray(0, committed.byteLength);
                    if (createHash("sha256").update(committedBytes).digest("hex") !== committed.digestHex) {
                        throw new Error("Committed Session recovery baseline changed; recovery is blocked");
                    }
                }
                if (
                    bytes.byteLength !== evidence.byteLength ||
                    createHash("sha256").update(bytes).digest("hex") !== evidence.digestHex
                ) {
                    throw new Error("Session recovery transcript changed; refresh and retry");
                }
                if (bytes.at(-1) !== 10) {
                    const recovered = inspectRecoverableSessionTranscript(bytes);
                    const retained = new TextEncoder().encode(recovered.contents);
                    const baselineLength =
                        manifest.generation?.byteLength ?? manifest.activation.baselineByteLength ?? 0;
                    if (retained.length < baselineLength) {
                        throw new Error("Recovery cannot discard saved baseline bytes");
                    }
                    writeTextAtomically(current.transcriptPath, recovered.contents);
                    evidence = {
                        byteLength: retained.length,
                        digestHex: createHash("sha256").update(retained).digest("hex"),
                        terminalEntryId: recovered.terminalEntryId,
                    };
                }
                const now = isoNow(recoveryOptions.now || options.now);
                const generation =
                    recoveryOptions.expectedGeneration === null ? 0 : recoveryOptions.expectedGeneration + 1;
                manifest.fence += 1;
                manifest.generation = {
                    runwieldSessionId: manifest.runwieldSessionId,
                    projectId: manifest.projectId,
                    generation,
                    evidenceVersion: evidence.evidenceVersion || 1,
                    digestAlgorithm: evidence.digestAlgorithm || "sha256",
                    byteLength: evidence.byteLength,
                    terminalEntryId: evidence.terminalEntryId ?? null,
                    digestHex: evidence.digestHex,
                    operationId: recoveryOptions.operationId || crypto.randomUUID(),
                    fence: manifest.fence,
                    currentSegmentId: manifest.currentSegmentId,
                    committedAt: now,
                };
                manifest.activation = idleActivation(manifest);
                stampPendingPlanAssociations(manifest, generation);
                manifests.write(manifest, found.path);
                return { activation: activationView(manifest), generation: generationView(manifest) };
            } finally {
                file.unlockSync();
                file.close();
            }
        },

        markSessionReconcileRequired(session, reconciliationOptions = {}) {
            const found = manifests.resolve(session.runwieldSessionId, session.projectId);
            if (!found) throw new Error("Session identity is unavailable");
            const sessionDir = sessionDirForManifestPath(found.path);
            const file = openNativeFileLock(lockPath(sessionDir, found.manifest.runwieldSessionId));
            if (!file.tryLockSync(true)) {
                file.close();
                throw new Error("Session is open in another RunWield surface");
            }
            try {
                const manifest = readJson<FileSessionManifest>(found.path);
                manifest.activation = {
                    ...idleActivation(manifest),
                    state: "reconcile_required",
                    blockedReason: reconciliationOptions.reason || "transcript_evidence_changed",
                };
                dropPendingPlanAssociations(manifest);
                manifests.write(manifest, found.path);
                return { activation: activationView(manifest), generation: generationView(manifest) };
            } finally {
                file.unlockSync();
                file.close();
            }
        },

        markSessionUncertain(proof, uncertaintyOptions = {}) {
            const held = requireHeldLock(locks, proof);
            try {
                const manifest = readJson<FileSessionManifest>(held.manifestPath);
                assertProof(manifest, proof);
                reconcilePendingTranscriptMigration(manifest, isoNow(options.now));
                const baselineByteLength = manifest.activation.baselineByteLength;
                const baselineDigestHex = manifest.activation.baselineDigestHex;
                manifest.activation = {
                    ...idleActivation(manifest),
                    state: "uncertain",
                    blockedReason: uncertaintyOptions.reason || "writer_interrupted",
                    baselineByteLength,
                    baselineDigestHex,
                };
                dropPendingPlanAssociations(manifest);
                manifests.write(manifest, held.manifestPath);
                return { activation: activationView(manifest), generation: generationView(manifest) };
            } finally {
                releaseHeldLock(locks, proof);
            }
        },

        markSessionReconcileRequiredWithProof(proof, reconciliationOptions = {}) {
            const held = requireHeldLock(locks, proof);
            try {
                const manifest = readJson<FileSessionManifest>(held.manifestPath);
                assertProof(manifest, proof);
                reconcilePendingTranscriptMigration(manifest, isoNow(options.now));
                const baselineByteLength = manifest.activation.baselineByteLength;
                const baselineDigestHex = manifest.activation.baselineDigestHex;
                manifest.activation = {
                    ...idleActivation(manifest),
                    state: "reconcile_required",
                    blockedReason: reconciliationOptions.reason || "transcript_evidence_changed",
                    baselineByteLength,
                    baselineDigestHex,
                };
                dropPendingPlanAssociations(manifest);
                manifests.write(manifest, held.manifestPath);
                return { activation: activationView(manifest), generation: generationView(manifest) };
            } finally {
                releaseHeldLock(locks, proof);
            }
        },

        commitSegmentRolloverAndPublish(proof, rolloverOptions) {
            const held = requireHeldLock(locks, proof);
            let successorProof: FileActivationProof | undefined;
            try {
                const manifest = readJson<FileSessionManifest>(held.manifestPath);
                assertProof(manifest, proof);
                if (proof.phase !== "checkpointing") throw new Error("Segment rollover requires checkpointing");
                const predecessor = manifest.segments.find(
                    (segment) => segment.segmentId === rolloverOptions.predecessorSegmentId,
                );
                if (!predecessor || predecessor.segmentId !== manifest.currentSegmentId) {
                    throw new Error("Rollover predecessor is not current");
                }
                const supplied = rolloverOptions.predecessorEvidence;
                const bytes = readFileSync(predecessor.transcriptPath);
                if (
                    bytes.byteLength !== supplied.byteLength ||
                    createHash("sha256").update(bytes).digest("hex") !== supplied.digestHex
                ) {
                    throw new Error("Rollover predecessor evidence changed");
                }
                const now = isoNow(rolloverOptions.now || options.now);
                predecessor.sealedAt = now;
                predecessor.sealedByteLength = supplied.byteLength;
                predecessor.sealedDigestHex = supplied.digestHex;
                predecessor.sealedTerminalEntryId = supplied.terminalEntryId ?? null;
                predecessor.lastCatalogedAt = now;
                const successorOptions = rolloverOptions.successor;
                const safe = rolloverOptions.successorSafeLocator;
                const successor = {
                    segmentId: successorOptions.idFactory ? successorOptions.idFactory() : crypto.randomUUID(),
                    runwieldSessionId: manifest.runwieldSessionId,
                    projectId: manifest.projectId,
                    piSessionId: safe.piSessionId,
                    transcriptPath: safe.sessionPath,
                    transcriptCwd: safe.headerCwd,
                    ordinal: manifest.segments.length,
                    kind: successorOptions.kind,
                    sealedAt: null,
                    headerVersion: safe.headerVersion,
                    headerTimestamp: safe.headerTimestamp,
                    firstCatalogedAt: now,
                    lastCatalogedAt: now,
                    lineageParentSegmentId: successorOptions.lineageParentSegmentId ?? null,
                    lineageParentPiSessionId: successorOptions.lineageParentPiSessionId ?? null,
                    lineageGroupKey: successorOptions.lineageGroupKey ?? null,
                    lineageRecordedAt: now,
                    sealedByteLength: null,
                    sealedDigestHex: null,
                    sealedTerminalEntryId: null,
                };
                if (manifest.segments.some((segment) => segment.segmentId === successor.segmentId)) {
                    throw new Error("Successor segment identity already exists");
                }
                manifest.segments.push(successor);
                manifest.currentSegmentId = successor.segmentId;
                const evidence = rolloverOptions.generationEvidence;
                const expected = manifest.generation ? manifest.generation.generation + 1 : 0;
                if (evidence.generation !== expected) throw new Error(`Session generation must advance to ${expected}`);
                manifest.generation = {
                    runwieldSessionId: manifest.runwieldSessionId,
                    projectId: manifest.projectId,
                    generation: evidence.generation,
                    evidenceVersion: evidence.evidenceVersion || 1,
                    digestAlgorithm: evidence.digestAlgorithm || "sha256",
                    byteLength: evidence.byteLength,
                    terminalEntryId: evidence.terminalEntryId ?? null,
                    digestHex: evidence.digestHex,
                    operationId: proof.operationId,
                    fence: proof.fence,
                    currentSegmentId: successor.segmentId,
                    committedAt: now,
                };
                manifest.activation = idleActivation(manifest);
                if (rolloverOptions.retainActivation) {
                    const operationId = crypto.randomUUID();
                    manifest.fence += 1;
                    manifest.activation = {
                        state: "active",
                        phase: "preparing",
                        ownerInstanceId: proof.ownerInstanceId,
                        ownerProcessKind: proof.ownerProcessKind,
                        operationId,
                        expectedGeneration: evidence.generation,
                        expectedCurrentSegmentId: successor.segmentId,
                        acquiredAt: now,
                        blockedReason: null,
                        baselineByteLength: evidence.byteLength,
                        baselineDigestHex: evidence.digestHex,
                    };
                    successorProof = {
                        ...proof,
                        operationId,
                        fence: manifest.fence,
                        phase: "preparing",
                        expectedGeneration: evidence.generation,
                        expectedCurrentSegmentId: successor.segmentId,
                    };
                }
                stampPendingPlanAssociations(manifest, evidence.generation);
                manifests.write(manifest, held.manifestPath);
                refreshLocalProject(manifest);
                if (successorProof) {
                    // Re-key the same native handle. Never unlock or reopen it during the transfer.
                    locks.set(successorProof.operationId, held);
                    locks.delete(proof.operationId);
                }
                return {
                    ...(successorProof ? { successorProof } : {}),
                    predecessor: { ...predecessor },
                    successor: { ...successor },
                    activation: activationView(manifest),
                    generation: generationView(manifest),
                };
            } finally {
                if (!successorProof || locks.has(proof.operationId)) releaseHeldLock(locks, proof);
            }
        },
    };
}
