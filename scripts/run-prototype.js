#!/usr/bin/env bun
import { captureScriptProcess } from "./script-process.ts";
import { getCwd } from "../src/constants.js";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import process from "node:process";
/**
 * Launch local throwaway prototypes from the ignored prototypes/<slug>/ root.
 *
 * @module run-prototype
 */

import { join, normalize, relative, resolve } from "node:path";

const SAFE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const THROWAWAY_MARKER = ["THROWAWAY", "PROTOTYPE"].join(" ");

/**
 * @typedef {Object} PrototypeProcessPort
 * @property {(command: string, options: import("./script-process.ts").ScriptProcessOptions) => { status: Promise<{ code: number }> }} spawn
 */

/** @type {PrototypeProcessPort} */
const SYSTEM_PROTOTYPE_PROCESS_PORT = Object.freeze({
    spawn: (command, options) => ({ status: captureScriptProcess(command, options) }),
});

/** @param {string} slug */
export function isSafePrototypeSlug(slug) {
    return SAFE_SLUG_RE.test(slug);
}

/** @param {string} cwd @param {string} slug */
export function prototypeDir(cwd, slug) {
    return resolve(cwd, "prototypes", slug);
}

/** @param {string} cwd @param {string} path */
function repoRelative(cwd, path) {
    return normalize(relative(cwd, path)).replaceAll("\\", "/");
}

/**
 * @param {string} cwd
 * @param {string} slug
 * @returns {Promise<{ dir: string, configPath: string, relativeConfigPath: string }>}
 */
export async function validatePrototypeSetup(cwd, slug) {
    if (!isSafePrototypeSlug(slug)) {
        throw new Error("Prototype slug must be kebab-case: lowercase letters/numbers separated by single dashes.");
    }
    const dir = prototypeDir(cwd, slug);
    const relativeDir = repoRelative(cwd, dir);
    if (relativeDir.startsWith("..") || relativeDir === "") {
        throw new Error("Prototype slug resolved outside the project prototypes/ root.");
    }
    if (!(await isGitIgnored(cwd, relativeDir))) {
        throw new Error(`Prototype directory must be gitignored before use: ${relativeDir}/`);
    }
    let stat;
    try {
        stat = await fsStat(dir);
    } catch {
        throw new Error(`Prototype not found: ${relativeDir}/. Create it with README.md and package.json first.`);
    }
    if (!stat.isDirectory()) throw new Error(`Prototype path is not a directory: ${relativeDir}/`);

    const configPath = join(dir, "package.json");
    let config;
    try {
        config = JSON.parse(await fsReadFile(configPath, "utf8"));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Prototype ${relativeDir}/package.json is missing or invalid: ${message}`);
    }
    if (!config || typeof config !== "object" || typeof config.scripts?.dev !== "string") {
        throw new Error(`Prototype ${relativeDir}/package.json must define a local scripts.dev command.`);
    }
    return { dir, configPath, relativeConfigPath: repoRelative(cwd, configPath) };
}

/** @param {string} cwd @param {string} relativePath */
export async function isGitIgnored(cwd, relativePath) {
    const output = await captureScriptProcess("git", {
        args: ["check-ignore", "-q", relativePath],
        cwd,
        stdout: "null",
        stderr: "null",
    });
    return output.success;
}

/**
 * @param {{ cwd?: string, slug: string }} opts
 * @param {PrototypeProcessPort} processPort
 * @returns {Promise<number>}
 */
export async function runPrototype(opts, processPort) {
    const cwd = opts.cwd || getCwd();
    const setup = await validatePrototypeSetup(cwd, opts.slug);
    const args = ["run", "--cwd", setup.dir, "dev"];
    const child = processPort.spawn(process.execPath, {
        args,
        cwd,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
    });
    const status = await child.status;
    return status.code;
}

/**
 * @param {{ cwd?: string }} [opts]
 * @returns {Promise<string[]>}
 */
export async function findTrackedPrototypeArtifacts(opts = {}) {
    const cwd = opts.cwd || getCwd();
    const output = await captureScriptProcess("git", {
        args: ["ls-files", "-z"],
        cwd,
        stdout: "piped",
        stderr: "piped",
    });
    if (!output.success) throw new Error("Could not inspect tracked files for prototype artifacts.");
    const files = new TextDecoder().decode(output.stdout).split("\0").filter(Boolean);
    const violations = [];
    for (const file of files) {
        if (file.startsWith("prototypes/")) {
            violations.push(file);
            continue;
        }
        if (isAllowedPrototypeConventionFile(file)) continue;
        const basename = file.split("/").at(-1) || file;
        if (isPrototypeArtifactFilename(basename)) {
            violations.push(file);
            continue;
        }
        try {
            const text = await fsReadFile(join(cwd, file), "utf8");
            if (text.includes(THROWAWAY_MARKER)) violations.push(file);
        } catch {
            // Deleted paths are already leaving the tree; do not block the convention check on them.
        }
    }
    return violations;
}

/** @param {string} basename */
function isPrototypeArtifactFilename(basename) {
    return basename.includes(".prototype.") || /Prototype\./.test(basename);
}

/** @param {string} file */
function isAllowedPrototypeConventionFile(file) {
    const normalized = file.replaceAll("\\", "/");
    const basename = normalized.split("/").at(-1) || normalized;
    if (normalized.startsWith("src/skills/prototype/") && /\.mdx?$/i.test(basename)) return true;
    return /(^|\/)(?:__fixtures__|fixtures|testdata)(\/|$)/.test(normalized);
}

if (import.meta.main) {
    const [slug, ...extra] = process.argv.slice(2);
    if (!slug || extra.length > 0) {
        console.error("Usage: bun run prototype <kebab-case-slug>");
        process.exit(2);
    }
    try {
        process.exit(await runPrototype({ slug }, SYSTEM_PROTOTYPE_PROCESS_PORT));
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
