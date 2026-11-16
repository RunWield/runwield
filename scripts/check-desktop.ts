import { build, transform, type Plugin } from "esbuild";
import ts from "typescript";
import { isBuiltin } from "node:module";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { desktopRoot } from "./desktop-paths.ts";
import { renderRunWieldThemeCss } from "../src/ui/design-system/theme-bridge.ts";

type DesktopTarget = "renderer" | "main" | "preload" | "core";
export interface DesktopEntry {
    target: DesktopTarget;
    entry: string;
}

const pureShared = new Set([
    "src/acp/workspace-contract.ts",
    "src/tools/registry.ts",
    "src/shared/session/interaction-values.ts",
    "src/shared/session/session-artifact-types.ts",
    "src/shared/workflow/delivery-report-view.ts",
]);

function refuse(target: DesktopTarget, dependency: string): never {
    throw new Error(`Desktop ${target} runtime dependency refused: ${dependency}`);
}

function inspectPath(target: DesktopTarget, path: string): void {
    const name = relative(desktopRoot, path).replaceAll("\\", "/");
    if (!name.startsWith("src/")) return; // Packages and explicit external fixture entrypoints still get full graph checks.
    if (target === "core") {
        if (
            name === "src/ui/workspace/server.js" ||
            name.startsWith("src/ui/workspace/server/") ||
            name.startsWith("src/ui/workspace/routes/")
        )
            refuse(target, name);
        return;
    }
    const contract = name.startsWith("src/ui/workspace/client/");
    const design = name.startsWith("src/ui/design-system/");
    if (target === "preload") {
        if (contract || name === "src/ui/desktop/preload.ts" || name === "src/ui/desktop/bridge.ts") return;
    } else if (
        pureShared.has(name) ||
        contract ||
        design ||
        (target === "main" && (name.startsWith("src/acp/client/") || name.startsWith("src/ui/desktop/"))) ||
        (target === "renderer" &&
            (name.startsWith("src/ui/desktop/renderer/") ||
                name.startsWith("src/ui/workspace/components/") ||
                name.startsWith("src/ui/workspace/react/") ||
                name.startsWith("src/ui/workspace/static/workspace-styles/")))
    ) {
        return;
    }
    refuse(target, name);
}

/** Inspect emitted JavaScript, not TypeScript annotations or erased imports. */
function inspectJavaScript(target: DesktopTarget, path: string, code: string): void {
    if (target === "core") return;
    const source = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const globals = new Set(["Bun", "Deno"]);
    // Package environment guards are transformed by the bundler; our browser source has no Node ambient API.
    if (target === "renderer" && !path.replaceAll("\\", "/").includes("/node_modules/")) {
        for (const name of ["process", "Buffer", "require", "__dirname", "__filename", "global", "module"])
            globals.add(name);
    }
    const hosts = new Set(["globalThis", "window", "self", "global"]);
    function visit(node: ts.Node): void {
        if (ts.isIdentifier(node) && globals.has(node.text)) {
            const parent = node.parent;
            const dataKey = ts.isPropertyAssignment(parent) && parent.name === node;
            const property = ts.isPropertyAccessExpression(parent) && parent.name === node;
            const globalProperty = property && ts.isIdentifier(parent.expression) && hosts.has(parent.expression.text);
            if (!dataKey && (!property || globalProperty)) refuse(target, `${path}: ${node.text}`);
        }
        if (
            ts.isElementAccessExpression(node) &&
            ts.isIdentifier(node.expression) &&
            hosts.has(node.expression.text) &&
            ts.isStringLiteralLike(node.argumentExpression) &&
            globals.has(node.argumentExpression.text)
        )
            refuse(target, `${path}: ${node.argumentExpression.text}`);
        if (ts.isCallExpression(node)) {
            const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
            const requireCall = ts.isIdentifier(node.expression) && node.expression.text === "require";
            if ((dynamicImport || requireCall) && (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0])))
                refuse(target, `${path}: non-literal runtime import`);
        }
        ts.forEachChild(node, visit);
    }
    visit(source);
}

function boundaryPlugin(target: DesktopTarget): Plugin {
    return {
        name: "desktop-runtime-boundary",
        setup(builder) {
            builder.onResolve({ filter: /.*/ }, async (args) => {
                if (args.pluginData?.resolved) return;
                const specifier = args.path;
                if (specifier === "virtual:runwield-theme.css") return { path: specifier, namespace: "desktop-theme" };
                if (args.kind === "url-token" && specifier.startsWith("data:"))
                    return { path: specifier, external: true };
                if (target === "core" && /^(bun|deno)(:|\/|$)/i.test(specifier))
                    return { path: specifier, external: true };
                if (/^(bun|deno)(:|\/|$)/i.test(specifier) || /^(astro|@astrojs)(\/|$)/.test(specifier))
                    refuse(target, specifier);
                if (specifier === "electron" || isBuiltin(specifier)) {
                    if (target === "renderer" || (target === "preload" && specifier !== "electron"))
                        refuse(target, specifier);
                    return { path: specifier, external: true };
                }
                const resolved = await builder.resolve(specifier, {
                    importer: args.importer,
                    resolveDir: args.resolveDir,
                    kind: args.kind,
                    pluginData: { resolved: true },
                });
                if (resolved.errors.length) return { errors: resolved.errors };
                if (resolved.external && target !== "core") refuse(target, specifier);
                if (resolved.external) return resolved;
                inspectPath(target, resolved.path);
                if (target === "preload" && /[/\\]node_modules[/\\]/.test(resolved.path)) refuse(target, resolved.path);
                // Astro server code is not a UI dependency, even when it happens to bundle for browsers.
                if (/[/\\]node_modules[/\\]astro[/\\]/.test(resolved.path)) refuse(target, resolved.path);
                return { path: resolved.path, namespace: resolved.namespace, suffix: resolved.suffix };
            });
            builder.onLoad({ filter: /.*/, namespace: "desktop-theme" }, () => ({
                contents: renderRunWieldThemeCss(),
                loader: "css",
                resolveDir: desktopRoot,
            }));
            builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
                const contents = await readFile(args.path, "utf8");
                const extension = extname(args.path);
                const loader =
                    extension === ".tsx" ? "tsx" : extension === ".jsx" ? "jsx" : /tsx?$/.test(extension) ? "ts" : "js";
                const emitted = await transform(contents, { loader, target: "esnext", jsx: "automatic" });
                inspectJavaScript(target, args.path, emitted.code);
                return { contents, loader };
            });
        },
    };
}

async function checkAssets(directory: string, outputs: string[]): Promise<void> {
    const styles = outputs.filter((path) => path.endsWith(".css"));
    const fonts = outputs.filter((path) => path.endsWith(".woff2"));
    if (!styles.length || fonts.length < 2)
        throw new Error("Desktop renderer must emit local styles and both local fonts.");
    for (const path of [...styles, ...fonts]) {
        if (!(await stat(resolve(desktopRoot, path))).size) throw new Error(`Empty desktop asset: ${path}`);
    }
    for (const path of styles) {
        const css = await readFile(resolve(desktopRoot, path), "utf8");
        for (const match of css.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g)) {
            const url = match[1];
            if (url.startsWith("data:")) continue;
            if (/^(?:[a-z]+:|\/)/i.test(url)) throw new Error(`Desktop style must use local assets: ${url}`);
            const asset = resolve(dirname(resolve(desktopRoot, path)), url);
            if (relative(directory, asset).startsWith("..") || !(await stat(asset)).size)
                throw new Error(`Missing local desktop asset: ${url}`);
        }
    }
}

/** Build the real runtime graphs in a private directory. Explicit entries support real boundary regression fixtures. */
export async function checkDesktop(entries?: readonly DesktopEntry[]): Promise<void> {
    const defaults = !entries;
    // Include retained standalone browser hosts in the complete ACP/Core dependency boundary.
    const selected: readonly DesktopEntry[] = entries ?? [
        { target: "core", entry: join(desktopRoot, "src/acp/server.js") },
        { target: "core", entry: join(desktopRoot, "src/shared/browser-host/standalone.ts") },
        { target: "core", entry: join(desktopRoot, "src/shared/remote/entry.ts") },
        { target: "core", entry: join(desktopRoot, "src/acp/workspace-projects.ts") },
        { target: "core", entry: join(desktopRoot, "src/shared/owner-coordination/index.ts") },
        { target: "core", entry: join(desktopRoot, "src/shared/owner-coordination/owner-projects.ts") },
        { target: "main", entry: join(desktopRoot, "src/ui/desktop/main.ts") },
        { target: "preload", entry: join(desktopRoot, "src/ui/desktop/preload.ts") },
        { target: "renderer", entry: join(desktopRoot, "src/ui/desktop/renderer/index.tsx") },
        { target: "renderer", entry: join(desktopRoot, "src/ui/workspace/client/session-client.ts") },
    ];
    const directory = await mkdtemp(join(tmpdir(), "runwield-desktop-check-"));
    try {
        for (const [index, { target, entry }] of selected.entries()) {
            if (!isAbsolute(entry)) throw new Error("Desktop gate entrypoints must be absolute.");
            const result = await build({
                absWorkingDir: desktopRoot,
                entryPoints: [entry],
                outdir: join(directory, String(index)),
                bundle: true,
                ...(target === "core" ? { packages: "external" as const } : {}),
                treeShaking: false, // A forbidden barrel export must not disappear before inspection.
                platform: target === "renderer" ? "browser" : "node",
                target: target === "renderer" ? "chrome156" : "node24",
                format: "esm",
                jsx: "automatic",
                loader: { ".woff2": "file", ".woff": "file", ".svg": "file", ".png": "file" },
                metafile: true,
                logLevel: "silent",
                plugins: [boundaryPlugin(target)],
            });
            if (defaults && target === "renderer" && entry.endsWith("index.tsx"))
                await checkAssets(directory, Object.keys(result.metafile.outputs));
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

if (import.meta.main) {
    await checkDesktop();
    console.log("Desktop runtime boundaries and local styles/fonts passed.");
}
