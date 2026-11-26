import { assertEquals } from "../../src/testing/assertions.ts";
import { mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunWieldModelRegistry } from "./model-registry.ts";

test("template model resolution requires a selectable provider/model", async () => {
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
                        models: [{ id: "usable", headers: { "X-Fixture-Token": "private-header" } }],
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

        assertEquals(registry.find("authed", "usable")?.headers, { "X-Fixture-Token": "private-header" });
        for (const model of [
            registry.catalog.find("authed", "usable"),
            registry.catalog.getAll().find(({ provider }) => provider === "authed"),
            registry.catalog.getAvailable().find(({ provider }) => provider === "authed"),
            registry.catalog.getSelectable().find(({ provider }) => provider === "authed"),
        ]) {
            assertEquals(JSON.parse(JSON.stringify(model)), {
                provider: "authed",
                id: "usable",
                name: "usable",
                reasoning: false,
                input: ["text"],
                contextWindow: 128000,
                maxTokens: 16384,
            });
        }

        assertEquals(registry.catalog.resolveTemplateModel("authed/usable"), {
            ok: true,
            provider: "authed",
            id: "usable",
        });
        assertEquals(registry.catalog.resolveTemplateModel("unauthed/blocked"), { ok: false });
        for (const reference of ["authed/missing", "usable", "authed/", "/usable"]) {
            assertEquals(registry.catalog.resolveTemplateModel(reference), { ok: false });
        }
    } finally {
        await fsRm(tempDir, { recursive: true });
    }
});
