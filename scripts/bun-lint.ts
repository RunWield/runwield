/** Portable equivalent of the project's existing recommended lint gate. */
import { TSESLint } from "@typescript-eslint/utils";
import ts from "typescript-eslint";
import react from "eslint-plugin-react";
import mapping from "./bun-lint-rules.json" with { type: "json" };
import { rules as parityRules } from "./lint-rules/bun-parity.ts";
import owned from "./lint-rules/no-module-scope-process-state.js";

const aliases = new Map(mapping.map((entry) => [entry.deno, entry.eslint]));
const rules: TSESLint.FlatConfig.Rules = Object.fromEntries(
    mapping.flatMap((entry) => entry.eslint ? [[entry.eslint, "error"]] : []),
);
Object.assign(rules, {
    "no-inner-declarations": ["error", "functions", { blockScopedFunctions: "disallow" }],
    "@typescript-eslint/ban-ts-comment": ["error", {
        "ts-ignore": "allow-with-description",
        "ts-nocheck": "allow-with-description",
        "ts-expect-error": "allow-with-description",
        minimumDescriptionLength: 1,
    }],
    "@typescript-eslint/no-unused-vars": ["error", {
        args: "all",
        varsIgnorePattern: "^_",
        argsIgnorePattern: "^_",
        caughtErrors: "all",
        caughtErrorsIgnorePattern: "^_",
        ignoreRestSiblings: false,
    }],
    "@typescript-eslint/no-empty-object-type": ["error", {
        allowInterfaces: "with-single-extends",
        allowObjectTypes: "always",
    }],
    "@typescript-eslint/no-restricted-types": ["error", {
        types: Object.fromEntries(
            ["Boolean", "String", "Number", "Symbol", "Function", "Object", "{}"].map((
                name,
            ) => [name, "Use an explicit primitive or signature."]),
        ),
    }],
    "runwield/no-module-scope-process-state": "error",
});

/** Preserve the existing rule-specific Deno suppressions while both gates run. */
function translateDirectives(source: string, filename: string): string {
    let comments;
    const parser = ts.parser as TSESLint.Parser.ParserModule;
    try {
        if (!("parseForESLint" in parser)) throw new Error("Pinned parser does not provide comments.");
        comments = parser.parseForESLint(source, {
            filePath: filename,
            ecmaFeatures: { jsx: true },
            comment: true,
            range: true,
        }).ast.comments ?? [];
    } catch {
        // Let ESLint report malformed source through its normal diagnostic path.
        return source;
    }
    let result = source;
    for (const comment of [...comments].reverse()) {
        if (!comment.range) continue;
        const original = source.slice(...comment.range);
        const match = original.match(/^\/\/\s*deno-lint-ignore(-file)?([^\n]*)$/);
        if (!match) continue;
        const [, whole, codes] = match;
        const names = codes.trim().split(/\s+/).map((code) =>
            aliases.get(code) ??
                (code === "runwield/no-module-scope-process-state" ? code : null)
        ).filter(Boolean);
        const replacement = names.length
            ? whole
                ? `/* eslint-disable ${[...new Set(names)].join(", ")} */`
                : `// eslint-disable-next-line ${[...new Set(names)].join(", ")}`
            : codes.trim()
            ? "// deno-lint-rule-unmapped"
            : original;
        result = result.slice(0, comment.range[0]) + replacement + result.slice(comment.range[1]);
    }
    return result;
}

const linter = new TSESLint.Linter();
export function lintSource(source: string, filename: string): TSESLint.Linter.LintMessage[] {
    return linter.verify(translateDirectives(source, filename), [{
        files: ["**/*.{js,jsx,ts,tsx,mjs,mts,cjs,cts}"],
        languageOptions: {
            parser: ts.parser as TSESLint.FlatConfig.Parser,
            parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },
        },
        plugins: {
            "@typescript-eslint": ts.plugin as TSESLint.FlatConfig.Plugin,
            react: { rules: react.rules } as TSESLint.FlatConfig.Plugin,
            parity: { rules: parityRules },
            runwield: owned,
        },
        rules,
        linterOptions: { reportUnusedDisableDirectives: true },
    }], { filename });
}
