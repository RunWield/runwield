/**
 * @module shared/session/session-host
 * Registry and lifecycle owner for in-process Hosted Sessions.
 */

import { HostedSession } from "./hosted-session.js";
import type { ManagedSessionMetadata, MinimalSessionManagerLike } from "./hosted-session.js";
import type { SessionRuntimeEvent } from "./session-runtime-events.ts";

export interface SessionRuntimeEventSink {
    emit: (event: Partial<SessionRuntimeEvent> & { type: string }) => void;
}

export type SessionHostEventSink = SessionRuntimeEventSink | SessionRuntimeEventSink["emit"];

export interface SessionHostOptions {
    idFactory?: () => string;
}

export interface CreateSessionOptions {
    id?: string;
    cwd?: string;
    sessionManager?: MinimalSessionManagerLike | null;
    eventSink?: SessionHostEventSink | null;
    managed?: ManagedSessionMetadata | null;
}

export interface HostedSessionMetadata {
    id: string;
    cwd: string;
    sessionManagerId: string | null;
    disposed: boolean;
}

function getSessionManagerId(sessionManager: MinimalSessionManagerLike | null | undefined): string | null {
    if (
        !sessionManager || typeof sessionManager !== "object" || !("getSessionId" in sessionManager) ||
        typeof sessionManager.getSessionId !== "function"
    ) {
        return null;
    }
    const id = sessionManager.getSessionId();
    return typeof id === "string" && id ? id : null;
}

function createDefaultSessionId() {
    return crypto.randomUUID();
}

export class SessionHost {
    declare idFactory: () => string;
    declare sessions: Map<string, HostedSession>;
    declare managedSessionIds: Map<string, string>;

    constructor(options: SessionHostOptions = {}) {
        this.idFactory = options.idFactory || createDefaultSessionId;
        this.sessions = new Map<string, HostedSession>();
        this.managedSessionIds = new Map<string, string>();
    }

    createSession(options: CreateSessionOptions = {}): HostedSession {
        const id = options.id || getSessionManagerId(options.sessionManager) || this.idFactory();
        const hostedSession = new HostedSession({ ...options, id });
        return this.adoptSession(hostedSession);
    }

    adoptSession(session: HostedSession): HostedSession {
        if (!(session instanceof HostedSession)) throw new Error("SessionHost can only adopt HostedSession instances");
        if (this.sessions.has(session.id)) throw new Error(`HostedSession "${session.id}" already exists`);
        const managed = session.getManagedMetadata?.() || null;
        if (managed) {
            const existingId = this.managedSessionIds.get(managed.runwieldSessionId);
            if (existingId) {
                throw new Error(
                    `RunWield Session "${managed.runwieldSessionId}" already has live HostedSession "${existingId}"`,
                );
            }
            this.managedSessionIds.set(managed.runwieldSessionId, session.id);
        }
        this.sessions.set(session.id, session);
        return session;
    }

    getSession(id: string): HostedSession | null {
        return this.sessions.get(id) || null;
    }

    requireSession(id: string): HostedSession {
        const session = this.getSession(id);
        if (!session) throw new Error(`HostedSession "${id}" was not found`);
        return session;
    }

    listSessions(): HostedSessionMetadata[] {
        return Array.from(this.sessions.values()).map((session) => ({
            id: session.id,
            cwd: session.cwd,
            sessionManagerId: getSessionManagerId(session.getRootSessionManager()),
            disposed: session.disposed,
        }));
    }

    async disposeSession(id: string): Promise<boolean> {
        const session = this.sessions.get(id);
        if (!session) return false;
        const managed = session.getManagedMetadata?.() || null;
        try {
            await session.dispose();
        } finally {
            this.sessions.delete(id);
            if (managed && this.managedSessionIds.get(managed.runwieldSessionId) === id) {
                this.managedSessionIds.delete(managed.runwieldSessionId);
            }
        }
        return true;
    }

    async dispose(): Promise<void> {
        for (const id of Array.from(this.sessions.keys())) await this.disposeSession(id);
    }
}
