import { exit } from "node:process";
import type { SessionRuntime } from "@runwield/session-runtime";
import type { InteractiveSessionRuntime as InteractiveRuntime } from "@runwield/session-runtime/services";
import { stopTUI } from "../../ui/tui/tui.ts";
import { cleanupAgentBrowserSessionSync } from "../../shared/agent-browser-session.ts";

interface QuitCommandEditor {
    setText(text: string): void;
}

interface QuitCommandTui {
    requestRender(): void;
}

interface QuitCommandOptions {
    editor?: QuitCommandEditor;
    sessionRuntime?: Partial<Pick<SessionRuntime, "closeAllSessionsWhenIdle">> &
        Pick<InteractiveRuntime, "closeAllSessions">;
    tui?: QuitCommandTui;
}

export async function runQuitCommand(_argv: string[], options: QuitCommandOptions = {}): Promise<void> {
    const { editor, tui } = options;
    if (!editor || !tui) return;

    editor.setText("");
    tui.requestRender();
    setTimeout(() => {
        void (async () => {
            if (options.sessionRuntime?.closeAllSessionsWhenIdle) {
                await options.sessionRuntime.closeAllSessionsWhenIdle();
            } else {
                options.sessionRuntime?.closeAllSessions();
            }
            stopTUI();
            cleanupAgentBrowserSessionSync();
            setTimeout(() => exit(0), 100);
        })();
    }, 50);

    await Promise.resolve();
}
