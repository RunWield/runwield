/**
 * @module shared/session/file-session-activation-state
 * Writer proof, lock ownership, and abandoned-writer recovery state.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
    FileActivationProof,
    FileSessionActivation,
    FileSessionGeneration,
    FileSessionManifest,
    HeldFileLock,
} from "./file-session-store-types.ts";

export function activationView(manifest: FileSessionManifest) {
    const activation = manifest.activation;
    return {
        runwieldSessionId: manifest.runwieldSessionId,
        projectId: manifest.projectId,
        state: activation.state,
        phase: activation.phase,
        latestGeneration: manifest.generation?.generation ?? null,
        fence: manifest.fence,
        ownerInstanceId: activation.ownerInstanceId,
        ownerProcessKind: activation.ownerProcessKind,
        operationId: activation.operationId,
        expectedGeneration: activation.expectedGeneration,
        currentSegmentId: manifest.currentSegmentId,
        expectedCurrentSegmentId: activation.expectedCurrentSegmentId,
        acquiredAt: activation.acquiredAt,
        updatedAt: manifest.updatedAt,
        blockedReason: activation.blockedReason,
    };
}

export function generationView(manifest: FileSessionManifest): FileSessionGeneration | null {
    return manifest.generation ? { ...manifest.generation } : null;
}

export function assertProof(manifest: FileSessionManifest, proof: FileActivationProof): void {
    const activation = manifest.activation;
    if (
        activation.state !== "active" || manifest.fence !== proof.fence ||
        activation.ownerInstanceId !== proof.ownerInstanceId ||
        activation.ownerProcessKind !== proof.ownerProcessKind ||
        activation.operationId !== proof.operationId || activation.phase !== proof.phase ||
        activation.expectedGeneration !== proof.expectedGeneration ||
        activation.expectedCurrentSegmentId !== (proof.expectedCurrentSegmentId ?? null)
    ) {
        throw new Error("Session writer proof was rejected");
    }
}

export function idleActivation(manifest: FileSessionManifest): FileSessionActivation {
    return {
        state: manifest.generation ? "idle" : "uninitialized",
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
    };
}

export function requireHeldLock(
    locks: Map<string, HeldFileLock>,
    proof: FileActivationProof,
): HeldFileLock {
    const held = locks.get(proof.operationId);
    if (!held) throw new Error("Session writer lock is not held");
    return held;
}

export function releaseHeldLock(locks: Map<string, HeldFileLock>, proof: FileActivationProof): void {
    const held = locks.get(proof.operationId);
    if (!held) return;
    locks.delete(proof.operationId);
    try {
        held.file.unlockSync();
    } finally {
        held.file.close();
    }
}

export function markRecoveryAfterAbandonedWriter(manifest: FileSessionManifest, now: string): void {
    if (manifest.activation.state !== "active") return;
    const current = manifest.segments.find((segment) => segment.segmentId === manifest.currentSegmentId);
    if (!current) {
        manifest.activation = {
            ...idleActivation(manifest),
            state: "uncertain",
            blockedReason: "session_transcript_is_unavailable",
        };
        manifest.updatedAt = now;
        return;
    }
    if (!manifest.generation) {
        const bytes = readFileSync(current.transcriptPath);
        const baselineByteLength = manifest.activation.baselineByteLength;
        const baselineDigestHex = manifest.activation.baselineDigestHex;
        const unchanged = baselineByteLength === bytes.byteLength &&
            baselineDigestHex === createHash("sha256").update(bytes).digest("hex");
        manifest.activation = unchanged ? idleActivation(manifest) : {
            ...idleActivation(manifest),
            state: "reconcile_required",
            blockedReason: "transcript_changed_before_initial_checkpoint",
            baselineByteLength,
            baselineDigestHex,
        };
        manifest.updatedAt = now;
        return;
    }
    const bytes = readFileSync(current.transcriptPath);
    const committedBytes = bytes.subarray(0, manifest.generation.byteLength);
    const digest = createHash("sha256").update(committedBytes).digest("hex");
    if (bytes.byteLength === manifest.generation.byteLength && digest === manifest.generation.digestHex) {
        manifest.activation = idleActivation(manifest);
    } else {
        manifest.activation = {
            ...idleActivation(manifest),
            state: "reconcile_required",
            blockedReason: "transcript_changed_before_writer_checkpoint",
        };
    }
    manifest.updatedAt = now;
}

export function committedTranscriptMatches(manifest: FileSessionManifest): boolean {
    if (!manifest.generation) return true;
    const current = manifest.segments.find((segment) => segment.segmentId === manifest.currentSegmentId);
    if (!current) return false;
    try {
        const bytes = readFileSync(current.transcriptPath);
        if (bytes.byteLength !== manifest.generation.byteLength) return false;
        return createHash("sha256").update(bytes).digest("hex") === manifest.generation.digestHex;
    } catch {
        return false;
    }
}
