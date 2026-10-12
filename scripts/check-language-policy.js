#!/usr/bin/env bun
import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import process from "node:process";

import { dirname } from "node:path";
import { fileURLToPath as fromFileUrl } from "node:url";
import { listCiFiles } from "./ci-files.ts";

const BASELINE_PATH = new URL("./language-policy-baseline.json", import.meta.url);
const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const GENERATED_AND_DEPENDENCY_DIRS = new Set([
    ".astro",
    ".vite",
    "_fresh",
    "coverage",
    "dist",
    "node_modules",
]);
const TEST_DIRS = new Set(["__fixtures__", "__tests__", "fixtures", "test-fixtures", "tests"]);
const TEST_FILE_PATTERN = /(?:^|[._-])(?:test|spec)(?:\.|$)|_test\./;
const PRODUCTION_JS_PATTERN = /\.[jm]?jsx?$/;
const EXCLUDED_PRODUCTION_PATHS = new Set(["src/shared/version.js"]);

/** @param {string} path */
function toPosixPath(path) {
    return path.replaceAll("\\", "/");
}

/** @param {string} path */
function isProductionJavaScriptPath(path) {
    const normalized = toPosixPath(path);
    if (!normalized.startsWith("src/")) return false;
    if (!PRODUCTION_JS_PATTERN.test(normalized)) return false;
    if (EXCLUDED_PRODUCTION_PATHS.has(normalized)) return false;

    const parts = normalized.split("/");
    const fileName = parts.at(-1) || "";
    if (TEST_FILE_PATTERN.test(fileName)) return false;
    return !parts.some((part) => TEST_DIRS.has(part) || GENERATED_AND_DEPENDENCY_DIRS.has(part));
}

async function collectProductionJavaScriptFiles() {
    return (await listCiFiles(REPO_ROOT)).filter(isProductionJavaScriptPath);
}

/** @returns {Promise<string[]>} */
async function readBaseline() {
    const parsed = JSON.parse(await fsReadFile(BASELINE_PATH, "utf8"));
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
        throw new Error("language-policy-baseline.json must contain a JSON array of path strings");
    }
    return [...parsed].sort();
}

/**
 * @param {string[]} left
 * @param {string[]} right
 */
function difference(left, right) {
    const rightSet = new Set(right);
    return left.filter((entry) => !rightSet.has(entry));
}

/** @param {string[]} entries */
function formatList(entries) {
    return entries.map((entry) => `  - ${entry}`).join("\n");
}

if (import.meta.main) {
    const update = process.argv.slice(2).includes("--update");
    const currentFiles = await collectProductionJavaScriptFiles();
    if (update) {
        await fsWriteFile(BASELINE_PATH, `${JSON.stringify(currentFiles, null, 4)}\n`);
        console.log("Updated scripts/language-policy-baseline.json.");
        process.exit(0);
    }
    const baselineFiles = await readBaseline();
    const newFiles = difference(currentFiles, baselineFiles);
    const staleFiles = difference(baselineFiles, currentFiles);

    if (newFiles.length || staleFiles.length) {
        const sections = [];
        if (newFiles.length) {
            sections.push(
                `New production JS files (use .ts/.tsx or intentionally update the policy):\n${formatList(newFiles)}`,
            );
        }
        if (staleFiles.length) {
            sections.push(
                `Stale baseline entries (remove migrated/deleted paths from the baseline):\n${formatList(staleFiles)}`,
            );
        }
        console.error(sections.join("\n\n"));
        process.exit(1);
    }

    console.log("Language policy baseline matches current production JS/JSX files.");
}

export { collectProductionJavaScriptFiles, isProductionJavaScriptPath };
