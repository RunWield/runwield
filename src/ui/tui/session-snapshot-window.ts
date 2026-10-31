/** A short-lived read projection owned by one real Session runtime. */
import type { SessionRuntime } from "../../shared/session/session-runtime.ts";

type SessionSnapshot = ReturnType<SessionRuntime["getSessionSnapshot"]>;

export interface SessionSnapshotWindow {
    read(): SessionSnapshot;
    invalidate(): void;
    rebind(): void;
    dispose(): void;
}

export function createSessionSnapshotWindow(
    runtime: SessionRuntime,
    getSessionId: () => string,
    ttlMs = 500,
): SessionSnapshotWindow {
    let cachedAt = 0;
    let cached: SessionSnapshot = null;
    let hasCached = false;
    let sessionId: string | null = null;
    let unsubscribe = () => {};
    let disposed = false;
    function invalidate(): void {
        cached = null;
        hasCached = false;
    }
    function rebind(): void {
        if (disposed) return;
        const nextId = getSessionId();
        if (sessionId === nextId) return;
        unsubscribe();
        sessionId = nextId;
        invalidate();
        unsubscribe = runtime.subscribeSessionEvents(nextId, invalidate);
    }
    rebind();
    return {
        read(): SessionSnapshot {
            rebind();
            const now = Date.now();
            if (hasCached && now - cachedAt < ttlMs) return cached;
            cached = runtime.getSessionSnapshot(getSessionId());
            cachedAt = Date.now();
            hasCached = true;
            return cached;
        },
        invalidate,
        rebind,
        dispose(): void {
            disposed = true;
            unsubscribe();
        },
    };
}
