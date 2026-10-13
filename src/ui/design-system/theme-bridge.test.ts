import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { DARK_BROWSER_THEME } from "./themes/dark.ts";
import type { BrowserThemeColors } from "./themes/dark.ts";
import { renderRunWieldThemeCss } from "./theme-bridge.ts";

test("browser theme defaults to the dark RunWield brand", () => {
    const css = renderRunWieldThemeCss();
    assertStringIncludes(css, '--rw-theme-name: "runwield-dark";');
    assertStringIncludes(css, "color-scheme: dark;");
    assertStringIncludes(css, "--rw-page-bg: #0b1020;");
    assertStringIncludes(css, "--rw-accent: #60a5fa;");
    assertStringIncludes(css, "--rw-brand: #85cbbf;");
});

test("browser theme preserves review component aliases", () => {
    const css = renderRunWieldThemeCss();
    assertStringIncludes(css, ".theme-runwield {");
    assertStringIncludes(css, "--card: var(--rw-surface);");
    assertStringIncludes(css, "--muted-foreground: var(--rw-text-muted);");
    assertStringIncludes(css, "--primary-foreground: var(--rw-on-accent);");
    assertStringIncludes(css, "--rw-radix-focus-ring: var(--rw-accent);");
    assertStringIncludes(css, "--font-sans: var(--rw-font-sans);");
    assertStringIncludes(css, "--font-mono: var(--rw-font-mono);");
});

test("another browser token set can replace colors without changing shared aliases or the default", () => {
    const original = renderRunWieldThemeCss();
    const css = renderRunWieldThemeCss({
        name: 'test "light"',
        colorScheme: "light",
        colors: {
            ...DARK_BROWSER_THEME.colors,
            "--rw-page-bg": "#ffffff",
            "--rw-text": "#102030",
            "--rw-accent": "#1255aa",
        },
    });
    assertStringIncludes(css, '--rw-theme-name: "test \\"light\\"";');
    assertStringIncludes(css, "color-scheme: light;");
    assertStringIncludes(css, "--rw-page-bg: #ffffff;");
    assertStringIncludes(css, "--rw-text: #102030;");
    assertStringIncludes(css, "--rw-accent: #1255aa;");
    assertEquals(css.slice(css.indexOf(".theme-runwield")), original.slice(original.indexOf(".theme-runwield")));
    assertEquals(renderRunWieldThemeCss(), original);
});

function luminance(hex: string): number {
    const channels = hex.slice(1).match(/../g)?.map((channel) => {
        const value = parseInt(channel, 16) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    assert(channels?.length === 3);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

type BrowserColorRole = keyof BrowserThemeColors;
type ContrastPair = [BrowserColorRole, BrowserColorRole];

test("browser text and action colors meet AA contrast on their surfaces", () => {
    const colors = DARK_BROWSER_THEME.colors;
    const textRoles: BrowserColorRole[] = [
        "--rw-text",
        "--rw-text-muted",
        "--rw-text-dim",
        "--rw-accent",
        "--rw-error",
    ];
    const surfaces: BrowserColorRole[] = ["--rw-page-bg", "--rw-surface", "--rw-surface-raised", "--rw-surface-muted"];
    const pairs: ContrastPair[] = [];
    for (const text of textRoles) {
        for (const surface of surfaces) pairs.push([text, surface]);
    }
    pairs.push(
        ["--rw-on-accent", "--rw-accent"],
        ["--rw-on-accent-strong", "--rw-accent-strong"],
        ["--rw-on-success", "--rw-success"],
        ["--rw-on-warning", "--rw-warning"],
        ["--rw-on-error", "--rw-error"],
        ["--rw-on-brand", "--rw-brand"],
    );
    for (const [foreground, background] of pairs) {
        const light = luminance(colors[foreground]);
        const dark = luminance(colors[background]);
        const ratio = (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
        assert(ratio >= 4.5, `${foreground} on ${background}: ${ratio.toFixed(2)}:1`);
    }
});
