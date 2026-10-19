import { withProjectRuntimeReadScope } from "../../project-runtime-layout.ts";
import { reconcileRemoteWorkflow } from "../workflow-context-recovery.ts";
import { isRuntimeRootSessionManager } from "./support.ts";
import { reasonForCandidate } from "../plan-session-lookup.ts";
import { restoreExecutionWorkflow } from "../execution-workflow-recovery.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readPersistedTutorialContext } from "../tutorial-context-session.ts";
import { readPersistedWorkflowContext } from "../workflow-context-session.js";
import type {
    RemotePlanSessionQuery,
    RemoteRolloverOptions,
    RemoteRolloverReceipt,
    RemoteSessionRecords,
} from "../../remote/session-protocol.ts";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import type { HostedSession, ManagedSessionMetadata } from "../hosted-session.js";
import { createRemoteRootSessionManager, getRemoteSessionSaveBridge } from "../root-session.js";
import { summarizeProjectedEntries } from "../session-transcript-projection.js";
import { RuntimeEventTypes } from "../session-runtime-events.js";
import { parseRemoteSessionTranscript, REMOTE_SESSION_IDENTITY_ENTRY } from "../../remote/session-protocol.ts";
import { RemoteSessionControl } from "../../remote/session-control-client.ts";
import type { RemoteSessionSaveBridge } from "../../remote/session-save-bridge.ts";

interface RemoteIdentity {
    projectId: string;
    currentSegmentId: string;
    piSessionId?: string;
}
interface RemoteHydration {
    operation: string;
    bridge: RemoteSessionSaveBridge;
    manager: Awaited<ReturnType<typeof createRemoteRootSessionManager>>;
}

/** File-free remote persistence, selected once when the runtime is built. */
export class RemoteSessionPersistence {
    #pending = new Map<string, RemoteHydration>();
    constructor(readonly control: RemoteSessionControl) {}

    metadata(sessionId: string, entries: FileEntry[], generation: number | null): ManagedSessionMetadata {
        const identityEntry = entries.findLast(
            (entry) => entry.type === "custom" && entry.customType === REMOTE_SESSION_IDENTITY_ENTRY,
        );
        const identity = identityEntry?.type === "custom" ? (identityEntry.data as RemoteIdentity) : null;
        if (!identity?.projectId || !identity.currentSegmentId) {
            throw new Error("Laptop Session identity is unavailable");
        }
        const summary = summarizeProjectedEntries(entries);
        const header = entries[0];
        if (header?.type !== "session") throw new Error("Session header is unavailable");
        const manager = SessionManager.inMemory(header.cwd, undefined, entries);
        return {
            runwieldSessionId: sessionId,
            projectId: identity.projectId,
            piSessionId: identity.piSessionId || header.id,
            // A remote runtime owns no transcript file locator.
            transcriptPath: "",
            currentSegmentId: identity.currentSegmentId,
            generation,
            acknowledgedGeneration: generation,
            committedSummary: summary,
            name: summary.name,
            activeAgent: summary.activeAgent,
            model: summary.model,
            provider: summary.provider,
            thinkingLevel: summary.thinkingLevel,
            workflowContext: readPersistedWorkflowContext(manager),
            tutorialContext: readPersistedTutorialContext(manager),
            syncState: {
                type: RuntimeEventTypes.MANAGED_SYNC_STATE_CHANGED,
                status: "current",
                localGeneration: generation,
                latestGeneration: generation,
            },
        };
    }

    async #hydrate(session: HostedSession, operation: string): Promise<RemoteHydration> {
        try {
            const manager = await createRemoteRootSessionManager(
                session.cwd,
                this.control.sessionConnection(operation),
            );
            return { operation, bridge: getRemoteSessionSaveBridge(manager)!, manager };
        } catch (error) {
            await this.control.markUncertain(operation).catch(() => {});
            throw error;
        }
    }

    async create(session: HostedSession, name = ""): Promise<ManagedSessionMetadata> {
        const sessionId = crypto.randomUUID();
        const hydrated = await this.#hydrate(session, await this.control.create(sessionId, name));
        try {
            if (name) hydrated.manager.appendSessionInfo(name);
            const metadata = this.metadata(
                sessionId,
                [hydrated.manager.getHeader()!, ...hydrated.manager.getEntries()],
                null,
            );
            session.setRootSessionManager(hydrated.manager);
            session.setManagedMetadata(metadata);
            this.#pending.set(session.id, hydrated);
            return metadata;
        } catch (error) {
            hydrated.bridge.close();
            await this.control.markUncertain(hydrated.operation).catch(() => {});
            throw error;
        }
    }

    async open(session: HostedSession): Promise<RemoteHydration> {
        const pending = this.#pending.get(session.id);
        if (pending) {
            this.#pending.delete(session.id);
            return pending;
        }
        const managed = session.getManagedMetadata();
        if (!managed) throw new Error("Session identity is unavailable");
        return await this.#hydrate(session, await this.control.begin(managed.runwieldSessionId));
    }

    /** Reads under the current held laptop owner, never from an optimistic write cache. */
    records(session: HostedSession, query?: RemotePlanSessionQuery): RemoteSessionRecords {
        const manager = session.getRootSessionManager();
        const bridge = isRuntimeRootSessionManager(manager) ? getRemoteSessionSaveBridge(manager) : null;
        if (!bridge) throw new Error("Remote Session records require a held owner");
        return JSON.parse(
            bridge.request(query ? "plan-sessions" : "records", query ? JSON.stringify(query) : "").contents,
        );
    }

    async readSessionRecords(session: HostedSession, query?: RemotePlanSessionQuery): Promise<RemoteSessionRecords> {
        const pending = this.#pending.get(session.id);
        if (pending)
            return JSON.parse(
                pending.bridge.request(query ? "plan-sessions" : "records", query ? JSON.stringify(query) : "")
                    .contents,
            );
        if (session.getRootSessionManager()) return this.records(session, query);
        const managed = session.getManagedMetadata();
        if (!managed) throw new Error("Session identity is unavailable");
        return await this.readRecords(managed.runwieldSessionId, query);
    }

    async readRecords(sessionId: string, query?: RemotePlanSessionQuery): Promise<RemoteSessionRecords> {
        const operation = await this.control.begin(sessionId);
        let bridge: RemoteSessionSaveBridge | null = null;
        try {
            const { RemoteSessionSaveBridge } = await import("../../remote/session-save-bridge.ts");
            bridge = new RemoteSessionSaveBridge(this.control.sessionConnection(operation));
            bridge.request("hydrate");
            const records: RemoteSessionRecords = JSON.parse(
                bridge.request(query ? "plan-sessions" : "records", query ? JSON.stringify(query) : "").contents,
            );
            await this.control.checkpoint(operation);
            // This read held the query Session's owner only until the checkpoint.
            for (const candidate of records.planSessions) {
                if (candidate.runwieldSessionId !== sessionId) continue;
                candidate.activationState = "idle";
                candidate.activeSurface = null;
                candidate.reason = reasonForCandidate("idle", candidate.currentSegmentKind, candidate.latestPurpose);
                candidate.safePlanningResume = candidate.reason === null;
            }
            return records;
        } catch (error) {
            await this.control.markUncertain(operation).catch(() => {});
            throw error;
        } finally {
            bridge?.close();
        }
    }

    async resume(session: HostedSession, sessionId: string): Promise<void> {
        const hydrated = await this.#hydrate(session, await this.control.begin(sessionId));
        try {
            const entries = [hydrated.manager.getHeader()!, ...hydrated.manager.getEntries()];
            session.setRootSessionManager(hydrated.manager);
            const records = this.records(session);
            session.setManagedMetadata({ ...this.metadata(sessionId, entries, null), remoteRecords: records });
            await withProjectRuntimeReadScope(() => restoreExecutionWorkflow(session, { persist: false }));
            await this.control.checkpoint(hydrated.operation);
            session.dehydrateManagedSession();
            await this.synchronize(session, records);
        } catch (error) {
            await this.control.markUncertain(hydrated.operation).catch(() => {});
            if (!session.disposed) session.dehydrateManagedSession();
            throw error;
        } finally {
            hydrated.bridge.close();
        }
    }

    /** Rollover callers run between managed operations. Keep the transferred laptop lock until the next one. */
    async rollover(session: HostedSession, options: RemoteRolloverOptions) {
        const managed = session.getManagedMetadata();
        if (!managed) throw new Error("Session identity is unavailable");
        const predecessor = await this.open(session);
        let successor: RemoteHydration | null = null;
        let successorOperation: string | null = null;
        try {
            const receipt: RemoteRolloverReceipt = JSON.parse(
                predecessor.bridge.request("rollover", JSON.stringify(options)).contents,
            );
            successorOperation = receipt.operation;
            successor = await this.#hydrate(session, receipt.operation);
            const entries = [successor.manager.getHeader()!, ...successor.manager.getEntries()];
            session.dehydrateManagedSession();
            session.setManagedMetadata(this.metadata(managed.runwieldSessionId, entries, receipt.result.generation));
            this.#pending.set(session.id, successor);
            return { ...receipt.result, transcriptPath: "" };
        } catch (error) {
            successor?.bridge.close();
            await this.control.markUncertain(successorOperation || predecessor.operation).catch(() => {});
            throw error;
        } finally {
            predecessor.bridge.close();
        }
    }

    async read(sessionId: string) {
        const saved = (await this.control.list(sessionId))[0];
        if (!saved?.contents) throw new Error("Saved laptop Session evidence is unavailable");
        return {
            entries: parseRemoteSessionTranscript(saved.contents),
            summary: saved,
        };
    }

    async synchronize(session: HostedSession, ownedRecords?: RemoteSessionRecords) {
        const managed = session.getManagedMetadata();
        if (!managed) return;
        const remoteRecords = ownedRecords || (await this.readSessionRecords(session));
        const saved = await this.read(managed.runwieldSessionId);
        const metadata = this.metadata(
            managed.runwieldSessionId,
            saved.entries,
            saved.summary.generation ?? managed.generation,
        );
        const workflowContext = await reconcileRemoteWorkflow(session.cwd, metadata.workflowContext);
        if (workflowContext?.validationProgress?.outcome === "verified")
            session.restoreActiveExecutionWorkflow(null, null);
        session.replaceWorkflowContext(workflowContext, { persist: false });
        session.setManagedMetadata({ ...metadata, workflowContext, remoteRecords });
    }

    async discard(sessionId: string): Promise<void> {
        const pending = this.#pending.get(sessionId);
        if (!pending) return;
        this.#pending.delete(sessionId);
        pending.bridge.close();
        await this.control.markUncertain(pending.operation);
    }
}
