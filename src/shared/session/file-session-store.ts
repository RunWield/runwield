import { CURRENT_SESSION_VERSION, migrateSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";
import type { FileEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { readSessionImageAttachment, saveImageAttachment } from "./image-attachments.ts";
import type { ImageAttachment } from "./types.js";
import { rollSessionTranscriptSegment } from "./segment-rollover.ts";
import type {
    FileActivationProof,
    ProcessKind,
    TranscriptEvidence,
    PlanAssociation,
} from "./file-session-store-types.ts";
import type { RemoteArtifactOptions, RemotePlanReview } from "../remote/session-protocol.ts";
import { readExecutionWorkflowSnapshot } from "./execution-workflow-session.ts";
import { readPersistedTutorialContext } from "./tutorial-context-session.ts";
import { readPersistedWorkflowContext } from "./workflow-context-session.js";
import { findProject, sessionDirForProject } from "./file-session-storage.ts";
import type { ManagedSessionMetadata } from "./hosted-session.js";
import type { RemoteRolloverOptions, RemoteRolloverReceipt } from "../remote/session-protocol.ts";
import { projectRemoteSessionRecords } from "../remote/session-records.ts";
import { normalizePlanAssociation } from "./plan-association.ts";
import {
    inspectRecoverableSessionTranscript,
    parseRemoteSessionTranscript,
    type RemoteSessionRequest,
    type RemoteSessionResponse,
    sessionDigest,
    validateSessionRequest,
} from "../remote/session-protocol.ts";

import { type LocalFileSessionStore, openLocalFileSessionStore } from "./file-session-store-local.ts";
import type { FileSessionStore, OpenFileSessionStoreOptions } from "./file-session-store-types.ts";

export type { FileSessionProject, FileSessionStore } from "./file-session-store-types.ts";
export type { SessionSegmentLineageEvidence } from "./file-session-store-types.ts";
export { FILE_SESSION_STORE_VERSION } from "./file-session-storage.ts";

interface RemoteOperation {
    owner: RemoteSessionOwner;
    store: FileSessionStore;
}
const remoteOperations = new Map<string, RemoteOperation>();

/** Resolve only an operation constructed by the native file store in this process. */
export function getRemoteSessionOwner(operation: string): RemoteSessionOwner {
    const owner = remoteOperations.get(operation)?.owner;
    if (!owner) throw new Error("Stale Session operation");
    return owner;
}

/** Revoke a trusted registration, releasing native locks even if durable uncertainty cannot be recorded. */
export function releaseRemoteSessionOperation(operation: string): void {
    const record = remoteOperations.get(operation);
    if (!record) return;
    try {
        record.owner.markUncertain();
    } finally {
        remoteOperations.delete(operation);
    }
}

/** Construct the real local store and remote owners together, sharing its native lock context. */
export function openFileSessionStore(options: OpenFileSessionStoreOptions = {}): FileSessionStore {
    const local = openLocalFileSessionStore(options);
    const closeLocal = local.close;
    const store: FileSessionStore = Object.assign(local, {
        close() {
            for (const [operation, record] of remoteOperations) {
                if (record.store === store) remoteOperations.delete(operation);
            }
            closeLocal();
        },
        createRemoteSessionOwner(proof: FileActivationProof) {
            const owner = new RemoteSessionOwner(store, proof);
            Object.freeze(owner);
            remoteOperations.set(owner.operation, { owner, store });
            return owner;
        },
        recoverRemoteSession(sessionId: string, ownerInstanceId: string, ownerProcessKind?: ProcessKind) {
            recoverRemoteSession(store, sessionId, ownerInstanceId, ownerProcessKind);
        },
    });
    return Object.freeze(store);
}

// Only the store can construct operation owners with its held native locks.
export type { RemoteSessionOwner };

interface SaveReceipt {
    payload: string;
    response: RemoteSessionResponse;
}

/**
 * Laptop-only operation owner. Proofs come from trusted local activation, never from HTTP.
 * A new owner/operation is required after checkpoint or uncertainty; remote state is discarded.
 */
class RemoteSessionOwner {
    readonly operation = crypto.randomUUID();
    #store: FileSessionStore;
    #proof: FileActivationProof;
    #contents: string;
    #transcriptPath: string;
    #header: SessionHeader;
    #next = 0;
    #receipts = new Map<number, SaveReceipt>();
    #settled = false;
    #hydrated = false;
    #failure: Error | null = null;

    constructor(store: FileSessionStore, proof: FileActivationProof) {
        this.#store = store;
        this.#proof = { ...proof };
        if (proof.phase !== "preparing") throw new Error("Remote Session owner requires preparing phase");
        this.#contents = store.readActiveSessionTranscript(this.#proof);
        const segment = store.getCurrentSessionSegment(proof.runwieldSessionId);
        if (!segment) throw new Error("Session transcript is unavailable");
        this.#transcriptPath = segment.transcriptPath;
        if (CURRENT_SESSION_VERSION !== 3) throw new Error("Incompatible Pi Session format");
        const supplied: FileEntry[] = this.#contents
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line));
        const header = supplied[0];
        if (
            !header ||
            header.type !== "session" ||
            (header.version !== undefined && ![1, 2, 3].includes(header.version))
        ) {
            throw new Error("Invalid laptop Session header");
        }
        const before = JSON.stringify(supplied);
        migrateSessionEntries(supplied);
        const migrated = supplied.map((entry) => `${JSON.stringify(entry)}\n`).join("");
        const entries = parseRemoteSessionTranscript(migrated);
        if (before !== JSON.stringify(supplied)) {
            this.#proof = store.migrateActiveSessionTranscript(this.#proof, migrated, sessionDigest(this.#contents));
            this.#contents = migrated;
        }
        this.#header = entries[0] as SessionHeader;
        const manager = SessionManager.inMemory(this.#header.cwd, undefined, structuredClone(entries));
        if (JSON.stringify([manager.getHeader(), ...manager.getEntries()]) !== JSON.stringify(entries)) {
            throw new Error("Incompatible Pi Session hydration contract");
        }
    }

    inspect(): RemoteSessionResponse {
        const contents = this.#settled
            ? readFileSync(this.#transcriptPath, "utf8")
            : this.#store.readActiveSessionTranscript(this.#proof);
        const entries = parseRemoteSessionTranscript(contents);
        const last = entries.at(-1);
        return {
            operation: this.operation,
            sequence: this.#next,
            contents,
            evidence: {
                byteLength: new TextEncoder().encode(contents).length,
                digestHex: sessionDigest(contents),
                terminalEntryId: last?.type === "session" ? null : (last?.id ?? null),
            },
        };
    }

    /** Execute in HTTP arrival order. This synchronous method cannot interleave two admissions. */
    handle(input: RemoteSessionRequest): RemoteSessionResponse {
        validateSessionRequest(input);
        if (input.kind === "rollover") throw new Error("Rollover requires asynchronous laptop admission");
        if (input.operation !== this.operation || this.#settled) throw new Error("Stale Session operation");
        if (this.#failure) throw this.#failure;
        // Reassert both native-lock ownership and server-owned proof even for retries.
        const current = this.#store.readActiveSessionTranscript(this.#proof);
        if (current !== this.#contents) throw new Error("Session transcript evidence changed");
        const payload = JSON.stringify(input);
        const prior = this.#receipts.get(input.sequence);
        if (prior) {
            if (prior.payload !== payload) throw new Error("Conflicting Session request identity");
            return structuredClone(prior.response);
        }
        if (input.sequence !== this.#next) throw new Error("Out-of-order Session request");
        if (!this.#hydrated && input.kind !== "hydrate" && input.kind !== "uncertain") {
            throw new Error("Remote Session has not been hydrated");
        }
        let contents = current;
        let attachment = "";
        if (input.kind === "hydrate") {
            if (this.#hydrated) throw new Error("Remote Session is already hydrated");
        } else if (input.kind === "append" || input.kind === "rewrite") {
            contents = input.kind === "append" ? current + input.contents : input.contents;
            const entries = parseRemoteSessionTranscript(contents);
            if (JSON.stringify(entries[0]) !== JSON.stringify(this.#header)) throw new Error("Session header changed");
            if (input.kind === "append" && input.contents.trimEnd().split("\n").length !== 1) {
                throw new Error("Session append must contain exactly one entry");
            }
            if (input.kind === "rewrite" && contents !== current) {
                // Pi 1.0.0 uses append-only context edits; uncaptured history replacement fails closed.
                throw new Error("Remote Session history replacement requires a laptop lifecycle operation");
            }
        }
        let evidence: TranscriptEvidence;
        try {
            if (input.kind === "artifact") {
                const options: RemoteArtifactOptions = JSON.parse(input.contents);
                if (
                    !options ||
                    !["plan", "prd", "adr", "work-record", "epic-artifact", "report"].includes(options.kind) ||
                    ![options.path, options.title, options.registeredBy].every(
                        (value) => typeof value === "string" && value.length > 0,
                    ) ||
                    Object.keys(options).some(
                        (key) => !["kind", "path", "title", "registeredBy", "sourceSegmentId"].includes(key),
                    )
                ) {
                    throw new Error("Invalid Session artifact");
                }
                attachment = JSON.stringify(this.#store.registerSessionArtifact(this.#proof, options));
            } else if (input.kind === "plan-association") {
                const entry: PlanAssociation = JSON.parse(input.contents);
                const normalized = normalizePlanAssociation(entry);
                if (
                    !normalized ||
                    entry.planId !== normalized.planId ||
                    entry.planName !== normalized.planName ||
                    entry.purpose !== normalized.purpose ||
                    entry.segmentId !== normalized.segmentId ||
                    entry.segmentKind !== normalized.segmentKind ||
                    entry.recordedAt !== normalized.recordedAt ||
                    Object.keys(entry).sort().join(",") !== "planId,planName,purpose,recordedAt,segmentId,segmentKind"
                )
                    throw new Error("Invalid Plan association");
                attachment = JSON.stringify(this.#store.stagePlanAssociation(this.#proof, normalized));
            } else if (input.kind === "plan-review") {
                const review: RemotePlanReview = JSON.parse(input.contents);
                if (
                    !review ||
                    Object.keys(review).sort().join(",") !== "planId,planName,planningAgentName" ||
                    ![review.planId, review.planName, review.planningAgentName].every(
                        (value) => typeof value === "string" && value.trim(),
                    )
                ) {
                    throw new Error("Invalid Plan review");
                }
                attachment = JSON.stringify(this.#store.recordLastPlanReview(this.#proof, review));
            } else if (input.kind === "segment") {
                attachment = JSON.stringify(
                    this.#store.getCurrentSessionSegment(this.#proof.runwieldSessionId)?.kind || "session",
                );
            } else if (input.kind === "records" || input.kind === "plan-sessions") {
                const query: import("../remote/session-protocol.ts").RemotePlanSessionQuery | undefined =
                    input.kind === "plan-sessions" ? JSON.parse(input.contents) : undefined;
                if (
                    input.kind === "plan-sessions" &&
                    (!query ||
                        !query.planId ||
                        typeof query.planId !== "string" ||
                        (query.sessionId !== undefined && typeof query.sessionId !== "string") ||
                        Object.keys(query).some((key) => !["planId", "sessionId"].includes(key)))
                )
                    throw new Error("Invalid Plan Session query");
                const records = projectRemoteSessionRecords(
                    this.#store,
                    this.#proof.runwieldSessionId,
                    this.#proof.projectId,
                    query,
                );
                attachment = JSON.stringify(records);
            } else if (input.kind === "attachment") {
                const image: ImageAttachment = JSON.parse(input.contents);
                if (
                    !image ||
                    Object.keys(image).sort().join(",") !== "base64,mimeType" ||
                    typeof image.base64 !== "string" ||
                    typeof image.mimeType !== "string"
                ) {
                    throw new Error("Invalid Session attachment");
                }
                const segment = this.#store.getCurrentSessionSegment(this.#proof.runwieldSessionId);
                if (!segment) throw new Error("Session segment is unavailable");
                const saved = saveImageAttachment(
                    image,
                    join(dirname(segment.transcriptPath), `${this.#header.id}_images`),
                );
                attachment = JSON.stringify({ base64: saved.base64, mimeType: saved.mimeType, ref: saved.ref });
            } else if (input.kind === "attachment-read") {
                attachment = JSON.stringify(
                    readSessionImageAttachment(
                        input.contents,
                        join(dirname(this.#transcriptPath), `${this.#header.id}_images`),
                    ),
                );
            }
            evidence = this.#store.writeActiveSessionTranscript(this.#proof, contents, sessionDigest(current));
        } catch (error) {
            this.#failure = error instanceof Error ? error : new Error(String(error));
            throw this.#failure;
        }
        this.#contents = contents;
        try {
            if (input.kind === "hydrate") {
                this.#proof = this.#store.changeSessionActivationPhase(this.#proof, "hydrated");
                this.#hydrated = true;
            }
            if (input.kind === "checkpoint") {
                this.#proof = this.#store.changeSessionActivationPhase(this.#proof, "checkpointing");
                this.#store.publishGenerationAndRelease(this.#proof, {
                    ...evidence,
                    generation: (this.#proof.expectedGeneration ?? -1) + 1,
                });
                this.#settled = true;
                remoteOperations.delete(this.operation);
            } else if (input.kind === "uncertain") {
                this.#store.markSessionUncertain(this.#proof, { reason: "remote_save_uncertain" });
                this.#settled = true;
                remoteOperations.delete(this.operation);
            }
        } catch (error) {
            this.#failure = error instanceof Error ? error : new Error(String(error));
            throw this.#failure;
        }
        const response: RemoteSessionResponse = {
            operation: this.operation,
            sequence: input.sequence,
            contents: ["hydrate", "inspect"].includes(input.kind) ? contents : attachment,
            evidence,
        };
        this.#receipts.set(input.sequence, { payload, response });
        this.#next++;
        return structuredClone(response);
    }

    /** Ordered save-bridge admission. No remote file locator or native proof is returned. */
    async handleRollover(input: RemoteSessionRequest) {
        validateSessionRequest(input);
        if (input.kind !== "rollover" || input.operation !== this.operation || this.#settled)
            throw new Error("Stale Session operation");
        if (this.#failure) throw this.#failure;
        if (!this.#hydrated || input.sequence !== this.#next) throw new Error("Out-of-order Session rollover");
        const options: RemoteRolloverOptions = JSON.parse(input.contents);
        if (
            !options ||
            !["execution", "semantic_repair"].includes(options.kind) ||
            !Object.hasOwn(options, "continuation") ||
            (options.transcriptCwd !== undefined &&
                (typeof options.transcriptCwd !== "string" || !isAbsolute(options.transcriptCwd))) ||
            (options.expectedGeneration !== undefined &&
                options.expectedGeneration !== null &&
                (!Number.isSafeInteger(options.expectedGeneration) || options.expectedGeneration < 0)) ||
            (options.lineageGroupKey !== undefined &&
                options.lineageGroupKey !== null &&
                typeof options.lineageGroupKey !== "string") ||
            Object.keys(options).some(
                (key) =>
                    !["kind", "transcriptCwd", "continuation", "expectedGeneration", "lineageGroupKey"].includes(key),
            )
        ) {
            throw new Error("Invalid Session rollover");
        }
        if (options.expectedGeneration !== undefined && options.expectedGeneration !== this.#proof.expectedGeneration)
            throw new Error("Session generation changed; refresh and retry");
        const predecessor = this.inspect();
        const manager = SessionManager.inMemory(
            this.#header.cwd,
            undefined,
            parseRemoteSessionTranscript(this.#contents),
        );
        let managed: ManagedSessionMetadata = {
            runwieldSessionId: this.#proof.runwieldSessionId,
            projectId: this.#proof.projectId,
            piSessionId: this.#header.id,
            transcriptPath: this.#transcriptPath,
            currentSegmentId: this.#proof.expectedCurrentSegmentId || undefined,
            generation: this.#proof.expectedGeneration,
            name: null,
            activeAgent: null,
            workflowContext: readPersistedWorkflowContext(manager),
            tutorialContext: readPersistedTutorialContext(manager),
        };
        const project = findProject(this.#store.path, managed.projectId);
        if (!project?.remote) throw new Error("Remote Project identity is unavailable");
        const result = await this.rollover({
            ...options,
            successorSessionDir: sessionDirForProject(this.#store.path, project),
            retainActivation: true,
            hostedSession: {
                cwd: this.#header.cwd,
                getManagedMetadata: () => managed,
                getActiveExecutionWorkflow: () => readExecutionWorkflowSnapshot(manager)?.workflow || null,
                getTutorialContext: () => managed.tutorialContext || null,
                getRootSessionManager: () => manager,
                dehydrateManagedSession() {},
                replaceManagedTranscriptSegment() {},
                setManagedMetadata: (metadata) => {
                    managed = metadata;
                },
            },
        });
        if (!result.successorProof) throw new Error("Successor activation is unavailable");
        let successor;
        try {
            successor = this.#store.createRemoteSessionOwner(result.successorProof);
        } catch (error) {
            this.#store.markSessionUncertain(result.successorProof);
            throw error;
        }
        const { successorProof: _proof, transcriptPath: _path, ...publicResult } = result;
        const receipt: RemoteRolloverReceipt = { operation: successor.operation, result: publicResult };
        const response: RemoteSessionResponse = {
            operation: input.operation,
            sequence: input.sequence,
            contents: JSON.stringify(receipt),
            evidence: predecessor.evidence,
        };
        return { successor, response };
    }

    /** Commit successor lineage under the existing laptop lock, refusing remote saves during handoff. */
    async rollover(
        options: Omit<
            Parameters<typeof rollSessionTranscriptSegment>[0],
            "ownerCoordinationStore" | "ownerInstanceId" | "ownerProcessKind" | "operationId" | "activeProof"
        >,
    ) {
        if (this.#settled || !this.#hydrated) throw new Error("Remote Session is not active");
        if (this.#failure) throw this.#failure;
        if (this.#store.readActiveSessionTranscript(this.#proof) !== this.#contents) {
            throw new Error("Session transcript evidence changed");
        }
        this.#settled = true;
        remoteOperations.delete(this.operation);
        return await rollSessionTranscriptSegment({
            ...options,
            ownerCoordinationStore: this.#store,
            ownerInstanceId: this.#proof.ownerInstanceId,
            ownerProcessKind: this.#proof.ownerProcessKind,
            activeProof: this.#proof,
        });
    }

    checkpoint(): void {
        this.handle({ operation: this.operation, sequence: this.#next, kind: "checkpoint", contents: "" });
    }

    /** Trusted laptop lifecycle path. Recovery uses actual digest-based store APIs, with no effect replay. */
    markUncertain(): void {
        if (this.#settled) return;
        this.#store.markSessionUncertain(this.#proof, { reason: "remote_save_uncertain" });
        this.#settled = true;
        remoteOperations.delete(this.operation);
    }

    recoverUncertain(): void {
        if (!this.#settled) throw new Error("Stop the active remote operation before recovery");
        recoverRemoteSession(
            this.#store,
            this.#proof.runwieldSessionId,
            this.#proof.ownerInstanceId,
            this.#proof.ownerProcessKind,
        );
    }
}

/** Recover laptop evidence after a released or abandoned operation, without replaying effects. */
function recoverRemoteSession(
    store: LocalFileSessionStore,
    sessionId: string,
    ownerInstanceId: string,
    ownerProcessKind: ProcessKind = "tui",
): void {
    const inspected = store.inspectSessionActivation(sessionId);
    const activation = inspected.activation;
    if (!activation || !["uncertain", "reconcile_required"].includes(activation.state)) {
        throw new Error("Session is not awaiting recovery");
    }
    const segment = store.getCurrentSessionSegment(sessionId);
    if (!segment) throw new Error("Session transcript is unavailable");
    const bytes = readFileSync(segment.transcriptPath);
    const recovered = inspectRecoverableSessionTranscript(bytes);
    store.recoverSessionControl({
        runwieldSessionId: sessionId,
        projectId: segment.projectId,
        expectedFence: activation.fence,
        expectedGeneration: inspected.generation?.generation ?? null,
        expectedCurrentSegmentId: activation.currentSegmentId,
        ownerInstanceId: ownerInstanceId,
        ownerProcessKind: ownerProcessKind,
        transcriptEvidence: {
            byteLength: bytes.length,
            digestHex: sessionDigest(bytes),
            terminalEntryId: recovered.terminalEntryId,
        },
    });
}

Object.freeze(RemoteSessionOwner.prototype);
