import { assertEquals } from "../testing/assertions.ts";
import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { env } from "node:process";
import { test, type TestContext } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHomeDir } from "../constants.ts";
import { withProcessGlobalTestLock } from "../testing/process-global-lock.ts";
import { persistImageAttachment } from "../shared/session/image-attachments.ts";
import { createSeeImageTool } from "./see-image.ts";

import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { registerBuiltInApiProviders, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { codingAgent } from "@runwield/pi-ai/coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const expectedDefaultQuestion =
    "Describe this image in detail for a text-only coding agent. Include all visible UI/content, readable text and error messages, relevant layout, controls, highlighted regions, and visual state. If text or details are unclear, say so explicitly.";

type SeeImageTool = ReturnType<typeof createSeeImageTool>;
type SeeImageToolContext = Parameters<SeeImageTool["execute"]>[4];
function registerVisionProvider(t: TestContext) {
    const provider = registerFauxProvider({ api: "openai-completions", provider: "vision", models: [{ id: "model" }] });
    t.after(() => {
        provider.unregister();
        registerBuiltInApiProviders();
    });
    return provider;
}

async function writeVisionFallbackSetting(cwd: string) {
    await fsMkdir(join(cwd, ".wld"), { recursive: true });
    await fsWriteFile(
        join(cwd, ".wld", "settings.json"),
        JSON.stringify({
            visionFallback: { model: "vision/model" },
        }),
    );
}

async function writeVisionModelConfig(tempHome: string) {
    await fsMkdir(join(tempHome, ".wld"), { recursive: true });
    await fsWriteFile(
        join(tempHome, ".wld", "models.json"),
        JSON.stringify({
            providers: {
                vision: {
                    baseUrl: "https://example.invalid/v1",
                    api: "openai-completions",
                    apiKey: "key",
                    headers: { a: "b" },
                    models: [{ id: "model", input: ["text", "image"] }],
                },
            },
        }),
    );
}

async function removeTempDir(path: string) {
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            await fsRm(path, { recursive: true });
            return;
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        }
    }
    throw lastError;
}

test("see_image maps a native vision response and forwards cancellation", async (t) => {
    const provider = registerVisionProvider(t);
    await withProcessGlobalTestLock(async () => {
        const originalHome = getHomeDir();
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-see-image-home-"));
        const cwd = await fsMkdtemp(join(tmpdir(), "runwield-see-image-"));
        try {
            env.HOME = tempHome;
            await writeVisionModelConfig(tempHome);
            await writeVisionFallbackSetting(cwd);
            await fsWriteFile(join(cwd, "shot.png"), new Uint8Array([1, 2, 3]));
            const controller = new AbortController();
            provider.setResponses([
                (context, options, _state, model) => {
                    const message = context.messages[0];
                    assertEquals(context.messages.length, 1);
                    assertEquals(message.role, "user");
                    assertEquals(message.content, [
                        { type: "text", text: expectedDefaultQuestion },
                        { type: "image", data: "AQID", mimeType: "image/png" },
                    ]);
                    assertEquals(model.provider, "vision");
                    assertEquals(model.id, "model");
                    assertEquals(options?.apiKey, "key");
                    assertEquals(options?.headers?.a, "b");
                    assertEquals(options?.maxTokens, 2048);
                    return fauxAssistantMessage([fauxText("one"), fauxThinking("internal"), fauxText("two")]);
                },
                (_context, options) => {
                    assertEquals(options?.signal, controller.signal);
                    controller.abort();
                    return fauxAssistantMessage(fauxText("canceled text"));
                },
            ]);
            const outcomes: string[] = [];
            const tool = createSeeImageTool({
                cwd,
                completeTurn: codingAgent.complete,
                onModelStart: () => ({
                    finish(_usage, outcome) {
                        outcomes.push(outcome);
                    },
                }),
            });

            const result = await tool.execute(
                "1",
                { imageRef: "shot.png" },
                undefined,
                undefined,
                {} as SeeImageToolContext,
            );

            assertEquals(result.content, [{ type: "text", text: "one\ntwo" }]);
            const canceled = await tool.execute(
                "2",
                { imageRef: "shot.png" },
                controller.signal,
                undefined,
                {} as SeeImageToolContext,
            );
            assertEquals(canceled.isError, true);
            assertEquals(controller.signal.aborted, true);
            assertEquals(outcomes, ["succeeded", "canceled"]);
            assertEquals(provider.state.callCount, 2);
        } finally {
            env.HOME = originalHome;
            await removeTempDir(tempHome);
            await removeTempDir(cwd);
        }
    });
});

test("see_image returns tool error on auth failure", async (t) => {
    const provider = registerVisionProvider(t);
    await withProcessGlobalTestLock(async () => {
        const originalHome = getHomeDir();
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-see-image-home-"));
        const cwd = await fsMkdtemp(join(tmpdir(), "runwield-see-image-"));
        try {
            env.HOME = tempHome;
            await fsMkdir(join(tempHome, ".wld"), { recursive: true });
            await fsWriteFile(
                join(tempHome, ".wld", "models.json"),
                JSON.stringify({
                    providers: {
                        "missing-vision": {
                            baseUrl: "https://example.invalid/v1",
                            api: "openai-completions",
                            models: [{ id: "model", input: ["text", "image"] }],
                        },
                    },
                }),
            );
            await fsMkdir(join(cwd, ".wld"), { recursive: true });
            await fsWriteFile(
                join(cwd, ".wld", "settings.json"),
                JSON.stringify({
                    visionFallback: { model: "missing-vision/model" },
                }),
            );
            await fsWriteFile(join(cwd, "shot.png"), new Uint8Array([1]));
            const tool = createSeeImageTool({
                cwd,
                completeTurn: codingAgent.complete,
            });
            const result = await tool.execute(
                "1",
                { imageRef: "shot.png" },
                undefined,
                undefined,
                {} as SeeImageToolContext,
            );
            assertEquals(result.isError, true);
            assertEquals(provider.state.callCount, 0);
            assertEquals(result.content[0], {
                type: "text",
                text: "No API key configured for visionFallback.model: missing-vision/model",
            });
        } finally {
            env.HOME = originalHome;
            await removeTempDir(tempHome);
            await removeTempDir(cwd);
        }
    });
});

test("see_image resolves attachment refs from the session image directory", async (t) => {
    const provider = registerVisionProvider(t);
    await withProcessGlobalTestLock(async () => {
        const originalHome = getHomeDir();
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-see-image-home-"));
        const cwd = await fsMkdtemp(join(tmpdir(), "runwield-see-image-attachment-"));
        try {
            env.HOME = tempHome;
            await writeVisionModelConfig(tempHome);
            await writeVisionFallbackSetting(cwd);
            const sessionManager = SessionManager.create(cwd, join(tempHome, "sessions"));
            const attachment = await persistImageAttachment(
                { base64: btoa("img"), mimeType: "image/png" },
                sessionManager,
                cwd,
            );
            provider.setResponses([
                (context) => {
                    assertEquals(context.messages[0].content, [
                        { type: "text", text: expectedDefaultQuestion },
                        { type: "image", data: btoa("img"), mimeType: "image/png" },
                    ]);
                    return fauxAssistantMessage(fauxText("attachment description"));
                },
            ]);
            const tool = createSeeImageTool({ cwd, sessionManager, completeTurn: codingAgent.complete });

            const result = await tool.execute(
                "1",
                { imageRef: attachment.ref },
                undefined,
                undefined,
                {} as SeeImageToolContext,
            );

            assertEquals(result.content[0], { type: "text", text: "attachment description" });
            assertEquals(provider.state.callCount, 1);
        } finally {
            env.HOME = originalHome;
            await removeTempDir(tempHome);
            await removeTempDir(cwd);
        }
    });
});
