import { writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { __resetSettingsForTests } from "../settings.js";
import { type RuntimeFixture, withRemoteRuntimeFixture } from "./remote-runtime-test-fixture.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function configureVision(f: RuntimeFixture, visionInput: string[] = ["text", "image"]) {
    await fsWriteFile(
        join(f.homeDir, ".wld", "models.json"),
        JSON.stringify({
            providers: {
                "runtime-command-fixture": {
                    api: "runtime-command-faux",
                    baseUrl: "http://127.0.0.1:0",
                    apiKey: "laptop-only-vision-secret",
                    models: [
                        {
                            id: "fixture-model",
                            name: "Text model",
                            input: ["text"],
                            contextWindow: 128000,
                            maxTokens: 4096,
                        },
                        {
                            id: "vision-model",
                            name: "Vision model",
                            input: visionInput,
                            contextWindow: 128000,
                            maxTokens: 4096,
                        },
                    ],
                },
            },
        }),
    );
    const settings = {
        defaultProvider: "runtime-command-fixture",
        defaultModel: "fixture-model",
        visionFallback: { model: "runtime-command-fixture/vision-model" },
        notifications: { enabled: false },
    };
    await fsWriteFile(f.settingsPath, JSON.stringify(settings));
    await fsWriteFile(join(f.resources, "settings.json"), JSON.stringify(settings));
    __resetSettingsForTests();
}

for (const source of ["project", "attachment"] as const) {
    test(`remote text-only root describes an image from ${source} through the laptop vision fallback`, async () => {
        await withRemoteRuntimeFixture(async (f) => {
            await configureVision(f);
            // Omit see_image from the Agent definition: fallback must activate it automatically.
            await fsWriteFile(
                join(f.resources, "agents", "remote-runtime.md"),
                "---\nname: Remote Runtime\ndescription: Text-only image conversation\ntools:\n    - read\n---\nDescribe images when asked.\n",
            );
            await fsWriteFile(
                join(f.remoteProject, "pixel.png"),
                Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)),
            );
            const contexts: string[] = [];
            f.setModelResponseFactories([
                (context) => {
                    const serialized = JSON.stringify(context);
                    contexts.push(serialized);
                    const imageRef =
                        source === "project" ? "pixel.png" : serialized.match(/attachment:[a-f0-9-]+/)?.[0];
                    assert(imageRef, serialized);
                    return fauxAssistantMessage(fauxToolCall("see_image", { imageRef, question: "What is visible?" }));
                },
                (context) => {
                    contexts.push(JSON.stringify(context));
                    return fauxAssistantMessage(fauxText("A small amber pixel."));
                },
                (context) => {
                    contexts.push(JSON.stringify(context));
                    return fauxAssistantMessage(fauxText("The vision model described an amber pixel."));
                },
            ]);
            const child = await f.start();
            await child.read();
            await child.send({ kind: "turn", text: "Describe the image.", image: source === "attachment" });
            const result = await child.read();
            assertEquals(result.ok, true, JSON.stringify(result));
            assertEquals(contexts.length, 3, JSON.stringify(result));
            assertEquals(
                f.modelRequests.map((request) => `${request.provider}/${request.model}`),
                [
                    "runtime-command-fixture/fixture-model",
                    "runtime-command-fixture/vision-model",
                    "runtime-command-fixture/fixture-model",
                ],
            );
            assertEquals(f.modelRequests[1].options.maxTokens, 2048);
            assertStringIncludes(contexts[0], "see_image");
            assertEquals(contexts[0].includes('"type":"image"'), false);
            assertStringIncludes(contexts[1], '"type":"image"');
            assertStringIncludes(contexts[1], PNG);
            assertStringIncludes(contexts[1], "What is visible?");
            assertStringIncludes(contexts[2], "A small amber pixel.");
            assert(result.savedId);
            const transcript = (await f.control.list(result.savedId))[0].contents || "";
            assertStringIncludes(transcript, '"toolName":"see_image"');
            assertStringIncludes(transcript, "A small amber pixel.");
            assertEquals(transcript.includes("laptop-only-vision-secret"), false);
        });
    });
}

test("remote text-only root rejects a fallback without image input before model execution", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        await configureVision(f, ["text"]);
        let executed = false;
        f.setModelResponseFactory(() => {
            executed = true;
            return fauxAssistantMessage(fauxText("Should not run."));
        });
        const child = await f.start();
        await child.read();
        await child.send({ kind: "turn", text: "Describe pixel.png." });
        const result = await child.read();
        assertEquals(result.ok, false, JSON.stringify(result));
        assertStringIncludes(result.error || "", "visionFallback.model is not vision-capable");
        assertEquals(executed, false);
    });
});
