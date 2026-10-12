/**
 * @module acp/session-map
 * ACP session id to SessionRuntime session-id mapping.
 */

const ACP_SESSION_PREFIX = "acp-";

export function normalizeAcpSessionIdForLoad(sessionId: string): string {
    return sessionId.startsWith(ACP_SESSION_PREFIX) ? sessionId.slice(ACP_SESSION_PREFIX.length) : sessionId;
}

export interface AcpPromptRecord {
    cancelled: boolean;
    turnId: string;
    requestId?: string;
}

export interface AcpSessionRecord {
    acpSessionId: string;
    runtimeSessionId: string;
    cwd: string;
    activePrompt: AcpPromptRecord | null;
    loaded: boolean;
    usageCostUsd: number;
    persistedSessionId?: string;
    sessionPath?: string;
}

export interface CreateAcpSessionRecordOptions {
    acpSessionId?: string;
    loaded?: boolean;
    persistedSessionId?: string;
    sessionPath?: string;
}

export interface AcpRuntimeSession {
    sessionId: string;
    cwd: string;
}

export interface AcpReplacementRuntimeSession {
    sessionId: string;
    cwd?: string;
}

export class AcpSessionMap {
    declare records: Map<string, AcpSessionRecord>;
    declare acpIdsByRuntimeSessionId: Map<string, string>;

    constructor() {
        this.records = new Map<string, AcpSessionRecord>();
        this.acpIdsByRuntimeSessionId = new Map<string, string>();
    }

    createRecord(session: AcpRuntimeSession, options: CreateAcpSessionRecordOptions = {}): AcpSessionRecord {
        const acpSessionId = options.acpSessionId ||
            `${ACP_SESSION_PREFIX}${options.persistedSessionId || session.sessionId}`;
        if (this.records.has(acpSessionId)) throw new Error(`ACP session already exists: ${acpSessionId}`);
        const record: AcpSessionRecord = {
            acpSessionId,
            runtimeSessionId: session.sessionId,
            cwd: session.cwd,
            activePrompt: null,
            loaded: Boolean(options.loaded),
            usageCostUsd: 0,
            ...(options.persistedSessionId ? { persistedSessionId: options.persistedSessionId } : {}),
            ...(options.sessionPath ? { sessionPath: options.sessionPath } : {}),
        };
        this.records.set(acpSessionId, record);
        this.acpIdsByRuntimeSessionId.set(session.sessionId, acpSessionId);
        return record;
    }

    getRecord(acpSessionId: string): AcpSessionRecord | null {
        return this.records.get(acpSessionId) || null;
    }

    listRecords(): AcpSessionRecord[] {
        return Array.from(this.records.values());
    }

    getAcpSessionIdForRuntimeSession(runtimeSessionId: string): string | null {
        return this.acpIdsByRuntimeSessionId.get(runtimeSessionId) || null;
    }

    getRuntimeSessionId(acpSessionId: string): string | null {
        return this.getRecord(acpSessionId)?.runtimeSessionId || null;
    }

    beginPrompt(
        acpSessionId: string,
        turnId: string,
        requestId: string | undefined = undefined,
    ): AcpPromptRecord | null {
        const record = this.getRecord(acpSessionId);
        if (!record) return null;
        record.activePrompt = {
            cancelled: false,
            turnId,
            ...(requestId ? { requestId } : {}),
        };
        return record.activePrompt;
    }

    /**
     * Add one usage event's cost to the Session total and return the new total.
     *
     * ACP reports `cost.amount` as the cumulative Session cost, while the Runtime
     * emits the cost of a single assistant message, so the adapter keeps the sum.
     * The total belongs to the ACP Session, so it survives Runtime replacement.
     */
    addUsageCost(acpSessionId: string, costUsd: number | null | undefined): number {
        const record = this.getRecord(acpSessionId);
        if (!record) return 0;
        if (typeof costUsd === "number" && Number.isFinite(costUsd)) record.usageCostUsd += costUsd;
        return record.usageCostUsd;
    }

    endPrompt(acpSessionId: string, prompt: AcpPromptRecord): boolean {
        const record = this.getRecord(acpSessionId);
        if (!record || record.activePrompt !== prompt) return false;
        record.activePrompt = null;
        return true;
    }

    isCurrentPrompt(acpSessionId: string, prompt: AcpPromptRecord): boolean {
        return this.getRecord(acpSessionId)?.activePrompt === prompt;
    }

    /**
     * Atomically remap a stable ACP id to a replacement Runtime session id.
     */
    replaceRuntimeSession(acpSessionId: string, session: AcpReplacementRuntimeSession): AcpSessionRecord | null {
        const record = this.getRecord(acpSessionId);
        if (!record) return null;
        this.acpIdsByRuntimeSessionId.delete(record.runtimeSessionId);
        record.runtimeSessionId = session.sessionId;
        if (session.cwd) record.cwd = session.cwd;
        this.acpIdsByRuntimeSessionId.set(session.sessionId, acpSessionId);
        return record;
    }

    markCancelled(acpSessionId: string): boolean {
        const record = this.getRecord(acpSessionId);
        if (!record?.activePrompt) return false;
        record.activePrompt.cancelled = true;
        return true;
    }

    deleteRecord(acpSessionId: string): boolean {
        const record = this.records.get(acpSessionId);
        if (!record) return false;
        this.records.delete(acpSessionId);
        this.acpIdsByRuntimeSessionId.delete(record.runtimeSessionId);
        return true;
    }
}
