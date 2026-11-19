/**
 * @module cmd/new
 * Command to start a new session.
 */

import { getCwd } from "../../constants.ts";
import type { SessionRuntime } from "../../shared/session/session-runtime.ts";
import { setTerminalTitleForName } from "../../ui/tui/terminal-title.ts";

interface NewCommandUi {
    clearMessages?(): void;
}

interface NewCommandOptions {
    uiAPI?: NewCommandUi;
    sessionId?: string;
    sessionRuntime?: SessionRuntime;
    replaceRuntimeSession?(nextSessionId: string): void;
}

export async function runNewCommand(argv: string[], options: NewCommandOptions = {}): Promise<void> {
    if (!options.uiAPI) {
        console.error("The /new command is only available inside an interactive session.");
        return;
    }

    const { uiAPI } = options;
    const sessionName = argv.join(" ").trim();
    if (!options.sessionRuntime || !options.replaceRuntimeSession) {
        throw new Error("/new requires the SessionRuntime surface.");
    }

    const projectRoot = options.sessionId
        ? options.sessionRuntime.getSessionSnapshot(options.sessionId)?.cwd || getCwd()
        : getCwd();
    const nextSessionId = await options.sessionRuntime.createPromptReadySession({
        cwd: projectRoot,
        deferPersistenceUntilFirstMessage: true,
    });
    if (sessionName) await options.sessionRuntime.renameSession(nextSessionId, sessionName);
    options.replaceRuntimeSession(nextSessionId);
    setTerminalTitleForName(sessionName || undefined);
    uiAPI.clearMessages?.();
}
