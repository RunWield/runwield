/*
 * @module cmd/auth
 * Login/logout/status commands for RunWield-owned model authentication.
 */

import { AGENTS } from "../../constants.ts";
import {
    getModelRegistry,
    isExternalCliProvider,
    type RunWieldModelRegistry,
} from "../../shared/models/model-registry.ts";
import type { SessionRuntime } from "../../shared/session/session-runtime.ts";
import type { UiAPI } from "../../ui/tui/api.ts";

export interface AuthUiPort {
    abortActivePrompt: NonNullable<UiAPI["abortActivePrompt"]>;
    appendSystemMessage: UiAPI["appendSystemMessage"];
    promptSelect: UiAPI["promptSelect"];
    promptText: UiAPI["promptText"];
    showModelSelector: UiAPI["showModelSelector"];
}

interface AuthCommandOptions {
    uiAPI: AuthUiPort;
    sessionId?: string;
    sessionRuntime?: SessionRuntime;
    skipPostLoginSetup?: boolean;
}

export type AuthCommandOutcome =
    | { status: "authenticated"; providerId: string; providerName: string }
    | { status: "canceled" }
    | { status: "failed"; providerId?: string; providerName?: string; message: string };

interface AuthProviderOption {
    id: string;
    name: string;
    authType: "oauth" | "api_key";
}

const LOGIN_SUBSCRIPTION_LABEL = "Use a subscription";
const LOGIN_API_KEY_LABEL = "Use an API key";
const LOGIN_BACK_VALUE = "__runwield_login_back__";

async function hydrateModelRegistry(registry: RunWieldModelRegistry): Promise<void> {
    await registry.getRuntime();
}

function getProviderDisplayName(registry: RunWieldModelRegistry, providerId: string): string {
    try {
        return registry.getProviderDisplayName(providerId) || providerId;
    } catch {
        return providerId;
    }
}

function getOAuthProviders(registry: RunWieldModelRegistry): Array<{ id: string; name: string }> {
    return registry.getOAuthProviders();
}

async function listStoredCredentialProviders(registry: RunWieldModelRegistry): Promise<AuthProviderOption[]> {
    return await registry.listStoredCredentialProviders();
}

async function getStoredCredentialType(
    registry: RunWieldModelRegistry,
    providerId: string,
): Promise<"oauth" | "api_key" | undefined> {
    return await registry.getStoredCredentialType(providerId);
}

async function setProviderApiKey(
    registry: RunWieldModelRegistry,
    providerId: string,
    apiKey: string,
): Promise<void> {
    await registry.setProviderApiKey(providerId, apiKey);
}

async function logoutProvider(registry: RunWieldModelRegistry, providerId: string): Promise<void> {
    await registry.logoutProvider(providerId);
}

export function getLoginProviderOptions(
    registry: RunWieldModelRegistry,
    authType: "oauth" | "api_key",
): AuthProviderOption[] {
    const oauthProviders = getOAuthProviders(registry);
    if (authType === "oauth") {
        return oauthProviders
            .map((provider) => ({ id: provider.id, name: provider.name, authType }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    const providerIds = new Set(registry.getAll().map((model) => model.provider));
    return Array.from(providerIds)
        .filter((providerId) => !isExternalCliProvider(providerId))
        .map((providerId) => ({ id: providerId, name: getProviderDisplayName(registry, providerId), authType }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

async function getLogoutProviderOptions(registry: RunWieldModelRegistry): Promise<AuthProviderOption[]> {
    return (await listStoredCredentialProviders(registry)).sort((a, b) => a.name.localeCompare(b.name));
}

function parseAuthType(value: string): "oauth" | "api_key" | null {
    const normalized = value.trim().toLowerCase();
    if (["subscription", "sub", "oauth"].includes(normalized)) return "oauth";
    if (["key", "api-key", "apikey", "api_key"].includes(normalized)) return "api_key";
    return null;
}

function formatClickableTerminalUrl(url: string): string {
    const safeUrl = Array.from(url).filter((char) => {
        const code = char.charCodeAt(0);
        return code >= 32 && code !== 127;
    }).join("");
    return `\x1b]8;;${safeUrl}\x07${safeUrl}\x1b]8;;\x07`;
}

async function promptForAuthType(uiAPI: AuthUiPort): Promise<"oauth" | "api_key" | null> {
    const selected = await uiAPI.promptSelect("Select authentication method:", [
        { value: "oauth", label: LOGIN_SUBSCRIPTION_LABEL },
        { value: "api_key", label: LOGIN_API_KEY_LABEL },
    ]);
    return selected === "oauth" || selected === "api_key" ? selected : null;
}

async function promptForProvider(
    uiAPI: AuthUiPort,
    providers: AuthProviderOption[],
    mode: "login" | "logout",
    options: { allowBack?: boolean } = {},
): Promise<AuthProviderOption | "back" | null> {
    const providerOptions = providers.map((provider) => ({
        value: provider.id,
        label: provider.name,
        description: provider.authType === "oauth" ? "subscription" : "API key",
    }));
    const selected = await uiAPI.promptSelect(
        mode === "login" ? "Select provider to configure:" : "Select provider to logout:",
        options.allowBack
            ? [
                { value: LOGIN_BACK_VALUE, label: "Back", description: "Choose a different authentication method" },
                ...providerOptions,
            ]
            : providerOptions,
    );
    if (selected === LOGIN_BACK_VALUE || (selected === null && options.allowBack)) return "back";
    return providers.find((provider) => provider.id === selected) || null;
}

async function loginWithSubscription(
    uiAPI: AuthUiPort,
    provider: Pick<AuthProviderOption, "id" | "name">,
    registry: RunWieldModelRegistry,
): Promise<void> {
    try {
        await registry.loginProvider(provider.id, "oauth", {
            notify: (event: import("@earendil-works/pi-ai").AuthEvent) => {
                if (event.type === "auth_url") {
                    uiAPI.appendSystemMessage(
                        [
                            `Open this URL to login to ${provider.name}:`,
                            formatClickableTerminalUrl(event.url),
                            event.instructions || "",
                        ].filter(Boolean).join("\n"),
                    );
                } else if (event.type === "progress" || event.type === "info") {
                    uiAPI.appendSystemMessage(event.message);
                } else if (event.type === "device_code") {
                    uiAPI.appendSystemMessage(
                        `Open ${formatClickableTerminalUrl(event.verificationUri)} and enter code ${event.userCode}`,
                    );
                }
            },
            prompt: async (prompt: import("@earendil-works/pi-ai").AuthPrompt) => {
                if (prompt.type === "select") {
                    const selected = await uiAPI.promptSelect(
                        prompt.message,
                        prompt.options.map((option) => ({
                            value: option.id,
                            label: option.label,
                        })),
                    );
                    if (!selected) throw new Error("Login cancelled");
                    return selected;
                }
                if (prompt.type === "text") {
                    const value = await uiAPI.promptText(prompt.message, {
                        placeholder: prompt.placeholder,
                        allowEmpty: false,
                    });
                    if (value === null) throw new Error("Login cancelled");
                    return value;
                }
                const value = await uiAPI.promptText("Paste redirect URL below, or complete login in browser:", {
                    allowEmpty: false,
                });
                if (value === null) throw new Error("Login cancelled");
                return value;
            },
        });
        uiAPI.abortActivePrompt();
    } catch (error) {
        uiAPI.abortActivePrompt();
        throw error;
    }
}

async function loginWithApiKey(
    uiAPI: AuthUiPort,
    provider: Pick<AuthProviderOption, "id" | "name">,
    registry: RunWieldModelRegistry,
): Promise<void> {
    const apiKey = await uiAPI.promptText(`Enter API key for ${provider.name}:`, {
        allowEmpty: false,
        persistResult: false,
    });
    if (apiKey === null) throw new Error("Login cancelled");
    const trimmedApiKey = apiKey.trim();
    if (!trimmedApiKey) throw new Error("API key cannot be empty");
    await setProviderApiKey(registry, provider.id, trimmedApiKey);
}

async function configureInteractiveSessionAfterLogin(
    options: AuthCommandOptions,
    registry: RunWieldModelRegistry,
    providerId: string,
): Promise<void> {
    const availableModels = registry.getAvailable();
    const initialSearchInput = availableModels.some((model) => model.provider === providerId)
        ? `${providerId}/`
        : undefined;
    if (availableModels.length > 0) await options.uiAPI.showModelSelector(initialSearchInput);
    if (options.sessionId && options.sessionRuntime) {
        await options.sessionRuntime.switchAgent(options.sessionId, { agentName: AGENTS.ROUTER });
    }
}

export async function runLoginCommand(argv: string[], options: AuthCommandOptions): Promise<AuthCommandOutcome> {
    const { uiAPI } = options;

    const registry = getModelRegistry();
    await hydrateModelRegistry(registry);
    let authType = argv[0] ? parseAuthType(argv[0]) : null;
    const providerArg = authType ? argv[1] : argv[0];

    if (!authType && providerArg) {
        const oauthProviderIds = new Set(getOAuthProviders(registry).map((provider) => provider.id));
        authType = oauthProviderIds.has(providerArg) ? "oauth" : "api_key";
    }

    while (true) {
        if (!authType) authType = await promptForAuthType(uiAPI);
        if (!authType) return { status: "canceled" };

        const providers = getLoginProviderOptions(registry, authType);
        if (providers.length === 0) {
            const message = authType === "oauth"
                ? "No subscription providers available."
                : "No API key providers available.";
            uiAPI.appendSystemMessage(message);
            return { status: "failed", message };
        }

        let provider = providerArg ? providers.find((candidate) => candidate.id === providerArg) : null;
        if (!provider) {
            const selectedProvider = await promptForProvider(uiAPI, providers, "login", { allowBack: true });
            if (selectedProvider === "back") {
                authType = null;
                continue;
            }
            provider = selectedProvider;
        }
        if (!provider) return { status: "canceled" };

        try {
            if (provider.authType === "oauth") await loginWithSubscription(uiAPI, provider, registry);
            else await loginWithApiKey(uiAPI, provider, registry);
            uiAPI.appendSystemMessage(`Logged in to ${provider.name}.`);
            if (!options.skipPostLoginSetup) {
                await configureInteractiveSessionAfterLogin(options, registry, provider.id);
            }
            return { status: "authenticated", providerId: provider.id, providerName: provider.name };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message !== "Login cancelled") {
                uiAPI.appendSystemMessage(`Failed to login to ${provider.name}: ${message}`, true);
                return { status: "failed", providerId: provider.id, providerName: provider.name, message };
            }
            return { status: "canceled" };
        }
    }
}

export async function runLogoutCommand(argv: string[], options: AuthCommandOptions): Promise<void> {
    const { uiAPI } = options;

    const registry = getModelRegistry();
    await hydrateModelRegistry(registry);
    const providers = await getLogoutProviderOptions(registry);
    if (providers.length === 0) {
        uiAPI.appendSystemMessage("No stored credentials to remove.");
        return;
    }

    const providerArg = argv[0];
    let provider = providerArg ? providers.find((candidate) => candidate.id === providerArg) : null;
    if (!provider) {
        const selectedProvider = await promptForProvider(uiAPI, providers, "logout");
        provider = selectedProvider === "back" ? null : selectedProvider;
    }
    if (!provider) return;

    try {
        await logoutProvider(registry, provider.id);
        uiAPI.appendSystemMessage(`Logged out of ${provider.name}.`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        uiAPI.appendSystemMessage(`Logout failed: ${message}`, true);
    }
}

function formatProviderAuthStatus(registry: RunWieldModelRegistry, providerId: string): string {
    const status = registry.getProviderAuthStatus(providerId);
    switch (status.source) {
        case "environment":
            return `environment ${status.label || "API key"}`;
        case "runtime":
            return "runtime API key";
        case "fallback":
            return "custom provider config";
        case "models_json_key":
            return "key in models.json";
        case "models_json_command":
            return "command in models.json";
        case "stored":
        case "auth_json":
            return "stored";
        default:
            return "not configured";
    }
}

async function formatProviderStatusAsync(registry: RunWieldModelRegistry, providerId: string): Promise<string> {
    const credentialType = await getStoredCredentialType(registry, providerId);
    if (credentialType === "oauth") return "subscription stored";
    if (credentialType === "api_key") return "API key stored";
    return formatProviderAuthStatus(registry, providerId);
}

async function formatAuthStatusForRuntime(registry: RunWieldModelRegistry): Promise<string> {
    const oauthProviderIds = getOAuthProviders(registry).map((provider) => provider.id);
    const storedProviders = await listStoredCredentialProviders(registry);
    const providerIds = new Set([...oauthProviderIds, ...storedProviders.map((provider) => provider.id)]);
    for (const model of registry.getAll()) {
        const status = registry.getProviderAuthStatus(model.provider);
        if (!isExternalCliProvider(model.provider) && status.source) providerIds.add(model.provider);
    }
    return await formatAuthStatusLinesAsync(registry, providerIds);
}

async function formatAuthStatusLinesAsync(
    registry: RunWieldModelRegistry,
    providerIds: Set<string>,
): Promise<string> {
    const lines = [`Available models: ${registry.getAvailable().length}`, "Providers:"];
    if (providerIds.size === 0) {
        lines.push("- none configured");
        return lines.join("\n");
    }
    for (const providerId of Array.from(providerIds).sort()) {
        lines.push(
            `- ${getProviderDisplayName(registry, providerId)} (${providerId}): ${await formatProviderStatusAsync(
                registry,
                providerId,
            )}`,
        );
    }
    return lines.join("\n");
}

export async function runStatusCommand(_argv: string[], options: AuthCommandOptions): Promise<void> {
    const registry = getModelRegistry();
    await hydrateModelRegistry(registry);
    const status = await formatAuthStatusForRuntime(registry);
    options.uiAPI.appendSystemMessage(status);
}
