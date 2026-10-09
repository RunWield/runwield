import process from "node:process";
/**
 * @module cmd/remove
 * RunWield remove command wrapping Pi's PackageManager.
 */

import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import { getCwd } from "../../constants.js";
import { getSettingsDir, getSettingsManager } from "../../shared/settings.js";
import { discoverAndRegisterThemes, getAvailableThemes, setTheme } from "../../ui/theme/theme.js";

const DEFAULT_THEME = "catppuccin-mocha";

export async function runRemoveCommand(argv: string[]): Promise<void> {
    if (argv.length === 0) {
        console.error("Usage: wld remove <source>");
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

        const success = await packageManager.removeAndPersist(source);
        if (!success) {
            console.log(`Package "${source}" is not currently installed — nothing to remove.`);
            return;
        }

        await discoverAndRegisterThemes();

        const activeTheme = settings.getTheme();
        if (activeTheme && activeTheme !== DEFAULT_THEME && !getAvailableThemes().includes(activeTheme)) {
            settings.setTheme(DEFAULT_THEME);
            setTheme(DEFAULT_THEME);
            console.log(
                `Active theme "${activeTheme}" was provided by the removed package — reset to ${DEFAULT_THEME}.`,
            );
        }

        console.log(`Successfully removed ${source}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Removal failed: ${message}`);
        process.exitCode = 1;
    }
}
