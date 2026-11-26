/** Host integration for registering and disposing in-process sessions. */

import { getSessionManagerId, HostedSession } from "./hosted-session.ts";
import type { ManagedSessionMetadata, MinimalSessionManagerLike } from "./hosted-session.ts";
import type { RuntimeEventDraft } from "./events.ts";

export { HostedSession };
export type {
    DisposableLike,
    HostedRuntimeEventObservation,
    HostedSessionOptions,
    ManagedSessionMetadata,
    MinimalSessionManagerLike,
    SessionManagerExtensions,
    ThinkingLevel,
} from "./hosted-session.ts";
export { emitAssistantMessage, emitHostedSessionRuntimeEvent, emitSystemStatus } from "./event-publication.ts";
export { normalizeRuntimeUsage } from "./provider-usage.ts";
export type { ProviderUsage } from "./provider-usage.ts";
export { requestHostedSessionInteraction, supportsHostedSessionInteraction } from "./interaction-broker.ts";

/** Receives producer events before the runtime adds session identity and validates them. */
export interface SessionRuntimeEventSink {
    /** Receive one event draft from a hosted session. */
    emit(event: RuntimeEventDraft): void;
}

/** Producer event destination supplied as a function or emitter. */
export type SessionHostEventSink = SessionRuntimeEventSink | SessionRuntimeEventSink["emit"];

/** Sets the ID source for sessions created without a supplied ID or manager identity. */
export interface SessionHostOptions {
    idFactory?: () => string;
}

/** Binds a live host session to a project, optional transcript, and event sink. */
export interface CreateSessionOptions {
    id?: string;
    cwd?: string;
    sessionManager?: MinimalSessionManagerLike | null;
    eventSink?: SessionHostEventSink | null;
    managed?: ManagedSessionMetadata | null;
}

/** Snapshot of a session identity currently registered with the host. */
export interface HostedSessionMetadata {
    id: string;
    cwd: string;
    sessionManagerId: string | null;
    disposed: boolean;
}

/** Owns live session identity and keeps managed sessions registered until disposal settles. */
export class SessionHost {
    readonly #idFactory: () => string;
    readonly #sessions = new Map<string, HostedSession>();
    readonly #managedSessionIds = new Map<string, string>();

    /** Create an empty registry for in-process sessions. */
    constructor(options: SessionHostOptions = {}) {
        this.#idFactory = options.idFactory || (() => crypto.randomUUID());
    }

    /** Create and register a session using an explicit ID, the manager ID, or a generated ID. */
    createSession(options: CreateSessionOptions = {}): HostedSession {
        const id = options.id || getSessionManagerId(options.sessionManager) || this.#idFactory();
        const hostedSession = new HostedSession({ ...options, id });
        return this.adoptSession(hostedSession);
    }

    /** Register an existing session and enforce one live owner per persisted managed identity. */
    adoptSession(session: HostedSession): HostedSession {
        if (!(session instanceof HostedSession)) throw new Error("SessionHost can only adopt HostedSession instances");
        if (this.#sessions.has(session.id)) throw new Error(`HostedSession "${session.id}" already exists`);
        const managed = session.getManagedMetadata?.() || null;
        if (managed) {
            const existingId = this.#managedSessionIds.get(managed.runwieldSessionId);
            if (existingId) {
                throw new Error(
                    `RunWield Session "${managed.runwieldSessionId}" already has live HostedSession "${existingId}"`,
                );
            }
            this.#managedSessionIds.set(managed.runwieldSessionId, session.id);
        }
        this.#sessions.set(session.id, session);
        return session;
    }

    /** Find a live session by host ID. */
    getSession(id: string): HostedSession | null {
        return this.#sessions.get(id) || null;
    }

    /** Find a live session or fail if its ID is absent. */
    requireSession(id: string): HostedSession {
        const session = this.getSession(id);
        if (!session) throw new Error(`HostedSession "${id}" was not found`);
        return session;
    }

    /** Read the registered identities in the order they joined the host. */
    listSessions(): HostedSessionMetadata[] {
        return Array.from(this.#sessions.values()).map((session) => ({
            id: session.id,
            cwd: session.cwd,
            sessionManagerId: getSessionManagerId(session.getRootSessionManager()),
            disposed: session.disposed,
        }));
    }

    /** Dispose a session and release its identity, including when teardown fails. */
    async disposeSession(id: string): Promise<boolean> {
        const session = this.#sessions.get(id);
        if (!session) return false;
        const managed = session.getManagedMetadata?.() || null;
        try {
            await session.dispose();
        } finally {
            this.#sessions.delete(id);
            if (managed && this.#managedSessionIds.get(managed.runwieldSessionId) === id) {
                this.#managedSessionIds.delete(managed.runwieldSessionId);
            }
        }
        return true;
    }

    /** Dispose the registered sessions in registration order. */
    async dispose(): Promise<void> {
        for (const id of Array.from(this.#sessions.keys())) await this.disposeSession(id);
    }
}
