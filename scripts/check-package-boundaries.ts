import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { convertToTsx, ExtractedScriptType } from "@astrojs/astro2tsx";
import ts from "typescript";

type ExportTarget = string | null | ExportTarget[] | ExportMap;
interface ExportMap {
    [key: string]: ExportTarget;
}

interface PackageManifest {
    name: string;
    exports?: ExportTarget;
    main?: string;
    module?: string;
    types?: string;
    wld?: { metricsExporter?: { entry: string } };
}

interface PackageBoundary {
    name: string;
    directory: string;
    entries: Map<string, string[]>;
    pluginEntry?: string;
}

interface PackageDiagnostic {
    file: string;
    line: number;
    message: string;
}

interface ModuleResolver {
    options: ts.CompilerOptions;
    cache: ts.ModuleResolutionCache;
}

interface SourcePiece {
    text: string;
    offset: number;
}

interface ModuleReference {
    specifier: string;
    offset: number;
}

export const PACKAGE_SOURCE_PATTERN = /\.(?:[cm]?[jt]sx?|astro|html)$/;

function asExportTargets(target: ExportTarget): string[] {
    if (target === null) return [];
    if (typeof target === "string") return target.startsWith("./") ? [target] : [];
    return Object.values(target).flatMap(asExportTargets);
}

function packageEntries(manifest: PackageManifest): Map<string, string[]> {
    const exports = manifest.exports;
    if (exports === undefined) {
        const targets = [manifest.main, manifest.module, manifest.types].flatMap((field) =>
            field ? [field.startsWith("./") ? field : `./${field}`] : [],
        );
        return new Map([[".", targets]]);
    }
    if (exports && typeof exports !== "string" && !Array.isArray(exports)) {
        const entries = Object.entries(exports).filter(([key]) => key === "." || key.startsWith("./"));
        if (entries.length) return new Map(entries.map(([key, target]) => [key, asExportTargets(target)]));
    }
    return new Map([[".", asExportTargets(exports)]]);
}

function wildcardMatch(pattern: string, value: string): string | undefined {
    const wildcard = pattern.indexOf("*");
    if (wildcard === -1) return undefined;
    const prefix = pattern.slice(0, wildcard);
    const suffix = pattern.slice(wildcard + 1);
    if (!value.startsWith(prefix) || !value.endsWith(suffix) || value.length <= prefix.length + suffix.length) return;
    return value.slice(prefix.length, value.length - suffix.length);
}

function entryForSubpath(boundary: PackageBoundary, subpath: string): string[] {
    const exact = boundary.entries.get(subpath);
    if (exact) return exact;
    const pattern = [...boundary.entries.keys()]
        .filter((entry) => wildcardMatch(entry, subpath) !== undefined)
        .sort((left, right) => right.indexOf("*") - left.indexOf("*") || right.length - left.length)[0];
    if (!pattern) return [];
    const match = wildcardMatch(pattern, subpath)!;
    return boundary.entries.get(pattern)!.map((target) => target.replaceAll("*", match));
}

function contains(directory: string, file: string): boolean {
    const path = relative(directory, file);
    return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function isPublicFile(boundary: PackageBoundary, target: string): boolean {
    if (boundary.pluginEntry === target) return true;
    const path = `./${relative(boundary.directory, target).split(sep).join("/")}`;
    for (const [entry, targets] of boundary.entries) {
        for (const targetPattern of targets) {
            if (targetPattern === path) return true;
            const match = wildcardMatch(targetPattern, path);
            if (match && entryForSubpath(boundary, entry.replace("*", match)).includes(path)) return true;
        }
    }
    return false;
}

function moduleSpecifier(node: ts.Node): ts.Node | undefined {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isJSDocImportTag(node))
        return node.moduleSpecifier;
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
        return node.moduleReference.expression;
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) return node.argument.literal;
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require") ||
        (ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression) &&
            callee.expression.text === "module" &&
            callee.name.text === "require")
    )
        return node.arguments[0];
}

function typescriptModuleReferences(file: string, piece: SourcePiece): ModuleReference[] {
    const tree = ts.createSourceFile(file, piece.text, ts.ScriptTarget.Latest, true);
    const references: ModuleReference[] = [];
    function visit(node: ts.Node): void {
        const specifier = moduleSpecifier(node);
        if (specifier && ts.isStringLiteralLike(specifier))
            references.push({ specifier: specifier.text, offset: piece.offset + specifier.getStart(tree) });
        ts.forEachChild(node, visit);
        if ("jsDoc" in node) {
            const documentation = node as ts.Node & { jsDoc?: readonly ts.JSDoc[] };
            documentation.jsDoc?.forEach(visit);
        }
    }
    visit(tree);
    return references;
}

function sourceModuleReferences(file: string, source: string): ModuleReference[] {
    if (file.endsWith(".astro")) {
        const { code, mappings, scripts } = convertToTsx(source, { filename: file });
        const references: ModuleReference[] = [];
        for (const { specifier, offset } of typescriptModuleReferences(`${file}.tsx`, { text: code, offset: 0 })) {
            const mapping = mappings.find(
                ([virtualStart, virtualLength, , originalLength]) =>
                    offset >= virtualStart && offset < virtualStart + Math.min(virtualLength, originalLength),
            );
            // Astro adds declarations for its generated component. Only mapped imports came from the file.
            if (!mapping) continue;
            const [virtualStart, , originalStart] = mapping;
            references.push({ specifier, offset: originalStart + offset - virtualStart });
        }
        for (const script of scripts) {
            if (script.type === ExtractedScriptType.Json) continue;
            references.push(
                ...typescriptModuleReferences(`${file}.ts`, {
                    text: script.content,
                    offset: script.position.start,
                }),
            );
        }
        return references;
    }
    if (file.endsWith(".html")) {
        return [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/dgi)].flatMap((match) => {
            const range = match.indices?.[1];
            return range
                ? typescriptModuleReferences(`${file}.ts`, { text: source.slice(...range), offset: range[0] })
                : [];
        });
    }
    return typescriptModuleReferences(file, { text: source, offset: 0 });
}

function physicalImport(specifier: string, importer: string): string | undefined {
    if (specifier.startsWith("file:")) {
        try {
            return fileURLToPath(specifier);
        } catch {
            return undefined;
        }
    }
    if (isAbsolute(specifier)) return resolve(specifier);
    if (/^\.\.?([\\/]|$)/.test(specifier)) return resolve(dirname(importer), specifier);
}

/** Discover package ownership and public entry points from first-party manifests. */
export async function createPackageBoundaryLint(repoRoot: string, files: readonly string[]) {
    const root = await realpath(repoRoot);
    const packages: PackageBoundary[] = await Promise.all(
        files
            .filter((file) => /^packages\/[^/]+\/package\.json$/.test(file))
            .map(async (file) => {
                const directory = resolve(root, dirname(file));
                const manifest: PackageManifest = JSON.parse(await readFile(join(root, file), "utf8"));
                const pluginEntry = manifest.wld?.metricsExporter?.entry;
                return {
                    name: manifest.name,
                    directory,
                    entries: packageEntries(manifest),
                    pluginEntry: pluginEntry && resolve(directory, pluginEntry),
                };
            }),
    );
    const byName = new Map(packages.map((boundary) => [boundary.name, boundary]));
    const packageAt = (file: string) => packages.find((boundary) => contains(boundary.directory, file));
    const configPaths = new Set(
        files.filter((file) => /(?:^|\/)tsconfig\.json$/.test(file)).map((file) => resolve(root, file)),
    );
    const resolvers = new Map<string, ModuleResolver>();
    function resolverFor(file: string): ModuleResolver {
        let directory = dirname(file);
        while (
            directory !== root &&
            dirname(directory) !== directory &&
            !configPaths.has(join(directory, "tsconfig.json"))
        ) {
            directory = dirname(directory);
        }
        const existing = resolvers.get(directory);
        if (existing) return existing;
        const config = ts.getParsedCommandLineOfConfigFile(
            join(directory, "tsconfig.json"),
            {},
            {
                ...ts.sys,
                onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
                    throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
                },
            },
        );
        const options = config?.options ?? {};
        const cache = ts.createModuleResolutionCache(directory, (path) => path, options);
        const resolver = { options, cache };
        resolvers.set(directory, resolver);
        return resolver;
    }

    function packageViolation(importer: string, owner: PackageBoundary | undefined, specifier: string) {
        const path = specifier.startsWith("#") ? specifier : specifier.replace(/[?#].*$/, "");
        const [first, second] = path.split("/");
        const packageName = first.startsWith("@") ? `${first}/${second}` : first;
        const named = byName.get(packageName);
        if (named) {
            const subpath = path === packageName ? "." : `.${path.slice(packageName.length)}`;
            return named !== owner && !entryForSubpath(named, subpath).length ? named : undefined;
        }

        const direct = physicalImport(path, importer);
        if (direct) {
            const target = packageAt(direct);
            if (target && (target === owner || isPublicFile(target, direct))) return;
        }
        const { options, cache } = resolverFor(importer);
        const loaded = ts.resolveModuleName(path, importer, options, ts.sys, cache).resolvedModule;
        const resolved = loaded?.resolvedFileName ?? direct;
        if (!resolved) return;
        const actual = ts.sys.realpath?.(resolved) ?? resolved;
        const target = packageAt(actual);
        if (target && target !== owner && !isPublicFile(target, actual)) return target;
    }

    return (source: string, file: string): PackageDiagnostic[] => {
        const importer = resolve(root, file);
        const owner = packageAt(importer);
        const references = sourceModuleReferences(file, source);
        const diagnostics: PackageDiagnostic[] = [];
        for (const { specifier, offset } of references.sort((left, right) => left.offset - right.offset)) {
            const boundary = packageViolation(importer, owner, specifier);
            if (boundary) {
                diagnostics.push({
                    file,
                    line: source.slice(0, offset).split("\n").length,
                    message: `Private import "${specifier}" from ${boundary.name}. Use an entry point declared in ${relative(root, join(boundary.directory, "package.json"))}.`,
                });
            }
        }
        return diagnostics;
    };
}
