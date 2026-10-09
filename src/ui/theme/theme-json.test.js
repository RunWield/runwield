import { assertEquals, assertThrows } from "@std/assert";
import { createThemeFromJson, mergeThemeJson, resolveThemeVars, splitFgBgColors } from "./theme-json.ts";

Deno.test("resolveThemeVars resolves nested references and leaves literals intact", () => {
    const resolved = resolveThemeVars({
        name: "test-theme",
        vars: {
            accent: "base",
            base: "#abcdef",
            indexed: 42,
        },
        colors: {
            accent: "accent",
            muted: "",
            warning: "indexed",
            selectedBg: "#111111",
        },
    });

    assertEquals(resolved.colors, {
        accent: "#abcdef",
        muted: "",
        warning: 42,
        selectedBg: "#111111",
    });
});

Deno.test("resolveThemeVars reports missing and circular variables", () => {
    assertThrows(
        () =>
            resolveThemeVars({
                colors: { accent: "missing" },
            }),
        Error,
        "Variable reference not found: missing",
    );

    assertThrows(
        () =>
            resolveThemeVars({
                vars: { one: "two", two: "one" },
                colors: { accent: "one" },
            }),
        Error,
        "Circular variable reference",
    );
});

Deno.test("mergeThemeJson supports partial external themes", () => {
    const base = {
        name: "catppuccin-mocha",
        vars: { base: "#111111", accent: "#222222" },
        colors: { accent: "accent", text: "", selectedBg: "base" },
        export: { pageBg: "base" },
    };
    const external = {
        name: "custom",
        vars: { customAccent: "#abcdef" },
        colors: { accent: "customAccent" },
    };

    const merged = mergeThemeJson(base, external);
    const resolved = resolveThemeVars(merged);

    assertEquals(merged.name, "custom");
    assertEquals(resolved.colors, {
        accent: "#abcdef",
        text: "",
        selectedBg: "#111111",
    });
    assertEquals(merged.export, { pageBg: "base" });
});

Deno.test("splitFgBgColors separates Pi foreground and background tokens", () => {
    const split = splitFgBgColors({
        accent: "#abcdef",
        selectedBg: "#111111",
        toolErrorBg: 52,
        text: "",
    });

    assertEquals(split.fgColors, { accent: "#abcdef", text: "" });
    assertEquals(split.bgColors, { selectedBg: "#111111", toolErrorBg: 52 });
});

Deno.test("embedded theme supplies workflow footer tokens and partial overrides can replace them", async () => {
    const base = JSON.parse(await Deno.readTextFile(new URL("./catppuccin-mocha.json", import.meta.url)));
    const merged = mergeThemeJson(base, {
        name: "custom-workflow",
        vars: { custom: "#123456" },
        colors: { routingFeature: "custom" },
    });
    const resolved = resolveThemeVars(merged);

    assertEquals(resolved.colors.routingQuickFix, "#94e2d5");
    assertEquals(resolved.colors.routingFeature, "#123456");
    assertEquals(resolved.colors.routingEpic, "#cba6f7");
    assertEquals(resolved.colors.complexityLow, "#a6e3a1");
    assertEquals(resolved.colors.complexityMedium, "#f9e2af");
    assertEquals(resolved.colors.complexityHigh, "#f38ba8");
});

Deno.test("createThemeFromJson constructs the real Pi Theme from resolved colors", async () => {
    const base = JSON.parse(await Deno.readTextFile(new URL("./catppuccin-mocha.json", import.meta.url)));
    const theme = createThemeFromJson(
        mergeThemeJson(base, {
            name: "custom",
            vars: { accent: "#abcdef", bg: "#111111" },
            colors: { accent: "accent", selectedBg: "bg" },
        }),
        { colorMode: "256color" },
    );

    assertEquals(theme.name, "custom");
    assertEquals(theme.fg("accent", "RunWield").includes("RunWield"), true);
    assertEquals(theme.bg("selectedBg", "RunWield").includes("RunWield"), true);
});
