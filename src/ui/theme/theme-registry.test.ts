import { readFileSync } from "node:fs";
import { createThemeFromJson } from "./theme-json.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { createThemeRegistry } from "./theme-registry.ts";

function fixtureTheme(name: string): Theme {
    return createThemeFromJson(
        { ...JSON.parse(readFileSync(new URL("./catppuccin-mocha.json", import.meta.url), "utf8")), name },
        { colorMode: "truecolor" },
    );
}

test("createThemeRegistry always keeps the default theme available", () => {
    const defaultTheme = fixtureTheme("catppuccin-mocha");
    const registry = createThemeRegistry({
        defaultTheme,
        setGlobalTheme: () => {},
    });

    registry.setRegisteredThemes([]);
    assertEquals(registry.getAvailableThemes(), ["catppuccin-mocha"]);
});

test("createThemeRegistry does not allow external themes to override the built-in default", () => {
    const defaultTheme = fixtureTheme("catppuccin-mocha");
    const externalDefault = fixtureTheme("catppuccin-mocha");
    let current: Theme | null = null;
    const registry = createThemeRegistry({
        defaultTheme,
        setGlobalTheme: (theme) => {
            current = theme;
        },
    });

    registry.setRegisteredThemes([externalDefault, fixtureTheme("custom")]);
    const result = registry.setTheme("catppuccin-mocha");

    assertEquals(result, { success: true });
    assertEquals(current, defaultTheme);
    assertEquals(registry.getAvailableThemes(), ["catppuccin-mocha", "custom"]);
});

test("createThemeRegistry warns and keeps current theme when persisted theme is unavailable", () => {
    const defaultTheme = fixtureTheme("catppuccin-mocha");
    const customTheme = fixtureTheme("custom");
    let current = defaultTheme;
    const warnings: string[] = [];
    const registry = createThemeRegistry({
        defaultTheme,
        setGlobalTheme: (theme) => {
            current = theme;
        },
        warn: (message) => warnings.push(message),
    });

    registry.setRegisteredThemes([customTheme]);
    registry.setTheme("custom");
    const result = registry.applyPersistedThemeName("missing");

    assertEquals(result.success, false);
    assertEquals(current, customTheme);
    assertEquals(warnings, ['Persisted theme "missing" is not available. Keeping current theme.']);
});

test("createThemeRegistry notifies subscribers on successful swaps and isolates throwing listeners", () => {
    const defaultTheme = fixtureTheme("catppuccin-mocha");
    const customTheme = fixtureTheme("custom");
    const events: string[] = [];
    const warnings: string[] = [];
    const registry = createThemeRegistry({
        defaultTheme,
        setGlobalTheme: (theme) => events.push(`global:${theme.name}`),
        warn: (message) => warnings.push(message),
    });

    registry.setRegisteredThemes([customTheme]);
    registry.onChange(() => events.push("first"));
    registry.onChange(() => {
        throw new Error("boom");
    });
    const unsubscribe = registry.onChange(() => events.push("third"));

    assertEquals(registry.setTheme("custom"), { success: true });
    unsubscribe();
    assertEquals(registry.setTheme("missing").success, false);

    assertEquals(events, ["global:custom", "first", "third"]);
    assertEquals(warnings, ["Theme change listener threw: boom"]);
});
