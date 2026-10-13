import { test } from "node:test";
import { strictEqual as assertStrictEquals } from "node:assert/strict";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { createTuiManager } from "./tui-manager.ts";

type InputHandler = (data: string) => void;

test("createTuiManager initializes once and returns the same running TUI", () => {
    const events: string[] = [];

    class FakeTerminal {
        constructor() {
            events.push("terminal");
        }

        write(_data: string): void {}
        start(_onInput: InputHandler): void {}
    }

    class FakeTui {
        terminal: FakeTerminal;
        starts = 0;

        constructor(terminal: FakeTerminal) {
            this.terminal = terminal;
            events.push("tui");
        }

        start(): void {
            this.starts++;
            events.push("start");
        }
    }

    const manager = createTuiManager({
        TerminalCtor: FakeTerminal,
        TuiCtor: FakeTui,
        installCrashGuards: () => events.push("install"),
        uninstallCrashGuards: () => events.push("uninstall"),
        restoreTitle: () => events.push("restoreTitle"),
    });

    const first = manager.initTUI();
    const second = manager.initTUI();
    const current = manager.getTUI();

    assertStrictEquals(first, second);
    assertStrictEquals(current.tui, first);
    assertStrictEquals(current.terminal, first.terminal);
    assertEquals(first.starts, 1);
    assertEquals(events, ["terminal", "tui", "start", "install"]);
});

test("createTuiManager throws before initialization and clears state on stop", () => {
    const events: string[] = [];

    class FakeTerminal {
        write(_data: string): void {}
        start(_onInput: InputHandler): void {}
    }

    class FakeTui {
        start(): void {
            events.push("start");
        }

        stop(): void {
            events.push("stop");
        }
    }

    const manager = createTuiManager({
        TerminalCtor: FakeTerminal,
        TuiCtor: FakeTui,
        installCrashGuards: () => events.push("install"),
        uninstallCrashGuards: () => events.push("uninstall"),
        restoreTitle: () => events.push("restoreTitle"),
    });

    assertThrows(
        () => manager.getTUI(),
        Error,
        "TUI not initialized. Call initTUI() first.",
    );

    manager.initTUI();
    manager.stopTUI();

    assertThrows(
        () => manager.getTUI(),
        Error,
        "TUI not initialized. Call initTUI() first.",
    );
    assertEquals(events, ["start", "install", "restoreTitle", "uninstall", "stop"]);
});

test("createTuiManager stop is safe before init and with TUI lacking stop", () => {
    const events: string[] = [];

    class FakeTerminal {
        write(_data: string): void {}
        start(_onInput: InputHandler): void {}
    }

    class FakeTui {
        start(): void {
            events.push("start");
        }
    }

    const manager = createTuiManager({
        TerminalCtor: FakeTerminal,
        TuiCtor: FakeTui,
        installCrashGuards: () => events.push("install"),
        uninstallCrashGuards: () => events.push("uninstall"),
        restoreTitle: () => events.push("restoreTitle"),
    });

    manager.stopTUI();
    manager.initTUI();
    manager.stopTUI();

    assertEquals(events, ["restoreTitle", "start", "install", "restoreTitle", "uninstall"]);
});

test("createTuiManager clears partial state when TUI start fails", () => {
    const events: string[] = [];

    class FakeTerminal {
        write(_data: string): void {}
        start(_onInput: InputHandler): void {}
    }

    class FakeTui {
        start(): void {
            events.push("start");
            throw new Error("boom");
        }

        stop(): void {
            events.push("stop");
        }
    }

    const manager = createTuiManager({
        TerminalCtor: FakeTerminal,
        TuiCtor: FakeTui,
        installCrashGuards: () => events.push("install"),
        uninstallCrashGuards: () => events.push("uninstall"),
        restoreTitle: () => events.push("restoreTitle"),
    });

    assertThrows(() => manager.initTUI(), Error, "boom");
    assertThrows(() => manager.getTUI(), Error, "TUI not initialized");
    manager.stopTUI();
    assertEquals(events, ["start", "stop", "restoreTitle"]);
});

test("createTuiManager enables and disables production terminal focus reporting", () => {
    const writes: string[] = [];

    class FakeTerminal {
        write(data: string): void {
            writes.push(data);
        }

        start(_onInput: InputHandler): void {}
    }

    class FakeTui {
        start(): void {}
        stop(): void {}
    }

    const manager = createTuiManager({
        TerminalCtor: FakeTerminal,
        TuiCtor: FakeTui,
        installCrashGuards: () => {},
        uninstallCrashGuards: () => {},
        restoreTitle: () => {},
    });

    manager.initTUI();
    manager.stopTUI();

    assertEquals(writes, ["\x1b[?1004h", "\x1b[?1004l"]);
});

test("createTuiManager disables focus reporting when crash-guard cleanup fails", () => {
    const writes: string[] = [];

    class FakeTerminal {
        write(data: string): void {
            writes.push(data);
        }

        start(_onInput: InputHandler): void {}
    }

    class FakeTui {
        start(): void {}
        stop(): void {}
    }

    const manager = createTuiManager({
        TerminalCtor: FakeTerminal,
        TuiCtor: FakeTui,
        installCrashGuards: () => {},
        uninstallCrashGuards: () => {
            throw new Error("cleanup failed");
        },
        restoreTitle: () => {},
    });

    manager.initTUI();
    manager.stopTUI();

    assertEquals(writes, ["\x1b[?1004h", "\x1b[?1004l"]);
});
