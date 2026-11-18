import ts from "typescript";
import { readFile } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { listCiFiles } from "./ci-files.ts";
import { PLAN_STORE_QUALIFICATIONS, PLAN_TEST_SUPPORT } from "./plan-store-boundary-qualification.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const configuration = ts.readConfigFile(resolve(root, "tsconfig.bun.json"), ts.sys.readFile);
const compilerOptions = ts.parseJsonConfigFileContent(configuration.config, ts.sys, root).options;
const privateMembers = new Set([
    "src/plan-store.js",
    // Existing retained-copy implementation. Its operations are public only through the owner interface.
    "src/shared/workflow/execution-plan-file.js",
]);
const pureSurface = "src/plan-format.ts";
const publicSurface = "src/plan-store/index.ts";

export interface PlanStoreBoundaryViolation {
    file: string;
    line: number;
    message: string;
}
function ownerMember(path: string): boolean {
    return path.startsWith("src/plan-store/") || privateMembers.has(path);
}
function relativeName(path: string): string {
    return relative(root, path).replaceAll("\\", "/");
}

/** Resolve real static/dynamic imports and reexports, including aliases from the repository TypeScript config. */
export function inspectPlanStoreImports(file: string, source: string): PlanStoreBoundaryViolation[] {
    const absolute = resolve(root, file);
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const constants = new Map<string, ts.Expression>();
    const collect = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
            constants.set(node.name.text, node.initializer);
        ts.forEachChild(node, collect);
    };
    collect(parsed);
    const literal = (node: ts.Node, depth = 0): string | undefined => {
        if (depth > 12) return undefined;
        if (ts.isStringLiteralLike(node)) return node.text;
        if (ts.isIdentifier(node)) {
            const value = constants.get(node.text);
            return value ? literal(value, depth + 1) : undefined;
        }
        if (ts.isParenthesizedExpression(node)) return literal(node.expression, depth + 1);
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
            const left = literal(node.left, depth + 1),
                right = literal(node.right, depth + 1);
            return left !== undefined && right !== undefined ? left + right : undefined;
        }
        if (ts.isTemplateExpression(node)) {
            let value = node.head.text;
            for (const span of node.templateSpans) {
                const part = literal(span.expression, depth + 1);
                if (part === undefined) return undefined;
                value += part + span.literal.text;
            }
            return value;
        }
        return undefined;
    };
    const violations: PlanStoreBoundaryViolation[] = [];
    const check = (node: ts.Node): void => {
        const specifier = literal(node);
        if (!specifier) return;
        const resolved = ts.resolveModuleName(specifier, absolute, compilerOptions, ts.sys).resolvedModule
            ?.resolvedFileName;
        const target = resolved
            ? relativeName(resolved)
            : specifier.startsWith(".")
              ? relativeName(resolve(dirname(absolute), specifier))
              : "";
        if ((PLAN_TEST_SUPPORT.has(target) || /\.(?:test|integration)\.[^.]+$/.test(target)) && !isTestCaller(file))
            violations.push({
                file,
                line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
                message: `Production code imports test-only Plan support ${specifier}.`,
            });
        if (
            !ownerMember(file) &&
            target !== publicSurface &&
            target !== pureSurface &&
            ownerMember(target) &&
            !PLAN_STORE_QUALIFICATIONS[file]?.modules.includes(target)
        )
            violations.push({
                file,
                line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
                message: `Private Plan persistence import ${specifier}; use a named Plan store operation.`,
            });
    };
    const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
            if (node.moduleSpecifier) check(node.moduleSpecifier);
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) check(node.argument.literal);
        else if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
            node.arguments[0]
        )
            check(node.arguments[0]);
        ts.forEachChild(node, visit);
        for (const comment of (node as ts.Node & { jsDoc?: readonly ts.JSDoc[] }).jsDoc || []) visit(comment);
    };
    visit(parsed);
    return violations;
}

/** Check the complete runtime graph; a pure facade cannot smuggle in persistence. */
export function inspectPlanFormatGraph(sources: ReadonlyMap<string, string>): PlanStoreBoundaryViolation[] {
    const violations: PlanStoreBoundaryViolation[] = [];
    const visited = new Set<string>();
    const visitFile = (file: string): void => {
        if (visited.has(file)) return;
        visited.add(file);
        const source = sources.get(file);
        if (source === undefined) return;
        const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
        const reject = (node: ts.Node, message: string): void => {
            violations.push({
                file,
                line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
                message,
            });
        };
        const inspect = (node: ts.Node): void => {
            if (
                ts.isCallExpression(node) &&
                (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                    (ts.isIdentifier(node.expression) && node.expression.text === "require"))
            ) {
                reject(node, "Plan format must use statically inspectable storage-free runtime imports.");
            }
            if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
                const typeOnly = ts.isImportDeclaration(node)
                    ? node.importClause?.isTypeOnly ||
                      Boolean(
                          node.importClause?.namedBindings &&
                          ts.isNamedImports(node.importClause.namedBindings) &&
                          !node.importClause.name &&
                          node.importClause.namedBindings.elements.every((entry) => entry.isTypeOnly),
                      )
                    : node.isTypeOnly ||
                      Boolean(
                          node.exportClause &&
                          ts.isNamedExports(node.exportClause) &&
                          node.exportClause.elements.every((entry) => entry.isTypeOnly),
                      );
                if (typeOnly || !node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) return;
                const specifier = node.moduleSpecifier.text;
                const resolved = ts.resolveModuleName(specifier, resolve(root, file), compilerOptions, ts.sys)
                    .resolvedModule?.resolvedFileName;
                const target = resolved
                    ? relativeName(resolved)
                    : specifier.startsWith(".")
                      ? relativeName(resolve(root, dirname(file), specifier))
                      : specifier;
                if (ownerMember(target) || /^(?:node:)?(?:fs|child_process|process)(?:\/|$)/.test(specifier))
                    reject(
                        node,
                        `Plan format runtime graph reaches persistence or environment I/O through ${specifier}.`,
                    );
                else if (target.startsWith("src/")) visitFile(target);
            }
            ts.forEachChild(node, inspect);
        };
        inspect(parsed);
    };
    visitFile(pureSurface);
    return violations;
}

function isTestCaller(file: string): boolean {
    return /\.(?:test|integration)\.[^.]+$/.test(file) || PLAN_TEST_SUPPORT.has(file);
}

/** Guard recognizable Plan paths, including destination paths; this is not general semantic taint analysis. */
export function inspectPlanFilesystemAccess(file: string, source: string): PlanStoreBoundaryViolation[] {
    if (ownerMember(file) || isTestCaller(file)) return [];
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const bindings = new Map<string, string>();
    const definitions = new Map<string, ts.Expression>();
    const filesystemModule = (specifier: string): boolean =>
        /^(?:node:)?fs(?:\/|$)|(?:atomic-text-file|private-json-file)\.ts$/.test(specifier);
    const addBindings = (pattern: ts.NamedImportBindings | ts.BindingName): void => {
        if (ts.isNamedImports(pattern))
            for (const entry of pattern.elements)
                bindings.set(entry.name.text, (entry.propertyName || entry.name).text);
        else if (ts.isObjectBindingPattern(pattern))
            for (const entry of pattern.elements) {
                if (ts.isIdentifier(entry.name))
                    bindings.set(entry.name.text, (entry.propertyName || entry.name).getText(parsed));
            }
        else if (ts.isNamespaceImport(pattern)) bindings.set(pattern.name.text, "*");
        else if (ts.isIdentifier(pattern)) bindings.set(pattern.text, "*");
    };
    for (const node of parsed.statements) {
        if (
            !ts.isImportDeclaration(node) ||
            !ts.isStringLiteral(node.moduleSpecifier) ||
            !filesystemModule(node.moduleSpecifier.text)
        )
            continue;
        if (node.importClause?.namedBindings) addBindings(node.importClause.namedBindings);
        if (node.importClause?.name) bindings.set(node.importClause.name.text, "*");
    }
    const collect = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && node.initializer) {
            if (ts.isIdentifier(node.name)) definitions.set(node.name.text, node.initializer);
            let initializer = node.initializer;
            if (ts.isAwaitExpression(initializer)) initializer = initializer.expression;
            if (
                ts.isCallExpression(initializer) &&
                (initializer.expression.kind === ts.SyntaxKind.ImportKeyword ||
                    (ts.isIdentifier(initializer.expression) && initializer.expression.text === "require")) &&
                initializer.arguments[0] &&
                ts.isStringLiteral(initializer.arguments[0]) &&
                filesystemModule(initializer.arguments[0].text)
            )
                addBindings(node.name);
        }
        ts.forEachChild(node, collect);
    };
    collect(parsed);
    const operation = (node: ts.Expression, depth = 0): string | undefined => {
        if (depth > 8) return undefined;
        if (ts.isIdentifier(node)) {
            const imported = bindings.get(node.text);
            if (imported) return imported;
            const value = definitions.get(node.text);
            return value ? operation(value, depth + 1) : undefined;
        }
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
            const receiver = node.expression;
            if (
                ts.isIdentifier(receiver) &&
                (bindings.get(receiver.text) === "*" || ["Bun", "Deno"].includes(receiver.text))
            ) {
                if (ts.isPropertyAccessExpression(node)) return node.name.text;
                if (ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
            }
        }
        return undefined;
    };
    const planPath = (node: ts.Node, depth = 0): boolean => {
        if (depth > 8) return false;
        if (
            /docs[\\/]plans|PLANS_DIR_NAME|(?:plan|controller)(?:s|Path|Dir|File|Document|\.path\b)|plan\.wld\.json/i.test(
                node.getText(parsed),
            )
        )
            return true;
        if (ts.isIdentifier(node)) {
            const value = definitions.get(node.text);
            return Boolean(value && planPath(value, depth + 1));
        }
        return false;
    };
    const violations: PlanStoreBoundaryViolation[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            const name = operation(node.expression);
            const indices = name && /^(?:rename|copyFile|cp|link|symlink)(?:Sync)?$/.test(name) ? [0, 1] : [0];
            if (name && indices.some((index) => node.arguments[index] && planPath(node.arguments[index])))
                violations.push({
                    file,
                    line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
                    message: "Direct filesystem access to a Plan path bypasses its owning operation.",
                });
        }
        ts.forEachChild(node, visit);
    };
    visit(parsed);
    return violations;
}

export async function checkPlanStoreProductionBoundary(): Promise<PlanStoreBoundaryViolation[]> {
    const violations: PlanStoreBoundaryViolation[] = [];
    const sources = new Map<string, string>();
    for (const file of await listCiFiles(root)) {
        if (!file.startsWith("src/") || !/\.(?:[cm]?[jt]sx?|astro)$/.test(file)) continue;
        const bytes = await readFile(resolve(root, file), "utf8");
        const source = file.endsWith(".astro")
            ? "\n" + (bytes.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)?.[1] || "")
            : bytes;
        sources.set(file, source);
        violations.push(...inspectPlanStoreImports(file, source), ...inspectPlanFilesystemAccess(file, source));
    }
    violations.push(...inspectPlanFormatGraph(sources));
    return violations;
}

if (import.meta.main) {
    const violations = await checkPlanStoreProductionBoundary();
    for (const violation of violations) console.error(`${violation.file}:${violation.line}: ${violation.message}`);
    console.log(`Plan store production boundary: ${violations.length} violation(s).`);
    process.exitCode = violations.length ? 1 : 0;
}
