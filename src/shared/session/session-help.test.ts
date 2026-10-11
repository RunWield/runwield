import { assertEquals, assertNotStrictEquals } from "@std/assert";
import { getSessionKeyboardHelp } from "./session-help.ts";

Deno.test("Session keyboard help preserves current shortcut order and copy", () => {
    assertEquals(getSessionKeyboardHelp(), {
        title: "Keyboard shortcuts",
        items: [
            { key: "esc", description: "to interrupt" },
            { key: "ctrl+c", description: "to clear input" },
            { key: "ctrl+c twice", description: "to exit" },
            { key: "ctrl+l", description: "to redraw the terminal" },
            { key: "shift+tab", description: "to cycle thinking level" },
            { key: "ctrl+o", description: "to expand/collapse tool groups" },
            { key: "ctrl+]", description: "to switch Session sidebar tabs" },
            { key: "alt+]", description: "to open a Session artifact in the Markdown reader" },
            { key: "ctrl+t", description: "to toggle thinking block visibility" },
            { key: "ctrl+g", description: "for external editor (not-implemented)" },
            { key: "ctrl+v", description: "to paste image" },
            { key: "shift+enter", description: "to insert newline" },
            { key: "/", description: "for commands" },
            { key: "!", description: "to run bash" },
            { key: "!!", description: "to run bash (no context)" },
        ],
    });
});

Deno.test("Session keyboard help returns mutation-safe clones", () => {
    const first = getSessionKeyboardHelp();
    const second = getSessionKeyboardHelp();

    first.title = "changed";
    first.items[0].key = "changed";
    first.items.push({ key: "x", description: "changed" });

    assertNotStrictEquals(first, second);
    assertNotStrictEquals(first.items, second.items);
    assertEquals(second.title, "Keyboard shortcuts");
    assertEquals(second.items[0], { key: "esc", description: "to interrupt" });
    assertEquals(second.items.length, 15);
});
