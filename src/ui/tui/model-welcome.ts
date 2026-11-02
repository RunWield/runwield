/**
 * @module ui/tui/model-welcome
 * No-model onboarding orchestration for the interactive TUI.
 *
 * Reads the real RunWield model registry, project-scoped settings, and the
 * canonical command registry directly. The only collaborators a caller may
 * supply are the runtime objects the interactive session already owns (UI,
 * editor, TUI, session), plus the project root that scopes settings.
 */

import { COMMAND_NAMES, commandRegistry } from "../../cmd/registry.js";
import {
    detectModelAvailability,
    getConfiguredModelAvailability,
    getConfiguredProviderAvailability,
    getSelectedDefaultModelAvailability,
    type ModelAvailability,
    type ModelAvailabilitySource,
    type ModelSummary,
} from "../../shared/session/model-readiness.ts";
import type { SessionRuntime } from "../../shared/session/session-runtime.ts";
import type { Editor, TUI } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { runSharedModelSetup } from "./model-setup.ts";
import type { UiAPI } from "./types.js";

export {
    detectModelAvailability,
    getConfiguredModelAvailability,
    getConfiguredProviderAvailability,
    getSelectedDefaultModelAvailability,
};
export type { ModelAvailability, ModelAvailabilitySource, ModelSummary };

export interface MaybeShowModelWelcomeOptions {
    uiAPI: UiAPI;
    editor: Editor;
    tui: TUI;
    sessionId: string;
    sessionRuntime: SessionRuntime;
    initialAgentInternalName: string;
    initialAgentModel?: string;
    forceModelSelection?: boolean;
    /** Project root that scopes the settings manager used for defaults. */
    projectRoot: string;
    deferRootActivation?: boolean;
    cancelBehavior?: "exit" | "return-to-input";
}

export interface ModelWelcomeResult {
    shown: boolean;
    suppressBootBanner: boolean;
    noModel: boolean;
    setupCompleted: boolean;
    availabilityError?: string | null;
}

function runCommandContext(options: MaybeShowModelWelcomeOptions) {
    return {
        uiAPI: options.uiAPI,
        editor: options.editor,
        tui: options.tui,
        sessionId: options.sessionId,
        sessionRuntime: options.sessionRuntime,
    };
}

/**
 * First-run model onboarding: availability check → login
 * (`skipPostLoginSetup: true`) → `/model` → root `switchAgent`. The boot banner
 * is suppressed whenever onboarding showed.
 *
 * @param options
 * @returns {Promise<ModelWelcomeResult>}
 */
export async function maybeShowModelWelcome(options: MaybeShowModelWelcomeOptions): Promise<ModelWelcomeResult> {
    const initialAvailability = getConfiguredModelAvailability();
    const selectedDefaultAvailability = getSelectedDefaultModelAvailability(options.projectRoot);
    if (initialAvailability.available && selectedDefaultAvailability.available && !options.forceModelSelection) {
        return { shown: false, suppressBootBanner: false, noModel: false, setupCompleted: false };
    }

    options.editor.disableSubmit = true;
    options.tui.requestRender();

    const title = [
        theme.bold("Welcome to RunWield"),
        "",
        "Choose how you'd like to connect your model.",
        "RunWield needs a configured model before chat submissions can run.",
        initialAvailability.error ? `Model registry note: ${initialAvailability.error}` : "",
    ].filter(Boolean).join("\n");

    const setupResult = await runSharedModelSetup({
        uiAPI: options.uiAPI,
        projectRoot: options.projectRoot,
        title,
        retryLoginFailures: true,
        forceModelSelection: options.forceModelSelection,
        commandContext: {
            sessionId: options.sessionId,
            sessionRuntime: options.sessionRuntime,
        },
    });

    if (setupResult.status === "canceled" && !setupResult.modelSelectionShown) {
        if (options.cancelBehavior === "return-to-input") {
            options.uiAPI.appendSystemMessage(
                "Model setup cancelled. The tutorial did not start. Run /onboard when you are ready.",
                false,
                "Tutorial",
            );
            options.editor.disableSubmit = false;
            options.tui.setFocus(options.editor);
            options.tui.requestRender();
        } else {
            options.uiAPI.appendSystemMessage("Model setup cancelled. Exiting RunWield.", false, "RunWield");
            await commandRegistry[COMMAND_NAMES.QUIT].execute([], runCommandContext(options));
        }
        return { shown: true, suppressBootBanner: true, noModel: true, setupCompleted: false };
    }

    const afterSelectionAvailability = getSelectedDefaultModelAvailability(options.projectRoot);
    if (setupResult.status !== "ready" && afterSelectionAvailability.available) {
        options.uiAPI.appendSystemMessage(setupResult.message, setupResult.status === "failed", "RunWield");
        options.editor.disableSubmit = false;
        options.tui.setFocus(options.editor);
        options.tui.requestRender();
        return { shown: true, suppressBootBanner: true, noModel: false, setupCompleted: false };
    }

    if (!afterSelectionAvailability.available) {
        options.uiAPI.appendSystemMessage(
            "No model was selected. Run /model to choose a default model, run /login to configure credentials, or quit with /quit.",
            true,
            "RunWield",
        );
        options.editor.disableSubmit = false;
        options.tui.setFocus(options.editor);
        options.tui.requestRender();
        return {
            shown: true,
            suppressBootBanner: true,
            noModel: true,
            setupCompleted: false,
            availabilityError: afterSelectionAvailability.error,
        };
    }

    try {
        if (options.deferRootActivation) {
            const result = options.sessionRuntime.markPromptReadyAgent(options.sessionId, {
                agentName: options.initialAgentInternalName,
                model: options.initialAgentModel,
            });
            if (!result.ok) throw new Error(result.error || "prompt-ready metadata failed");
        }
        options.editor.disableSubmit = false;
        options.tui.setFocus(options.editor);
        options.tui.requestRender();
        return { shown: true, suppressBootBanner: true, noModel: false, setupCompleted: true };
    } catch (error) {
        options.editor.disableSubmit = false;
        options.tui.setFocus(options.editor);
        options.uiAPI.appendSystemMessage(
            `Failed to initialize root agent after model setup: ${
                error instanceof Error ? error.message : String(error)
            }. Run /model to choose another model, run /login to configure credentials, or quit with /quit.`,
            true,
            "RunWield",
        );
        options.tui.requestRender();
        return { shown: true, suppressBootBanner: true, noModel: true, setupCompleted: false };
    }
}
