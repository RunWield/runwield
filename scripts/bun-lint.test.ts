import { assertEquals } from "../src/testing/assertions.ts";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { lintSource } from "./bun-lint.ts";
import mapping from "./bun-lint-rules.json" with { type: "json" };

interface LintCase {
    rule: string;
    source: string;
    filename?: string;
}
const cases: LintCase[] = [
    { rule: "parity/no-window-prefix", source: '// deno-lint-ignore no-window\nwindow.fetch("/");' },
    { rule: "parity/no-window", source: '// deno-lint-ignore no-window-prefix\nwindow.fetch("/");' },
    {
        rule: "no-inner-declarations",
        source: "export function f(condition) { if(condition) { function inner() { console.log(1); } inner(); } }",
    },
    {
        rule: "parity/jsx-button-has-type",
        source: 'export const button = <button type={kind ? "button" : "no"}/>;',
        filename: "case.tsx",
    },
    {
        rule: "parity/jsx-button-has-type",
        source: "export const button = <button type={`invalid`}/>;",
        filename: "case.tsx",
    },
    { rule: "@typescript-eslint/no-unused-vars", source: "export function f(unused: number) { return 1; }" },
    { rule: "@typescript-eslint/no-unused-vars", source: "try { console.log(1); } catch (unused) { console.log(2); }" },
    { rule: "@typescript-eslint/no-unused-vars", source: "const {unused, ...rest} = {unused: 1}; console.log(rest);" },
    { rule: "parity/no-import-assertions", source: 'void import("./x.json", {assert:{type:"json"}});' },
    {
        rule: "parity/jsx-button-has-type",
        source: 'export const button = <button {...props} type="invalid"/>;',
        filename: "case.tsx",
    },
    { rule: "parity/jsx-button-has-type", source: "export const button = <button type={5}/>;", filename: "case.tsx" },
    { rule: "parity/no-deprecated-deno-api", source: 'Deno["run"]({cmd:[]});' },
    { rule: "parity/no-empty-enum", source: "export enum Empty {}" },
    {
        rule: "parity/no-import-assertions",
        source: 'import value from "./x.json" assert {type:"json"}; console.log(value);',
    },
    { rule: "parity/no-unversioned-import", source: 'import "npm:chalk";' },
    { rule: "parity/no-unversioned-import", source: 'void import("jsr:@std/path");' },
    { rule: "parity/no-window", source: 'window.fetch("/");' },
    { rule: "parity/no-deprecated-deno-api", source: "Deno.run({cmd: []});" },
    {
        rule: "parity/no-invalid-triple-slash-reference",
        source: '/// <reference path="x" />\nexport {};',
        filename: "case.js",
    },
    { rule: "parity/ban-untagged-ignore", source: "// deno-lint-ignore\nexport {};" },
    { rule: "parity/no-this-alias", source: "export function f(){ const self=this; return self; }" },
    { rule: "parity/jsx-button-has-type", source: "export const button = <button/>;", filename: "case.tsx" },
    { rule: "@typescript-eslint/no-restricted-types", source: "export type Bad = String;" },
    { rule: "@typescript-eslint/no-explicit-any", source: "export type Bad = any;" },
    { rule: "runwield/no-module-scope-process-state", source: "export const home = getHomeDir();" },
];
for (const fixture of cases) {
    test(`portable lint rejects ${fixture.rule}: ${fixture.source}`, () => {
        const diagnostics = lintSource(fixture.source, fixture.filename ?? "case.ts");
        assert(diagnostics.some((diagnostic) => diagnostic.ruleId === fixture.rule), JSON.stringify(diagnostics));
    });
}

test("portable lint preserves scoped exceptions without rewriting strings or regular expressions", () => {
    for (
        const source of [
            'export const marker = "deno-lint-ignore no-explicit-any";',
            "export const marker = /deno-lint-ignore(-file)?/;",
            "// deno-lint-ignore no-explicit-any\nexport type Existing = any;",
            "export function f(window: { value: string }) { return window.value; }",
            'export const detected = typeof window === "undefined";',
            'import "npm:chalk@6.0.0";',
            "export enum Present { Yes }",
            "export const button = <button {...props}/>;",
        ]
    ) assertEquals(lintSource(source, "case.tsx"), [], source);
    assert(
        lintSource("// deno-lint-ignore no-explicit-any\nexport const value = 1;", "case.ts").some((diagnostic) =>
            diagnostic.message.includes("Unused eslint-disable")
        ),
    );
    assert(lintSource('/// <reference garbage="x" />\nexport {};', "case.ts").some((diagnostic) => diagnostic.fatal));
    assert(
        lintSource("export function f() { await Promise.resolve(); }", "case.ts").some((diagnostic) =>
            diagnostic.ruleId === "parity/no-await-in-sync-fn"
        ),
    );
});

test("every existing recommended rule has an explicit portable mapping or non-rule enforcement", () => {
    assertEquals(mapping.length, 87);
    assertEquals(new Set(mapping.map((entry) => entry.deno)).size, 87);
    assertEquals(mapping.filter((entry) => !entry.eslint).map((entry) => entry.deno).sort(), [
        "ban-unknown-rule-code", // Already excluded by the existing Deno gate.
        "ban-unused-ignore", // ESLint reportUnusedDisableDirectives.
        "no-sloppy-imports", // Only active with Deno's unused --unstable-sloppy-imports flag.
    ]);
});
