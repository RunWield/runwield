import { readFileSync } from "node:fs";
import {
    CURRENT_SESSION_VERSION,
    migrateSessionEntries,
    SessionManager,
    type FileEntry,
    type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { readSessionImageAttachment, saveImageAttachment } from "./image-attachments.ts";
import { type ImageAttachment } from "./types.js";
import { rollSessionTranscriptSegment } from "./segment-rollover.ts";
import {
    type FileActivationProof,
    type FileSessionStore,
    type ProcessKind,
    type TranscriptEvidence,
} from "./file-session-store-types.ts";
import {
    inspectRecoverableSessionTranscript,
    parseRemoteSessionTranscript,
    type RemoteSessionRequest,
    type RemoteSessionResponse,
    sessionDigest,
    validateSessionRequest,
} from "../remote/session-protocol.ts";

interface SaveReceipt {
    payload: string;
    response: RemoteSessionResponse;
}

/**
 * Laptop-only operation owner. Proofs come from trusted local activation, never from HTTP.
 * A new owner/operation is required after checkpoint or uncertainty; remote state is discarded.
 */
export class RemoteSessionOwner {
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
            if (input.kind === "attachment") {
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
            } else if (input.kind === "uncertain") {
                this.#store.markSessionUncertain(this.#proof, { reason: "remote_save_uncertain" });
                this.#settled = true;
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
export function recoverRemoteSession(
    store: FileSessionStore,
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
