/** Reject executable Deno APIs in first-party code, including tooling outside src/scripts. */
import ts from "typescript";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listCiFiles } from "./ci-files.ts";

export interface RuntimeDiagnostic {
    file: string;
    line: number;
    message: string;
}

interface RepositoryHook {
    command?: string;
}
interface RepositoryHookGroup {
    hooks: RepositoryHook[];
}
interface RepositoryCommands {
    scripts?: Record<string, string>;
    verification_command?: string;
    hooks?: Record<string, RepositoryHookGroup[]>;
}

// This explicit external compatibility probe intentionally launches the older runtime.
// It is never imported by product code or ordinary tests.
const LEGACY_INTEROPERABILITY = "scripts/check-lock-interoperability.ts";
const PROCESS_CALLS = new Set([
    "spawn",
    "spawnSync",
    "execFile",
    "execFileSync",
    "captureScriptProcess",
    "spawnNativeProcess",
    "captureForegroundProcess",
    "spawnForegroundProcess",
]);

function literal(node: ts.Node | undefined): string | undefined {
    if (!node) return undefined;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isCallExpression(node) && node.expression.getText() === "String") return literal(node.arguments[0]);
    return undefined;
}

export function auditRuntimeSource(source: string, file: string): RuntimeDiagnostic[] {
    if (file === LEGACY_INTEROPERABILITY) return [];
    const diagnostics: RuntimeDiagnostic[] = [];
    // Astro frontmatter and inline scripts are executable; markup and sample prose are not.
    const pieces = /\.(astro|html)$/.test(file)
        ? [...source.matchAll(/(?:^---\r?\n([\s\S]*?)\r?\n---|<script\b[^>]*>([\s\S]*?)<\/script>)/g)].map((match) => ({
              text: match[1] ?? match[2],
              offset: match.index + match[0].indexOf(match[1] ?? match[2]),
          }))
        : [{ text: source, offset: 0 }];
    for (const piece of pieces) {
        const tree = ts.createSourceFile(
            file,
            piece.text,
            ts.ScriptTarget.Latest,
            true,
            /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        );
        const report = (node: ts.Node, message: string) => {
            diagnostics.push({
                file,
                line: source.slice(0, piece.offset + node.getStart(tree)).split("\n").length,
                message,
            });
        };
        const walk = (node: ts.Node): void => {
            if (ts.isIdentifier(node) && node.text === "Deno") report(node, "Deno API reference in owned code");
            if (
                ts.isPropertyAccessExpression(node) &&
                node.name.text === "deno" &&
                /(?:^|\.)versions$/.test(node.expression.getText(tree))
            ) {
                report(node, "Retired Deno runtime branch");
            }
            if (ts.isElementAccessExpression(node) && literal(node.argumentExpression) === "Deno") {
                report(node, "Computed Deno API reference");
            }
            if (ts.isCallExpression(node)) {
                const callee = node.expression.getText(tree);
                if (callee === "Reflect.get" && literal(node.arguments[1]) === "Deno")
                    report(node, "Reflected Deno API reference");
                if (PROCESS_CALLS.has(callee.split(".").at(-1) || "") && literal(node.arguments[0]) === "deno") {
                    report(node, "Deno subprocess in owned code");
                }
                if (
                    (node.expression.kind === ts.SyntaxKind.ImportKeyword || callee === "require") &&
                    /^(jsr|npm):/.test(literal(node.arguments[0]) || "")
                ) {
                    report(node, "Runtime registry import bypasses the frozen Bun graph");
                }
            }
            if (
                (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
                /^(jsr|npm):/.test(literal(node.moduleSpecifier) || "")
            ) {
                report(node, "Runtime registry import bypasses the frozen Bun graph");
            }
            ts.forEachChild(node, walk);
        };
        walk(tree);
    }
    if (/^#![^\n]*\bdeno\b/.test(source)) diagnostics.push({ file, line: 1, message: "Deno executable shebang" });
    return diagnostics;
}

export async function checkOwnedRuntime(root: string): Promise<RuntimeDiagnostic[]> {
    const diagnostics: RuntimeDiagnostic[] = [];
    const files = await listCiFiles(root);
    for (const file of files.filter((file) => /\.(?:[cm]?[jt]sx?|astro|html)$/.test(file))) {
        diagnostics.push(...auditRuntimeSource(await readFile(join(root, file), "utf8"), file));
    }
    // listCiFiles excludes mutable .wld state; inspect only the repository's command default.
    for (const file of ["package.json", "docs-site/package.json", ".claude/settings.json", ".wld/settings.json"]) {
        const source = await readFile(join(root, file), "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return "{}";
            throw error;
        });
        const config: RepositoryCommands = JSON.parse(source);
        const commands: string[] = file.endsWith("package.json")
            ? Object.values(config.scripts || {})
            : file === ".wld/settings.json"
              ? [config.verification_command || ""]
              : Object.values(config.hooks || {}).flatMap((groups) =>
                    groups.flatMap((group) => group.hooks.map((hook) => hook.command || "")),
                );
        if (commands.some((command) => /\bdeno(?:\s|$)/.test(command))) {
            diagnostics.push({ file, line: 1, message: "Repository command still invokes Deno" });
        }
    }
    return diagnostics;
}

if (import.meta.main) {
    const diagnostics = await checkOwnedRuntime(dirname(dirname(fileURLToPath(import.meta.url))));
    for (const diagnostic of diagnostics) console.error(`${diagnostic.file}:${diagnostic.line}: ${diagnostic.message}`);
    if (diagnostics.length) process.exitCode = 1;
    else console.log("Owned runtime audit passed: no Deno APIs, executable defaults, or registry imports.");
}
