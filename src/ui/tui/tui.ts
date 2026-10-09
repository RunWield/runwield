/**
 * @module ui/tui/tui
 * TUI singleton manager.
 */

import { Key, matchesKey, ProcessTerminal, type Terminal, type TUI, TuiAltScreen } from "@earendil-works/pi-tui";
import { type BrowserPort, SYSTEM_BROWSER_PORT } from "../../shared/browser-port.ts";
import { createTuiCrashGuards } from "./tui-crash-guards.ts";
import { createTuiManager } from "./tui-manager.ts";
import { cleanupAgentBrowserSessionSync } from "../../shared/agent-browser-session.ts";

export interface TuiPair {
    terminal: Terminal;
    tui: TUI;
}

export interface TuiArtifactLink {
    sessionId: string;
    artifactId: string;
}
export class RunWieldTui extends TuiAltScreen {
    onArtifactLink?: (link: TuiArtifactLink) => void;
    constructor(terminal: Terminal, browser: BrowserPort = SYSTEM_BROWSER_PORT) {
        super(terminal, undefined, undefined, {
            openUrl: (url) => {
                if (url.startsWith("runwield-artifact:")) {
                    try {
                        const link = new URL(url);
                        this.onArtifactLink?.({
                            sessionId: decodeURIComponent(link.hostname),
                            artifactId: decodeURIComponent(link.pathname.slice(1)),
                        });
                    } catch { /* Ignore malformed internal links. */ }
                    return;
                }
                void browser.open(url);
            },
        });
        this.addInputListener((data) => {
            if (!matchesKey(data, Key.ctrl("l"))) return;
            // Repaint even unchanged rows when the terminal no longer matches
            // the renderer's cached screen. Preserve input, focus and scroll.
            this.requestRender(true);
            return { consume: true };
        });
    }
}

const tuiManager = createTuiManager<Terminal, TUI>({
    TerminalCtor: ProcessTerminal,
    TuiCtor: RunWieldTui,
    installCrashGuards: () => crashGuards.install(),
    uninstallCrashGuards: () => crashGuards.uninstall(),
});

const crashGuards = createTuiCrashGuards({
    stop: () => tuiManager.stopTUI(),
    eventTarget: globalThis,
    signalRuntime: Deno,
    os: Deno.build.os,
    exit: Deno.exit,
    cleanup: cleanupAgentBrowserSessionSync,
});

/** Initialize the TUI singleton if it is not already running. */
export function initTUI(): TUI {
    return tuiManager.initTUI();
}

/** Install an explicit Terminal/TUI pair for deterministic composition tests. */
export function initTUIWithPair(pair: TuiPair): TUI {
    return tuiManager.initTUIWithPair(pair);
}

/** Get the current TUI instance and terminal. */
export function getTUI(): TuiPair {
    return tuiManager.getTUI();
}

/** Stop the TUI and clean up terminal state. */
export function stopTUI(): void {
    tuiManager.stopTUI();
}
