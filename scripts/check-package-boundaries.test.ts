import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { createPackageBoundaryLint, PACKAGE_SOURCE_PATTERN } from "./check-package-boundaries.ts";

interface RepositoryFiles {
    [file: string]: string;
}

async function makeRepository(context: TestContext, extraFiles: RepositoryFiles = {}) {
    const root = await mkdtemp(join(tmpdir(), "package-boundaries-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const alpha = "packages/alpha";
    const files = {
        "tsconfig.json": JSON.stringify({
            compilerOptions: {
                module: "Preserve",
                moduleResolution: "Bundler",
                paths: { "alpha-alias": [`./${alpha}/src/private.ts`] },
            },
            files: [`${alpha}/src/index.ts`],
        }),
        "workspace/tsconfig.json": JSON.stringify({
            extends: "../tsconfig.json",
            compilerOptions: { paths: { "workspace-alpha-alias": [`../${alpha}/src/private.ts`] } },
        }),
        [`${alpha}/package.json`]: JSON.stringify({
            name: "@sample/alpha",
            exports: {
                ".": { import: "./src/index.ts", types: "./src/index.d.ts" },
                "./public": "./src/public.ts",
                "./features/*": "./src/features/*.ts",
                "./features/private": null,
                "./features/internal/*": null,
            },
        }),
        [`${alpha}/src/index.ts`]: "export {};",
        [`${alpha}/src/private.ts`]: "export {};",
        "packages/plans/package.json": JSON.stringify({ name: "@runwield/plans", exports: "./index.ts" }),
        "packages/plans/index.ts": "export {};",
        "packages/beta/package.json": JSON.stringify({ name: "beta", exports: "./entry.ts" }),
        "packages/plugin/package.json": JSON.stringify({
            name: "@sample/plugin",
            files: ["exporter.ts"],
            wld: { metricsExporter: { entry: "./exporter.ts" } },
        }),
        ...extraFiles,
    };
    for (const [file, content] of Object.entries(files)) {
        await mkdir(dirname(join(root, file)), { recursive: true });
        await writeFile(join(root, file), content);
    }
    await symlink(join(root, alpha), join(root, "alpha-link"), "junction");
    const { lint, checkIndependence } = await createPackageBoundaryLint(root, Object.keys(files));
    const lintRepository = () => {
        const fileDiagnostics = Object.entries(files).flatMap(([file, source]) =>
            PACKAGE_SOURCE_PATTERN.test(file) ? lint(source, file) : [],
        );
        return [...fileDiagnostics, ...checkIndependence()];
    };
    return { root, lint, lintRepository };
}

test("checks private package specifiers and paths in runtime, type, and reexport syntax", async (context) => {
    const { root, lint } = await makeRepository(context);
    const source = [
        'import "@sample/alpha/src/private.ts";',
        'export * from "../packages/alpha/src/private.ts";',
        'export type Private = import("alpha-alias").Private;',
        'import fromCjs = require("../packages/alpha/src/private.ts");',
        "void import(`@sample/alpha/features/private`);",
        'module.require("../packages/alpha/src/private.ts");',
        'require("../packages/alpha/src/private.ts?raw");',
        'import "../packages/alpha/src/features/private.ts";',
        'import "@sample/alpha/features/internal/path";',
        'import "@sample/alpha/package.json";',
        `import ${JSON.stringify(pathToFileURL(join(root, "packages/alpha/src/private.ts")).href)};`,
        'import "../alpha-link/src/private.ts";',
    ].join("\n");

    const diagnostics = lint(source, "scripts/example.ts");
    assert.deepEqual(
        diagnostics.map(({ line }) => line),
        Array.from({ length: 12 }, (_, index) => index + 1),
    );
    assert.match(diagnostics[0].message, /@sample\/alpha\/src\/private\.ts.*packages\/alpha\/package\.json/);
    assert.equal(lint('import "../alpha/src/private.ts";', "packages/beta/test.ts").length, 1);
    assert.equal(
        lint(
            '/** @import { Private } from "@sample/alpha/src/private.ts" */\nexport const value = 1;',
            "src/example.js",
        ).length,
        1,
    );
});

test("preserves declared entry points, package-local paths and unrelated imports", async (context) => {
    const { lint } = await makeRepository(context);
    const source = [
        'import "@sample/alpha";',
        'import "@sample/alpha/public";',
        'export * from "@sample/alpha/features/visible";',
        'export * from "../packages/alpha/src/features/visible.ts";',
        'import "../packages/alpha/src/index.d.ts";',
        'import "../packages/plugin/exporter.ts";',
        'void import("beta");',
        'import "@sample/alpha-other/src/private.ts";',
        'import "node:fs";',
        '// import "../packages/alpha/src/private.ts";',
        'export const example = `import "../packages/alpha/src/private.ts";`;',
    ].join("\n");

    assert.deepEqual(lint(source, "src/example.ts"), []);
    assert.deepEqual(lint('import "./private.ts";', "packages/alpha/src/index.ts"), []);
    assert.deepEqual(lint('import "./xyz.ts";', "packages/beta/example.ts"), []);
});

test("checks Astro frontmatter and inline browser scripts", async (context) => {
    const { lint } = await makeRepository(context);
    const source = [
        "---",
        'import "@sample/alpha/src/private.ts";',
        "---",
        "<p>See @sample/alpha/src/private.ts for an example.</p>",
        "<script>",
        '  void import("../../packages/alpha/src/private.ts");',
        '  void import("workspace-alpha-alias");',
        "</script>",
    ].join("\n");
    assert.deepEqual(
        lint(source, "workspace/pages/example.astro").map(({ line }) => line),
        [2, 6, 7],
    );
});

test("checks executable Astro template expressions and skips literal markup", async (context) => {
    const { lint } = await makeRepository(context);
    const source = [
        "<p>Résumé</p>",
        '<p>{(await import("../packages/alpha/src/private.ts")).value.length}</p>',
        '<p title={(await import("@sample/alpha/src/private.ts")).label} />',
        '<p>{true && <span>{require("alpha-alias").value}</span>}</p>',
        '<p>{null as import("@sample/alpha/src/private.ts").Private}</p>',
        "<p>{await import(`@sample/alpha/src/private.ts`)}</p>",
        '<p>{await import("@sample/alpha")}</p>',
        "<p>{await import(",
        '  "@sample/alpha/src/private.ts"',
        ")}</p>",
        '<!-- {import("@sample/alpha/src/private.ts")} -->',
        "<p title='import(\"@sample/alpha/src/private.ts\")'>literal</p>",
    ].join("\n");
    assert.deepEqual(
        lint(source, "src/example.astro").map(({ line }) => line),
        [2, 3, 4, 5, 6, 9],
    );
});

test("applications consume extracted packages through their declared entry points", async (context) => {
    const { lint } = await makeRepository(context);
    const source = [
        'export * from "@runwield/plans";',
        'export type { PlanId } from "../packages/plans/index.ts";',
        'import { plans } from "@runwield/plans";',
        'export { adapt } from "./plan-adapter.ts";',
    ].join("\n");
    const diagnostics = lint(source, "src/plan-store.ts");
    assert.deepEqual(
        diagnostics.map(({ line }) => line),
        [1, 2],
    );
    assert.match(diagnostics[0].message, /Consumers must import @runwield\/plans directly/);
    assert.deepEqual(lint('export * from "@runwield/plans";', "packages/beta/entry.ts"), []);
});

test("application re-exports follow imported bindings to their package and report the export line", async (context) => {
    const { lint } = await makeRepository(context);
    const source = [
        "export type { LocalId as PublicId };",
        'import type { PlanId as LocalId } from "../packages/plans/index.ts";',
        'import { plans } from "@runwield/plans";',
        "export { plans as registry };",
        'import * as domain from "@runwield/plans";',
        "export default (domain);",
        'import adapter from "./adapter.ts";',
        "export { adapter };",
        "export function read(id: LocalId) { return plans.read(id); }",
        'import defaultExport from "@runwield/plans";',
        "export { defaultExport };",
        'import moduleBinding = require("@runwield/plans");',
        "export { moduleBinding as planModule };",
        'export { plans as externalPlans } from "./adapter.ts";',
        'const { plans: loaded } = require("@runwield/plans");',
        "export { loaded };",
        'const loadPlans = (await import("@runwield/plans")).plans;',
        "export { loadPlans as dynamicPlans };",
        "const adapted = makeAdapter(plans);",
        "export { adapted };",
        "const alias = plans;",
        "export const planRegistry = alias;",
        "export const derived = makeAdapter(plans);",
        "export const namespacePlans = domain.plans;",
    ].join("\n");
    const diagnostics = lint(source, "src/example.ts");
    assert.deepEqual(
        diagnostics.map(({ line }) => line),
        [1, 4, 6, 11, 13, 16, 18, 22, 24],
    );
    for (const diagnostic of diagnostics)
        assert.match(diagnostic.message, /Consumers must import @runwield\/plans directly/);
    assert.deepEqual(lint(source, "packages/beta/entry.ts"), []);
});

test("independent packages cannot reach root src through aliases, public exports, or other repo files", async (context) => {
    const { lintRepository } = await makeRepository(context, {
        "tsconfig.json": JSON.stringify({
            compilerOptions: {
                module: "Preserve",
                moduleResolution: "Bundler",
                paths: { "beta-alias": ["./packages/beta/entry.ts"], "app-alias": ["./src/app.ts"] },
            },
            files: ["packages/tools/index.ts"],
        }),
        "packages/tools/package.json": JSON.stringify({ name: "@runwield/tools", exports: "./index.ts" }),
        "packages/tools/index.ts": 'import "beta-alias";\nimport "./worker.ts";',
        "packages/tools/worker.ts": '/// <reference path="../../src/legacy.d.ts" />\nexport {};',
        "packages/beta/entry.ts": 'export type { Result } from "../../helpers/result.ts";',
        "helpers/result.ts": 'export type { Result } from "app-alias";',
        "src/app.ts": "export type Result = string;",
        "src/legacy.d.ts": "export {};",
        "packages/plans/index.ts": 'export type { Result } from "../../src/app.ts";',
    });
    assert.deepEqual(lintRepository(), [
        {
            file: "packages/tools/worker.ts",
            line: 1,
            message: "@runwield/tools depends on root src/: packages/tools/worker.ts -> src/legacy.d.ts.",
        },
        {
            file: "helpers/result.ts",
            line: 1,
            message:
                "@runwield/tools depends on root src/: packages/tools/index.ts -> packages/beta/entry.ts -> helpers/result.ts -> src/app.ts.",
        },
    ]);
});

test("reports type-only package cycles downstream of an independent package", async (context) => {
    const { lintRepository } = await makeRepository(context, {
        "packages/tools/package.json": JSON.stringify({ name: "@runwield/tools", exports: "./index.ts" }),
        "packages/tools/index.ts": 'export type { Value } from "beta";',
        "packages/beta/entry.ts": 'export type { Value } from "@runwield/plans";',
        "packages/plans/index.ts": 'export type Value = import("../../helpers/value.ts").Value;',
        "helpers/value.ts": 'export type Value = import("../packages/beta/entry.ts").Value;',
    });
    assert.deepEqual(lintRepository(), [
        {
            file: "helpers/value.ts",
            line: 1,
            message:
                "Package dependency cycle from @runwield/tools: @runwield/tools -> beta -> @runwield/plans -> beta.",
        },
    ]);
});

test("permits unrelated legacy dependencies and dependencies used only by another package's tests", async (context) => {
    const { lintRepository } = await makeRepository(context, {
        "packages/tools/package.json": JSON.stringify({ name: "@runwield/tools", exports: "./index.ts" }),
        "packages/tools/index.ts": 'export { result } from "beta";',
        "packages/beta/entry.ts": "export const result = 1;",
        "packages/beta/entry.test.ts": 'import "./test-fixture.ts";',
        "packages/beta/test-fixture.ts": 'import "@runwield/tools";\nimport "../../src/app.ts";',
        "packages/plans/index.ts": 'import "../../src/app.ts";\nimport "@sample/alpha";',
        "packages/alpha/src/index.ts": 'import "@runwield/plans";',
        "src/app.ts": "export {};",
    });
    assert.deepEqual(lintRepository(), []);
});

test("resolves triple-slash type directives through typeRoots instead of module aliases", async (context) => {
    const { lintRepository } = await makeRepository(context, {
        "tsconfig.json": JSON.stringify({
            compilerOptions: {
                module: "Preserve",
                moduleResolution: "Bundler",
                typeRoots: ["./src/types", "./node_modules/@types"],
                paths: { ambient: ["./src/module.ts"] },
            },
            files: ["packages/tools/index.ts"],
        }),
        "packages/tools/package.json": JSON.stringify({ name: "@runwield/tools", exports: "./index.ts" }),
        "packages/tools/index.ts": [
            '/// <reference types="legacy" />',
            '/// <reference types="ambient" />',
            'import "legacy";',
        ].join("\n"),
        "src/types/legacy/index.d.ts": "export {};",
        "node_modules/legacy/index.d.ts": "export {};",
        "node_modules/@types/ambient/index.d.ts": "export {};",
        "src/module.ts": "export {};",
    });
    assert.deepEqual(lintRepository(), [
        {
            file: "packages/tools/index.ts",
            line: 1,
            message: "@runwield/tools depends on root src/: packages/tools/index.ts -> src/types/legacy/index.d.ts.",
        },
    ]);
});

test("follows a triple-slash type directive through a package symlink", async (context) => {
    const { lintRepository, root } = await makeRepository(context, {
        "tsconfig.json": JSON.stringify({
            compilerOptions: { module: "Preserve", moduleResolution: "Bundler", preserveSymlinks: true },
            files: ["packages/tools/index.ts"],
        }),
        "packages/tools/package.json": JSON.stringify({ name: "@runwield/tools", exports: "./index.ts" }),
        "packages/tools/index.ts": '/// <reference types="legacy" />\nexport {};',
        "src/types/legacy/index.d.ts": "export {};",
        "node_modules/legacy/index.d.ts": "export {};",
    });
    await mkdir(join(root, "node_modules/@types"));
    await symlink(join(root, "src/types/legacy"), join(root, "node_modules/@types/legacy"), "junction");
    assert.deepEqual(lintRepository(), [
        {
            file: "packages/tools/index.ts",
            line: 1,
            message: "@runwield/tools depends on root src/: packages/tools/index.ts -> src/types/legacy/index.d.ts.",
        },
    ]);
});
