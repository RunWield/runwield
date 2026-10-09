/**
 * @module ui/tui/tui-manager
 * TUI singleton lifecycle.
 */

import { writeSync } from "node:fs";
import { env } from "node:process";

import {
    type FocusReportingTerminal,
    installTerminalFocusState,
    type TerminalFocusStateOwner,
} from "./terminal-focus-state.ts";

interface ManagedTui {
    start?(): void;
    stop?(): void;
    requestRender?(force?: boolean): void;
}

type TerminalConstructor<TTerminal extends FocusReportingTerminal> = new () => TTerminal;
type TuiConstructor<TTerminal extends FocusReportingTerminal, TTui extends ManagedTui> = new (
    terminal: TTerminal,
) => TTui;

interface TuiManagerDeps<TTerminal extends FocusReportingTerminal, TTui extends ManagedTui> {
    TerminalCtor: TerminalConstructor<TTerminal>;
    TuiCtor: TuiConstructor<TTerminal, TTui>;
    installCrashGuards(): void;
    uninstallCrashGuards(): void;
    restoreTitle?: () => void;
}

interface TuiPair<TTerminal extends FocusReportingTerminal, TTui extends ManagedTui> {
    terminal: TTerminal;
    tui: TTui;
}

/**
 * Restore the terminal window/tab title to its default by writing an empty
 * OSC 0 sequence (`\x1b]0;\x07`). Most terminal emulators interpret this as
 * "reset to default title".
 */
function defaultRestoreTitle(): void {
    try {
        writeSync(1, new TextEncoder().encode("\x1b]0;\x07"));
    } catch {
        // Terminal title restoration is cosmetic — never crash on it.
    }
}

export function createTuiManager<TTerminal extends FocusReportingTerminal, TTui extends ManagedTui>(
    deps: TuiManagerDeps<TTerminal, TTui>,
) {
    const {
        TerminalCtor,
        TuiCtor,
        installCrashGuards,
        uninstallCrashGuards,
        restoreTitle = defaultRestoreTitle,
    } = deps;
    let tuiInstance: TTui | null = null;
    let terminalInstance: TTerminal | null = null;
    let started = false;
    let crashGuardsInstalled = false;
    let focusStateOwner: TerminalFocusStateOwner | null = null;

    function startPair(pair: TuiPair<TTerminal, TTui>): TTui {
        terminalInstance = pair.terminal;
        tuiInstance = pair.tui;
        try {
            tuiInstance.start?.();
            started = true;
            installCrashGuards();
            crashGuardsInstalled = true;
            return tuiInstance;
        } catch (error) {
            if (crashGuardsInstalled) {
                try {
                    uninstallCrashGuards();
                } catch {
                    // Preserve the original construction/start failure.
                }
            }
            try {
                tuiInstance?.stop?.();
            } catch {
                // Preserve the original construction/start failure.
            }
            try {
                focusStateOwner?.dispose();
            } catch {
                // Preserve the original construction/start failure.
            }
            focusStateOwner = null;
            tuiInstance = null;
            terminalInstance = null;
            started = false;
            crashGuardsInstalled = false;
            throw error;
        }
    }

    function initTUI(): TTui {
        if (tuiInstance) return tuiInstance;
        const terminal = new TerminalCtor();
        if (!env.WLD_GOLDEN_TUI && !env.WLD_GOLDEN_TUI_CHILD) {
            focusStateOwner = installTerminalFocusState(terminal, () => tuiInstance?.requestRender?.(true));
        }
        try {
            const tui = new TuiCtor(terminal);
            return startPair({ terminal, tui });
        } catch (error) {
            focusStateOwner?.dispose();
            focusStateOwner = null;
            throw error;
        }
    }

    /** Install an explicit Terminal/TUI pair, primarily for deterministic tests. */
    function initTUIWithPair(pair: TuiPair<TTerminal, TTui>): TTui {
        if (tuiInstance) return tuiInstance;
        return startPair(pair);
    }

    function getTUI(): TuiPair<TTerminal, TTui> {
        if (!tuiInstance || !terminalInstance) {
            throw new Error("TUI not initialized. Call initTUI() first.");
        }
        return { tui: tuiInstance, terminal: terminalInstance };
    }

    function stopTUI(): void {
        try {
            restoreTitle();
        } catch {
            // Terminal title restoration is best effort.
        }
        if (crashGuardsInstalled) {
            try {
                uninstallCrashGuards();
            } catch {
                // Crash guard cleanup must not prevent terminal restoration.
            } finally {
                crashGuardsInstalled = false;
            }
        }
        const tui = tuiInstance;
        const focusState = focusStateOwner;
        tuiInstance = null;
        terminalInstance = null;
        focusStateOwner = null;
        const wasStarted = started;
        started = false;
        try {
            focusState?.dispose();
        } catch {
            // Focus reporting cleanup is best effort.
        }
        if (tui && wasStarted) {
            tui.stop?.();
        }
    }

    return { initTUI, initTUIWithPair, getTUI, stopTUI };
}
