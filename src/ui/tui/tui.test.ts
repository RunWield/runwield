import { test } from "node:test";
import { strictEqual as assertStrictEquals } from "node:assert/strict";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import type { BrowserPort } from "../../shared/browser-port.ts";
import { VirtualTerminal } from "./testing/virtual-terminal.js";
import { getTUI, initTUIWithPair, RunWieldTui, stopTUI } from "./tui.ts";
import { createTuiManager } from "./tui-manager.ts";

class CompatibleVirtualTerminal extends VirtualTerminal {
    override drainInput(): Promise<void> {
        return Promise.resolve();
    }

    override moveBy(lines: number, columns?: number): void {
        super.moveBy(lines, columns ?? 0);
    }

    override setProgress(active: boolean | number | null): void {
        super.setProgress(typeof active === "boolean" ? (active ? 1 : null) : active);
    }
}

function makePair(): { terminal: CompatibleVirtualTerminal; tui: TUI } {
    const terminal = new CompatibleVirtualTerminal({ columns: 100, rows: 30 });
    return { terminal, tui: new TuiMainScreen(terminal) };
}

test("TUI singleton uses Pi TuiMainScreen regular mode", () => {
    const { terminal, tui } = makePair();
    const initialized = initTUIWithPair({ terminal, tui });
    try {
        const current = getTUI();
        assertStrictEquals(initialized, tui);
        assertStrictEquals(current.tui, tui);
        assertStrictEquals(current.terminal, terminal);
        assertEquals(current.tui.mode, "regular");
        assertEquals(terminal.started, true);
    } finally {
        stopTUI();
    }
});

test("RunWield TUI opens a rendered hyperlink when clicked", async () => {
    const terminal = new CompatibleVirtualTerminal({ columns: 100, rows: 30 });
    const opened: string[] = [];
    const browser: BrowserPort = {
        open(url) {
            opened.push(url);
            return Promise.resolve(true);
        },
    };
    const tui = new RunWieldTui(terminal, browser);
    const url = "https://runwield.dev/docs";
    tui.setLayoutRoot({
        render: () => [`\x1b]8;;${url}\x07RunWield docs\x1b]8;;\x07`],
        invalidate() {},
    });

    try {
        tui.start();
        tui.requestRender();
        await new Promise((resolve) => setTimeout(resolve, 10));
        await terminal.flush();
        terminal.input("\x1b[<0;1;1M");
        terminal.input("\x1b[<0;1;1m");

        assertEquals(opened, [url]);
    } finally {
        tui.stop();
    }
});

test("TUI exit restores the shell without leaving the input behind", async () => {
    const terminal = new CompatibleVirtualTerminal({ columns: 100, rows: 30 });
    terminal.write("shell history\r\n$ wld\r\n");
    await terminal.flush();
    const shellScreen = terminal.getScreenText();
    const tui = new RunWieldTui(terminal);
    tui.setLayoutRoot({
        render: () => ["─".repeat(100), "draft input", "─".repeat(100)],
        invalidate() {},
    });

    initTUIWithPair({ terminal, tui });
    try {
        tui.renderNow();
        await terminal.flush();
        assertEquals(terminal.getScreenText().includes("draft input"), true);
    } finally {
        stopTUI();
    }
    await terminal.flush();

    assertEquals(terminal.getScreenText(), shellScreen);
    assertEquals(terminal.stopped, true);
    const screenEnteredAt = terminal.writes.lastIndexOf("\x1b[?1049h");
    const focusReportingEnabledAt = terminal.writes.lastIndexOf("\x1b[?1004h");
    const focusReportingDisabledAt = terminal.writes.lastIndexOf("\x1b[?1004l");
    const screenRestoredAt = terminal.writes.lastIndexOf("\x1b[?1049l");
    assertEquals(focusReportingEnabledAt > screenEnteredAt, true);
    assertEquals(focusReportingDisabledAt > focusReportingEnabledAt, true);
    assertEquals(focusReportingDisabledAt < screenRestoredAt, true);
    stopTUI();
    await terminal.flush();
    assertEquals(terminal.getScreenText(), shellScreen);
});

test("TUI startup failure restores the shell without leaving the input behind", async () => {
    const terminal = new CompatibleVirtualTerminal({ columns: 100, rows: 30 });
    terminal.write("shell history\r\n$ wld\r\n");
    await terminal.flush();
    const shellScreen = terminal.getScreenText();
    const tui = new RunWieldTui(terminal);
    tui.setLayoutRoot({
        render: () => ["─".repeat(100), "draft input", "─".repeat(100)],
        invalidate() {},
    });
    const manager = createTuiManager({
        TerminalCtor: CompatibleVirtualTerminal,
        TuiCtor: RunWieldTui,
        installCrashGuards: () => {
            tui.renderNow();
            throw new Error("signal listener setup failed");
        },
        uninstallCrashGuards: () => {},
        restoreTitle: () => {},
    });

    assertThrows(() => manager.initTUIWithPair({ terminal, tui }), Error, "signal listener setup failed");
    await terminal.flush();

    assertEquals(terminal.getScreenText(), shellScreen);
    assertEquals(terminal.stopped, true);
    assertThrows(() => manager.getTUI(), Error, "TUI not initialized");
});

test("TUI singleton stop is idempotent and clears deterministic pair state", () => {
    const { terminal, tui } = makePair();
    initTUIWithPair({ terminal, tui });

    stopTUI();
    stopTUI();

    assertEquals(terminal.stopped, true);
    assertThrows(() => getTUI(), Error, "TUI not initialized. Call initTUI() first.");
});

test("TUI singleton accepts a second compatible pair after cleanup", () => {
    const first = makePair();
    initTUIWithPair(first);
    stopTUI();

    const second = makePair();
    try {
        initTUIWithPair(second);
        const current = getTUI();
        assertStrictEquals(current.tui, second.tui);
        assertStrictEquals(current.terminal, second.terminal);
        assertEquals(current.tui.mode, "regular");
    } finally {
        stopTUI();
    }
});

test("RunWield TUI routes artifact clicks to the Session without opening a custom OS URL", async () => {
    const terminal = new CompatibleVirtualTerminal({ columns: 100, rows: 30 });
    const opened: string[] = [];
    const clicked: Array<{ sessionId: string; artifactId: string }> = [];
    const tui = new RunWieldTui(terminal, {
        open: (url) => {
            opened.push(url);
            return Promise.resolve(true);
        },
    });
    tui.onArtifactLink = (link) => clicked.push(link);
    tui.setLayoutRoot({
        render: () => ["\x1b]8;;runwield-artifact://session/id%2Fone\x07Test results\x1b]8;;\x07"],
        invalidate() {},
    });
    try {
        tui.start();
        tui.requestRender();
        await new Promise((resolve) => setTimeout(resolve, 10));
        await terminal.flush();
        terminal.input("\x1b[<0;1;1M");
        terminal.input("\x1b[<0;1;1m");
        assertEquals(clicked, [{ sessionId: "session", artifactId: "id/one" }]);
        assertEquals(opened, []);
    } finally {
        tui.stop();
    }
});
