import { assertEquals } from "../../testing/assertions.ts";
import { mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunWieldModelRegistry } from "./model-registry.ts";
import { resolveTemplateModel } from "./model-validation.ts";

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
        for (const reference of ["authed/missing", "usable", "authed/", "/usable"]) {
            assertEquals(resolveTemplateModel(reference, registry), { ok: false });
        }
    } finally {
        await fsRm(tempDir, { recursive: true });
    }
});
