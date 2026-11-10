import { getCwd } from "../../constants.ts";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
/**
 * @module shared/extensions/wld-extension-manifest
 * Helpers for allowing only WLD-compatible Pi package code extensions.
 */

import { dirname, join, parse } from "node:path";
import { DefaultPackageManager, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { getSettingsDir, getSettingsManager } from "../settings.ts";
import { isEnabledPackageResource, type ResolvedResource } from "../package-resources.ts";

interface ManifestRecord {
    pi?: unknown;
    wld?: unknown;
    compatible?: unknown;
    extensionApi?: unknown;
    kind?: unknown;
}

export interface WldExtensionResourceOptions {
    cwd?: string;
    agentDir?: string;
    settingsManager?: SettingsManager;
}

function isRecord(value: unknown): value is ManifestRecord {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isWldCompatibleExtensionManifest(manifest: unknown): boolean {
    if (!isRecord(manifest)) return false;
    const pi = manifest.pi;
    if (!isRecord(pi)) return false;
    const wld = pi.wld;
    if (!isRecord(wld)) return false;

    return wld.compatible === true && wld.extensionApi === 1 && wld.kind === "code-extension";
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        const stat = await fsStat(filePath);
        return stat.isFile();
    } catch {
        return false;
    }
}

async function findNearestPackageRoot(startDir: string): Promise<string | null> {
    let current = startDir;
    while (true) {
        if (await fileExists(join(current, "package.json"))) return current;
        const parent = dirname(current);
        if (parent === current || parse(current).root === current) return null;
        current = parent;
    }
}

export async function findPackageRootForExtensionResource(resource: ResolvedResource): Promise<string | null> {
    const baseDir = resource.metadata?.baseDir;
    if (baseDir && (await fileExists(join(baseDir, "package.json")))) return baseDir;
    return await findNearestPackageRoot(dirname(resource.path));
}

async function readPackageJson(packageRoot: string): Promise<ManifestRecord | null> {
    try {
        const raw = await fsReadFile(join(packageRoot, "package.json"), "utf8");
        const parsed: unknown = JSON.parse(raw);
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

export async function isWldCompatibleExtensionResource(resource: ResolvedResource): Promise<boolean> {
    if (!isEnabledPackageResource(resource)) return false;
    const packageRoot = await findPackageRootForExtensionResource(resource);
    if (!packageRoot) return false;
    const manifest = await readPackageJson(packageRoot);
    return isWldCompatibleExtensionManifest(manifest);
}

export async function filterWldCompatibleExtensionResources(
    resources: ResolvedResource[],
): Promise<ResolvedResource[]> {
    const compatible: ResolvedResource[] = [];
    for (const resource of resources) {
        if (await isWldCompatibleExtensionResource(resource)) {
            compatible.push(resource);
        }
    }
    return compatible;
}

export function getWldExtensionPaths(resources: ResolvedResource[]): string[] {
    return resources.map((resource) => resource.path);
}

/**
 * Resolve installed WLD-compatible package extension resources without installing
 * missing packages. Package metadata is author self-attestation of compatibility;
 * install-time consent controls whether extension resources are present/enabled
 * in settings.
 */
export async function resolveInstalledWldExtensionResources(
    options: WldExtensionResourceOptions = {},
): Promise<ResolvedResource[]> {
    const packageManager = new DefaultPackageManager({
        cwd: options.cwd || getCwd(),
        agentDir: options.agentDir || getSettingsDir("global"),
        settingsManager: options.settingsManager || getSettingsManager(),
    });

    const resolved = await packageManager.resolve(() => Promise.resolve("skip"));
    return await filterWldCompatibleExtensionResources(resolved.extensions);
}
