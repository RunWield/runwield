import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDesktop, type DesktopEntry } from "./check-desktop.ts";
import { desktopRoot } from "./desktop-paths.ts";

async function fixture(target: DesktopEntry["target"], source: string, barrel: string): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "desktop-boundary-fixture-"));
    try {
        const entry = join(directory, "entry.ts");
        await writeFile(entry, source);
        await writeFile(join(directory, "innocent.ts"), barrel);
        await checkDesktop([{ target, entry }]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

const core = JSON.stringify(join(desktopRoot, "src/shared/session/root-session.js"));

test("real desktop runtime graphs and emitted local fonts/styles pass without production artifacts", async () => {
    await checkDesktop();
});

test("erased type imports and re-exports do not introduce runtime dependencies", async () => {
    await fixture(
        "renderer",
        'import type { Stats } from "node:fs"; export type { Stats } from "node:fs"; export { label } from "./innocent.ts";',
        `import type { createRootSessionManager } from ${core}; export type Open = typeof createRootSessionManager; export const label = "pure contract";`,
    );
});

for (const [name, barrel] of [
    ["runtime import", 'import { readFileSync } from "node:fs"; export const label = readFileSync;'],
    ["re-export", 'export { readFileSync as label } from "node:fs";'],
    ["dynamic import", 'export const label = () => import("node:fs");'],
]) {
    test(`renderer rejects a Node ${name} hidden behind a barrel`, async () => {
        await assert.rejects(
            fixture("renderer", 'export { label } from "./innocent.ts";', barrel),
            /Desktop renderer runtime dependency refused: node:fs/,
        );
    });
}

for (const dependency of ["electron", "astro", core]) {
    const specifier = dependency === core ? core : JSON.stringify(dependency);
    test(`renderer rejects hidden runtime dependency ${dependency}`, async () => {
        await assert.rejects(
            fixture("renderer", 'export * from "./innocent.ts";', `export * from ${specifier};`),
            /Desktop renderer runtime dependency refused:/,
        );
    });
}

for (const [name, barrel] of [
    ["Core execution/storage", `export * from ${core};`],
    ["Bun module", 'export * from "bun";'],
    ["Deno module", 'export const value = () => import("deno:fs");'],
    ["Bun global", 'export const value = () => Bun.file("private");'],
    ["Deno global", 'export const value = () => Deno.readTextFile("private");'],
    ["qualified Bun global", 'export const value = () => globalThis.Bun.file("private");'],
    ["non-literal dynamic import", "export const value = (path: string) => import(path);"],
]) {
    test(`Node main/client rejects hidden ${name}`, async () => {
        await assert.rejects(
            fixture("main", 'export * from "./innocent.ts";', barrel),
            /Desktop main runtime dependency refused:/,
        );
    });
}

for (const expression of ["process.cwd()", "Buffer.alloc(1)", 'globalThis["process"].cwd()']) {
    test(`renderer rejects hidden Node runtime global ${expression}`, async () => {
        await assert.rejects(
            fixture("renderer", 'export * from "./innocent.ts";', `export const value = () => ${expression};`),
            /Desktop renderer runtime dependency refused:/,
        );
    });
}

test("Node host refuses computed Bun runtime access", async () => {
    await assert.rejects(
        fixture(
            "main",
            'export * from "./innocent.ts";',
            'export const value = () => globalThis["Bun"].file("private");',
        ),
        /Desktop main runtime dependency refused:/,
    );
});

test("sandbox preload refuses Node builtins even though main can use them", async () => {
    await assert.rejects(
        fixture("preload", 'export * from "./innocent.ts";', 'export { readFile } from "node:fs/promises";'),
        /Desktop preload runtime dependency refused: node:fs\/promises/,
    );
    await fixture("main", 'export * from "./innocent.ts";', 'export { readFile } from "node:fs/promises";');
});

for (const [name, source] of [
    ["direct", `export * from ${JSON.stringify(join(desktopRoot, "src/ui/workspace/server/owner-projects.ts"))};`],
    [
        "dynamic",
        `export const load = () => import(${JSON.stringify(join(desktopRoot, "src/ui/workspace/server/owner-projects.ts"))});`,
    ],
    ["barrel", 'export * from "./innocent.ts";'],
]) {
    test(`Core refuses Workspace server ${name} dependencies`, async () => {
        await assert.rejects(
            fixture(
                "core",
                source,
                `export * from ${JSON.stringify(join(desktopRoot, "src/ui/workspace/server/owner-projects.ts"))};`,
            ),
            /Desktop core runtime dependency refused:/,
        );
    });
}

for (const dependency of ["src/ui/workspace/server.js", "src/ui/workspace/routes/api/review-handlers.ts"]) {
    for (const [name, barrel] of [
        [
            "import",
            `import * as host from ${JSON.stringify(join(desktopRoot, dependency))}; export const label = host;`,
        ],
        ["re-export", `export * from ${JSON.stringify(join(desktopRoot, dependency))};`],
        ["dynamic import", `export const load = () => import(${JSON.stringify(join(desktopRoot, dependency))});`],
    ]) {
        test(`Core refuses retained browser host ${dependency} ${name} through a barrel`, async () => {
            await assert.rejects(
                fixture("core", 'export * from "./innocent.ts";', barrel),
                /Desktop core runtime dependency refused:/,
            );
        });
    }
}
