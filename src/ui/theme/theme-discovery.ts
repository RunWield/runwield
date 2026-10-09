/**
 * @module ui/theme/theme-discovery
 * Load external JSON themes from resolved package resources.
 */

import { mergeThemeJson, type ThemeJson } from "./theme-json.ts";

interface ThemePackageManager {
    resolve(): Promise<{ themes: Array<{ path: string }> }>;
}

interface ThemeDiscoveryPorts {
    packageManager: ThemePackageManager;
    readTextFile(path: string): string | Promise<string>;
}

interface ExternalThemeOptions extends ThemeDiscoveryPorts {
    defaultThemeName: string;
    baseThemeJson: ThemeJson;
}

export async function loadExternalThemeJsons({
    packageManager,
    readTextFile,
    defaultThemeName,
    baseThemeJson,
}: ExternalThemeOptions): Promise<ThemeJson[]> {
    const resolved = await packageManager.resolve();
    const externalThemeJsons: ThemeJson[] = [];

    for (const themeResource of resolved.themes) {
        try {
            const themeJson: ThemeJson = JSON.parse(await readTextFile(themeResource.path));
            if (themeJson.name === defaultThemeName) continue;
            externalThemeJsons.push(mergeThemeJson(baseThemeJson, themeJson));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`Failed to load theme from ${themeResource.path}: ${message}`);
        }
    }

    return externalThemeJsons;
}
