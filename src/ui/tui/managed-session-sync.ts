/**
 * @module ui/tui/managed-session-sync
 * Idle read-only synchronization loop for dormant managed Sessions.
 */

import type { SessionRuntime } from "../../shared/session/session-runtime.ts";

type NativeTimerHandle = ReturnType<typeof setTimeout>;
type TimerCallback = () => void;

export interface ManagedSessionTimer<TimerHandle> {
    set(callback: TimerCallback, delayMs: number): TimerHandle;
    clear(timer: TimerHandle): void;
}

export interface ManagedSessionSyncControllerOptions<TimerHandle = NativeTimerHandle> {
    runtime: SessionRuntime;
    getSessionId: () => string | null;
    timer: ManagedSessionTimer<TimerHandle>;
    pollIntervalMs?: number;
    retryDelayMs?: number;
    isPaused?: () => boolean;
    onError?: (error: unknown) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 1000;
const TRANSIENT_RETRY_MS = 250;

export const SYSTEM_MANAGED_SESSION_TIMER = Object.freeze({
    set: (callback: TimerCallback, delayMs: number) => setTimeout(callback, delayMs),
    clear: (timer: NativeTimerHandle) => clearTimeout(timer),
});

export function createManagedSessionSyncController<TimerHandle>(
    options: ManagedSessionSyncControllerOptions<TimerHandle>,
) {
    const { timer: timerPort } = options;
    const pollIntervalMs = Math.max(100, options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS);
    const retryDelayMs = Math.max(50, options.retryDelayMs || TRANSIENT_RETRY_MS);
    let disposed = false;
    let paused = false;
    let inFlight = false;
    let inFlightPromise: Promise<void> | null = null;
    let timer: TimerHandle | null = null;

    function clearScheduled() {
        if (timer === null) return;
        timerPort.clear(timer);
        timer = null;
    }

    function schedule(delayMs: number) {
        if (disposed || paused) return;
        clearScheduled();
        timer = timerPort.set(() => {
            timer = null;
            void inspect();
        }, delayMs);
    }

    async function inspect() {
        if (disposed || paused || inFlight || options.isPaused?.()) return;
        const sessionId = options.getSessionId();
        if (!sessionId) return;
        if (!options.runtime.isManagedSessionDormant(sessionId)) return;
        inFlight = true;
        inFlightPromise = (async () => {
            try {
                await options.runtime.synchronizeManagedSession(sessionId);
                schedule(pollIntervalMs);
            } catch (error) {
                options.onError?.(error);
                schedule(retryDelayMs);
            } finally {
                inFlight = false;
                inFlightPromise = null;
            }
        })();
        await inFlightPromise;
    }

    return {
        start() {
            if (disposed || paused) return;
            schedule(0);
        },
        async pause() {
            paused = true;
            clearScheduled();
            if (inFlightPromise) await inFlightPromise;
        },
        resume() {
            if (disposed) return;
            paused = false;
            schedule(0);
        },
        async refreshNow() {
            await inspect();
        },
        async dispose() {
            disposed = true;
            clearScheduled();
            if (inFlightPromise) await inFlightPromise;
        },
        isInFlight() {
            return inFlight;
        },
    };
}
