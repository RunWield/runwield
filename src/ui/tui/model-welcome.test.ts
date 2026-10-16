import { writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import {
    registerScriptedOAuthProvider,
    SCRIPTED_OAUTH_MODEL,
    SCRIPTED_OAUTH_PROVIDER_ID,
    SCRIPTED_OAUTH_PROVIDER_NAME,
    withRuntimeCommandFixture,
} from "../../cmd/testing/runtime-command-fixture.ts";
import { getSettingsManager } from "../../shared/settings.js";
import { getModelRegistry } from "../../shared/models/model-registry.ts";
import {
    detectModelAvailability,
    getConfiguredModelAvailability,
    getSelectedDefaultModelAvailability,
} from "./model-welcome.ts";
import {
    createInteractiveCompositionHarness,
    type InteractiveCompositionHarness,
} from "./testing/interactive-composition-fixture.ts";
import { ONBOARDING_WARNING } from "./onboarding-content.ts";

const WELCOME_TITLE = "Welcome to RunWield";
const MODEL_SELECTOR_MARKER = "Only showing models from configured providers";
const REDIRECT_URL = "https://fixture.example/callback";
const SCRIPTED_PROVIDER_FILTER = "Aardvark";

interface RegistryValueModel {
    id: string;
    provider: string;
}

interface RegistryValue {
    getAvailable(): RegistryValueModel[];
    find(provider: string, id: string): RegistryValueModel | undefined;
}

function registryValue(available: RegistryValueModel[]): RegistryValue {
    return {
        getAvailable: () => available,
        find: (provider: string, id: string) =>
            available.find((model) => model.id === id && (!provider || model.provider === provider)),
    };
}

/** Drive the onboarding completion path through the scripted OAuth provider. */
async function chooseSubscriptionLogin(harness: InteractiveCompositionHarness): Promise<void> {
    await harness.type("subscription\r");
}

async function completeOnboardingWithScriptedProvider(
    harness: InteractiveCompositionHarness,
): Promise<void> {
    await chooseSubscriptionLogin(harness);
    await harness.waitForScreen("Select provider to configure:");
    await harness.type(`${SCRIPTED_PROVIDER_FILTER}\r`);
    await harness.waitForScreen("Paste the redirect URL");
    await harness.type(`${REDIRECT_URL}\r`);
    await harness.waitForScreen(`Logged in to ${SCRIPTED_OAUTH_PROVIDER_NAME}.`);
    await harness.waitForScreen(MODEL_SELECTOR_MARKER);
    await harness.type(`${SCRIPTED_OAUTH_MODEL}\r`);
}

async function waitForWelcomeRePrompt(harness: InteractiveCompositionHarness): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const screen = harness.terminal.getScreenText();
        if (screen.includes(WELCOME_TITLE) && !screen.includes("Select provider to configure:")) return screen;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
        `Login cancellation did not return to the welcome prompt. Screen:\n${harness.terminal.getScreenText()}`,
    );
}

test("detectModelAvailability treats at least one available model as usable", () => {
    assertEquals(detectModelAvailability(registryValue([])), { available: false, error: null });
    assertEquals(
        detectModelAvailability(registryValue([{ id: "model", provider: "fixture" }])),
        { available: true, error: null },
    );
});

test("detectModelAvailability captures registry errors as no model", () => {
    const result = detectModelAvailability({
        getAvailable: () => {
            throw new Error("broken registry");
        },
    });
    assertEquals(result, { available: false, error: "broken registry" });
});

test("a malformed models.json in the fixture HOME degrades to no configured models without throwing", async () => {
    await withRuntimeCommandFixture("model-welcome-malformed-", async ({ homeDir, projectRoot }) => {
        await fsWriteFile(join(homeDir, ".wld", "models.json"), "{ not valid json !!!");
        const availability = getConfiguredModelAvailability();
        assertEquals(availability.available, false);
        const selected = getSelectedDefaultModelAvailability(projectRoot);
        assertEquals(selected.available, false);
        assertEquals(selected.error, "No default model is selected.");
    }, { providerState: "none" });
});

test("a usable selected fixture model bypasses onboarding without eager Router activation", async () => {
    await withRuntimeCommandFixture("model-welcome-bypass-", async () => {
        const harness = await createInteractiveCompositionHarness({});
        try {
            const composition = await harness.waitForComposition(30_000);
            const screen = harness.terminal.getScreenText();
            assert(!screen.includes(WELCOME_TITLE), "a usable selected model must bypass the welcome prompt");
            const snapshot = composition.runtime.getSessionSnapshot(composition.sessionId);
            assertEquals(snapshot?.activeAgent, "router");
            assertEquals(snapshot?.sessionManagerId, null);
            assertEquals(snapshot?.managed, null);
            assertEquals(snapshot?.busy, false);
        } finally {
            await harness.dispose();
        }
    });
});

test("no-provider onboarding can choose Claude Code CLI without login", async () => {
    await withRuntimeCommandFixture("model-welcome-claude-cli-", async ({ projectRoot }) => {
        const harness = await createInteractiveCompositionHarness({});
        try {
            await harness.waitForScreen(WELCOME_TITLE);
            await harness.type("\r"); // first option: Use Claude Code CLI
            const selectorScreen = await harness.waitForScreen(MODEL_SELECTOR_MARKER);
            assert(selectorScreen.includes("Claude CLI"));
            assert(!selectorScreen.includes("Select provider to configure:"));
            await harness.type("\r");
            const composition = await harness.waitForComposition(30_000);
            const snapshot = composition.runtime.getSessionSnapshot(composition.sessionId);
            assertEquals(snapshot?.activeAgent, "router");
            assertEquals(snapshot?.activeModel, { model: "sonnet", provider: "claude-cli" });
            assertEquals(getSettingsManager(projectRoot).getDefaultModel(), "sonnet");
            assertEquals(getSettingsManager(projectRoot).getDefaultProvider(), "claude-cli");
        } finally {
            await harness.dispose();
        }
    }, { providerState: "none" });
});

test("no providers opens the real welcome prompt and never the model selector", async () => {
    await withRuntimeCommandFixture("model-welcome-no-providers-", async () => {
        const harness = await createInteractiveCompositionHarness({});
        try {
            const screen = await harness.waitForScreen(WELCOME_TITLE);
            assert(screen.includes("Use Antigravity CLI"));
            assert(screen.includes("Use a subscription login"));
            assert(!screen.includes(MODEL_SELECTOR_MARKER), "no-provider startup must not open the model selector");
            const provider = await registerScriptedOAuthProvider();
            provider.setOutcome({ kind: "success" });
            await completeOnboardingWithScriptedProvider(harness);
            await harness.waitForComposition(30_000);
        } finally {
            await harness.dispose();
        }
    }, { providerState: "none" });
});

test("a configured provider without a selected model opens the real model selector", async () => {
    await withRuntimeCommandFixture("model-welcome-provider-no-model-", async () => {
        const harness = await createInteractiveCompositionHarness({});
        try {
            const screen = await harness.waitForScreen(MODEL_SELECTOR_MARKER);
            assert(!screen.includes(WELCOME_TITLE), "configured-provider startup must skip login onboarding");
            // Cancel the selector so the composition resolves and the test can end.
            await harness.pressKey("escape");
            await harness.waitForScreen("No model was selected");
            await harness.waitForComposition(20_000);
        } finally {
            await harness.dispose();
        }
    }, { providerState: "provider-no-model" });
});

test("cancelled model selection activates no root Session", async () => {
    await withRuntimeCommandFixture("model-welcome-selector-cancel-", async () => {
        const harness = await createInteractiveCompositionHarness({});
        try {
            await harness.waitForScreen(MODEL_SELECTOR_MARKER);
            await harness.pressKey("escape");
            const screen = await harness.waitForScreen("No model was selected");
            assert(screen.includes("Run /model to choose a default model"));
            const composition = await harness.waitForComposition(20_000);
            const snapshot = composition.runtime.getSessionSnapshot(composition.sessionId);
            assert(snapshot?.activeAgent !== "router", "cancelled model selection must not build the root Session");
            assertEquals(snapshot?.busy, false);
        } finally {
            await harness.dispose();
        }
    }, { providerState: "provider-no-model" });
});

test("subscription login through the scripted OAuth fixture runs the real /login then /model order and activates the root Session", async () => {
    await withRuntimeCommandFixture("model-welcome-subscription-", async ({ projectRoot }) => {
        const harness = await createInteractiveCompositionHarness({});
        try {
            await harness.waitForScreen(WELCOME_TITLE);
            const provider = await registerScriptedOAuthProvider();
            provider.setOutcome({ kind: "success" });
            await chooseSubscriptionLogin(harness);
            await harness.waitForScreen("Select provider to configure:");
            await harness.type(`${SCRIPTED_PROVIDER_FILTER}\r`);
            await harness.waitForScreen("Paste the redirect URL");
            await harness.type(`${REDIRECT_URL}\r`);

            // The real /login runs first: its success message must appear on the
            // combined screen before the /model model selector.
            await harness.waitForScreen(`Logged in to ${SCRIPTED_OAUTH_PROVIDER_NAME}.`);
            const combined = await harness.waitForScreen(MODEL_SELECTOR_MARKER);
            assert(
                combined.indexOf(`Logged in to ${SCRIPTED_OAUTH_PROVIDER_NAME}.`) <
                    combined.indexOf(MODEL_SELECTOR_MARKER),
                "login must complete before model selection opens",
            );
            await harness.type(`${SCRIPTED_OAUTH_MODEL}\r`);

            const composition = await harness.waitForComposition(30_000);
            const snapshot = composition.runtime.getSessionSnapshot(composition.sessionId);
            assertEquals(snapshot?.activeAgent, "router");
            assertEquals(snapshot?.activeModel.model, SCRIPTED_OAUTH_MODEL);
            assertEquals(snapshot?.busy, false);

            assertEquals(await getModelRegistry().getStoredCredentialType(SCRIPTED_OAUTH_PROVIDER_ID), "oauth");
            assertEquals(getSettingsManager(projectRoot).getDefaultModel(), SCRIPTED_OAUTH_MODEL);
            assertEquals(getSettingsManager(projectRoot).getDefaultProvider(), SCRIPTED_OAUTH_PROVIDER_ID);
        } finally {
            await harness.dispose();
        }
    }, { providerState: "none" });
});

test("selecting a model offers the Tutorial in an Empty Project Directory", async () => {
    await withRuntimeCommandFixture("model-welcome-tutorial-offer-", async () => {
        const harness = await createInteractiveCompositionHarness({});
        try {
            await harness.waitForScreen(WELCOME_TITLE);
            const provider = await registerScriptedOAuthProvider();
            provider.setOutcome({ kind: "success" });
            await chooseSubscriptionLogin(harness);
            await harness.waitForScreen("Select provider to configure:");
            await harness.type(`${SCRIPTED_PROVIDER_FILTER}\r`);
            await harness.waitForScreen("Paste the redirect URL");
            await harness.type(`${REDIRECT_URL}\r`);
            await harness.waitForScreen(MODEL_SELECTOR_MARKER);
            await harness.type(`${SCRIPTED_OAUTH_MODEL}\r`);

            const offer = await harness.waitForScreen("This tutorial makes a real change");
            assert(offer.replace(/\s+/g, " ").includes(ONBOARDING_WARNING));
            assert(offer.includes("Project:"));
            await harness.type("skip\r");
            await harness.waitForComposition(30_000);
        } finally {
            await harness.dispose();
        }
    }, { providerState: "none", offerTutorial: true });
});

test("login failure renders a user-visible error and activates no root Session", async () => {
    await withRuntimeCommandFixture("model-welcome-login-failure-", async () => {
        const harness = await createInteractiveCompositionHarness({});
        try {
            await harness.waitForScreen(WELCOME_TITLE);
            const provider = await registerScriptedOAuthProvider();
            provider.setOutcome({ kind: "failure", error: "boom" });
            await chooseSubscriptionLogin(harness);
            await harness.waitForScreen("Select provider to configure:");
            await harness.type(`${SCRIPTED_PROVIDER_FILTER}\r`);
            const errorScreen = await harness.waitForScreen("Failed to login to Aardvark Fixture OAuth: boom");
            assertStringIncludes(errorScreen, "Failed to login to");
            assert(
                harness.runtime.getSessionSnapshot(harness.sessionId)?.activeAgent !== "router",
                "login failure must not activate the root Session",
            );
            assertEquals(await getModelRegistry().getStoredCredentialType(SCRIPTED_OAUTH_PROVIDER_ID), undefined);
            // The welcome prompt re-appears instead of dropping to chat.
            await harness.waitForScreen(WELCOME_TITLE);

            provider.setOutcome({ kind: "success" });
            await completeOnboardingWithScriptedProvider(harness);
            await harness.waitForComposition(30_000);
        } finally {
            await harness.dispose();
        }
    }, { providerState: "none" });
});

test("cancelled login re-prompts instead of returning to chat", async () => {
    await withRuntimeCommandFixture("model-welcome-login-cancel-", async () => {
        const harness = await createInteractiveCompositionHarness({});
        try {
            await harness.waitForScreen(WELCOME_TITLE);
            const provider = await registerScriptedOAuthProvider();
            provider.setOutcome({ kind: "cancel" });
            await chooseSubscriptionLogin(harness);
            await harness.waitForScreen("Select provider to configure:");
            await harness.type(`${SCRIPTED_PROVIDER_FILTER}\r`);
            const rePrompted = await waitForWelcomeRePrompt(harness);
            assert(rePrompted.includes("Use a subscription login"), "login cancellation must re-prompt the welcome");
            assert(
                !rePrompted.includes("Select provider to configure:"),
                "login cancellation must leave the provider prompt",
            );
            assert(
                harness.runtime.getSessionSnapshot(harness.sessionId)?.activeAgent !== "router",
                "cancelled login must not activate the root Session",
            );
            assertEquals(await getModelRegistry().getStoredCredentialType(SCRIPTED_OAUTH_PROVIDER_ID), undefined);

            provider.setOutcome({ kind: "success" });
            await completeOnboardingWithScriptedProvider(harness);
            await harness.waitForComposition(30_000);
        } finally {
            await harness.dispose();
        }
    }, { providerState: "none" });
});

test("failed root activation returns focus to the editor with recovery guidance", async () => {
    await withRuntimeCommandFixture("model-welcome-fail-root-", async () => {
        const harness = await createInteractiveCompositionHarness({ initialAgentName: "no-such-agent" });
        try {
            await harness.waitForScreen(WELCOME_TITLE);
            const provider = await registerScriptedOAuthProvider();
            provider.setOutcome({ kind: "success" });
            await completeOnboardingWithScriptedProvider(harness);
            const screen = await harness.waitForScreen("Failed to initialize root agent after model setup");
            const normalizedScreen = screen.replace(/\s+/g, " ");
            assertStringIncludes(normalizedScreen, "Run /model");
            assertStringIncludes(normalizedScreen, "choose another model");
            const composition = await harness.waitForComposition(30_000);
            const snapshot = composition.runtime.getSessionSnapshot(composition.sessionId);
            assert(snapshot?.activeAgent !== "router", "failed root activation must not build the root Session");
            assertEquals(snapshot?.busy, false);
        } finally {
            await harness.dispose();
        }
    }, { providerState: "none" });
});
