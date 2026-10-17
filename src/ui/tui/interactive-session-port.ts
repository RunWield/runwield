import { DirectoryStartupCanceled } from "./directory-warning.ts";
/** The slow interactive-session boundary used by CLI commands. */

import { startInteractiveSession } from "./chat-session.ts";
import type { UiAPI } from "./types.js";
import { SYSTEM_BROWSER_PORT } from "../../shared/browser-port.ts";

export interface InteractiveSessionOptions {
    initialAgentName?: string;
    sessionStartMode?: "new" | "continue";
    resumeSessionId?: string;
    startupIntent?: "onboard";
}

export interface InteractiveSessionPort {
    startInteractiveSession(
        userRequest: string | null,
        options: InteractiveSessionOptions,
    ): Promise<UiAPI | void>;
}

/** Production composition for commands that launch the interactive TUI. */
export const SYSTEM_INTERACTIVE_SESSION_PORT: InteractiveSessionPort = Object.freeze({
    startInteractiveSession: async (userRequest: string | null, options: InteractiveSessionOptions) => {
        try {
            return await startInteractiveSession(userRequest, { ...options, browser: SYSTEM_BROWSER_PORT });
        } catch (error) {
            if (!(error instanceof DirectoryStartupCanceled)) throw error;
        }
    },
});
