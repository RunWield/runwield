import { mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { ok as assert, partialDeepStrictEqual as assertObjectMatch } from "node:assert/strict";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { join } from "node:path";
import { assertModelExecutionBackendSupported, UnsupportedModelExecutionBackendError } from "./model-execution.ts";
import { discoverProviderModel, RunWieldCredentialStore, RunWieldModelRegistry } from "./model-registry.ts";
import { resolveTemplateModel } from "./model-validation.ts";

const AGY_MODELS = ["gemini-3.8-flash", "gemini-3.1-pro"];

async function makeRegistry(): Promise<{ registry: RunWieldModelRegistry; tempDir: string }> {
    const tempDir = await fsMkdtemp(join(tmpdir(), "runwield-agy-cli-models-"));
    return {
        tempDir,
        registry: new RunWieldModelRegistry({
            configDir: tempDir,
            credentialStore: new RunWieldCredentialStore(join(tempDir, "auth.json")),
        }),
    };
}

test("Agy CLI exposes exactly the supported selectable base models", async () => {
    const { registry, tempDir } = await makeRegistry();
    try {
        const selectable = registry.getSelectable().filter((model) => model.provider === "agy-cli");
        assertEquals(selectable.map((model) => model.id), AGY_MODELS);
        assertEquals(
            registry.getAll().filter((model) => model.provider === "agy-cli").map((model) => model.id),
            AGY_MODELS,
        );
        assertEquals(registry.getAvailable().some((model) => model.provider === "agy-cli"), false);
        for (const model of selectable) {
            assertObjectMatch(model, {
                provider: "agy-cli",
                executionBackend: "agy-cli",
                authenticationKind: "external-cli",
                healthCheck: "execution-preflight",
                contextWindow: 128000,
                maxTokens: 16384,
            });
            assertEquals(model.input, ["text"]);
            assertEquals(registry.isSelectable(model), true);
            assertEquals(registry.hasConfiguredAuth(model), false);
            assertEquals(registry.getProviderAuthStatus("agy-cli"), { configured: false });
            assertEquals(await registry.getProviderAuth("agy-cli"), undefined);
            assertEquals(await registry.getApiKeyForProvider("agy-cli"), undefined);
            assertEquals(await registry.getApiKeyAndHeaders(model), {
                ok: false,
                error: "No API auth for external CLI provider agy-cli",
            });
            assertEquals(registry.isUsingOAuth(model), false);
            assertModelExecutionBackendSupported(model);
        }
    } finally {
        await fsRm(tempDir, { recursive: true });
    }
});

test("Agy CLI lookup accepts only the supported base models", async () => {
    const { registry, tempDir } = await makeRegistry();
    try {
        for (const modelId of AGY_MODELS) {
            const model = registry.find("agy-cli", modelId);
            assert(model);
            assertEquals(resolveTemplateModel(`agy-cli/${modelId}`, registry), {
                ok: true,
                provider: "agy-cli",
                id: modelId,
            });
        }
        for (
            const modelId of [
                "",
                "   ",
                "fixture-model",
                "gemini-3.8-flash-low",
                "gemini-3.8-flash-medium",
                "gemini-3.8-flash-high",
                "gemini-3.1-pro-low",
                "gemini-3.1-pro-high",
                `vendor/path/${crypto.randomUUID()}`,
            ]
        ) {
            assertEquals(registry.find("agy-cli", modelId), undefined);
        }
        assertEquals(resolveTemplateModel("agy-cli/gemini-3.8-flash-low", registry), { ok: false });
        assertEquals(resolveTemplateModel("missing-provider/future-model", registry), { ok: false });
    } finally {
        await fsRm(tempDir, { recursive: true });
    }
});

test("Agy CLI ignores misleading configured providers and live discovery", async () => {
    const { registry, tempDir } = await makeRegistry();
    try {
        const store = new RunWieldCredentialStore(join(tempDir, "auth.json"));
        await fsWriteFile(
            join(tempDir, "auth.json"),
            JSON.stringify({
                "agy-cli": { type: "api_key", key: "fake" },
                "claude-cli": { type: "api_key", key: "also-fake" },
                openai: { type: "api_key", key: "real" },
            }),
        );
        await fsWriteFile(
            join(tempDir, "models.json"),
            JSON.stringify({
                providers: {
                    "agy-cli": {
                        name: "Wrong API Provider",
                        apiKey: "fake",
                        baseUrl: "https://agy.example.test/v1",
                        api: "openai-completions",
                        models: [{ id: "configured-only", name: "Wrong" }],
                    },
                    local: {
                        baseUrl: "https://local.example.test/v1",
                        api: "openai-completions",
                        apiKey: "real",
                        models: [{ id: "configured" }],
                    },
                },
            }),
        );

        assertEquals(registry.find("agy-cli", "configured-only"), undefined);
        assertEquals(
            await discoverProviderModel(registry, "agy-cli", "configured-only", { fetch: fetch.bind(globalThis) }),
            undefined,
        );
        assertEquals(await store.read("agy-cli"), undefined);
        assertEquals(await store.read("claude-cli"), undefined);
        assertEquals(await store.list(), [{ providerId: "openai", type: "api_key" }]);
        assertEquals(registry.getProvider("agy-cli"), undefined);
        assertEquals(registry.getRegisteredProviderConfig("agy-cli"), undefined);
        assertEquals(registry.getRegisteredProviderIds(), ["local"]);
        assertEquals(registry.getConfiguredModels().some((entry) => entry.provider === "agy-cli"), false);
        assertEquals(registry.find("local", "configured")?.provider, "local");
    } finally {
        await fsRm(tempDir, { recursive: true });
    }
});

test("unknown execution backends still receive the typed support rejection", () => {
    const baseModel = {
        provider: "fixture",
        id: "model",
        name: "Fixture Model",
        api: "openai-completions" as const,
        baseUrl: "",
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
    };

    const error = assertThrows(
        () =>
            assertModelExecutionBackendSupported({
                ...baseModel,
                // @ts-expect-error This intentionally exercises the defensive runtime guard for invalid persisted data.
                executionBackend: "future",
            }),
        UnsupportedModelExecutionBackendError,
    );
    assertEquals(error.executionBackend, "future");
});
