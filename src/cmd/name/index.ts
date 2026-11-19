/**
 * @module cmd/name
 * Command to set or show the current session name.
 */

import { sanitizeSessionName, setTerminalTitleForName } from "../../ui/tui/terminal-title.ts";
import { theme } from "../../ui/theme/theme.ts";
import type { SessionRuntime } from "../../shared/session/session-runtime.ts";

interface NameCommandUi {
    appendSystemMessage(message: string): void;
}

interface NameCommandOptions {
    uiAPI?: NameCommandUi;
    sessionRuntime?: SessionRuntime;
    sessionId?: string;
}

export async function runNameCommand(argv: string[], options: NameCommandOptions = {}): Promise<void> {
    if (!options.uiAPI) {
        console.error("The /name command is only available inside an interactive session.");
        return;
    }

    const { uiAPI, sessionRuntime, sessionId } = options;
    if (!sessionRuntime || !sessionId) {
        uiAPI.appendSystemMessage("Error: No active session.");
        return;
    }

    const name = sanitizeSessionName(argv.join(" "));
    if (!name) {
        const currentName = sanitizeSessionName(sessionRuntime.getSessionSnapshot(sessionId)?.name || "");
        if (currentName) {
            uiAPI.appendSystemMessage(theme.fg("dim", `Session name: ${currentName}`));
        } else {
            uiAPI.appendSystemMessage(theme.fg("dim", "Usage: /name <name>"));
        }
        return;
    }

    const result = await sessionRuntime.renameSession(sessionId, name);
    if (!result.ok) {
        uiAPI.appendSystemMessage(theme.fg("dim", `Session name not changed: ${result.error || "unsupported"}`));
        return;
    }
    setTerminalTitleForName(name);
    uiAPI.appendSystemMessage(theme.fg("dim", `Session name set: ${name}`));
}
