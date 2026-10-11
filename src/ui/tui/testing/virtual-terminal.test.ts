import { assert, assertEquals } from "@std/assert";
import { normalizeScreenText, VirtualTerminal } from "./virtual-terminal.js";

type TerminalResizeCallback = NonNullable<Parameters<VirtualTerminal["start"]>[1]>;
type TerminalSize = Parameters<TerminalResizeCallback>[0];

Deno.test("VirtualTerminal captures writes in normalized viewport text", async () => {
    const terminal = new VirtualTerminal({ columns: 20, rows: 4 });
    terminal.write("hello\nworld");
    await terminal.flush();
    assert(terminal.getScreenText().includes("hello"));
    assert(terminal.getScreenText().includes("world"));
});

Deno.test("VirtualTerminal captures the active viewport after scrollback", async () => {
    const terminal = new VirtualTerminal({ columns: 20, rows: 3 });
    terminal.write("one\r\ntwo\r\nthree\r\nfour\r\nfive");
    await terminal.flush();
    const screenText = terminal.getScreenText();
    assert(!screenText.includes("one"));
    assert(screenText.includes("three"));
    assert(screenText.includes("five"));
});

Deno.test("VirtualTerminal sends input and resize through terminal callbacks", () => {
    const terminal = new VirtualTerminal({ columns: 20, rows: 4 });
    const input: string[] = [];
    const sizes: TerminalSize[] = [];
    terminal.start((data) => input.push(data), (size) => sizes.push(size));
    terminal.typeText("/help");
    terminal.pressEnter();
    terminal.pressEscape();
    terminal.resize(40, 10);
    assertEquals(input.join(""), "/help\r\x1b");
    assertEquals(sizes, [{ columns: 40, rows: 10 }]);
});

Deno.test("normalizeScreenText removes ansi control sequences and trailing space", () => {
    assertEquals(normalizeScreenText("\x1b[31mhello   \x1b[0m\n\n"), "hello");
});
