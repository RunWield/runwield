import type { SessionRuntime } from "../../shared/session/session-runtime.ts";
import type { UiAPI } from "../../ui/tui/types.js";

export const INIT_FILE_CONFIRMATION = `Init will create or update these project files:

- .wld/settings.json — project settings, including the verification command you choose.
- docs/domain-language.md — a glossary of the project's current terms and concepts.
- .gitignore — RunWield's managed rules for keeping its internal runtime state out of Git; existing unrelated rules are preserved.

RunWield also keeps ignored workflow state in .wld/internal/, indexes the codebase, and saves project memories.

Is it OK to create or update these files?`;

export const INIT_DECLINED_MESSAGE =
    "Init cannot proceed without permission to create or update these files. Run /init if you change your mind.";

interface InitConsentOptions {
    sessionRuntime?: SessionRuntime;
    sessionId?: string;
    uiAPI?: Partial<Pick<UiAPI, "promptSelect">>;
}

export async function confirmInitFiles(options: InitConsentOptions): Promise<boolean> {
    const choices = [
        { value: "yes", label: "Yes, initialize this project" },
        { value: "no", label: "No, stop initialization" },
    ];
    if (options.uiAPI?.promptSelect) {
        return await options.uiAPI.promptSelect(INIT_FILE_CONFIRMATION, choices) === "yes";
    }
    if (options.sessionRuntime && options.sessionId) {
        const answer = await options.sessionRuntime.requestInteraction(options.sessionId, {
            id: "init-project-files",
            type: "select",
            prompt: INIT_FILE_CONFIRMATION,
            options: choices,
            defaultValue: "no",
        });
        return "outcome" in answer && answer.outcome === "selected" && answer.value === "yes";
    }
    const answer = globalThis.prompt(`${INIT_FILE_CONFIRMATION}\nType yes to continue:`);
    return /^(y|yes)$/i.test(answer?.trim() || "");
}
