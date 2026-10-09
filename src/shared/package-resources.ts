/**
 * @module shared/package-resources
 * Helpers for consuming Pi package resources through RunWield policy.
 */

import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import type { PackageSource, ResolvedPaths, ResolvedResource, SettingsManager } from "@earendil-works/pi-coding-agent";
export type { PathMetadata, ResolvedPaths, ResolvedResource } from "@earendil-works/pi-coding-agent";

import { isAbsolute, join, relative } from "@std/path";
import { getCwd } from "../constants.js";
import { getSettingsDir, getSettingsManager } from "./settings.js";
import {
    assertPersonalResourcePath,
    personalPackageRoots,
    remotePersonalResourcesActive,
} from "./remote/personal-resources.ts";

export interface PackagePromptResourceOptions {
    cwd?: string;
    agentDir?: string;
    settingsManager?: SettingsManager;
}

export interface PackageResourceCounts {
    themes: number;
    prompts: number;
    extensions: number;
    skills: number;
}

export function isEnabledPackageResource(resource: ResolvedResource) {
    return resource.enabled === true && resource.metadata?.origin === "package";
}

/**
 * Resolve installed package prompt resources without installing missing packages.
 * Prompt templates are passive Markdown resources, so they do not require the
 * executable extension compatibility gate.
 */
export async function resolveInstalledPackagePromptResources(
    options: PackagePromptResourceOptions = {},
): Promise<ResolvedResource[]> {
    const settings = options.settingsManager || getSettingsManager(options.cwd);
    const remote = remotePersonalResourcesActive();
    const roots = personalPackageRoots();
    if (remote) {
        for (const [source, path] of Object.entries(roots)) {
            await assertPersonalResourcePath(path, `package root "${source}"`, { packageResource: true });
            await assertPersonalResourcePath(join(path, "package.json"), `package manifest "${source}"`, {
                packageResource: true,
            });
        }
    }
    const originalSources = new Map<string, string>();
    // Only the laptop-verified package inventory is eligible remotely. In
    // particular, Pi must never probe a remote account's legacy global npm root.
    const settingsManager = remote ? mappedRemotePackageSettings(settings, roots, originalSources) : settings;
    const packageManager = new DefaultPackageManager({
        cwd: options.cwd || getCwd(),
        agentDir: options.agentDir || getSettingsDir("global"),
        settingsManager: settingsManager,
    });

    const resolved = await packageManager.resolve(() => Promise.resolve("skip"));
    const prompts = filterEnabledPackagePrompts(resolved);
    if (remote) {
        const project = await Deno.realPath(options.cwd || getCwd());
        for (const resource of prompts) {
            const path = await Deno.realPath(resource.path);
            const rest = relative(project, path);
            if (rest !== "" && rest !== ".." && !rest.startsWith("../") && !isAbsolute(rest)) continue;
            await assertPersonalResourcePath(resource.path, `package prompt "${resource.metadata.source}"`, {
                packageResource: true,
            });
        }
    }
    return remote
        ? prompts.map((resource) => ({
            ...resource,
            metadata: {
                ...resource.metadata,
                source: originalSources.get(resource.metadata.source) ?? resource.metadata.source,
            },
        }))
        : prompts;
}

/**
 * Map only laptop-installed global packages. Pi's loader also resolves packages before applying resource flags.
 */
export function mappedRemotePackageSettings(
    settings: SettingsManager,
    roots: Readonly<Record<string, string>> = personalPackageRoots(),
    originalSources: Map<string, string> = new Map(),
) {
    return new Proxy(settings, {
        get(target, key) {
            if (key === "getGlobalSettings") {
                return () => ({
                    ...target.getGlobalSettings(),
                    packages: (target.getGlobalSettings().packages ?? [])
                        .flatMap<PackageSource>((entry) => {
                            const source = typeof entry === "string" ? entry : entry.source;
                            const path = roots[source];
                            if (!path) return [];
                            // Pi must read the installed laptop directory, never install
                            // a missing package or interpret a laptop path on the server.
                            if (!originalSources.has(path)) originalSources.set(path, source);
                            return [typeof entry === "string" ? path : { ...entry, source: path }];
                        }),
                });
            }
            return Reflect.get(target, key, target);
        },
    });
}

export function filterEnabledPackagePrompts(resolved: ResolvedPaths) {
    return resolved.prompts.filter(isEnabledPackageResource);
}

export function getPackagePromptTemplatePaths(resources: ResolvedResource[]) {
    return resources.map((resource) => resource.path);
}

export function countPackageResourcesForSource(resolved: ResolvedPaths, source: string): PackageResourceCounts {
    const fromSource = (resource: ResolvedResource) => resource.metadata?.source === source;
    return {
        themes: resolved.themes.filter(fromSource).length,
        prompts: resolved.prompts.filter(fromSource).length,
        extensions: resolved.extensions.filter(fromSource).length,
        skills: resolved.skills.filter(fromSource).length,
    };
}
