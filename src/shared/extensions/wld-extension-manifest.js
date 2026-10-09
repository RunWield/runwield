/**
 * @module shared/extensions/wld-extension-manifest
 * Helpers for allowing only WLD-compatible Pi package code extensions.
 */

import { dirname, join, parse } from "@std/path";
import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import { getSettingsDir, getSettingsManager } from "../settings.js";
import { isEnabledPackageResource } from "../package-resources.ts";

/**
 * @typedef {import("../package-resources.ts").ResolvedResource} ResolvedResource
 * @typedef {import("../package-resources.ts").ResolvedPaths} ResolvedPaths
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} manifest
 * @returns {boolean}
 */
export function isWldCompatibleExtensionManifest(manifest) {
    if (!isRecord(manifest)) return false;
    const pi = manifest.pi;
    if (!isRecord(pi)) return false;
    const wld = pi.wld;
    if (!isRecord(wld)) return false;

    return wld.compatible === true && wld.extensionApi === 1 && wld.kind === "code-extension";
}

/**
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function fileExists(filePath) {
    try {
        const stat = await Deno.stat(filePath);
        return stat.isFile;
    } catch {
        return false;
    }
}

/**
 * @param {string} startDir
 * @returns {Promise<string | null>}
 */
async function findNearestPackageRoot(startDir) {
    let current = startDir;
    while (true) {
        if (await fileExists(join(current, "package.json"))) return current;
        const parent = dirname(current);
        if (parent === current || parse(current).root === current) return null;
        current = parent;
    }
}

/**
 * @param {ResolvedResource} resource
 * @returns {Promise<string | null>}
 */
export async function findPackageRootForExtensionResource(resource) {
    const baseDir = resource.metadata?.baseDir;
    if (baseDir && await fileExists(join(baseDir, "package.json"))) return baseDir;
    return await findNearestPackageRoot(dirname(resource.path));
}

/**
 * @param {string} packageRoot
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function readPackageJson(packageRoot) {
    try {
        const raw = await Deno.readTextFile(join(packageRoot, "package.json"));
        const parsed = JSON.parse(raw);
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * @param {ResolvedResource} resource
 * @returns {Promise<boolean>}
 */
export async function isWldCompatibleExtensionResource(resource) {
    if (!isEnabledPackageResource(resource)) return false;
    const packageRoot = await findPackageRootForExtensionResource(resource);
    if (!packageRoot) return false;
    const manifest = await readPackageJson(packageRoot);
    return isWldCompatibleExtensionManifest(manifest);
}

/**
 * @param {ResolvedResource[]} resources
 * @returns {Promise<ResolvedResource[]>}
 */
export async function filterWldCompatibleExtensionResources(resources) {
    /** @type {ResolvedResource[]} */
    const compatible = [];
    for (const resource of resources) {
        if (await isWldCompatibleExtensionResource(resource)) {
            compatible.push(resource);
        }
    }
    return compatible;
}

/**
 * @param {ResolvedResource[]} resources
 * @returns {string[]}
 */
export function getWldExtensionPaths(resources) {
    return resources.map((resource) => resource.path);
}

/**
 * Resolve installed WLD-compatible package extension resources without installing
 * missing packages. Package metadata is author self-attestation of compatibility;
 * install-time consent controls whether extension resources are present/enabled
 * in settings.
 *
 * @param {{
 *   cwd?: string,
 *   agentDir?: string,
 *   settingsManager?: any,
 * }} [options]
 * @returns {Promise<ResolvedResource[]>}
 */
export async function resolveInstalledWldExtensionResources(options = {}) {
    const packageManager = new DefaultPackageManager({
        cwd: options.cwd || Deno.cwd(),
        agentDir: options.agentDir || getSettingsDir("global"),
        settingsManager: /** @type {any} */ (options.settingsManager || getSettingsManager()),
    });

    const resolved = await packageManager.resolve(() => Promise.resolve("skip"));
    return await filterWldCompatibleExtensionResources(resolved.extensions);
}
