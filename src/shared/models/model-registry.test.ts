import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { FetchRequest } from "../fetch-request.ts";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { mkdir as fsMkdir, readFile as fsReadFile, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import { join } from "node:path";
import {
    discoverProviderModel,
    migratePiModelConfigOnce,
    RunWieldCredentialStore,
    RunWieldModelRegistry,
} from "./model-registry.ts";

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

for (const mode of ["default", "explicit-vision", "allowlist"] as const) {
    test(`model discovery registers usable catalog entries with ${mode} image policy`, async () => {
        const tempDir = await mkdtemp(join(tmpdir(), "runwield-model-discovery-real-"));
        try {
            await fsWriteFile(
                join(tempDir, "models.json"),
                JSON.stringify({
                    providers: {
                        fixture: {
                            baseUrl: "https://provider.example/v1",
                            api: "openai-completions",
                            apiKey: "fixture-key",
                            ...(mode === "allowlist" ? { imageInputModels: ["vision-model"] } : {}),
                        },
                    },
                }),
            );
            const credentialStore = new RunWieldCredentialStore(join(tempDir, "auth.json"));
            const runtime = await ModelRuntime.create({
                credentials: credentialStore,
                modelsPath: null,
                allowModelNetwork: false,
                refreshOnCreate: false,
            });
            const registry = new RunWieldModelRegistry({ configDir: tempDir, credentialStore, runtime });
            const fetchFixture: FetchRequest = (input, init) => {
                assertEquals(String(input), "https://provider.example/v1/models");
                assertEquals(new Headers(init?.headers).get("authorization"), "Bearer fixture-key");
                return Promise.resolve(Response.json({ data: [{ id: "vision-model" }, { id: "text-model" }] }));
            };
            for (const id of ["vision-model", "text-model"]) {
                const found = await discoverProviderModel(
                    registry,
                    "fixture",
                    id,
                    { fetch: fetchFixture },
                    {
                        runwieldDir: tempDir,
                        ...(mode === "explicit-vision" ? { input: ["text", "image"] } : {}),
                    },
                );
                assert(found);
                assertEquals(found.id, id);
                assertEquals(found.provider, "fixture");
                assertEquals(
                    registry.find("fixture", id)?.input,
                    mode === "explicit-vision" || (mode === "allowlist" && id === "vision-model")
                        ? ["text", "image"]
                        : ["text"],
                );
                assertEquals(
                    registry.getSelectable().some((model) => model.provider === "fixture" && model.id === id),
                    true,
                );
            }
        } finally {
            await fsRm(tempDir, { recursive: true });
        }
    });
}
