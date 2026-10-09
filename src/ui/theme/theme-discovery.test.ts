import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { loadExternalThemeJsons } from "./theme-discovery.ts";

test("external theme discovery merges partial themes and skips built-in name overrides", async () => {
    const baseThemeJson = {
        name: "catppuccin-mocha",
        vars: { base: "#111111", accent: "#222222" },
        colors: { accent: "accent", text: "", selectedBg: "base" },
    };
    const files = {
        "/themes/custom.json": JSON.stringify({
            name: "custom",
            vars: { customAccent: "#abcdef" },
            colors: { accent: "customAccent" },
        }),
        "/themes/catppuccin-mocha.json": JSON.stringify({
            name: "catppuccin-mocha",
            colors: { accent: "#000000" },
        }),
    };
    const themes = await loadExternalThemeJsons({
        packageManager: {
            resolve: () =>
                Promise.resolve({
                    themes: [
                        { path: "/themes/custom.json" },
                        { path: "/themes/catppuccin-mocha.json" },
                    ],
                }),
        },
        readTextFile: (path) => files[path as keyof typeof files],
        defaultThemeName: "catppuccin-mocha",
        baseThemeJson,
    });

    assertEquals(themes, [{
        name: "custom",
        vars: { base: "#111111", accent: "#222222", customAccent: "#abcdef" },
        colors: { accent: "customAccent", text: "", selectedBg: "base" },
        export: {},
    }]);
});
