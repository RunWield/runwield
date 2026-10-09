import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { getHomeDir } from "../constants.js";
import { withProcessGlobalTestLock } from "../testing/process-global-lock.ts";
import { persistImageAttachment } from "../shared/session/image-attachments.ts";
import { createSeeImageTool, DEFAULT_SEE_IMAGE_PROMPT, extractAssistantText } from "./see-image.ts";

const TEST_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
const TEST_USAGE = Object.freeze({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: TEST_COST,
});

Deno.test("extractAssistantText joins text blocks", () => {
    assertEquals(
        extractAssistantText([{ type: "text", text: "one" }, { type: "image", data: "x" }, {
            type: "text",
            text: "two",
        }]),
        "one\ntwo",
    );
});

/** @param {string} cwd */
async function writeVisionFallbackSetting(cwd) {
    await Deno.mkdir(join(cwd, ".wld"), { recursive: true });
    await Deno.writeTextFile(
        join(cwd, ".wld", "settings.json"),
        JSON.stringify({
            visionFallback: { model: "vision/model" },
        }),
    );
}

/** @param {string} tempHome */
async function writeVisionModelConfig(tempHome) {
    await Deno.mkdir(join(tempHome, ".wld"), { recursive: true });
    await Deno.writeTextFile(
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

/** @param {string} path */
async function removeTempDir(path) {
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            await Deno.remove(path, { recursive: true });
            return;
        } catch (error) {
            if (error instanceof Deno.errors.NotFound) return;
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        }
    }
    throw lastError;
}

Deno.test("see_image invokes fallback model with local image and default prompt", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = getHomeDir();
        const tempHome = await Deno.makeTempDir({ prefix: "runwield-see-image-home-" });
        const cwd = await Deno.makeTempDir({ prefix: "runwield-see-image-" });
        try {
            Deno.env.set("HOME", tempHome);
            await writeVisionModelConfig(tempHome);
            await writeVisionFallbackSetting(cwd);
            await Deno.writeFile(join(cwd, "shot.png"), new Uint8Array([1, 2, 3]));
            /** @type {any[]} */
            const calls = [];
            const tool = /** @type {any} */ (createSeeImageTool({
                cwd,
                completeSimpleFn: (model, context, options) => {
                    calls.push({ model, context, options });
                    return Promise.resolve({
                        role: "assistant",
                        api: "openai-completions",
                        provider: "vision",
                        model: "model",
                        content: [{ type: "text", text: "description" }],
                        stopReason: "stop",
                        usage: TEST_USAGE,
                        timestamp: Date.now(),
                    });
                },
            }));

            const result = await tool.execute("1", { imageRef: "shot.png" }, undefined, undefined, {});

            assertEquals(result.content, [{ type: "text", text: "description" }]);
            assertEquals(calls.length, 1);
            assertEquals(calls[0].context.messages[0].content[0].text, DEFAULT_SEE_IMAGE_PROMPT);
            assertEquals(calls[0].context.messages[0].content[1].mimeType, "image/png");
            assertEquals(calls[0].options.apiKey, "key");
        } finally {
            Deno.env.set("HOME", originalHome);
            await removeTempDir(tempHome);
            await removeTempDir(cwd);
        }
    });
});

Deno.test("see_image returns tool error on auth failure", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = getHomeDir();
        const tempHome = await Deno.makeTempDir({ prefix: "runwield-see-image-home-" });
        const cwd = await Deno.makeTempDir({ prefix: "runwield-see-image-" });
        try {
            Deno.env.set("HOME", tempHome);
            await Deno.mkdir(join(tempHome, ".wld"), { recursive: true });
            await Deno.writeTextFile(
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
            await Deno.mkdir(join(cwd, ".wld"), { recursive: true });
            await Deno.writeTextFile(
                join(cwd, ".wld", "settings.json"),
                JSON.stringify({
                    visionFallback: { model: "missing-vision/model" },
                }),
            );
            await Deno.writeFile(join(cwd, "shot.png"), new Uint8Array([1]));
            const tool = /** @type {any} */ (createSeeImageTool({
                cwd,
                completeSimpleFn: () => Promise.reject(new Error("should not call")),
            }));
            const result = await tool.execute("1", { imageRef: "shot.png" }, undefined, undefined, {});
            assertEquals(result.isError, true);
            assertEquals(
                result.content[0].text,
                "No API key configured for visionFallback.model: missing-vision/model",
            );
        } finally {
            Deno.env.set("HOME", originalHome);
            await removeTempDir(tempHome);
            await removeTempDir(cwd);
        }
    });
});

Deno.test("see_image resolves attachment refs from the session image directory", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = getHomeDir();
        const tempHome = await Deno.makeTempDir({ prefix: "runwield-see-image-home-" });
        const cwd = await Deno.makeTempDir({ prefix: "runwield-see-image-attachment-" });
        try {
            Deno.env.set("HOME", tempHome);
            await writeVisionModelConfig(tempHome);
            await writeVisionFallbackSetting(cwd);
            const sessionManager = /** @type {any} */ ({ getSessionId: () => "session-abc" });
            const attachment = await persistImageAttachment(
                { base64: btoa("img"), mimeType: "image/png" },
                sessionManager,
                cwd,
            );
            /** @type {any[]} */
            const calls = [];
            const tool = /** @type {any} */ (createSeeImageTool({
                cwd,
                sessionManager,
                completeSimpleFn: (_model, context) => {
                    calls.push(context.messages[0].content[1]);
                    return Promise.resolve({
                        role: "assistant",
                        api: "openai-completions",
                        provider: "vision",
                        model: "model",
                        content: [{ type: "text", text: "attachment description" }],
                        stopReason: "stop",
                        usage: TEST_USAGE,
                        timestamp: Date.now(),
                    });
                },
            }));

            const result = await tool.execute("1", { imageRef: attachment.ref }, undefined, undefined, {});

            assertEquals(result.content[0].text, "attachment description");
            assertEquals(calls[0].mimeType, "image/png");
            assertEquals(calls[0].data, btoa("img"));
        } finally {
            Deno.env.set("HOME", originalHome);
            await removeTempDir(tempHome);
            await removeTempDir(cwd);
        }
    });
});
