// @ts-nocheck: Astro/Vite plugin type packages resolve to multiple Vite versions under Deno npm nodeModulesDir.
// Polyfill for Astro's Vite CJS evaluator in Deno, following the local Goaly Astro app pattern.
globalThis.exports = globalThis.exports || {};
globalThis.module = globalThis.module || { exports: globalThis.exports };

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, passthroughImageService } from "astro/config";
import deno from "@deno/astro-adapter";
import react from "./integrations/deno-react.mjs";
import tailwindcss from "@tailwindcss/vite";
import { reviewCollapseStatePlugin } from "./integrations/review-collapse-state.ts";

const WORKSPACE_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(WORKSPACE_DIR, "../../..");
const PLANNOTATOR_DIR = resolve(ROOT_DIR, "third_party/plannotator");
const STD_EXTERNALS = [
    "@std/assert",
    "@std/cli",
    "@std/cli/parse-args",
    "@std/front-matter",
    "@std/jsonc",
    "@std/path",
];

export default defineConfig({
    root: WORKSPACE_DIR,
    srcDir: WORKSPACE_DIR,
    publicDir: resolve(WORKSPACE_DIR, "static"),
    outDir: resolve(ROOT_DIR, "dist/workspace"),
    output: "server",
    server: {
        host: "127.0.0.1",
        port: 5173,
    },
    adapter: deno({
        start: false,
        port: 8085,
        hostname: "0.0.0.0",
    }),
    integrations: [react()],
    image: {
        service: passthroughImageService(),
    },
    security: {
        checkOrigin: false,
    },
    vite: {
        plugins: [reviewCollapseStatePlugin(), tailwindcss()],
        define: { "process.env.NODE_ENV": '"development"' },
        build: {
            rollupOptions: {
                external: STD_EXTERNALS,
            },
        },
        ssr: {
            external: STD_EXTERNALS,
        },
        optimizeDeps: {
            exclude: STD_EXTERNALS,
            include: [
                // ClientRouter's virtual imports escape the initial dependency scan. Discovering them
                // after the toolbar loads invalidates its optimized modules and causes persistent 504s.
                "astro/virtual-modules/transitions-router.js",
                "astro/virtual-modules/transitions-types.js",
                "astro/virtual-modules/transitions-events.js",
                "astro/virtual-modules/transitions-swap-functions.js",
                "react",
                "react-dom/client",
                "@codemirror/autocomplete",
                "@codemirror/lang-javascript",
                "@codemirror/lang-json",
                "@codemirror/lang-markdown",
                "@codemirror/lang-python",
                "@codemirror/lang-yaml",
                "@codemirror/language",
                "@codemirror/legacy-modes/mode/shell",
                "@codemirror/state",
                "@codemirror/view",
                "@lezer/common",
                "@lezer/highlight",
                "@pierre/diffs",
                "@pierre/diffs/edit",
                "@pierre/diffs/react",
                "@plannotator/atomic-editor",
                "@plannotator/markdown-editor",
                "@plannotator/web-highlighter",
                "@radix-ui/react-context-menu",
                "@radix-ui/react-dialog",
                "@radix-ui/react-dropdown-menu",
                "@radix-ui/react-popover",
                "@radix-ui/react-slot",
                "@radix-ui/react-tabs",
                "@radix-ui/react-tooltip",
                "@tanstack/react-table",
                "@base-ui/react",
                "@base-ui/react/button",
                "@base-ui/react/context-menu",
                "@base-ui/react/dialog",
                "@base-ui/react/menu",
                "@base-ui/react/merge-props",
                "@base-ui/react/popover",
                "@base-ui/react/tabs",
                "@base-ui/react/tooltip",
                "@base-ui/react/use-render",
                "@viz-js/viz",
                "class-variance-authority",
                "clsx",
                "diff",
                "dompurify",
                "dockview-react",
                "fuse.js",
                "highlight.js",
                "lucide-react",
                "katex",
                "marked",
                "mermaid",
                "perfect-freehand",
                "quikdown",
                "tailwind-merge",
                "unique-username-generator",
            ],
        },
        resolve: {
            alias: {
                "@pierre/diffs/worker/worker.js?worker&inline": resolve(
                    WORKSPACE_DIR,
                    "react/pierre-diffs-worker-shim.js",
                ),
                "@pierre/diffs/worker/worker.js": resolve(WORKSPACE_DIR, "react/pierre-diffs-worker-shim.js"),
                "@plannotator/markdown-editor/themes/plannotator.css": resolve(
                    ROOT_DIR,
                    "node_modules/@plannotator/markdown-editor/dist/styles/themes/plannotator.css",
                ),
                "@plannotator/markdown-editor": resolve(
                    ROOT_DIR,
                    "node_modules/@plannotator/markdown-editor/dist/index.js",
                ),
                "@plannotator/ui": resolve(PLANNOTATOR_DIR, "packages/ui"),
                "@plannotator/guide-viewer": resolve(PLANNOTATOR_DIR, "packages/guide-viewer"),
                "@plannotator/core": resolve(PLANNOTATOR_DIR, "packages/core"),
                "@plannotator/shared": resolve(PLANNOTATOR_DIR, "packages/shared"),
                "@plannotator/ai": resolve(PLANNOTATOR_DIR, "packages/ai"),
            },
            dedupe: ["react", "react-dom"],
        },
    },
});
