/**
 * @module cmd/install
 * RunWield install command wrapping Pi's PackageManager.
 */

import { DefaultPackageManager, type PackageSource, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { getCwd } from "../../constants.js";
import { filterWldCompatibleExtensionResources } from "../../shared/extensions/wld-extension-manifest.js";
import { countPackageResourcesForSource } from "../../shared/package-resources.ts";
import { getSettingsDir, getSettingsManager } from "../../shared/settings.js";
import { discoverAndRegisterThemes } from "../../ui/theme/theme.js";

type CommandLog = (message?: string) => void;

function packageEntrySource(entry: PackageSource): string {
    return typeof entry === "string" ? entry : entry.source;
}

export function disablePackageExtensions(settings: SettingsManager, source: string): boolean {
    const packages = settings.getGlobalSettings().packages || [];
    const index = packages.findIndex((entry) => packageEntrySource(entry) === source);
    if (index === -1) return false;

    const current = packages[index];
    const sourceValue = packageEntrySource(current);
    const nextEntry: PackageSource = typeof current === "string"
        ? { source: sourceValue, extensions: [] }
        : { ...current, extensions: [] };
    const nextPackages = [...packages];
    nextPackages[index] = nextEntry;
    settings.setPackages(nextPackages);
    return true;
}

export function confirmWldExtensionInstall(
    source: string,
    extensionCount: number,
    log: CommandLog = console.log,
): boolean {
    log(`Package source contains WLD-compatible code extensions: ${extensionCount}`);
    log("");
    log(
        "Extensions can register tools, alter prompts, intercept tool calls, read project/session data, and call external services.",
    );
    log("RunWield has not vetted this extension package. It could leak data, run unwanted commands, or cause other issues.");
    log("");
    const answer = globalThis.prompt(`Enable extensions from ${source} for loading? [y/N] `) || "";
    return /^(?:y|yes)$/i.test(answer.trim());
}

function resolveConfiguredSource(packageManager: DefaultPackageManager, requestedSource: string): string {
    const requestedPath = packageManager.getInstalledPath(requestedSource, "user");
    const configured = packageManager.listConfiguredPackages().find((entry) =>
        entry.scope === "user" &&
        (entry.source === requestedSource || Boolean(requestedPath && entry.installedPath === requestedPath))
    );
    return configured?.source || requestedSource;
}

export async function runInstallCommand(argv: string[]): Promise<void> {
    if (argv.length === 0) {
        console.error("Usage: wld install <source>");
        console.error("Sources: npm:<spec>, git:<url>, local:<path>");
        Deno.exitCode = 1;
        return;
    }

    const source = argv[0];
    try {
        const settings = getSettingsManager();
        const packageManager = new DefaultPackageManager({
            cwd: getCwd(),
            agentDir: getSettingsDir("global"),
            settingsManager: settings,
        });

        await packageManager.installAndPersist(source);

        const configuredSource = resolveConfiguredSource(packageManager, source);
        const resolved = await packageManager.resolve();
        const counts = countPackageResourcesForSource(resolved, configuredSource);
        const sourceExtensions = resolved.extensions.filter((resource) =>
            resource.metadata?.source === configuredSource
        );
        const compatibleExtensions = await filterWldCompatibleExtensionResources(sourceExtensions);
        const ignoredExtensionCount = Math.max(0, counts.extensions - compatibleExtensions.length);
        let enabledExtensionCount = compatibleExtensions.length;
        let skippedExtensionCount = 0;

        if (compatibleExtensions.length > 0) {
            const allowExtensions = confirmWldExtensionInstall(source, compatibleExtensions.length);
            if (!allowExtensions) {
                disablePackageExtensions(settings, configuredSource);
                skippedExtensionCount = compatibleExtensions.length;
                enabledExtensionCount = 0;
            }
        }

        await discoverAndRegisterThemes();

        console.log(`Installed ${source}`);
        console.log(`  Themes registered: ${counts.themes}`);
        console.log(`  Prompt templates available: ${counts.prompts}`);
        if (enabledExtensionCount > 0) {
            console.log(`  WLD-compatible code extensions enabled: ${enabledExtensionCount}`);
        }
        if (skippedExtensionCount > 0) {
            console.log(`  WLD-compatible code extensions skipped: ${skippedExtensionCount}`);
        }
        if (ignoredExtensionCount > 0) {
            console.log(`  Code extensions ignored: ${ignoredExtensionCount} (missing pi.wld compatibility marker)`);
        }
        if (counts.skills > 0) {
            console.log(`  Skills ignored: ${counts.skills} (RunWield does not load Pi package skills)`);
            console.log(`  Install skills separately with: npx skills add ${source}`);
            console.log("  Use -a/--agent to choose the target agent when needed.");
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Installation failed: ${message}`);
        Deno.exitCode = 1;
    }
}
