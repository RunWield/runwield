import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { VirtualTerminal } from "./testing/virtual-terminal.js";
import { initTUIWithPair, stopTUI } from "./tui.ts";
import { formatTerminalTitle, sanitizeSessionName, setTerminalTitleForName } from "./terminal-title.ts";

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

test("sanitizeSessionName trims, collapses whitespace, and strips control characters", () => {
    assertEquals(sanitizeSessionName("  fix\n\tmodel\u0007 routing  "), "fix model routing");
});

test("sanitizeSessionName truncates to a tab-friendly length", () => {
    assertEquals(sanitizeSessionName("a".repeat(50)), "a".repeat(40));
});

test("formatTerminalTitle prefixes sanitized names and falls back to W.", () => {
    assertEquals(formatTerminalTitle(" terminal titles "), "W. - terminal titles");
    assertEquals(formatTerminalTitle("\n\t"), "W.");
});

test("setTerminalTitleForName updates the active terminal", () => {
    const terminal = new CompatibleVirtualTerminal();
    const tui = new TuiMainScreen(terminal);
    initTUIWithPair({ terminal, tui });
    try {
        assertEquals(setTerminalTitleForName("  plan\nboard  "), "W. - plan board");
        assertEquals(terminal.title, "W. - plan board");
    } finally {
        stopTUI();
    }
});

test("setTerminalTitleForName ignores an unavailable terminal", () => {
    stopTUI();
    assertEquals(setTerminalTitleForName("safe"), "W. - safe");
});
