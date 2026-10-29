import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertEquals, assertThrows } from "../src/testing/assertions.ts";
import { bunArtifactTarget, PASSIVE_PATHS } from "./compile-bun.ts";
import bunAdapter from "../src/ui/workspace/integrations/bun-adapter.ts";

test("compiled Workspace includes the unbundled shell's browser imports", async () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const shell = await readFile(new URL("../src/ui/workspace/static/workspace-shell.ts", import.meta.url), "utf8");
    const imports = [...shell.matchAll(/from\s+["']([^"']+)["']/g)];
    assert(imports.length > 0);
    for (const [, specifier] of imports) {
        const browserPath = new URL(specifier, "https://workspace.test/workspace-shell.js").pathname;
        const path = resolve(root, `src/ui${browserPath}`);
        assert((await stat(path)).isFile());
        const packaged = relative(root, path).replaceAll("\\", "/");
        assert(
            PASSIVE_PATHS.some((entry) => packaged === entry || packaged.startsWith(`${entry}/`)),
            `Missing browser dependency in compiled Workspace: ${browserPath}`,
        );
    }
});

test("Bun artifacts keep release platform triples across every supported compiler target", () => {
    for (const [compiler, artifact] of [
        ["bun-darwin-arm64", "aarch64-apple-darwin"],
        ["bun-darwin-x64", "x86_64-apple-darwin"],
        ["bun-linux-arm64", "aarch64-unknown-linux-gnu"],
        ["bun-linux-x64", "x86_64-unknown-linux-gnu"],
        ["bun-windows-arm64", "aarch64-pc-windows-msvc"],
        ["bun-windows-x64", "x86_64-pc-windows-msvc"],
    ])
        assertEquals(bunArtifactTarget(compiler), artifact);
    assertThrows(() => bunArtifactTarget("bun-freebsd-x64"), Error, "Unsupported Bun target");
});

test("Bun Workspace adapter serializes identical static asset membership consistently", () => {
    const hook = bunAdapter().hooks["astro:build:ssr"];
    const first = {
        assets: ["/pwa/icon.png", "/workspace-styles/review.css", "/workspace.js"],
        routes: ["/plans", "/"],
    };
    const second = {
        assets: ["/workspace.js", "/workspace-styles/review.css", "/pwa/icon.png"],
        routes: ["/plans", "/"],
    };
    hook({ manifest: first });
    hook({ manifest: second });
    assertEquals(first.assets, ["/pwa/icon.png", "/workspace-styles/review.css", "/workspace.js"]);
    assertEquals(JSON.stringify(first), JSON.stringify(second));
    assertEquals(first.routes, ["/plans", "/"]);
});
