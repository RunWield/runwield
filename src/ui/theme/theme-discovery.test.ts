import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExternalThemeJsons } from "./theme-discovery.ts";

test("external theme discovery merges partial themes and skips built-in name overrides", async () => {
    const baseThemeJson = {
        name: "catppuccin-mocha",
        vars: { base: "#111111", accent: "#222222" },
        colors: { accent: "accent", text: "", selectedBg: "base" },
    };
    const root = await mkdtemp(join(tmpdir(), "theme-discovery-"));
    try {
        await writeFile(
            join(root, "custom.json"),
            JSON.stringify({
                name: "custom",
                vars: { customAccent: "#abcdef" },
                colors: { accent: "customAccent" },
            }),
        );
        await writeFile(
            join(root, "catppuccin-mocha.json"),
            JSON.stringify({
                name: "catppuccin-mocha",
                colors: { accent: "#000000" },
            }),
        );
        const themes = await loadExternalThemeJsons({
            packageManager: {
                resolve: () =>
                    Promise.resolve({
                        themes: [{ path: join(root, "custom.json") }, { path: join(root, "catppuccin-mocha.json") }],
                    }),
            },
            readTextFile: (path) => readFile(path, "utf8"),
            defaultThemeName: "catppuccin-mocha",
            baseThemeJson,
        });

        assertEquals(themes, [
            {
                name: "custom",
                vars: { base: "#111111", accent: "#222222", customAccent: "#abcdef" },
                colors: { accent: "customAccent", text: "", selectedBg: "base" },
                export: {},
            },
        ]);
    } finally {
        await rm(root, { recursive: true });
    }
});
