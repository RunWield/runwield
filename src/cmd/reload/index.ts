/**
 * @module cmd/reload
 * Implementation of the reload command.
 */

import { discoverAndRegisterThemes, setTheme } from "../../ui/theme/theme.ts";
import { clearMascotEnabledCache, getSettingsManager } from "../../shared/settings.js";
import type { CommandContext } from "../registry.ts";

/**
 * Executed when /reload is called.
 */
export async function runReloadCommand(_argv: string[], options: CommandContext = {}): Promise<void> {
    if (!options.uiAPI) {
        console.log("The /reload command is only available in the interactive session.");
        return;
    }
    if (!options.sessionRuntime || !options.sessionId) throw new Error("/reload requires an active runtime session.");

    try {
        const result = await options.sessionRuntime.reloadSession(options.sessionId);
        if (result.ok) {
            clearMascotEnabledCache();
            const settings = getSettingsManager(options.sessionRuntime.getSessionSnapshot(options.sessionId)?.cwd);
            await discoverAndRegisterThemes();
            const persistedTheme = settings.getTheme();
            if (persistedTheme) setTheme(persistedTheme);
            options.uiAPI.appendSystemMessage(
                result.deferred
                    ? "Successfully reloaded configs and themes. Agent context will rebuild on the next managed turn."
                    : "Successfully reloaded configs, themes, and agent context.",
            );
        } else {
            options.uiAPI.appendSystemMessage("Reload skipped (no active root session found).");
        }
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        options.uiAPI.appendSystemMessage(`Failed to reload: ${msg}`);
    }
}
