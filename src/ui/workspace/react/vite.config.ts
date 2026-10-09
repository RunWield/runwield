import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

const WORKSPACE_REACT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(WORKSPACE_REACT_DIR, "../../../..");
const PLANNOTATOR_DIR = resolve(ROOT_DIR, "third_party/plannotator");

export default defineConfig({
    plugins: [tailwindcss()],
    resolve: {
        alias: {
            "@plannotator/ui": resolve(PLANNOTATOR_DIR, "packages/ui"),
            "@plannotator/shared": resolve(PLANNOTATOR_DIR, "packages/shared"),
            "@plannotator/ai": resolve(PLANNOTATOR_DIR, "packages/ai"),
        },
        dedupe: ["react", "react-dom"],
    },
    build: {
        outDir: resolve(ROOT_DIR, "_workspace/workspace-react-check"),
        emptyOutDir: true,
        rollupOptions: {
            input: resolve(WORKSPACE_REACT_DIR, "plan-detail-entry.tsx"),
        },
    },
});
