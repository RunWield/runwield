import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { FetchRequest } from "../fetch-request.ts";
import type { JsonRecord } from "../jsonc.ts";
import type { RunWieldModel } from "./model-registry.ts";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { mkdir as fsMkdir, readFile as fsReadFile, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { ok as assert, partialDeepStrictEqual as assertObjectMatch } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import {
    discoverProviderModel,
    migratePiModelConfigOnce,
    RunWieldCredentialStore,
    RunWieldModelRegistry,
} from "./model-registry.ts";

type ModelReferenceFixture = Pick<RunWieldModel, "provider" | "id">;
type ProviderModelFixture = Pick<RunWieldModel, "id" | "input">;

interface ProviderConfigFixture extends JsonRecord {
    models: ProviderModelFixture[];
}

interface DiscoveryRequestFixture {
    headers?: Record<string, string>;
}

interface RuntimeAvailabilityFixture {
    getAvailableSnapshot(): readonly ModelReferenceFixture[];
}

type RegistryLookupFixture = Pick<RunWieldModelRegistry, "find">;
type FetchResponseFixture = Pick<Response, "ok" | "status" | "statusText" | "json">;
type FetchPortFixture = (...args: Parameters<FetchRequest>) => Promise<FetchResponseFixture>;
type RegisteredProviderCapture = ProviderConfigFixture | undefined;

test("RunWield model runtime registers statically bundled OAuth loaders before creation", async () => {
    const source = await fsReadFile(new URL("./model-registry.ts", import.meta.url), "utf8");

    assertStringIncludes(source, 'import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth"');
    assertStringIncludes(source, "registerBundledOAuthFlowsOnce();\n    const agentDir = getRunWieldModelConfigDir();");
});

test("migratePiModelConfigOnce copies Pi files into RunWield when missing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "runwield-model-config-"));
    try {
        const piDir = join(tempDir, ".pi", "agent");
        const runwieldDir = join(tempDir, ".wld");
        await fsMkdir(piDir, { recursive: true });
        await fsWriteFile(join(piDir, "models.json"), '{"providers":{}}');
        await fsWriteFile(join(piDir, "auth.json"), '{"openai":{"type":"api_key","key":"abc"}}');

        const result = migratePiModelConfigOnce({ homeDir: tempDir, runwieldDir });

        assertEquals(result.copied.sort(), ["auth.json", "models.json"]);
        assertEquals(result.failed, []);
        assertEquals(await fsReadFile(join(runwieldDir, "models.json"), "utf8"), '{"providers":{}}');
        assertEquals(
            await fsReadFile(join(runwieldDir, "auth.json"), "utf8"),
            '{"openai":{"type":"api_key","key":"abc"}}',
        );
    } finally {
        await fsRm(tempDir, { recursive: true });
    }
});

test("migratePiModelConfigOnce leaves existing RunWield files untouched", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "runwield-model-config-"));
    try {
        const piDir = join(tempDir, ".pi", "agent");
        const runwieldDir = join(tempDir, ".wld");
        await fsMkdir(piDir, { recursive: true });
        await fsMkdir(runwieldDir, { recursive: true });
        await fsWriteFile(join(piDir, "models.json"), '{"providers":{"pi":{}}}');
        await fsWriteFile(join(runwieldDir, "models.json"), '{"providers":{"runwield":{}}}');

        const result = migratePiModelConfigOnce({ homeDir: tempDir, runwieldDir });

        assertEquals(result.copied, []);
        assertEquals(await fsReadFile(join(runwieldDir, "models.json"), "utf8"), '{"providers":{"runwield":{}}}');
    } finally {
        await fsRm(tempDir, { recursive: true });
    }
});

test("migratePiModelConfigOnce supports legacy ~/.pi file location", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "runwield-model-config-"));
    try {
        const piDir = join(tempDir, ".pi");
        const runwieldDir = join(tempDir, ".wld");
        await fsMkdir(piDir, { recursive: true });
        await fsWriteFile(join(piDir, "auth.json"), '{"openai-codex":{"type":"oauth"}}');

        const result = migratePiModelConfigOnce({ homeDir: tempDir, runwieldDir });

        assertEquals(result.copied, ["auth.json"]);
        assertEquals(await fsReadFile(join(runwieldDir, "auth.json"), "utf8"), '{"openai-codex":{"type":"oauth"}}');
    } finally {
        await fsRm(tempDir, { recursive: true });
    }
});

test("RunWieldCredentialStore preserves Codex OAuth token fields", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "runwield-model-credentials-oauth-"));
    try {
        const authPath = join(tempDir, "auth.json");
        await fsWriteFile(
            authPath,
            JSON.stringify({
                "openai-codex": {
                    type: "oauth",
                    refresh: "refresh-token",
                    access: "access-token",
                    expires: 123456789,
                },
            }),
        );
        const store = new RunWieldCredentialStore(authPath);

        assertEquals(await store.read("openai-codex"), {
            type: "oauth",
            refresh: "refresh-token",
            access: "access-token",
            expires: 123456789,
        });
    } finally {
        await fsRm(tempDir, { recursive: true });
    }
});

test("RunWieldModelRegistry availability delegates to runtime snapshot when hydrated", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "runwield-model-registry-runtime-"));
    try {
        await fsWriteFile(
            join(tempDir, "models.json"),
            JSON.stringify({
                providers: {
                    configured: {
                        baseUrl: "https://example.test/v1",
                        api: "openai-completions",
                        apiKey: "configured-key",
                        models: [{ id: "local-only" }],
                    },
                },
            }),
        );
        const availableModel = { provider: "runtime", id: "available" };
        const registry = new RunWieldModelRegistry({
            configDir: tempDir,
            runtime: {
                getAvailableSnapshot: () => [availableModel],
            } as RuntimeAvailabilityFixture as ModelRuntime,
        });

        assertEquals(registry.getAvailable(), [availableModel]);
    } finally {
        await fsRm(tempDir, { recursive: true });
    }
});

test("RunWieldModelRegistry sync availability filters local models by configured auth", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "runwield-model-registry-sync-"));
    try {
        await fsWriteFile(
            join(tempDir, "models.json"),
            JSON.stringify({
                providers: {
                    authed: {
                        baseUrl: "https://authed.example.test/v1",
                        api: "openai-completions",
                        apiKey: "configured-key",
                        models: [{ id: "available" }],
                    },
                    unauthed: {
                        baseUrl: "https://unauthed.example.test/v1",
                        api: "openai-completions",
                        models: [{ id: "hidden" }],
                    },
                },
            }),
        );
        const registry = new RunWieldModelRegistry({ configDir: tempDir });

        assertEquals(
            registry.getAvailable().map((model) => `${model.provider}/${model.id}`),
            ["authed/available"],
        );
    } finally {
        await fsRm(tempDir, { recursive: true });
    }
});

test("RunWieldModelRegistry cold sync availability includes built-in models with stored credentials", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "runwield-model-registry-cold-builtin-"));
    try {
        await fsWriteFile(join(tempDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "test-key" } }));
        const registry = new RunWieldModelRegistry({ configDir: tempDir });

        const availableRefs = registry.getAvailable().map((model) => `${model.provider}/${model.id}`);

        assertEquals(
            availableRefs.some((ref) => ref.startsWith("openai/")),
            true,
        );
    } finally {
        await fsRm(tempDir, { recursive: true });
    }
});

test("discoverProviderModel registers a model returned by OpenAI-compatible /models", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "runwield-model-discovery-"));
    try {
        await fsWriteFile(
            join(tempDir, "models.json"),
            JSON.stringify({
                providers: {
                    crofai: {
                        baseUrl: "https://crof.ai/v1",
                        api: "openai-completions",
                        apiKey: "test-key",
                    },
                },
            }),
        );

        let registeredModel: ModelReferenceFixture | undefined;
        let requestedUrl: string | undefined;
        let authorization: string | undefined;
        const registry = {
            find: (provider: string, modelId: string) =>
                registeredModel && registeredModel.provider === provider && registeredModel.id === modelId
                    ? registeredModel
                    : undefined,
            registerProvider: (provider: string, config: ProviderConfigFixture) => {
                registeredModel = { provider, id: config.models[0].id };
            },
        } as RegistryLookupFixture as RunWieldModelRegistry;

        const result = await discoverProviderModel(
            registry,
            "crofai",
            "deepseek-v4-pro",
            {
                fetch: ((url: string, init: DiscoveryRequestFixture) => {
                    requestedUrl = url;
                    authorization = init.headers?.Authorization;
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        statusText: "OK",
                        json: () => Promise.resolve({ data: [{ id: "deepseek-v4-pro" }] }),
                    });
                }) as FetchRequest,
            },
            { runwieldDir: tempDir },
        );

        assertEquals(requestedUrl, "https://crof.ai/v1/models");
        assertEquals(authorization, "Bearer test-key");
        assert(result);
        assertObjectMatch(result, { provider: "crofai", id: "deepseek-v4-pro" });
    } finally {
        await fsRm(tempDir, { recursive: true });
    }
});

test("discoverProviderModel defaults discovered models to text-only input", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "runwield-model-discovery-input-"));
    try {
        await fsWriteFile(
            join(tempDir, "models.json"),
            JSON.stringify({
                providers: {
                    crofai: {
                        baseUrl: "https://crof.ai/v1",
                        api: "openai-completions",
                        apiKey: "test-key",
                    },
                },
            }),
        );

        // The real discovery call populates this capture through registerProvider.
        let registeredConfig: RegisteredProviderCapture;
        const registry = {
            find: () => (registeredConfig ? { ...registeredConfig.models[0], provider: "crofai" } : undefined),
            registerProvider: (_provider: string, config: ProviderConfigFixture) => {
                registeredConfig = config;
            },
        } as RegistryLookupFixture as RunWieldModelRegistry;

        // Default discovery (active model path): must NOT claim image support,
        // otherwise raw image bytes get sent to a text-only model and silently fail.
        const fetchFn = (() =>
            Promise.resolve({
                ok: true,
                status: 200,
                statusText: "OK",
                json: () => Promise.resolve({ data: [{ id: "deepseek-v4-pro" }] }),
            })) as FetchPortFixture as FetchRequest;

        // Default discovery (active model path): must NOT claim image support,
        // otherwise raw image bytes get sent to a text-only model and silently fail.
        await discoverProviderModel(
            registry,
            "crofai",
            "deepseek-v4-pro",
            { fetch: fetchFn },
            { runwieldDir: tempDir },
        );
        assertEquals((registeredConfig as RegisteredProviderCapture)!.models[0].input, ["text"]);

        // Explicit vision-fallback path: caller opts the discovered model into image input.
        registeredConfig = undefined;
        await discoverProviderModel(
            registry,
            "crofai",
            "deepseek-v4-pro",
            { fetch: fetchFn },
            { runwieldDir: tempDir, input: ["text", "image"] },
        );
        assertEquals((registeredConfig as RegisteredProviderCapture)!.models[0].input, ["text", "image"]);
    } finally {
        await fsRm(tempDir, { recursive: true });
    }
});

test("discoverProviderModel honors provider imageInputModels allowlist", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "runwield-model-discovery-allowlist-"));
    try {
        await fsWriteFile(
            join(tempDir, "models.json"),
            JSON.stringify({
                providers: {
                    crofai: {
                        baseUrl: "https://crof.ai/v1",
                        api: "openai-completions",
                        apiKey: "test-key",
                        imageInputModels: ["vision-model"],
                    },
                },
            }),
        );

        // The real discovery call populates this capture through registerProvider.
        let registeredConfig: RegisteredProviderCapture;
        const registry = {
            find: () => undefined,
            registerProvider: (_provider: string, config: ProviderConfigFixture) => {
                registeredConfig = config;
            },
        } as RegistryLookupFixture as RunWieldModelRegistry;

        const fetchFn = (() =>
            Promise.resolve({
                ok: true,
                status: 200,
                statusText: "OK",
                json: () => Promise.resolve({ data: [{ id: "vision-model" }, { id: "text-model" }] }),
            })) as FetchPortFixture as FetchRequest;

        // Listed in imageInputModels -> vision-capable.
        await discoverProviderModel(
            registry,
            "crofai",
            "vision-model",
            { fetch: fetchFn },
            {
                runwieldDir: tempDir,
            },
        );
        assertEquals((registeredConfig as RegisteredProviderCapture)!.models[0].input, ["text", "image"]);

        // Not listed -> text-only.
        registeredConfig = undefined;
        await discoverProviderModel(
            registry,
            "crofai",
            "text-model",
            { fetch: fetchFn },
            {
                runwieldDir: tempDir,
            },
        );
        assertEquals((registeredConfig as RegisteredProviderCapture)!.models[0].input, ["text"]);
    } finally {
        await fsRm(tempDir, { recursive: true });
    }
});
