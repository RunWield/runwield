import process from "node:process";
/**
 * @module cmd/install
 * RunWield install command wrapping Pi's PackageManager.
 */

import { DefaultPackageManager, type PackageSource, SettingsManager } from "@earendil-works/pi-coding-agent";
import { relative } from "@std/path";
import { getCwd } from "../../constants.js";
import { approveMetricsExporter, listInstalledMetricsExporters } from "../../shared/extensions/metrics-exporter.ts";
import { filterWldCompatibleExtensionResources } from "../../shared/extensions/wld-extension-manifest.js";
import { countPackageResourcesForSource, resolveConfiguredUserPackageSource } from "../../shared/package-resources.ts";
import { getSettingsDir, getSettingsManager } from "../../shared/settings.js";
import { discoverAndRegisterThemes } from "../../ui/theme/theme.js";

type CommandLog = (message?: string) => void;

function packageEntrySource(entry: PackageSource): string {
    return typeof entry === "string" ? entry : entry.source;
}

async function flushSettings(settings: SettingsManager): Promise<void> {
    await settings.flush();
    const errors = settings.drainErrors();
    if (errors.length) throw new Error(errors.map((error) => error.error.message).join("; "));
}

function confirmCodeLoading(question: string): boolean {
    try {
        return /^(?:y|yes)$/i.test((globalThis.prompt(question) || "").trim());
    } catch {
        return false;
    }
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
    log(
        "RunWield has not vetted this extension package. It could leak data, run unwanted commands, or cause other issues.",
    );
    log("");
    return confirmCodeLoading(`Enable extensions from ${source} for loading? [y/N] `);
}

export async function runInstallCommand(argv: string[]): Promise<void> {
    if (argv.length === 0) {
        console.error("Usage: wld install <source>");
        console.error("Sources: npm:<spec>, git:<url>, <path>");
        process.exitCode = 1;
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

        const existingSource = resolveConfiguredUserPackageSource(source, { settingsManager: settings });
        const packages = settings.getGlobalSettings().packages || [];
        const savedSources = new Set(packages.map(packageEntrySource));
        const existing = savedSources.has(existingSource);
        await packageManager.install(source);
        if (!existing) {
            const normalizationSettings = SettingsManager.inMemory({ packages });
            const normalizer = new DefaultPackageManager({
                cwd: getCwd(),
                agentDir: getSettingsDir("global"),
                settingsManager: normalizationSettings,
            });
            normalizer.addSourceToSettings(source);
            settings.setPackages(
                (normalizationSettings.getGlobalSettings().packages || []).map((entry) =>
                    savedSources.has(packageEntrySource(entry))
                        ? entry
                        : { ...(typeof entry === "string" ? { source: entry } : entry), extensions: [] },
                ),
            );
        }
        await flushSettings(settings);

        const configuredSource = resolveConfiguredUserPackageSource(source, { settingsManager: settings });
        // Inspect the unfiltered source, without importing it or applying Project precedence.
        const candidates = await packageManager.resolveExtensionSources([configuredSource]);
        const counts = countPackageResourcesForSource(candidates, configuredSource);
        const compatibleExtensions = await filterWldCompatibleExtensionResources(candidates.extensions);
        const ignoredExtensionCount = Math.max(0, counts.extensions - compatibleExtensions.length);
        let skippedExtensionCount = 0;

        if (!existing && compatibleExtensions.length > 0) {
            if (confirmWldExtensionInstall(source, compatibleExtensions.length)) {
                const root = packageManager.getInstalledPath(configuredSource, "user");
                if (!root) throw new Error("Installed package path is unavailable");
                settings.setPackages(
                    (settings.getGlobalSettings().packages || []).map((entry) =>
                        packageEntrySource(entry) === configuredSource
                            ? {
                                  ...(typeof entry === "string" ? { source: entry } : entry),
                                  extensions: compatibleExtensions.map((resource) => relative(root, resource.path)),
                              }
                            : entry,
                    ),
                );
                await flushSettings(settings);
            } else {
                skippedExtensionCount = compatibleExtensions.length;
            }
        }
        const exporter = (await listInstalledMetricsExporters()).find((entry) => entry.source === configuredSource);
        if (exporter && !exporter.approved) {
            console.log("Metrics exporters are trusted code. They can read host data and call external services.");
            if (confirmCodeLoading(`Approve metrics exporter ${exporter.id} from ${source}? [y/N] `)) {
                await approveMetricsExporter(exporter);
                console.log(`  Metrics exporter approved: ${exporter.id}`);
            }
        }

        await discoverAndRegisterThemes();
        const installed = await new DefaultPackageManager({
            cwd: getCwd(),
            agentDir: getSettingsDir("global"),
            settingsManager: SettingsManager.inMemory(settings.getGlobalSettings()),
        }).resolve(() => Promise.resolve("skip"));
        const fromSource = (resource: (typeof installed.themes)[number]) =>
            resource.enabled && resource.metadata.source === configuredSource;
        const enabledExtensionCount = (
            await filterWldCompatibleExtensionResources(installed.extensions.filter(fromSource))
        ).length;

        console.log(`Installed ${source}`);
        console.log(`  Themes registered: ${installed.themes.filter(fromSource).length}`);
        console.log(`  Prompt templates available: ${installed.prompts.filter(fromSource).length}`);
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
        process.exitCode = 1;
    }
}
