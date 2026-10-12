/** Runtime fatal-error events used to restore the terminal before termination. */
import process from "node:process";

interface CrashEventRuntime {
    addEventListener(type: string, handler: () => void): void;
    removeEventListener(type: string, handler: () => void): void;
}

const rejectionListeners = new WeakMap<() => void, (reason: Error) => void>();

export const SYSTEM_TUI_CRASH_EVENTS: CrashEventRuntime = {
    addEventListener(type, handler) {
        if (type === "error") {
            // Monitoring must not consume the exception or suppress termination.
            process.on("uncaughtExceptionMonitor", handler);
        } else if (type === "unhandledrejection") {
            const listener = (reason: Error) => {
                handler();
                // Bun does not dispatch browser-style fatal-error events. An
                // unhandledRejection listener consumes the default failure, so
                // rethrow after restoration to preserve fatal process behavior.
                queueMicrotask(() => {
                    throw reason;
                });
            };
            rejectionListeners.set(handler, listener);
            process.on("unhandledRejection", listener);
        }
    },
    removeEventListener(type, handler) {
        if (type === "error") process.off("uncaughtExceptionMonitor", handler);
        else if (type === "unhandledrejection") {
            const listener = rejectionListeners.get(handler);
            if (listener) process.off("unhandledRejection", listener);
            rejectionListeners.delete(handler);
        }
    },
};
