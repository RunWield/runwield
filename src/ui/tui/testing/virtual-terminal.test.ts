import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../../testing/assertions.ts";
import { normalizeScreenText, VirtualTerminal } from "./virtual-terminal.js";
import type { IDisposable } from "@xterm/headless";

type TerminalResizeCallback = NonNullable<Parameters<VirtualTerminal["start"]>[1]>;
type TerminalSize = Parameters<TerminalResizeCallback>[0];

// The bundled headless declaration omits the parser's supported asynchronous return.
interface AsyncOscParser {
    registerOscHandler(identifier: number, callback: (data: string) => boolean | Promise<boolean>): IDisposable;
}

test("VirtualTerminal captures writes in normalized viewport text", async () => {
    const terminal = new VirtualTerminal({ columns: 20, rows: 4 });
    terminal.write("hello\nworld");
    await terminal.flush();
    assert(terminal.getScreenText().includes("hello"));
    assert(terminal.getScreenText().includes("world"));
});

test("VirtualTerminal captures the active viewport after scrollback", async () => {
    const terminal = new VirtualTerminal({ columns: 20, rows: 3 });
    terminal.write("one\r\ntwo\r\nthree\r\nfour\r\nfive");
    await terminal.flush();
    const screenText = terminal.getScreenText();
    assert(!screenText.includes("one"));
    assert(screenText.includes("three"));
    assert(screenText.includes("five"));
});

test("VirtualTerminal flush waits for the complete queued xterm write", async () => {
    const terminal = new VirtualTerminal({ columns: 40, rows: 3 });
    let resumeParser = (_accepted: boolean) => {};
    let parserEntered = () => {};
    const entered = new Promise<void>((resolve) => {
        parserEntered = resolve;
    });
    const blocked = new Promise<boolean>((resolve) => {
        resumeParser = resolve;
    });
    // Use xterm's real asynchronous escape parser to hold a frame in flight.
    const parser = terminal._xterm.parser as AsyncOscParser;
    const handler = parser.registerOscHandler(777, () => {
        parserEntered();
        return blocked;
    });
    terminal.write("\x1b]777;wait\x07complete final frame");
    let flushed = false;
    const flush = terminal.flush().then(() => {
        flushed = true;
    });
    try {
        await entered;
        await new Promise((resolve) => setTimeout(resolve, 25));
        assertEquals(flushed, false, "an unfinished xterm write must keep flush pending");
    } finally {
        resumeParser(true);
        await flush;
        handler.dispose();
    }
    assertStringIncludes(terminal.getScreenText(), "complete final frame");
});

test("VirtualTerminal sends input and resize through terminal callbacks", () => {
    const terminal = new VirtualTerminal({ columns: 20, rows: 4 });
    const input: string[] = [];
    const sizes: TerminalSize[] = [];
    terminal.start(
        (data) => input.push(data),
        (size) => sizes.push(size),
    );
    terminal.typeText("/help");
    terminal.pressEnter();
    terminal.pressEscape();
    terminal.resize(40, 10);
    assertEquals(input.join(""), "/help\r\x1b");
    assertEquals(sizes, [{ columns: 40, rows: 10 }]);
});

test("normalizeScreenText removes ansi control sequences and trailing space", () => {
    assertEquals(normalizeScreenText("\x1b[31mhello   \x1b[0m\n\n"), "hello");
});
