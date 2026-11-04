import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { createThemeFromJson, mergeThemeJson } from "./theme-json.ts";
import type { ThemeJson } from "./theme-json.ts";

async function baseTheme(): Promise<ThemeJson> {
    return JSON.parse(await readFile(new URL("./catppuccin-mocha.json", import.meta.url), "utf8"));
}

test("partial external themes render nested custom colors while retaining default colors", async () => {
    const base = await baseTheme();
    const original = createThemeFromJson(base, { colorMode: "truecolor" });
    const theme = createThemeFromJson(
        mergeThemeJson(base, {
            name: "custom",
            vars: { accent: "nested", nested: "#abcdef", bg: "#111111" },
            colors: { accent: "accent", selectedBg: "bg", routingFeature: "#123456" },
        }),
        { colorMode: "truecolor" },
    );
    assertEquals(theme.name, "custom");
    assertEquals(theme.fg("accent", "RunWield"), "\x1b[38;2;171;205;239mRunWield\x1b[39m");
    assertEquals(theme.bg("selectedBg", "selected"), "\x1b[48;2;17;17;17mselected\x1b[49m");
    const token = "routingFeature" as Parameters<typeof theme.fg>[0];
    assertEquals(theme.fg(token, "Plan"), "\x1b[38;2;18;52;86mPlan\x1b[39m");
    assertEquals(theme.fg("warning", "unchanged"), original.fg("warning", "unchanged"));
});

test("invalid custom variable graphs are rejected before installing a Theme", async () => {
    const base = await baseTheme();
    for (const external of [
        { colors: { accent: "missing" } },
        { vars: { one: "two", two: "one" }, colors: { accent: "one" } },
    ]) {
        assertThrows(() => createThemeFromJson(mergeThemeJson(base, external), { colorMode: "truecolor" }), Error);
    }
});
