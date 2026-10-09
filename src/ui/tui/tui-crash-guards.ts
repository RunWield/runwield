/**
 * @module ui/tui/tui-crash-guards
 * Restores terminal state on abrupt exits.
 */

type TuiSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

interface SignalRuntime {
    addSignalListener(signal: TuiSignal, handler: () => void): void;
    removeSignalListener(signal: TuiSignal, handler: () => void): void;
}

interface EventRuntime {
    addEventListener(type: string, handler: () => void): void;
    removeEventListener(type: string, handler: () => void): void;
}

export interface TuiCrashGuardRuntime {
    stop(): void;
    eventTarget: EventRuntime;
    signalRuntime: SignalRuntime;
    os: string;
    exit(code: number): never;
    cleanup?: () => void;
}

export function createTuiCrashGuards(runtime: TuiCrashGuardRuntime) {
    const { stop, eventTarget, signalRuntime, os, exit, cleanup } = runtime;
    let installed = false;

    function safeStop(): void {
        try {
            stop();
        } catch {
            // Terminal restoration is best-effort during process failure paths.
        }
    }

    const onUnhandledRejection = (): void => safeStop();
    const onUncaughtError = (): void => safeStop();

    function makeSignalHandler(signal: TuiSignal): () => void {
        return () => {
            safeStop();
            cleanup?.();
            const code = signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129;
            exit(code);
        };
    }

    const onSigint = makeSignalHandler("SIGINT");
    const onSigterm = makeSignalHandler("SIGTERM");
    const onSighup = makeSignalHandler("SIGHUP");

    function install(): void {
        if (installed) return;
        eventTarget.addEventListener("unhandledrejection", onUnhandledRejection);
        eventTarget.addEventListener("error", onUncaughtError);
        try {
            signalRuntime.addSignalListener("SIGINT", onSigint);
            signalRuntime.addSignalListener("SIGTERM", onSigterm);
            if (os !== "windows") signalRuntime.addSignalListener("SIGHUP", onSighup);
        } catch {
            // Signal listeners are unavailable in some runtimes and tests.
        }
        installed = true;
    }

    function uninstall(): void {
        if (!installed) return;
        eventTarget.removeEventListener("unhandledrejection", onUnhandledRejection);
        eventTarget.removeEventListener("error", onUncaughtError);
        try {
            signalRuntime.removeSignalListener("SIGINT", onSigint);
            signalRuntime.removeSignalListener("SIGTERM", onSigterm);
            if (os !== "windows") signalRuntime.removeSignalListener("SIGHUP", onSighup);
        } catch {
            // Removal is also best-effort when the process is already failing.
        }
        installed = false;
    }

    return { install, uninstall, isInstalled: (): boolean => installed };
}
