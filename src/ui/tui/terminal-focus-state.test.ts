import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import {
    createTerminalFocusStateOwner,
    getCurrentTerminalFocusState,
    installTerminalFocusState,
    type TerminalInputHandler,
    type TerminalResizeHandler,
} from "./terminal-focus-state.ts";

class FocusTestTerminal {
    writes: string[] = [];
    onInput: TerminalInputHandler | null = null;
    onResize: TerminalResizeHandler | null = null;

    write(data: string): void {
        this.writes.push(data);
    }

    start(onInput: TerminalInputHandler, onResize?: TerminalResizeHandler): void {
        this.onInput = onInput;
        this.onResize = onResize || null;
    }

    input(data: string): void {
        this.onInput?.(data);
    }
}

test("createTerminalFocusStateOwner enables and disables focus reporting idempotently", () => {
    const terminal = new FocusTestTerminal();
    const owner = createTerminalFocusStateOwner(terminal);

    assertEquals(terminal.writes, ["\x1b[?1004h"]);
    assertEquals(owner.getState(), "unknown");

    owner.dispose();
    owner.dispose();

    assertEquals(terminal.writes, ["\x1b[?1004h", "\x1b[?1004l"]);
});

test("filterInput consumes focus reports and updates state", () => {
    const terminal = new FocusTestTerminal();
    const owner = createTerminalFocusStateOwner(terminal);

    assertEquals(owner.filterInput("a\x1b[Ib"), "ab");
    assertEquals(owner.getState(), "focused");
    assertEquals(owner.filterInput("c\x1b[Od"), "cd");
    assertEquals(owner.getState(), "unfocused");
});

test("filterInput consumes split focus reports and updates state", () => {
    const terminal = new FocusTestTerminal();
    const owner = createTerminalFocusStateOwner(terminal);

    assertEquals(owner.filterInput("a\x1b["), "a");
    assertEquals(owner.getState(), "unknown");
    assertEquals(owner.filterInput("Ib"), "b");
    assertEquals(owner.getState(), "focused");
    assertEquals(owner.filterInput("c\x1b["), "c");
    assertEquals(owner.filterInput("Od"), "d");
    assertEquals(owner.getState(), "unfocused");
});

test("filterInput passes standalone ESC through without pending", () => {
    const terminal = new FocusTestTerminal();
    const owner = createTerminalFocusStateOwner(terminal);

    assertEquals(owner.filterInput("\x1b"), "\x1b");
    assertEquals(owner.filterInput("x"), "x");
    assertEquals(owner.getState(), "unknown");
});

test("filterInput passes non-focus input through unchanged and in order", () => {
    const terminal = new FocusTestTerminal();
    const owner = createTerminalFocusStateOwner(terminal);

    assertEquals(owner.filterInput("\x1b[Ahello\r\x1b[B"), "\x1b[Ahello\r\x1b[B");
    assertEquals(owner.filterInput("\x1b["), "");
    assertEquals(owner.filterInput("Az"), "\x1b[Az");
    assertEquals(owner.getState(), "unknown");
});

test("installTerminalFocusState filters terminal start input before the TUI callback", () => {
    const terminal = new FocusTestTerminal();
    const owner = installTerminalFocusState(terminal);
    const inputs: string[] = [];

    terminal.start((data) => inputs.push(data));
    terminal.input("one");
    terminal.input("\x1b[I");
    terminal.input("two\x1b[Othree");

    assertEquals(inputs, ["one", "twothree"]);
    assertEquals(owner.getState(), "unfocused");
    assertEquals(getCurrentTerminalFocusState(), "unfocused");

    owner.dispose();
    assertEquals(getCurrentTerminalFocusState(), "unknown");
});

test("installTerminalFocusState preserves a delayed CSI keyboard sequence", async () => {
    const terminal = new FocusTestTerminal();
    const owner = installTerminalFocusState(terminal);
    const inputs: string[] = [];
    try {
        terminal.start((data) => inputs.push(data));
        terminal.input("\x1b");
        await new Promise((resolve) => setTimeout(resolve, 10));
        terminal.input("[1;5C");

        assertEquals(inputs, ["\x1b[1;5C"]);
    } finally {
        owner.dispose();
    }
});

test("installTerminalFocusState drops a delayed suffix of an incomplete mouse report", async () => {
    const terminal = new FocusTestTerminal();
    const owner = installTerminalFocusState(terminal);
    const inputs: string[] = [];
    try {
        terminal.start((data) => inputs.push(data));
        terminal.input("\x1b");
        await new Promise((resolve) => setTimeout(resolve, 10));
        terminal.input("[<64;");
        await new Promise((resolve) => setTimeout(resolve, 70));
        terminal.input("1;1M");

        assertEquals(inputs, []);
    } finally {
        owner.dispose();
    }
});

test("installTerminalFocusState suppresses empty focus-only reports", () => {
    const terminal = new FocusTestTerminal();
    installTerminalFocusState(terminal);
    const inputs: string[] = [];

    terminal.start((data) => inputs.push(data));
    terminal.input("\x1b[I");
    terminal.input("\x1b[O");

    assertEquals(inputs, []);
});

test("terminal focus requests recovery only on gaining focus and preserves accompanying input", () => {
    const terminal = new FocusTestTerminal();
    let focusEvents = 0;
    const owner = installTerminalFocusState(terminal, () => focusEvents++);
    const inputs: string[] = [];
    try {
        terminal.start((data) => inputs.push(data));
        terminal.input("\x1b[");
        assertEquals(focusEvents, 0);
        terminal.input("Ihello");
        terminal.input("\x1b[I");
        assertEquals(focusEvents, 1);
        terminal.input("\x1b[O");
        assertEquals(focusEvents, 1);
        terminal.input("\x1b[I");
        assertEquals(focusEvents, 2);
        assertEquals(inputs, ["hello"]);
    } finally {
        owner.dispose();
    }
});
