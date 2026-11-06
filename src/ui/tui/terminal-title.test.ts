import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { VirtualTerminal } from "./testing/virtual-terminal.ts";
import { initTUIWithPair, stopTUI } from "./tui.ts";
import { setTerminalTitleForName } from "./terminal-title.ts";

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

test("active terminal titles sanitize control characters, limit length, and support empty names", () => {
    const terminal = new CompatibleVirtualTerminal();
    const tui = new TuiMainScreen(terminal);
    initTUIWithPair({ terminal, tui });
    try {
        for (const [name, expected] of [
            ["  fix\n\tmodel\u0007 routing  ", "W. fix model routing"],
            ["a".repeat(50), "W. " + "a".repeat(40)],
            ["\n\t", "W."],
        ]) {
            assertEquals(setTerminalTitleForName(name), expected);
            assertEquals(terminal.title, expected);
        }
    } finally {
        stopTUI();
    }
});

test("setTerminalTitleForName ignores an unavailable terminal", () => {
    stopTUI();
    assertEquals(setTerminalTitleForName("safe"), "W. safe");
});
