import { test } from "node:test";
import { assertEquals, assertThrows } from "../src/testing/assertions.ts";
import { bunArtifactTarget } from "./compile-bun.ts";
import bunAdapter from "../src/ui/workspace/integrations/bun-adapter.ts";

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
