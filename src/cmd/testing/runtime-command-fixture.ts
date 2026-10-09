import { fauxAssistantMessage, type FauxResponseFactory, fauxText, type Provider } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import type { AuthInteraction, OAuthCredential } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { join } from "@std/path";
import { __resetSettingsForTests, ONBOARDING_TUTORIAL_OFFER_HANDLED_SETTING_KEY } from "../../shared/settings.js";
import { getModelRegistry } from "../../shared/models/model-registry.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { initRunWieldTheme } from "../../ui/theme/theme.js";
import {
    assertWorkflowBinaryCallsSupported,
    writeWorkflowBinaryFixtures,
} from "../../testing/workflow-binary-fixtures.ts";

export interface RuntimeCommandFixture {
    alternateRoot: string;
    homeDir: string;
    projectRoot: string;
    settingsPath: string;
    setModelMessages(messages: RuntimeModelMessage[]): void;
    setModelResponse(text: string): void;
    setModelResponseFactory(response: FauxResponseFactory): void;
    setModelResponseFactories(responses: FauxResponseFactory[]): void;
}

export type RuntimeModelMessage = ReturnType<typeof fauxAssistantMessage>;

export type RuntimeCommandFixtureProviderState = "default" | "none" | "provider-no-model";

export interface RuntimeCommandFixtureOptions {
    /**
     * Fixture model configuration:
     * - "default": configured provider + model with a selected default (onboarding bypasses).
     * - "none": no configured providers, no selected default (welcome login prompt opens).
     * - "provider-no-model": configured provider + model, no selected default (model selector opens).
     */
    providerState?: RuntimeCommandFixtureProviderState;
    /** Leave the first-run Tutorial offer pending only in tests that drive it. */
    offerTutorial?: boolean;
    reasoning?: boolean;
    contextWindow?: number;
    additionalModels?: RuntimeCommandFixtureModel[];
}

export interface RuntimeCommandFixtureModel {
    id: string;
    name: string;
    reasoning?: boolean;
    contextWindow?: number;
}

const TEST_PROVIDER = "runtime-command-fixture";
const TEST_MODEL = "fixture-model";
const TEST_API = "runtime-command-faux";

/**
 * The scripted OAuth boundary. Only the provider's login behavior is faked;
 * everything around it — the real registry, real `/login` orchestration, real
 * `AuthInteraction` prompt callbacks, and the real credential store — runs for
 * real against the fixture `HOME`.
 */
export interface ScriptedOAuthOutcome {
    kind: "success" | "cancel" | "failure";
    error?: string;
}

export interface ScriptedOAuthProviderHandle {
    providerId: string;
    providerName: string;
    /** Script the next login attempt's outcome. */
    setOutcome(outcome: ScriptedOAuthOutcome): void;
    /** Remove the provider from the process-wide runtime. */
    unregister(): Promise<void>;
}

export const SCRIPTED_OAUTH_PROVIDER_ID = "scripted-oauth-provider";
export const SCRIPTED_OAUTH_PROVIDER_NAME = "Aardvark Fixture OAuth";
export const SCRIPTED_OAUTH_MODEL = "scripted-oauth-model";
const SCRIPTED_OAUTH_API = "runtime-scripted-oauth";

/**
 * Register a fixture OAuth provider on the real `ModelRuntime`. The provider's
 * `auth.oauth.login(interaction)` is scripted by the test:
 * - success: notifies an `auth_url`, exercises the real `prompt` callback, and
 *   returns an OAuth credential that the real credential store persists.
 * - cancel: throws `Error("Login cancelled")`; nothing is persisted.
 * - failure: throws a scripted error; nothing is persisted.
 *
 * The name sorts first in the OAuth provider list so a bare Enter at the real
 * provider prompt selects this provider, never a real builtin OAuth provider.
 */
const activeScriptedOAuthProviders = new Set<ScriptedOAuthProviderHandle>();

export async function registerScriptedOAuthProvider(): Promise<ScriptedOAuthProviderHandle> {
    let outcome: ScriptedOAuthOutcome = { kind: "success" };
    const provider: Provider = createProvider({
        id: SCRIPTED_OAUTH_PROVIDER_ID,
        name: SCRIPTED_OAUTH_PROVIDER_NAME,
        auth: {
            oauth: {
                name: "Aardvark Fixture OAuth",
                login: async (interaction: AuthInteraction): Promise<OAuthCredential> => {
                    const current = outcome;
                    if (current.kind === "cancel") throw new Error("Login cancelled");
                    if (current.kind === "failure") {
                        throw new Error(current.error || "Scripted OAuth failure");
                    }
                    interaction.notify({
                        type: "auth_url",
                        url: "https://fixture.example/authorize",
                        instructions: "Open the fixture URL to approve.",
                    });
                    await interaction.prompt({ type: "text", message: "Paste the redirect URL" });
                    return {
                        type: "oauth",
                        refresh: "fixture-oauth-refresh",
                        access: "fixture-oauth-access",
                        expires: Date.now() + 3_600_000,
                        scope: "fixture",
                    };
                },
                refresh: (credential: OAuthCredential): Promise<OAuthCredential> => Promise.resolve(credential),
                toAuth: () => Promise.resolve({ apiKey: "fixture-oauth-access" }),
            },
        },
        models: [
            {
                id: SCRIPTED_OAUTH_MODEL,
                name: "Scripted OAuth Model",
                api: SCRIPTED_OAUTH_API,
                provider: SCRIPTED_OAUTH_PROVIDER_ID,
                baseUrl: "http://127.0.0.1:0",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 4096,
            },
        ],
        api: {
            stream: () => {
                throw new Error("Scripted OAuth provider does not serve model turns.");
            },
            streamSimple: () => {
                throw new Error("Scripted OAuth provider does not serve model turns.");
            },
        },
    });

    const runtime = await getModelRegistry().getRuntime();
    runtime.registerNativeProvider(provider);

    const handle: ScriptedOAuthProviderHandle = {
        providerId: SCRIPTED_OAUTH_PROVIDER_ID,
        providerName: SCRIPTED_OAUTH_PROVIDER_NAME,
        setOutcome(next) {
            outcome = next;
        },
        unregister() {
            runtime.unregisterProvider(SCRIPTED_OAUTH_PROVIDER_ID);
            activeScriptedOAuthProviders.delete(handle);
            return Promise.resolve();
        },
    };
    activeScriptedOAuthProviders.add(handle);
    return handle;
}

async function unregisterScriptedOAuthProviders(): Promise<void> {
    await Promise.all(Array.from(activeScriptedOAuthProviders, (provider) => provider.unregister()));
}

export async function withRuntimeCommandFixture<T>(
    prefix: string,
    run: (fixture: RuntimeCommandFixture) => Promise<T>,
    options: RuntimeCommandFixtureOptions = {},
): Promise<T> {
    const providerState = options.providerState || "default";
    const configuredModels = [
        {
            id: TEST_MODEL,
            name: "Runtime Command Fixture Model",
            reasoning: options.reasoning === true,
            contextWindow: options.contextWindow,
        },
        ...(options.additionalModels || []),
    ];
    return await withProcessGlobalTestLock(async () => {
        await unregisterScriptedOAuthProviders();
        const previousHome = Deno.env.get("HOME");
        const previousSandboxHome = Deno.env.get("WLD_TEST_SANDBOX_HOME");
        const previousMnemotecaDbPath = Deno.env.get("MNEMOTECA_DB_PATH");
        const previousPath = Deno.env.get("PATH");
        const previousCwd = Deno.cwd();
        const previousExitCode = Deno.exitCode;
        const fixtureRoot = await Deno.makeTempDir({ prefix });
        const homeDir = join(fixtureRoot, "home");
        const projectRoot = join(fixtureRoot, "project");
        const alternateRoot = join(fixtureRoot, "alternate-project");
        const runwieldDir = join(homeDir, ".wld");
        const settingsPath = join(runwieldDir, "settings.json");
        const fixtureBinDir = await writeWorkflowBinaryFixtures(fixtureRoot);
        await Promise.all([
            Deno.mkdir(runwieldDir, { recursive: true }),
            Deno.mkdir(projectRoot, { recursive: true }),
            Deno.mkdir(alternateRoot, { recursive: true }),
        ]);
        if (providerState !== "none") {
            await Deno.writeTextFile(
                join(runwieldDir, "models.json"),
                JSON.stringify({
                    providers: {
                        [TEST_PROVIDER]: {
                            name: "Runtime Command Fixture Provider",
                            baseUrl: "http://127.0.0.1:0",
                            apiKey: "fixture-key",
                            api: TEST_API,
                            models: configuredModels.map((model) => ({
                                id: model.id,
                                name: model.name,
                                api: TEST_API,
                                reasoning: model.reasoning === true,
                                input: ["text", "image"],
                                contextWindow: model.contextWindow ?? 128000,
                                maxTokens: 4096,
                            })),
                        },
                    },
                }),
            );
        } else {
            await Deno.writeTextFile(join(runwieldDir, "models.json"), JSON.stringify({ providers: {} }));
        }
        if (providerState === "none") {
            await Deno.writeTextFile(join(runwieldDir, "auth.json"), JSON.stringify({}));
        } else {
            await Deno.writeTextFile(
                join(runwieldDir, "auth.json"),
                JSON.stringify({ [TEST_PROVIDER]: { type: "api_key", key: "fixture-key" } }),
            );
        }
        if (providerState === "default") {
            await Deno.writeTextFile(
                settingsPath,
                JSON.stringify({
                    defaultProvider: TEST_PROVIDER,
                    defaultModel: TEST_MODEL,
                    notifications: { enabled: false },
                    [ONBOARDING_TUTORIAL_OFFER_HANDLED_SETTING_KEY]: options.offerTutorial !== true,
                }),
            );
        } else {
            await Deno.writeTextFile(
                settingsPath,
                JSON.stringify({
                    notifications: { enabled: false },
                    [ONBOARDING_TUTORIAL_OFFER_HANDLED_SETTING_KEY]: options.offerTutorial !== true,
                }),
            );
        }
        const canonicalProjectRoot = await Deno.realPath(projectRoot);
        const canonicalAlternateRoot = await Deno.realPath(alternateRoot);
        const fauxProvider = registerFauxProvider({
            api: TEST_API,
            provider: TEST_PROVIDER,
            // Preserve every streamed delta without simulating network latency.
            tokensPerSecond: 0,
            models: configuredModels.map((model) => ({ ...model, input: ["text", "image"] })),
        });

        try {
            Deno.env.set("HOME", homeDir);
            Deno.env.set("WLD_TEST_SANDBOX_HOME", homeDir);
            Deno.env.set("MNEMOTECA_DB_PATH", join(fixtureRoot, "mnemoteca.db"));
            Deno.env.set("PATH", `${fixtureBinDir}:${previousPath || ""}`);
            Deno.chdir(canonicalAlternateRoot);
            Deno.exitCode = 0;
            __resetSettingsForTests();
            initRunWieldTheme();
            return await run({
                alternateRoot: canonicalAlternateRoot,
                homeDir,
                projectRoot: canonicalProjectRoot,
                settingsPath,
                setModelMessages: (messages) => {
                    fauxProvider.setResponses(messages.map((message) => () => message));
                },
                setModelResponse: (response) => {
                    fauxProvider.setResponses([() => fauxAssistantMessage(fauxText(response))]);
                },
                setModelResponseFactory: (response) => {
                    fauxProvider.setResponses([response]);
                },
                setModelResponseFactories: (responses) => {
                    fauxProvider.setResponses(responses);
                },
            });
        } finally {
            await unregisterScriptedOAuthProviders();
            fauxProvider.unregister?.();
            initRunWieldTheme();
            __resetSettingsForTests();
            Deno.chdir(previousCwd);
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            if (previousSandboxHome === undefined) Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            else Deno.env.set("WLD_TEST_SANDBOX_HOME", previousSandboxHome);
            if (previousMnemotecaDbPath === undefined) Deno.env.delete("MNEMOTECA_DB_PATH");
            else Deno.env.set("MNEMOTECA_DB_PATH", previousMnemotecaDbPath);
            if (previousPath === undefined) Deno.env.delete("PATH");
            else Deno.env.set("PATH", previousPath);
            Deno.exitCode = previousExitCode;
            try {
                await assertWorkflowBinaryCallsSupported(fixtureRoot);
            } finally {
                await Deno.remove(fixtureRoot, { recursive: true }).catch(() => {});
            }
        }
    });
}
