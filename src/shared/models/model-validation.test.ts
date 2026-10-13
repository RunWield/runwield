import { assertEquals } from "../../testing/assertions.ts";
import { mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunWieldModelRegistry } from "./model-registry.ts";
import { formatProviderModelReference, parseProviderModel, resolveTemplateModel } from "./model-validation.ts";

test("parseProviderModel accepts strict provider/id", () => {
    const parsed = parseProviderModel("openai/gpt-4.1");
    assertEquals(parsed, { ok: true, provider: "openai", id: "gpt-4.1" });
});

test("parseProviderModel rejects non provider/id formats", () => {
    assertEquals(parseProviderModel("gpt-4.1"), { ok: false });
    assertEquals(parseProviderModel("openai/"), { ok: false });
    assertEquals(parseProviderModel("/gpt-4.1"), { ok: false });
});

test("formatProviderModelReference qualifies active model state exactly once", () => {
    assertEquals(formatProviderModelReference({ model: "gpt-5", provider: "openai" }), "openai/gpt-5");
    assertEquals(
        formatProviderModelReference({ model: "openai/gpt-5", provider: "openai" }),
        "openai/gpt-5",
    );
    assertEquals(formatProviderModelReference({ model: "local-model" }), "local-model");
});

test("resolveTemplateModel returns ok for valid configured model", () => {
    const result = resolveTemplateModel("openai/gpt-4.1", {
        find: (provider, model) => ({ provider, id: model }),
        hasConfiguredAuth: () => true,
    });

    assertEquals(result, { ok: true, provider: "openai", id: "gpt-4.1" });
});

test("resolveTemplateModel fails for unknown model", () => {
    const result = resolveTemplateModel("openai/gpt-4.1", {
        find: () => null,
        hasConfiguredAuth: () => true,
    });

    assertEquals(result, { ok: false });
});

test("resolveTemplateModel fails when auth is missing", () => {
    const result = resolveTemplateModel("openai/gpt-4.1", {
        find: (provider, model) => ({ provider, id: model }),
        hasConfiguredAuth: () => false,
    });

    assertEquals(result, { ok: false });
});

test("resolveTemplateModel uses the sync facade configured-auth contract", async () => {
    const tempDir = await fsMkdtemp(join(tmpdir(), "runwield-model-validation-facade-"));
    try {
        await fsWriteFile(
            join(tempDir, "models.json"),
            JSON.stringify({
                providers: {
                    authed: {
                        baseUrl: "https://authed.example.test/v1",
                        api: "openai-completions",
                        apiKey: "configured-key",
                        models: [{ id: "usable" }],
                    },
                    unauthed: {
                        baseUrl: "https://unauthed.example.test/v1",
                        api: "openai-completions",
                        models: [{ id: "blocked" }],
                    },
                },
            }),
        );
        const registry = new RunWieldModelRegistry({ configDir: tempDir });

        assertEquals(resolveTemplateModel("authed/usable", registry), { ok: true, provider: "authed", id: "usable" });
        assertEquals(resolveTemplateModel("unauthed/blocked", registry), { ok: false });
    } finally {
        await fsRm(tempDir, { recursive: true });
    }
});
