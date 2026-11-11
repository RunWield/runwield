import { AgyCliBackendError } from ".././backends/agy-cli/failure.ts";
import { listPromptTemplates, listSkills } from ".././session.ts";
import { createSessionRuntimeEvent, RuntimeEventTypes } from ".././session-runtime-events.ts";
import { appendLiveSessionEvent } from ".././live-session-events.ts";
import type { SessionRuntimeEventListener } from "./types.ts";

import type { RuntimeServices } from "./base.ts";

interface BusyOperationSettlement {
    promise: Promise<void>;
    resolve: () => void;
}

export class RuntimeEvents {
    constructor(private readonly services: RuntimeServices) {}

    private eventListeners = new Map<string, Set<SessionRuntimeEventListener>>();
    private busyOperationDepths = new Map<string, number>();
    private busyOperationSettlements = new Map<string, BusyOperationSettlement>();
    private pendingReplayEvents = new Map<string, import("../session-runtime-events.ts").SessionRuntimeEvent[]>();
    private liveSessionEvents = new Map<string, import("../session-runtime-events.ts").SessionRuntimeEvent[]>();

    cleanupSession(sessionId: string) {
        this.eventListeners.delete(sessionId);
        this.busyOperationDepths.delete(sessionId);
        this.busyOperationSettlements.get(sessionId)?.resolve();
        this.busyOperationSettlements.delete(sessionId);
        this.pendingReplayEvents.delete(sessionId);
        this.liveSessionEvents.delete(sessionId);
    }

    isBusy(sessionId: string) {
        return (this.busyOperationDepths.get(sessionId) || 0) > 0;
    }

    consumePendingReplayEvents(sessionId: string) {
        const events = this.pendingReplayEvents.get(sessionId) || [];
        this.pendingReplayEvents.delete(sessionId);
        return events;
    }

    replacePendingReplayEvents(
        sessionId: string,
        events: import("../session-runtime-events.ts").SessionRuntimeEvent[],
    ) {
        this.pendingReplayEvents.set(sessionId, events);
    }

    clearPendingReplayEvents(sessionId: string) {
        this.pendingReplayEvents.delete(sessionId);
    }

    beginLiveCapture(sessionId: string) {
        const events: import("../session-runtime-events.ts").SessionRuntimeEvent[] = [];
        this.liveSessionEvents.set(sessionId, events);
        return events;
    }

    endLiveCapture(sessionId: string) {
        this.liveSessionEvents.delete(sessionId);
    }

    beginBusyOperation(sessionId: string, turnId?: string) {
        const depth = this.busyOperationDepths.get(sessionId) || 0;
        this.busyOperationDepths.set(sessionId, depth + 1);
        if (depth === 0) {
            let resolve = () => {};
            const promise = new Promise<void>((settle) => {
                resolve = settle;
            });
            this.busyOperationSettlements.set(sessionId, { promise, resolve });
            this.emitSessionEvent(sessionId, {
                type: RuntimeEventTypes.BUSY_CHANGED,
                ...(turnId ? { turnId } : {}),
                busy: true,
            });
        }
    }

    endBusyOperation(sessionId: string, turnId?: string) {
        const depth = this.busyOperationDepths.get(sessionId) || 0;
        if (depth <= 0) return;
        if (depth > 1) {
            this.busyOperationDepths.set(sessionId, depth - 1);
            return;
        }
        this.busyOperationDepths.delete(sessionId);
        this.busyOperationSettlements.get(sessionId)?.resolve();
        this.busyOperationSettlements.delete(sessionId);
        this.emitSessionEvent(sessionId, {
            type: RuntimeEventTypes.BUSY_CHANGED,
            ...(turnId ? { turnId } : {}),
            busy: false,
        });
    }

    async awaitBusyOperationSettlement(sessionId: string) {
        await this.busyOperationSettlements.get(sessionId)?.promise;
    }

    async runBusyOperation<T>(sessionId: string, operation: () => Promise<T>) {
        this.beginBusyOperation(sessionId);
        try {
            return await operation();
        } finally {
            this.endBusyOperation(sessionId);
        }
    }

    subscribeSessionEvents(sessionId: string, listener: SessionRuntimeEventListener) {
        let listeners = this.eventListeners.get(sessionId);
        if (!listeners) {
            listeners = new Set();
            this.eventListeners.set(sessionId, listeners);
        }
        listeners.add(listener);
        return () => {
            const current = this.eventListeners.get(sessionId);
            if (!current) return;
            current.delete(listener);
            if (current.size === 0) this.eventListeners.delete(sessionId);
        };
    }

    emitSessionEvent<T extends { type: string }>(
        sessionId: string,
        event: T,
    ) {
        const sessionName = event.type === RuntimeEventTypes.ATTENTION_REQUESTED && !("sessionName" in event)
            ? this.services.sessionHost.getSession(sessionId)?.getRootSessionManager()?.getSessionName?.() || undefined
            : undefined;
        const hostedSession = this.services.sessionHost.getSession(sessionId);
        if (
            event.type === RuntimeEventTypes.ATTENTION_REQUESTED && "reason" in event &&
            event.reason === "agentStopped" && hostedSession
        ) {
            hostedSession.agentStoppedAttentionTurnId = hostedSession.activeTurnId;
        }
        const enrichedEvent = {
            ...event,
            ...(sessionName ? { sessionName } : {}),
            ...(event.type === RuntimeEventTypes.ATTENTION_REQUESTED
                ? { notificationSurface: hostedSession?.notificationSurface || this.services.ownerProcessKind }
                : {}),
            ...(event.type === RuntimeEventTypes.TERMINAL_ERROR &&
                    "error" in event && event.error instanceof AgyCliBackendError
                ? { messageAlreadyReported: true }
                : {}),
        };
        const runtimeEvent = createSessionRuntimeEvent(sessionId, enrichedEvent);
        const liveEvents = this.liveSessionEvents.get(sessionId);
        if (liveEvents) appendLiveSessionEvent(liveEvents, runtimeEvent);
        const listeners = this.eventListeners.get(sessionId);
        if (!listeners) {
            if (runtimeEvent.type === RuntimeEventTypes.SYSTEM_STATUS) {
                const pending = this.pendingReplayEvents.get(sessionId) || [];
                pending.push(runtimeEvent);
                this.pendingReplayEvents.set(sessionId, pending);
            }
            return;
        }
        for (const listener of Array.from(listeners)) {
            try {
                const result = listener(runtimeEvent);
                if (result && typeof result === "object" && "catch" in result && typeof result.catch === "function") {
                    result.catch(() => {});
                }
            } catch {
                // Event subscribers are adapter concerns; a bad adapter listener must not
                // crash an in-flight RunWield prompt.
            }
        }
    }

    async emitCommandCatalogChanged(sessionId: string, hostedSession: import(".././hosted-session.ts").HostedSession) {
        const [promptTemplates, skills] = await Promise.all([
            listPromptTemplates({ cwd: hostedSession.cwd }),
            listSkills({ cwd: hostedSession.cwd }),
        ]);
        this.emitSessionEvent(sessionId, {
            type: RuntimeEventTypes.COMMAND_CATALOG_CHANGED,
            promptTemplates,
            skills,
        });
    }

    attachRuntimeEventSink(hostedSession: import(".././hosted-session.ts").HostedSession) {
        if (!hostedSession) throw new Error("SessionRuntime.attachRuntimeEventSink: session not found");
        hostedSession.setEventSink({
            emit: (
                event: Partial<import("../session-runtime-events.ts").SessionRuntimeEvent> & { type: string },
            ) => {
                this.emitSessionEvent(hostedSession.id, event);
            },
        });
    }
}
