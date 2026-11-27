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
    typeReferenceCache: ts.TypeReferenceDirectiveResolutionCache;
}

interface SourcePiece {
    text: string;
    offset: number;
}

interface ModuleReference {
    specifier: string;
    offset: number;
    reexport: boolean;
    typeDirective?: ts.FileReference;
}

interface ResolvedImport {
    named?: PackageBoundary;
    entries: string[];
    direct?: string;
    actual?: string;
}

interface ModuleDependency {
    importer: string;
    target: string;
    line: number;
}

// Add each package here once its implementation has moved out of the application.
const INDEPENDENT_PACKAGES = new Set([
    "@runwield/tools",
    "@runwield/agents",
    "@runwield/projects",
    "@runwield/project-runtime",
]);

// Keep the lookup path so the boundary check can inspect it as well as the real path.
const TYPE_REFERENCE_HOST: ts.ModuleResolutionHost = { ...ts.sys, realpath: undefined };

const EXTRACTED_DOMAIN_PACKAGES = new Set([
    "@runwield/acp",
    "@runwield/tools",
    "@runwield/agents",
    "@runwield/projects",
    "@runwield/project-runtime",
    "@runwield/pi-ai",
    "@runwield/plans",
    "@runwield/session-runtime",
    "@runwield/workflow",
]);

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

/** A module URL resolved for another loader, such as a child process. */
function resolvedModuleSpecifier(node: ts.Node): ts.Expression | undefined {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const { expression, name } = node.expression;
    if (
        name.text === "resolve" &&
        ts.isMetaProperty(expression) &&
        expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
        expression.name.text === "meta"
    )
        return node.arguments[0];
}

/** Find a directly forwarded binding or module load. Calls that construct application values stop the lookup. */
function forwardedValue(expression: ts.Expression): ts.Expression {
    while (
        ts.isAwaitExpression(expression) ||
        ts.isParenthesizedExpression(expression) ||
        ts.isPropertyAccessExpression(expression) ||
        ts.isElementAccessExpression(expression) ||
        ts.isAsExpression(expression) ||
        ts.isTypeAssertionExpression(expression) ||
        ts.isSatisfiesExpression(expression) ||
        ts.isNonNullExpression(expression)
    )
        expression = expression.expression;
    return expression;
}

function importBindingNames(binding: ts.BindingName): ts.Identifier[] {
    if (ts.isIdentifier(binding)) return [binding];
    return binding.elements.flatMap((item) => (ts.isBindingElement(item) ? importBindingNames(item.name) : []));
}

/** Pair exports of local import bindings with their original module, regardless of declaration order. */
function localReexports(
    statements: ts.NodeArray<ts.Statement>,
    tree: ts.SourceFile,
    offset: number,
): ModuleReference[] {
    const imports = new Map<string, string>();
    const aliases = new Map<string, string>();
    const exported: ts.ModuleExportName[] = [];
    for (const statement of statements) {
        if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
            const source = statement.moduleSpecifier.text;
            const clause = statement.importClause;
            if (clause?.name) imports.set(clause.name.text, source);
            const bindings = clause?.namedBindings;
            if (bindings && ts.isNamespaceImport(bindings)) imports.set(bindings.name.text, source);
            if (bindings && ts.isNamedImports(bindings)) {
                for (const { name } of bindings.elements) imports.set(name.text, source);
            }
        } else if (ts.isVariableStatement(statement)) {
            const exportedHere = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
            for (const { name, initializer } of statement.declarationList.declarations) {
                if (!initializer) continue;
                const value = forwardedValue(initializer);
                const source = moduleSpecifier(value);
                if (source && ts.isStringLiteralLike(source)) {
                    for (const binding of importBindingNames(name)) {
                        imports.set(binding.text, source.text);
                        if (exportedHere) exported.push(binding);
                    }
                } else if (statement.declarationList.flags & ts.NodeFlags.Const && ts.isIdentifier(value)) {
                    for (const binding of importBindingNames(name)) {
                        aliases.set(binding.text, value.text);
                        if (exportedHere) exported.push(binding);
                    }
                }
            }
        } else if (ts.isImportEqualsDeclaration(statement)) {
            const source = moduleSpecifier(statement);
            if (source && ts.isStringLiteralLike(source)) imports.set(statement.name.text, source.text);
        } else if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause) {
            if (ts.isNamedExports(statement.exportClause)) {
                for (const item of statement.exportClause.elements) exported.push(item.propertyName ?? item.name);
            }
        } else if (ts.isExportAssignment(statement)) {
            const value = forwardedValue(statement.expression);
            if (ts.isIdentifier(value)) exported.push(value);
        }
    }
    return exported.flatMap((name) => {
        let binding = name.text;
        const seen = new Set<string>();
        while (aliases.has(binding) && !seen.has(binding)) {
            seen.add(binding);
            binding = aliases.get(binding)!;
        }
        const specifier = imports.get(binding);
        return specifier ? [{ specifier, offset: offset + name.getStart(tree), reexport: true }] : [];
    });
}

function typescriptModuleReferences(file: string, piece: SourcePiece): ModuleReference[] {
    const tree = ts.createSourceFile(file, piece.text, ts.ScriptTarget.Latest, true);
    const references: ModuleReference[] = [
        ...tree.referencedFiles.map(({ fileName, pos }) => ({
            specifier: physicalImport(fileName, file) === undefined ? `./${fileName}` : fileName,
            offset: piece.offset + pos,
            reexport: false,
        })),
        ...tree.typeReferenceDirectives.map((typeDirective) => ({
            specifier: typeDirective.fileName,
            offset: piece.offset + typeDirective.pos,
            reexport: false,
            typeDirective,
        })),
    ];
    function visit(node: ts.Node): void {
        if (ts.isSourceFile(node) || ts.isModuleBlock(node)) {
            references.push(...localReexports(node.statements, tree, piece.offset));
        }
        const specifier = moduleSpecifier(node) ?? resolvedModuleSpecifier(node);
        if (specifier && ts.isStringLiteralLike(specifier))
            references.push({
                specifier: specifier.text,
                offset: piece.offset + specifier.getStart(tree),
                reexport:
                    ts.isExportDeclaration(node) ||
                    (ts.isImportEqualsDeclaration(node) &&
                        (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0),
            });
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
        for (const reference of typescriptModuleReferences(`${file}.tsx`, { text: code, offset: 0 })) {
            const { offset } = reference;
            const mapping = mappings.find(
                ([virtualStart, virtualLength, , originalLength]) =>
                    offset >= virtualStart && offset < virtualStart + Math.min(virtualLength, originalLength),
            );
            // Astro adds declarations for its generated component. Only mapped imports came from the file.
            if (!mapping) continue;
            const [virtualStart, , originalStart] = mapping;
            references.push({ ...reference, offset: originalStart + offset - virtualStart });
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

function checkRootSourceDependencies(
    root: string,
    rootSource: string,
    boundary: PackageBoundary,
    dependencies: ReadonlyMap<string, ModuleDependency[]>,
): PackageDiagnostic[] {
    const diagnostics: PackageDiagnostic[] = [];
    const startingFiles = [...dependencies.keys()].filter((file) => contains(boundary.directory, file));
    const queue = [...startingFiles];
    const parents = new Map<string, string | undefined>(startingFiles.map((file) => [file, undefined]));
    for (const importer of queue) {
        for (const edge of dependencies.get(importer) ?? []) {
            if (contains(rootSource, edge.target)) {
                const path = [edge.target];
                for (let file: string | undefined = importer; file !== undefined; file = parents.get(file)) {
                    path.push(file);
                }
                diagnostics.push({
                    file: relative(root, importer),
                    line: edge.line,
                    message: `${boundary.name} depends on root src/: ${path
                        .reverse()
                        .map((file) => relative(root, file))
                        .join(" -> ")}.`,
                });
            } else if (!parents.has(edge.target) && dependencies.has(edge.target)) {
                parents.set(edge.target, importer);
                queue.push(edge.target);
            }
        }
    }
    return diagnostics;
}

function isTestFile(file: string): boolean {
    return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
}

function checkPackageCycles(
    root: string,
    boundary: PackageBoundary,
    dependencies: ReadonlyMap<PackageBoundary, Map<PackageBoundary, ModuleDependency>>,
): PackageDiagnostic[] {
    const visited = new Set<PackageBoundary>();
    const path = new Set<PackageBoundary>();
    function visit(owner: PackageBoundary): PackageDiagnostic | undefined {
        visited.add(owner);
        path.add(owner);
        for (const [target, edge] of dependencies.get(owner) ?? []) {
            if (path.has(target)) {
                const names = [...path, target].map(({ name }) => name).join(" -> ");
                return {
                    file: relative(root, edge.importer),
                    line: edge.line,
                    message: `Package dependency cycle from ${boundary.name}: ${names}.`,
                };
            }
            if (!visited.has(target)) {
                const cycle = visit(target);
                if (cycle) return cycle;
            }
        }
        path.delete(owner);
    }
    const cycle = visit(boundary);
    return cycle ? [cycle] : [];
}

/** Discover package ownership and public entry points from first-party manifests. */
export async function createPackageBoundaryLint(repoRoot: string, files: readonly string[]) {
    const root = await realpath(repoRoot);
    const rootSource = join(root, "src");
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
    const fileDependencies = new Map<string, ModuleDependency[]>();
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
        const typeReferenceCache = ts.createTypeReferenceDirectiveResolutionCache(
            directory,
            (path) => path,
            options,
            cache.getPackageJsonInfoCache(),
        );
        const resolver = { options, cache, typeReferenceCache };
        resolvers.set(directory, resolver);
        return resolver;
    }

    function resolveImport({ specifier, typeDirective }: ModuleReference, importer: string): ResolvedImport {
        const { options, cache, typeReferenceCache } = resolverFor(importer);
        if (typeDirective) {
            const mode =
                typeDirective.resolutionMode ?? ts.getImpliedNodeFormatForFile(importer, cache, ts.sys, options);
            const { resolvedTypeReferenceDirective } = ts.resolveTypeReferenceDirective(
                specifier,
                importer,
                options,
                TYPE_REFERENCE_HOST,
                undefined,
                typeReferenceCache,
                mode,
            );
            const resolved = resolvedTypeReferenceDirective?.resolvedFileName;
            return {
                entries: [],
                direct: resolved,
                actual: resolved && canonicalPath(resolved),
            };
        }
        const path = specifier.startsWith("#") ? specifier : specifier.replace(/[?#].*$/, "");
        const [first, second] = path.split("/");
        const packageName = first.startsWith("@") ? `${first}/${second}` : first;
        const named = byName.get(packageName);
        const subpath = path === packageName ? "." : `.${path.slice(packageName.length)}`;
        const entries = named ? entryForSubpath(named, subpath) : [];
        const direct = physicalImport(path, importer);
        const loaded = ts.resolveModuleName(direct ?? path, importer, options, ts.sys, cache).resolvedModule;
        const physical = loaded?.resolvedFileName ?? direct;
        const actual = physical ? canonicalPath(physical) : undefined;
        return { named, entries, direct, actual };
    }

    function canonicalPath(file: string): string {
        return ts.sys.realpath?.(file) ?? file;
    }

    function lint(source: string, file: string): PackageDiagnostic[] {
        const importer = resolve(root, file);
        const owner = packageAt(importer);
        const references = sourceModuleReferences(file, source);
        const diagnostics: PackageDiagnostic[] = [];
        const edges = new Map<string, ModuleDependency>();
        for (const reference of references.sort((left, right) => left.offset - right.offset)) {
            const { specifier, reexport, offset } = reference;
            const { named, entries, direct, actual } = resolveImport(reference, importer);
            const line = source.slice(0, offset).split("\n").length;
            const target = actual ? packageAt(actual) : undefined;
            const applicationReexport = reexport && contains(rootSource, importer);
            const checkImport = (boundary: PackageBoundary, isPublic: boolean) => {
                if (boundary === owner) return;
                if (!isPublic) {
                    const manifest = relative(root, join(boundary.directory, "package.json"));
                    diagnostics.push({
                        file,
                        line,
                        message: `Private import "${specifier}" from ${boundary.name}. Use an entry point declared in ${manifest}.`,
                    });
                } else if (applicationReexport && EXTRACTED_DOMAIN_PACKAGES.has(boundary.name)) {
                    diagnostics.push({
                        file,
                        line,
                        message: `Application code re-exports "${specifier}". Consumers must import ${boundary.name} directly.`,
                    });
                }
            };
            if (named) checkImport(named, entries.length > 0);
            if (target && target !== named && actual) {
                checkImport(
                    target,
                    isPublicFile(target, actual) || (direct !== undefined && isPublicFile(target, direct)),
                );
            }

            const destinations = named ? entries.map((entry) => canonicalPath(resolve(named.directory, entry))) : [];
            if (direct && contains(rootSource, direct) && (!actual || !contains(rootSource, actual))) {
                destinations.push(direct);
            }
            if (actual) destinations.push(actual);
            for (const destination of destinations) {
                if (!edges.has(destination)) edges.set(destination, { importer, target: destination, line });
            }
        }
        fileDependencies.set(importer, [...edges.values()]);
        return diagnostics;
    }

    function packageDependencies(owner: PackageBoundary): Map<PackageBoundary, ModuleDependency> {
        const outgoing = new Map<PackageBoundary, ModuleDependency>();
        const queue = [...fileDependencies.keys()].filter(
            (file) =>
                contains(owner.directory, file) &&
                (INDEPENDENT_PACKAGES.has(owner.name) ? !isTestFile(file) : isPublicFile(owner, file)),
        );
        const visited = new Set(queue);
        for (const importer of queue) {
            for (const edge of fileDependencies.get(importer) ?? []) {
                const target = packageAt(edge.target);
                if (target && target !== owner) {
                    if (!outgoing.has(target)) outgoing.set(target, edge);
                } else if (
                    !contains(rootSource, edge.target) &&
                    !visited.has(edge.target) &&
                    fileDependencies.has(edge.target)
                ) {
                    visited.add(edge.target);
                    queue.push(edge.target);
                }
            }
        }
        return outgoing;
    }

    function checkIndependence(): PackageDiagnostic[] {
        const graph = new Map(packages.map((boundary) => [boundary, packageDependencies(boundary)]));
        return packages
            .filter(({ name }) => INDEPENDENT_PACKAGES.has(name))
            .flatMap((boundary) => [
                ...checkRootSourceDependencies(root, rootSource, boundary, fileDependencies),
                ...checkPackageCycles(root, boundary, graph),
            ]);
    }

    return { lint, checkIndependence };
}
