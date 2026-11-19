import { test } from "node:test";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { createTuiManager } from "./tui-manager.ts";
import { createTuiCrashGuards } from "./tui-crash-guards.ts";
import { RunWieldTui } from "./tui.ts";
import { VirtualTerminal } from "./testing/virtual-terminal.ts";
import { Text } from "@earendil-works/pi-tui";

function makeManager(TerminalCtor = VirtualTerminal) {
    const events = new EventTarget();
    const signalTarget = new EventTarget();
    const guards = createTuiCrashGuards({
        stop: () => manager.stopTUI(),
        eventTarget: events,
        signalRuntime: {
            addSignalListener: (signal, listener) => signalTarget.addEventListener(signal, listener),
            removeSignalListener: (signal, listener) => signalTarget.removeEventListener(signal, listener),
        },
        os: "linux",
        exit: () => {
            throw new Error("unexpected exit");
        },
    });
    const manager = createTuiManager({
        TerminalCtor,
        TuiCtor: RunWieldTui,
        installCrashGuards: guards.install,
        uninstallCrashGuards: guards.uninstall,
        restoreTitle: () => {}, // Terminal control output is the external boundary.
    });
    return { manager, events, guards };
}

test("TUI manager keeps one live terminal, restores it on crash, and can restart", async () => {
    const { manager, events, guards } = makeManager();
    assertThrows(() => manager.getTUI(), Error, "TUI not initialized");
    try {
        const tui = manager.initTUI();
        assertEquals(manager.initTUI(), tui);
        const { terminal } = manager.getTUI();
        tui.addChild(new Text("Session remains visible", 0, 0));
        tui.requestRender(true);
        await new Promise((resolve) => setTimeout(resolve, 30));
        await terminal.flush();
        assertEquals(terminal.getScreenText().includes("Session remains visible"), true);
        assertEquals(guards.isInstalled(), true);
        events.dispatchEvent(new Event("error"));
        assertEquals(terminal.stopped, true);
        assertEquals(guards.isInstalled(), false);
        assertThrows(() => manager.getTUI(), Error, "TUI not initialized");
        const restarted = manager.initTUI();
        assertEquals(restarted === tui, false);
        assertEquals(manager.getTUI().terminal.started, true);
        manager.stopTUI();
        manager.stopTUI();
        assertEquals(guards.isInstalled(), false);
    } finally {
        manager.stopTUI();
    }
});

test("TUI manager recovers from a terminal startup failure without publishing a partial TUI", () => {
    let first = true;
    class UnavailableTerminal extends VirtualTerminal {
        start(...args: Parameters<VirtualTerminal["start"]>) {
            if (first) {
                first = false;
                throw new Error("terminal disconnected");
            }
            super.start(...args);
        }
    }
    const { manager, guards } = makeManager(UnavailableTerminal);
    try {
        assertThrows(() => manager.initTUI(), Error, "terminal disconnected");
        assertThrows(() => manager.getTUI(), Error, "TUI not initialized");
        assertEquals(guards.isInstalled(), false);
        manager.initTUI();
        assertEquals(manager.getTUI().terminal.started, true);
        assertEquals(guards.isInstalled(), true);
    } finally {
        manager.stopTUI();
    }
});
