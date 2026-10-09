import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import type { BrowserPort } from "../../shared/browser-port.ts";
import { VirtualTerminal } from "./testing/virtual-terminal.js";
import { getTUI, initTUIWithPair, RunWieldTui, stopTUI } from "./tui.ts";

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

Deno.test("TUI singleton uses Pi TuiMainScreen regular mode", () => {
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

Deno.test("RunWield TUI opens a rendered hyperlink when clicked", async () => {
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

Deno.test("TUI singleton stop is idempotent and clears deterministic pair state", () => {
    const { terminal, tui } = makePair();
    initTUIWithPair({ terminal, tui });

    stopTUI();
    stopTUI();

    assertEquals(terminal.stopped, true);
    assertThrows(() => getTUI(), Error, "TUI not initialized. Call initTUI() first.");
});

Deno.test("TUI singleton accepts a second compatible pair after cleanup", () => {
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

Deno.test("RunWield TUI routes artifact clicks to the Session without opening a custom OS URL", async () => {
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
