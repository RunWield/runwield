import { assertEquals } from "../testing/assertions.ts";
import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { env } from "node:process";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHomeDir } from "../constants.js";
import { withProcessGlobalTestLock } from "../testing/process-global-lock.ts";
import { persistImageAttachment } from "../shared/session/image-attachments.ts";
import { createSeeImageTool, DEFAULT_SEE_IMAGE_PROMPT, extractAssistantText } from "./see-image.ts";

import type { Context, ImageContent, TextContent } from "@earendil-works/pi-ai/compat";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

type SeeImageTool = ReturnType<typeof createSeeImageTool>;
type SeeImageToolContext = Parameters<SeeImageTool["execute"]>[4];
type CompleteSimpleFunction = NonNullable<Parameters<typeof createSeeImageTool>[0]["completeSimpleFn"]>;
type VisionModel = Parameters<CompleteSimpleFunction>[0];
type CompletionOptions = Parameters<CompleteSimpleFunction>[2];

interface ImageRequestMessage {
    role: "user";
    content: [TextContent, ImageContent];
    timestamp: number;
}

interface ImageRequestContext extends Context {
    messages: [ImageRequestMessage];
}

interface CompletionCall {
    model: VisionModel;
    context: ImageRequestContext;
    options: CompletionOptions;
}

const TEST_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
const TEST_USAGE = Object.freeze({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: TEST_COST,
});

test("extractAssistantText joins text blocks", () => {
    assertEquals(
        extractAssistantText([
            { type: "text", text: "one" },
            { type: "image", data: "x" },
            {
                type: "text",
                text: "two",
            },
        ]),
        "one\ntwo",
    );
});

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

test("see_image invokes fallback model with local image and default prompt", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = getHomeDir();
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-see-image-home-"));
        const cwd = await fsMkdtemp(join(tmpdir(), "runwield-see-image-"));
        try {
            env.HOME = tempHome;
            await writeVisionModelConfig(tempHome);
            await writeVisionFallbackSetting(cwd);
            await fsWriteFile(join(cwd, "shot.png"), new Uint8Array([1, 2, 3]));
            const calls: CompletionCall[] = [];
            const tool = createSeeImageTool({
                cwd,
                completeSimpleFn: (model, context, options) => {
                    calls.push({ model, context: context as ImageRequestContext, options });
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
            });

            const result = await tool.execute(
                "1",
                { imageRef: "shot.png" },
                undefined,
                undefined,
                {} as SeeImageToolContext,
            );

            assertEquals(result.content, [{ type: "text", text: "description" }]);
            assertEquals(calls.length, 1);
            assertEquals(calls[0].context.messages[0].content[0].text, DEFAULT_SEE_IMAGE_PROMPT);
            assertEquals(calls[0].context.messages[0].content[1].mimeType, "image/png");
            assertEquals(calls[0].options!.apiKey, "key");
        } finally {
            env.HOME = originalHome;
            await removeTempDir(tempHome);
            await removeTempDir(cwd);
        }
    });
});

test("see_image returns tool error on auth failure", async () => {
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
                completeSimpleFn: () => Promise.reject(new Error("should not call")),
            });
            const result = await tool.execute(
                "1",
                { imageRef: "shot.png" },
                undefined,
                undefined,
                {} as SeeImageToolContext,
            );
            assertEquals(result.isError, true);
            assertEquals(
                (result.content[0] as TextContent).text,
                "No API key configured for visionFallback.model: missing-vision/model",
            );
        } finally {
            env.HOME = originalHome;
            await removeTempDir(tempHome);
            await removeTempDir(cwd);
        }
    });
});

test("see_image resolves attachment refs from the session image directory", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = getHomeDir();
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-see-image-home-"));
        const cwd = await fsMkdtemp(join(tmpdir(), "runwield-see-image-attachment-"));
        try {
            env.HOME = tempHome;
            await writeVisionModelConfig(tempHome);
            await writeVisionFallbackSetting(cwd);
            const sessionManager = { getSessionId: () => "session-abc" } as SessionManager;
            const attachment = await persistImageAttachment(
                { base64: btoa("img"), mimeType: "image/png" },
                sessionManager,
                cwd,
            );
            const calls: ImageContent[] = [];
            const tool = createSeeImageTool({
                cwd,
                sessionManager,
                completeSimpleFn: (_model, context) => {
                    calls.push((context as ImageRequestContext).messages[0].content[1]);
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
            });

            const result = await tool.execute(
                "1",
                { imageRef: attachment.ref },
                undefined,
                undefined,
                {} as SeeImageToolContext,
            );

            assertEquals((result.content[0] as TextContent).text, "attachment description");
            assertEquals(calls[0].mimeType, "image/png");
            assertEquals(calls[0].data, btoa("img"));
        } finally {
            env.HOME = originalHome;
            await removeTempDir(tempHome);
            await removeTempDir(cwd);
        }
    });
});
