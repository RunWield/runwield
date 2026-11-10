import { type AuthCommandOutcome, runLoginCommand } from "../../cmd/auth/index.ts";
import {
    getConfiguredModelAvailability,
    getConfiguredProviderAvailability,
    getSelectedDefaultModelAvailability,
} from "../../shared/session/model-readiness.ts";
import type { SessionRuntime } from "../../shared/session/session-runtime.ts";
import type { UiAPI } from "./api.ts";

type SetupChoice = "claude-cli" | "agy-cli" | "subscription" | "api-key";
type SetupStatus = "ready" | "canceled" | "failed";

interface SetupUi {
    appendSystemMessage: UiAPI["appendSystemMessage"];
    promptSelect: UiAPI["promptSelect"];
    promptText: UiAPI["promptText"];
    showModelSelector: UiAPI["showModelSelector"];
    abortActivePrompt: UiAPI["abortActivePrompt"];
}

interface ModelSetupCommandContext {
    sessionId?: string;
    sessionRuntime?: SessionRuntime;
}

interface ModelSelectionOutcome {
    selected: boolean;
}

interface RunSharedModelSetupOptions {
    uiAPI: SetupUi;
    projectRoot: string;
    argv?: string[];
    title: string;
    retryLoginFailures?: boolean;
    forceModelSelection?: boolean;
    commandContext?: ModelSetupCommandContext;
}

interface RunSharedModelSetupResult {
    status: SetupStatus;
    message: string;
    modelSelectionShown: boolean;
}

const SETUP_CHOICES = [
    {
        value: "claude-cli",
        label: "Use Claude Code CLI",
        description:
            "Select a Claude CLI alias. Requires Claude Code installed and signed in; no RunWield API key login.",
    },
    {
        value: "agy-cli",
        label: "Use Antigravity CLI",
        description:
            "Select an Antigravity CLI model. Requires Agy installed and signed in; no RunWield API key login.",
    },
    {
        value: "subscription",
        label: "Use a subscription login",
        description: "Sign in with a supported provider account.",
    },
    {
        value: "api-key",
        label: "Use an API key",
        description: "Paste a provider API key and store it in RunWield config.",
    },
];

function parseSetupChoice(value: string | undefined): SetupChoice | null {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) return null;
    if (normalized === "claude-cli") return "claude-cli";
    if (normalized === "agy-cli" || normalized === "antigravity" || normalized === "agy") return "agy-cli";
    if (normalized === "subscription" || normalized === "sub" || normalized === "oauth") return "subscription";
    if (normalized === "api-key" || normalized === "apikey" || normalized === "api_key" || normalized === "key") {
        return "api-key";
    }
    return null;
}

function loginArgForChoice(choice: SetupChoice): string {
    return choice === "subscription" ? "subscription" : "api-key";
}

function isModelSelectionOutcome(value: ModelSelectionOutcome | void): value is ModelSelectionOutcome {
    return Boolean(value && typeof value.selected === "boolean");
}

function selectedDefaultResult(
    projectRoot: string,
    modelSelectionShown: boolean,
    modelSelectionAccepted: boolean,
): RunSharedModelSetupResult {
    if (modelSelectionShown && !modelSelectionAccepted) {
        return { status: "canceled", message: "Model selection canceled.", modelSelectionShown };
    }
    const readiness = getSelectedDefaultModelAvailability(projectRoot);
    if (readiness.available) {
        return { status: "ready", message: "Model setup complete.", modelSelectionShown };
    }
    return {
        status: "failed",
        message: readiness.error || "No usable default model is selected.",
        modelSelectionShown,
    };
}

async function runLogin(options: RunSharedModelSetupOptions, argv: string[]): Promise<AuthCommandOutcome> {
    return await runLoginCommand(argv, {
        uiAPI: options.uiAPI,
        sessionId: options.commandContext?.sessionId,
        sessionRuntime: options.commandContext?.sessionRuntime,
        skipPostLoginSetup: true,
    });
}

async function runModelSelection(
    options: RunSharedModelSetupOptions,
    initialSearchInput?: string,
): Promise<boolean> {
    const result = await options.uiAPI.showModelSelector(initialSearchInput);
    return isModelSelectionOutcome(result) ? result.selected : false;
}

async function chooseSetupPath(uiAPI: SetupUi, title: string): Promise<SetupChoice | null> {
    const choice = await uiAPI.promptSelect(title, SETUP_CHOICES, { hint: "↑↓ Navigate  Enter Select  Esc Quit" });
    return parseSetupChoice(choice || undefined);
}

/**
 * Shared provider-or-Claude setup plus default-model selection for first-run and setup-only login flows.
 */
export async function runSharedModelSetup(options: RunSharedModelSetupOptions): Promise<RunSharedModelSetupResult> {
    const argv = options.argv || [];
    const explicitChoice = parseSetupChoice(argv[0]);
    let modelSelectionShown = false;

    if (argv.length > 0 && explicitChoice !== "claude-cli" && explicitChoice !== "agy-cli") {
        const outcome = await runLogin(options, argv);
        if (outcome.status === "canceled") {
            return { status: "canceled", message: "Login canceled.", modelSelectionShown };
        }
        if (outcome.status === "failed") return { status: "failed", message: outcome.message, modelSelectionShown };
        modelSelectionShown = true;
        const modelSelectionAccepted = await runModelSelection(
            options,
            outcome.providerId ? `${outcome.providerId}/` : undefined,
        );
        return selectedDefaultResult(options.projectRoot, modelSelectionShown, modelSelectionAccepted);
    }

    const selectedDefault = getSelectedDefaultModelAvailability(options.projectRoot);
    if (selectedDefault.available && argv.length === 0 && !options.forceModelSelection) {
        return { status: "ready", message: "Model setup complete.", modelSelectionShown };
    }

    if (getConfiguredModelAvailability().available || getConfiguredProviderAvailability().available) {
        modelSelectionShown = true;
        const modelSelectionAccepted = await runModelSelection(options);
        return selectedDefaultResult(options.projectRoot, modelSelectionShown, modelSelectionAccepted);
    }

    let choice = explicitChoice;
    while (true) {
        if (!choice) choice = await chooseSetupPath(options.uiAPI, options.title);
        if (!choice) return { status: "canceled", message: "Login canceled.", modelSelectionShown };

        if (choice === "claude-cli" || choice === "agy-cli") {
            modelSelectionShown = true;
            const modelSelectionAccepted = await runModelSelection(
                options,
                choice === "claude-cli" ? "claude-cli/sonnet" : "agy-cli/",
            );
            return selectedDefaultResult(options.projectRoot, modelSelectionShown, modelSelectionAccepted);
        }

        const outcome = await runLogin(options, [loginArgForChoice(choice)]);
        if (outcome.status === "authenticated") {
            modelSelectionShown = true;
            const modelSelectionAccepted = await runModelSelection(
                options,
                outcome.providerId ? `${outcome.providerId}/` : undefined,
            );
            return selectedDefaultResult(options.projectRoot, modelSelectionShown, modelSelectionAccepted);
        }
        if (!options.retryLoginFailures) {
            return {
                status: outcome.status,
                message: outcome.status === "failed" ? outcome.message : "Login canceled.",
                modelSelectionShown,
            };
        }
        choice = null;
    }
}
