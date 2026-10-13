/**
 * The set of first-party source files, for tools that need to see all of them.
 *
 * Shared so the type checker and any future whole-tree tool agree on what "all our
 * source" means, rather than each carrying its own glob that can drift.
 */

import { dirname } from "node:path";
import { fileURLToPath as fromFileUrl } from "node:url";
import { listCiFiles } from "./ci-files.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const SOURCE_ROOTS = ["src", "scripts"];

/**
 * Directories that are not ours to check: vendored code, build output, and caches.
 *
 * `src/ui/workspace` is excluded because it is an Astro project with its own
 * `bun run workspace:check`, which understands `.astro` files and its own tsconfig.
 */
const SKIP_DIRS = new Set([
    ".astro",
    ".vite",
    "_fresh",
    "coverage",
    "dist",
    "node_modules",
]);

const SKIP_PATHS = new Set(["src/ui/workspace"]);

const SOURCE_FILE_PATTERN = /\.(?:jsx?|tsx?|mjs|mts)$/;

/**
 * Every first-party source file, sorted for stable output.
 *
 * @param {string[]} [roots]
 * @returns {Promise<string[]>}
 */
export async function walkSourceFiles(roots = SOURCE_ROOTS) {
    const files = await listCiFiles(REPO_ROOT);
    return files.filter((path) => {
        if (!SOURCE_FILE_PATTERN.test(path)) return false;
        if (!roots.some((root) => path === root || path.startsWith(`${root}/`))) return false;
        if ([...SKIP_PATHS].some((skipped) => path === skipped || path.startsWith(`${skipped}/`))) return false;
        return !path.split("/").some((part) => SKIP_DIRS.has(part));
    });
}
