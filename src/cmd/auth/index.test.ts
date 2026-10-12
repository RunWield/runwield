import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import {
    registerScriptedOAuthProvider,
    SCRIPTED_OAUTH_PROVIDER_ID,
    withRuntimeCommandFixture,
} from "../testing/runtime-command-fixture.ts";
import { getModelRegistry, type RunWieldModelRegistry } from "../../shared/models/model-registry.ts";
import { getLoginProviderOptions, runLoginCommand } from "./index.ts";
import type { SessionRuntime } from "../../shared/session/session-runtime.ts";
import {
    createInteractiveCompositionHarness,
    type InteractiveCompositionHarness,
} from "../../ui/tui/testing/interactive-composition-fixture.ts";

const FIXTURE_PROVIDER = "runtime-command-fixture";
const FIXTURE_PROVIDER_DISPLAY = "Runtime Command Fixture Provider";
const API_KEY_PROMPT = "Enter API key for Runtime Command Fixture Provider:";
const MODEL_SELECTOR_MARKER = "Only showing models from configured providers";

interface AuthTestContext {
    harness: InteractiveCompositionHarness;
    registry: RunWieldModelRegistry;
    runtime: SessionRuntime;
    sessionId: string;
}

async function withAuthTest(
    prefix: string,
    run: (context: AuthTestContext) => Promise<void>,
): Promise<void> {
    await withRuntimeCommandFixture(prefix, async () => {
        const harness = createInteractiveCompositionHarness({
            initialAgentName: "guide",
            terminalRows: 40,
        });
        try {
            const composition = await harness.waitForComposition(30_000);
            const registry = getModelRegistry();
            await registry.getRuntime();
            assert(
                !registry.getOAuthProviders().some((provider) => provider.id === SCRIPTED_OAUTH_PROVIDER_ID),
                "a scripted provider from another fixture must not leak into this registry",
            );
            assertEquals(composition.runtime.getSessionSnapshot(composition.sessionId)?.activeAgent, "guide");
            await run({
                harness,
                registry,
                runtime: composition.runtime,
                sessionId: composition.sessionId,
            });
        } finally {
            await harness.dispose();
        }
    });
}

test("subscription provider choices come from the hydrated fixture registry", async () => {
    await withAuthTest("auth-provider-list-", async ({ harness }) => {
        const provider = await registerScriptedOAuthProvider();
        await harness.type("/login subscription\r");
        const providerScreen = await harness.waitForScreen("Select provider to configure:");
        assertStringIncludes(providerScreen, provider.providerName);
        assertStringIncludes(providerScreen, "subscription");
        await harness.pressKey("escape");
        await harness.waitForScreen("Select authentication method:");
        await harness.pressKey("escape");
        await harness.waitForIdle(3_000);
    });
});

test("API-key login offers OpenAI even when it supports subscription login", async () => {
    await withAuthTest("auth-openai-api-key-", async ({ registry, harness }) => {
        assert(registry.getOAuthProviders().some((provider) => provider.id === "openai"));
        await harness.type("/login api-key openai\r");
        await harness.waitForScreen("Enter API key for OpenAI:");
        await harness.pressKey("escape");
        await harness.waitForIdle(3_000);
    });
});

test("API-key login persists through the fixture credential store and status command", async () => {
    await withAuthTest("auth-api-key-login-", async ({ harness, registry }) => {
        await registry.logoutProvider(FIXTURE_PROVIDER);
        assertEquals(await registry.getStoredCredentialType(FIXTURE_PROVIDER), undefined);

        await harness.type(`/login api-key ${FIXTURE_PROVIDER}\r`);
        await harness.waitForScreen(API_KEY_PROMPT);
        await harness.type(" fixture-secret \r");
        await harness.waitForScreen(`Logged in to ${FIXTURE_PROVIDER_DISPLAY}.`);
        assertEquals(await registry.getStoredCredentialType(FIXTURE_PROVIDER), "api_key");

        await harness.waitForScreen(MODEL_SELECTOR_MARKER);
        await harness.pressKey("escape");
        await harness.waitForIdle(5_000);
        await harness.type("/status\r");
        const statusScreen = await harness.waitForScreen("Available models:", 60_000);
        assertStringIncludes(statusScreen, `${FIXTURE_PROVIDER_DISPLAY} (${FIXTURE_PROVIDER}): API key`);
        assertStringIncludes(statusScreen, "stored");
    });
});

test("external CLI credentials stay out of API auth login, status, and logout choices", async () => {
    await withAuthTest("auth-external-cli-exclusion-", async ({ harness, registry }) => {
        await registry.credentialStore.modify("claude-cli", () => Promise.resolve({ type: "api_key", key: "fake" }));
        await registry.credentialStore.modify("agy-cli", () => Promise.resolve({ type: "api_key", key: "fake" }));
        assertEquals(
            (await registry.listStoredCredentialProviders()).map((provider) => provider.id),
            [FIXTURE_PROVIDER],
        );

        const loginProviders = getLoginProviderOptions(registry, "api_key");
        assert(loginProviders.some((provider) => provider.id === FIXTURE_PROVIDER));
        assert(!loginProviders.some((provider) => provider.id === "claude-cli"));
        assert(!loginProviders.some((provider) => provider.id === "agy-cli"));

        await harness.type("/status\r");
        const statusScreen = await harness.waitForScreen("Available models:");
        assert(!statusScreen.includes("(claude-cli):"));
        assert(!statusScreen.includes("(agy-cli):"));

        await harness.type("/logout\r");
        const logoutScreen = await harness.waitForScreen("Select provider to logout:");
        assertStringIncludes(logoutScreen, FIXTURE_PROVIDER_DISPLAY);
        assert(!logoutScreen.includes("(claude-cli):"));
        assert(!logoutScreen.includes("(agy-cli):"));
        await harness.pressKey("escape");
        await harness.waitForIdle(3_000);
    });
});

test("post-login setup shows the model selector and switches the real Session to Router", async () => {
    await withAuthTest("auth-post-login-session-", async ({ harness, registry, runtime, sessionId }) => {
        await harness.type(`/login api-key ${FIXTURE_PROVIDER}\r`);
        await harness.waitForScreen(API_KEY_PROMPT);
        await harness.type("replacement-secret\r");
        await harness.waitForScreen(`Logged in to ${FIXTURE_PROVIDER_DISPLAY}.`);
        await harness.waitForScreen(MODEL_SELECTOR_MARKER);
        await harness.pressKey("escape");

        for (let attempt = 0; attempt < 200; attempt += 1) {
            if (runtime.getSessionSnapshot(sessionId)?.activeAgent === "router") break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assertEquals(runtime.getSessionSnapshot(sessionId)?.activeAgent, "router");
        assertEquals(await registry.getStoredCredentialType(FIXTURE_PROVIDER), "api_key");
        await harness.waitForIdle(5_000);
    });
});

test("logout removes the fixture credential and status reflects the fallback model key", async () => {
    await withAuthTest("auth-logout-", async ({ harness, registry }) => {
        assertEquals(await registry.getStoredCredentialType(FIXTURE_PROVIDER), "api_key");
        await harness.type(`/logout ${FIXTURE_PROVIDER}\r`);
        await harness.waitForScreen(`Logged out of ${FIXTURE_PROVIDER_DISPLAY}.`);
        assertEquals(await registry.getStoredCredentialType(FIXTURE_PROVIDER), undefined);

        await harness.type("/status\r");
        const statusScreen = await harness.waitForScreen("Available models:");
        assertStringIncludes(statusScreen, `${FIXTURE_PROVIDER_DISPLAY} (${FIXTURE_PROVIDER}): key in`);
        assertStringIncludes(statusScreen, "models.json");
    });
});

test("cancelling API-key input leaves the fixture credential store unchanged", async () => {
    await withAuthTest("auth-api-key-cancel-", async ({ harness, registry }) => {
        await registry.logoutProvider(FIXTURE_PROVIDER);
        assertEquals(await registry.getStoredCredentialType(FIXTURE_PROVIDER), undefined);

        await harness.type(`/login api-key ${FIXTURE_PROVIDER}\r`);
        await harness.waitForScreen(API_KEY_PROMPT);
        await harness.pressKey("escape");
        await harness.waitForIdle(3_000);
        assertEquals(await registry.getStoredCredentialType(FIXTURE_PROVIDER), undefined);
    });
});

test("API-key login rejects whitespace-only keys and reports failure", async () => {
    await withRuntimeCommandFixture("auth-api-key-blank-", async () => {
        const registry = getModelRegistry();
        await registry.logoutProvider(FIXTURE_PROVIDER);
        const messages: string[] = [];
        const outcome = await runLoginCommand(["api-key", FIXTURE_PROVIDER], {
            uiAPI: {
                abortActivePrompt: () => {},
                appendSystemMessage: (message) => messages.push(message),
                promptSelect: () => Promise.resolve(null),
                promptText: () => Promise.resolve("   "),
                showModelSelector: () => {},
            },
        });

        if (outcome.status !== "failed") throw new Error(`Expected failed outcome, got ${outcome.status}`);
        assertStringIncludes(outcome.message, "API key cannot be empty");
        assertEquals(await registry.getStoredCredentialType(FIXTURE_PROVIDER), undefined);
        assertEquals(messages.some((message) => message.includes("Failed to login")), true);
    }, { providerState: "provider-no-model" });
});
