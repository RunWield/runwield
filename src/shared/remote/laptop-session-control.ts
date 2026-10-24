import { readCommittedRemoteLineage } from "./committed-session.ts";
import { join } from "node:path";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import type { FileSessionManifest, FileSessionProject, FileSessionStore } from "../session/file-session-store-types.ts";
import { openFileSessionStore, type RemoteSessionOwner } from "../session/file-session-store.ts";
import { getRunWieldSessionsBaseDir } from "../session/root-session.js";
import {
    ensurePrivateDir,
    ensureRemoteProject,
    listManifests,
    listProjectsFromDisk,
    remoteProjectRoot,
    sessionDirForProject,
    writeTextAtomically,
} from "../session/file-session-storage.ts";
import { buildProjectedSessionInfo, summarizeResumableTranscript } from "../session/session-transcript-projection.js";
import {
    REMOTE_SESSION_IDENTITY_ENTRY,
    sessionDigest,
    type RemoteSessionControlRequest,
    type RemoteSessionControlResponse,
    type RemoteSessionSummary,
    validateSessionControlRequest,
} from "./session-protocol.ts";
import type { ResolvedRemoteTarget } from "./target.ts";

export interface LaptopSessionTarget {
    baseDir?: string;
    target: ResolvedRemoteTarget;
    targetLabel: string;
}
export interface SavedRemoteSession {
    summary: RemoteSessionSummary;
    targetLabel: string;
    contents: string;
    currentContents?: string;
}

/** History follows only the committed current segment's parent chain. Hydration remains segment-local. */
function savedSession(project: FileSessionProject, manifest: FileSessionManifest): SavedRemoteSession | null {
    const generation = manifest.generation;
    if (!project.remote || manifest.archivedAt || !generation) return null;
    const { entries, currentContents } = readCommittedRemoteLineage(manifest);
    const contents = entries.map((entry) => JSON.stringify(entry) + "\n").join("");
    const resumed = summarizeResumableTranscript(entries);
    const info = buildProjectedSessionInfo(entries, {
        sessionId: manifest.runwieldSessionId,
        cwd: manifest.transcriptCwd,
        transcriptPath: "",
    });
    if (!resumed.firstMessage && !info.name) return null;
    return {
        summary: {
            id: manifest.runwieldSessionId,
            name: info.name || manifest.displayName || "",
            firstMessage: resumed.firstMessage || "",
            messageCount: resumed.messageCount,
            modified: generation.committedAt,
            generation: generation.generation,
        },
        targetLabel:
            project.remote.targetLabel ||
            `${project.remote.host.user}@${project.remote.host.hostname}:${project.remote.root}`,
        contents,
        currentContents,
    };
}

interface SavedRemoteSessionScope {
    projectIds: string[];
    sessionId?: string;
}

export function listSavedRemoteSessions(
    baseDir = getRunWieldSessionsBaseDir(),
    scope?: SavedRemoteSessionScope,
): SavedRemoteSession[] {
    const saved: SavedRemoteSession[] = [];
    for (const project of listProjectsFromDisk(baseDir).filter(
        (project) => project.remote && (!scope || scope.projectIds.includes(project.projectId)),
    )) {
        for (const { manifest } of listManifests(sessionDirForProject(baseDir, project), false)) {
            if (scope?.sessionId && manifest.runwieldSessionId !== scope.sessionId) continue;
            try {
                const session = savedSession(project, manifest);
                if (session) saved.push(session);
            } catch {
                // A global history list does not invent content from damaged evidence.
            }
        }
    }
    return saved.sort((left, right) => right.summary.modified.localeCompare(left.summary.modified));
}

interface SessionAdmission {
    payload: string;
    cancelled: boolean;
    operation?: string;
}

/** Recent terminal admissions are tombstones, not replayable results. */
const MAX_SETTLED_ADMISSIONS = 1024;

/** Laptop lifecycle authority. The wire holds ids, never native proofs or file locators. */
export class LaptopSessionControl {
    readonly #ownerInstanceId = crypto.randomUUID();
    #closed = false;
    readonly #store: FileSessionStore;
    readonly #owners = new Map<string, RemoteSessionOwner>();
    readonly #rollovers = new Map<string, string>();
    #creating = new Set<string>();
    #admissions = new Map<string, SessionAdmission>();
    #operationAdmissions = new Map<string, string>();
    #settledAdmissions = new Set<string>();

    #settleAdmission(admissionId: string): void {
        const admission = this.#admissions.get(admissionId);
        if (admission?.operation) this.#operationAdmissions.delete(admission.operation);
        this.#admissions.delete(admissionId);
        this.#settledAdmissions.add(admissionId);
        if (this.#settledAdmissions.size > MAX_SETTLED_ADMISSIONS) {
            this.#settledAdmissions.delete(this.#settledAdmissions.values().next().value!);
        }
    }

    #settleOperation(operation: string): void {
        this.#owners.delete(operation);
        for (const [prior, successor] of this.#rollovers) {
            if (successor === operation) this.#rollovers.delete(prior);
        }
        const admissionId = this.#operationAdmissions.get(operation);
        if (admissionId) this.#settleAdmission(admissionId);
    }

    constructor(readonly connection: LaptopSessionTarget) {
        this.#store = openFileSessionStore({ baseDir: connection.baseDir });
    }

    handleSave(input: import("./session-protocol.ts").RemoteSessionRequest) {
        const owner = this.#owners.get(input.operation);
        if (!owner || this.#closed) throw new Error("Stale Session operation");
        if (input.kind === "rollover") return this.#rollover(input, owner);
        return owner.handle(input);
    }

    async #rollover(input: import("./session-protocol.ts").RemoteSessionRequest, owner: RemoteSessionOwner) {
        const admissionId = this.#operationAdmissions.get(input.operation);
        const { successor, response } = await owner.handleRollover(input);
        this.#owners.delete(input.operation);
        this.#operationAdmissions.delete(input.operation);
        const admission = admissionId ? this.#admissions.get(admissionId) : undefined;
        if (this.#closed || !admission || admission.cancelled) {
            successor.markUncertain();
            throw new Error("Session rollover was cancelled");
        }
        for (const [prior, current] of this.#rollovers) {
            if (current === input.operation) this.#rollovers.set(prior, successor.operation);
        }
        this.#rollovers.set(input.operation, successor.operation);
        admission.operation = successor.operation;
        this.#owners.set(successor.operation, successor);
        this.#operationAdmissions.set(successor.operation, admissionId!);
        return response;
    }

    #projectMatches(project: FileSessionProject): boolean {
        const remote = project.remote;
        const target = this.connection.target;
        return Boolean(
            remote &&
            remote.root === remoteProjectRoot(target) &&
            remote.host.hostname === target.host.hostname &&
            remote.host.user === target.host.user &&
            remote.host.port === target.host.port &&
            remote.host.hostKeyFingerprint === target.host.hostKeyFingerprint,
        );
    }

    #locate(sessionId: string) {
        for (const project of listProjectsFromDisk(this.#store.path).filter((project) =>
            this.#projectMatches(project),
        )) {
            const found = listManifests(sessionDirForProject(this.#store.path, project), false).find(
                ({ manifest }) => manifest.runwieldSessionId === sessionId,
            );
            if (found) return { project, ...found };
        }
        throw new Error("Session does not belong to this remote target");
    }

    async handle(input: RemoteSessionControlRequest): Promise<RemoteSessionControlResponse> {
        validateSessionControlRequest(input);
        if (this.#closed) throw new Error("Session connection is closed");
        const store = this.#store;
        if (input.kind === "list") {
            // A first interrupted turn can have saved entries but no published
            // generation yet. Connected discovery repairs it; offline viewing
            // remains a read of published evidence only.
            const projects = listProjectsFromDisk(store.path).filter((project) => this.#projectMatches(project));
            for (const project of projects) {
                for (const { manifest } of listManifests(sessionDirForProject(store.path, project), false)) {
                    if (manifest.generation || (input.sessionId && input.sessionId !== manifest.runwieldSessionId)) {
                        continue;
                    }
                    const state = store.inspectSessionActivation(manifest.runwieldSessionId).activation?.state;
                    if (state === "uncertain" || state === "reconcile_required") {
                        store.recoverRemoteSession(manifest.runwieldSessionId, this.#ownerInstanceId);
                    }
                }
            }
            if (input.sessionId) this.#locate(input.sessionId);
            return {
                sessions: listSavedRemoteSessions(store.path, {
                    projectIds: projects.map((project) => project.projectId),
                    sessionId: input.sessionId,
                }).map((saved) => ({
                    ...saved.summary,
                    ...(input.sessionId ? { contents: saved.contents } : {}),
                })),
            };
        }
        if (input.kind === "markUncertain" && "admissionId" in input) {
            const admission = this.#admissions.get(input.admissionId);
            if (!admission) {
                // Cancellation can arrive before the admitting HTTP request.
                this.#settleAdmission(input.admissionId);
                return {};
            }
            admission.cancelled = true;
            if (admission.operation) {
                try {
                    this.#owners.get(admission.operation)?.markUncertain();
                } finally {
                    this.#settleOperation(admission.operation);
                }
            }
            // An acquisition still in progress must release its proof when it completes.
            return {};
        }
        if (input.kind === "checkpoint" || input.kind === "markUncertain") {
            const operation =
                input.kind === "markUncertain"
                    ? this.#rollovers.get(input.operation) || input.operation
                    : input.operation;
            const owner = this.#owners.get(operation);
            if (!owner) throw new Error("Stale Session operation");
            try {
                if (input.kind === "checkpoint") owner.checkpoint();
                else owner.markUncertain();
            } catch (error) {
                owner.markUncertain();
                throw error;
            } finally {
                this.#settleOperation(operation);
            }
            return {};
        }
        const payload = JSON.stringify([input.kind, input.sessionId, input.kind === "create" ? input.name : null]);
        if (this.#settledAdmissions.has(input.admissionId)) throw new Error("Session admission is settled");
        const prior = this.#admissions.get(input.admissionId);
        if (prior) {
            if (prior.payload !== payload) throw new Error("Conflicting Session admission identity");
            if (prior.cancelled || !prior.operation) throw new Error("Session admission is not available");
            return { operation: prior.operation };
        }
        const admission: SessionAdmission = { payload, cancelled: false };
        this.#admissions.set(input.admissionId, admission);
        try {
            let proof;
            if (input.kind === "create") {
                if (this.#creating.has(input.sessionId)) throw new Error("Session creation is already running");
                this.#creating.add(input.sessionId);
                try {
                    const project = ensureRemoteProject(
                        store.path,
                        this.connection.target.host,
                        this.connection.target,
                        undefined,
                        this.connection.targetLabel,
                    );
                    const directory = sessionDirForProject(store.path, project);
                    if (
                        listManifests(directory, false).some(
                            ({ manifest }) => manifest.runwieldSessionId === input.sessionId,
                        )
                    ) {
                        throw new Error("Session already exists");
                    }
                    ensurePrivateDir(directory);
                    const timestamp = new Date().toISOString();
                    const transcriptPath = join(
                        directory,
                        `${timestamp.replace(/[:.]/g, "-")}_${input.sessionId}.jsonl`,
                    );
                    writeTextAtomically(
                        transcriptPath,
                        JSON.stringify({
                            type: "session",
                            version: CURRENT_SESSION_VERSION,
                            id: input.sessionId,
                            timestamp,
                            cwd: this.connection.target.cwd,
                        }) + "\n",
                    );
                    const acquired = await store.ensureSessionCatalogRecordAndAcquire({
                        locator: {
                            projectId: project.projectId,
                            piSessionId: input.sessionId,
                            transcriptPath,
                            transcriptCwd: this.connection.target.cwd,
                            source: "created",
                            idFactory: () => input.sessionId,
                        },
                        activation: {
                            ownerInstanceId: this.#ownerInstanceId,
                            ownerProcessKind: "tui",
                            phase: "preparing",
                        },
                    });
                    proof = acquired.proof;
                    const initial = store.readActiveSessionTranscript(proof);
                    store.writeActiveSessionTranscript(
                        proof,
                        initial +
                            JSON.stringify({
                                type: "custom",
                                id: crypto.randomUUID(),
                                parentId: null,
                                timestamp,
                                customType: REMOTE_SESSION_IDENTITY_ENTRY,
                                data: { projectId: project.projectId, currentSegmentId: acquired.segment.segmentId },
                            }) +
                            "\n",
                        sessionDigest(initial),
                    );
                } catch (error) {
                    if (proof) store.markSessionUncertain(proof, { reason: "remote_save_uncertain" });
                    throw error;
                } finally {
                    this.#creating.delete(input.sessionId);
                }
            } else {
                const { manifest } = this.#locate(input.sessionId);
                const state = store.inspectSessionActivation(input.sessionId);
                if (state.activation && ["uncertain", "reconcile_required"].includes(state.activation.state)) {
                    store.recoverRemoteSession(input.sessionId, this.#ownerInstanceId);
                }
                proof = store.acquireSessionActivation({
                    runwieldSessionId: input.sessionId,
                    projectId: manifest.projectId,
                    ownerInstanceId: this.#ownerInstanceId,
                    ownerProcessKind: "tui",
                    phase: "preparing",
                });
            }
            try {
                if (this.#closed || admission.cancelled) throw new Error("Session admission was cancelled");
                const owner = store.createRemoteSessionOwner(proof);
                this.#owners.set(owner.operation, owner);
                admission.operation = owner.operation;
                this.#operationAdmissions.set(owner.operation, input.admissionId);
                return { operation: owner.operation };
            } catch (error) {
                try {
                    store.markSessionUncertain(proof, { reason: "remote_save_uncertain" });
                } catch {
                    /* Preserve acquisition failure. */
                }
                throw error;
            }
        } finally {
            if (!admission.operation) this.#settleAdmission(input.admissionId);
        }
    }

    close(): void {
        this.#closed = true;
        for (const admission of this.#admissions.values()) admission.cancelled = true;
        try {
            for (const [operation, owner] of this.#owners) {
                try {
                    owner.markUncertain();
                } finally {
                    this.#settleOperation(operation);
                }
            }
        } finally {
            this.#store.close();
        }
    }
}
