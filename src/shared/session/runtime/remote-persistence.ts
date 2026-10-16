import type { FileEntry } from "@earendil-works/pi-coding-agent";
import type { HostedSession, ManagedSessionMetadata } from "../hosted-session.js";
import { createRemoteRootSessionManager } from "../root-session.js";
import { summarizeProjectedEntries } from "../session-transcript-projection.js";
import { RuntimeEventTypes } from "../session-runtime-events.js";
import { parseRemoteSessionTranscript, REMOTE_SESSION_IDENTITY_ENTRY } from "../../remote/session-protocol.ts";
import { RemoteSessionControl } from "../../remote/session-control-client.ts";
import type { RemoteSessionSaveBridge } from "../../remote/session-save-bridge.ts";

interface RemoteIdentity {
    projectId: string;
    currentSegmentId: string;
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
        const identityEntry = entries.find(
            (entry) => entry.type === "custom" && entry.customType === REMOTE_SESSION_IDENTITY_ENTRY,
        );
        const identity = identityEntry?.type === "custom" ? (identityEntry.data as RemoteIdentity) : null;
        if (!identity?.projectId || !identity.currentSegmentId) {
            throw new Error("Laptop Session identity is unavailable");
        }
        const summary = summarizeProjectedEntries(entries);
        return {
            runwieldSessionId: sessionId,
            projectId: identity.projectId,
            piSessionId: sessionId,
            // A remote runtime owns no transcript file locator.
            transcriptPath: "",
            currentSegmentId: identity.currentSegmentId,
            generation,
            acknowledgedGeneration: generation,
            name: summary.name,
            activeAgent: summary.activeAgent,
            model: summary.model,
            provider: summary.provider,
            thinkingLevel: summary.thinkingLevel,
            workflowContext: null,
            tutorialContext: null,
            syncState: {
                type: RuntimeEventTypes.MANAGED_SYNC_STATE_CHANGED,
                status: "current",
                localGeneration: generation,
                latestGeneration: generation,
            },
        };
    }

    async #hydrate(session: HostedSession, operation: string): Promise<RemoteHydration> {
        const bridge = this.control.openBridge(operation);
        try {
            const manager = await createRemoteRootSessionManager(session.cwd, bridge);
            return { operation, bridge, manager };
        } catch (error) {
            bridge.close();
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

    async resume(session: HostedSession, sessionId: string): Promise<void> {
        const hydrated = await this.#hydrate(session, await this.control.begin(sessionId));
        try {
            const entries = [hydrated.manager.getHeader()!, ...hydrated.manager.getEntries()];
            session.setRootSessionManager(hydrated.manager);
            session.setManagedMetadata(this.metadata(sessionId, entries, null));
            await this.control.checkpoint(hydrated.operation);
            session.dehydrateManagedSession();
            await this.synchronize(session);
        } catch (error) {
            await this.control.markUncertain(hydrated.operation).catch(() => {});
            if (!session.disposed) session.dehydrateManagedSession();
            throw error;
        } finally {
            hydrated.bridge.close();
        }
    }

    async read(sessionId: string) {
        const saved = (await this.control.list(sessionId))[0];
        if (!saved?.contents) throw new Error("Saved laptop Session evidence is unavailable");
        return { entries: parseRemoteSessionTranscript(saved.contents), summary: saved };
    }

    async synchronize(session: HostedSession) {
        const managed = session.getManagedMetadata();
        if (!managed) return;
        const saved = await this.read(managed.runwieldSessionId);
        session.setManagedMetadata(
            this.metadata(managed.runwieldSessionId, saved.entries, saved.summary.generation ?? managed.generation),
        );
    }

    async discard(sessionId: string): Promise<void> {
        const pending = this.#pending.get(sessionId);
        if (!pending) return;
        this.#pending.delete(sessionId);
        pending.bridge.close();
        await this.control.markUncertain(pending.operation);
    }
}
