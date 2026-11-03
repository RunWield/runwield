import { ok as assert } from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";
import { getCwd, getHomeDir } from "../../constants.js";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { join } from "node:path";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import {
    formatImageAttachmentMarker,
    getSessionImageDir,
    modelSupportsImageInput,
    persistImageAttachment,
    preflightImageAttachments,
    prepareImagesForModel,
    readSessionImageAttachment,
    resolveImageRef,
    resolveVisionFallbackModel,
    saveImageAttachment,
} from "./image-attachments.ts";
import { __resetSettingsForTests } from "../settings.js";

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { RunWieldModel, RunWieldModelRegistry } from "../models/model-registry.ts";
import type { FetchRequest } from "../fetch-request.ts";

type VisionFixtureModel = Pick<RunWieldModel, "provider" | "id" | "input">;

interface VisionProviderFixture {
    models: Omit<VisionFixtureModel, "provider">[];
}

interface VisionRegistryFixture {
    models: VisionFixtureModel[];
    find(provider: string, id: string): VisionFixtureModel | undefined;
    hasConfiguredAuth: () => boolean;
    registerProvider(provider: string, config: VisionProviderFixture): void;
}

interface VisionFallbackSettings {
    model: string;
}

interface VisionSettings {
    visionFallback: VisionFallbackSettings;
}

type VisionSettingsCallback = (tempHome: string, tempProject: string) => Promise<void>;

const NO_MODEL_DISCOVERY_NETWORK = {
    fetch: () => Promise.reject(new Error("Unexpected model discovery network call")),
};

function makeSessionManager(id = "session-1"): SessionManager {
    return { getSessionId: () => id } as SessionManager;
}

async function removeTempDir(path: string) {
    let lastError: unknown;
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

test("modelSupportsImageInput checks image modality", () => {
    assertEquals(modelSupportsImageInput({ input: ["text", "image"] }), true);
    assertEquals(modelSupportsImageInput({ input: ["text"] }), false);
    assertEquals(modelSupportsImageInput({}), false);
});

test("persistImageAttachment stores session-scoped file and resolves attachment ref", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = getHomeDir();
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-images-home-"));
        const cwd = await fsMkdtemp(join(tmpdir(), "runwield-images-project-"));
        try {
            process.env["HOME"] = tempHome;
            const sessionManager = makeSessionManager("abc");
            const stored = await persistImageAttachment(
                { base64: btoa("hello"), mimeType: "image/png" },
                sessionManager,
                cwd,
            );
            assertEquals(stored.ref?.startsWith("attachment:"), true);
            assertEquals(await fsReadFile(stored.path || "", "utf8"), "hello");
            assertEquals(stored.path?.startsWith(getSessionImageDir(sessionManager, cwd)), true);

            const resolved = await resolveImageRef(stored.ref || "", {
                sessionManager: sessionManager,
                cwd,
            });
            assertEquals(resolved.mimeType, "image/png");
            assertEquals(resolved.refType, "attachment");
        } finally {
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            await removeTempDir(tempHome);
            await removeTempDir(cwd);
        }
    });
});

test("resolveImageRef resolves safe project-relative paths and rejects escapes", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-image-path-"));
    try {
        await fsWriteFile(join(cwd, "screenshot.png"), new Uint8Array([1, 2, 3]));
        const local = await resolveImageRef("@screenshot.png", { cwd });
        assertEquals(local.mimeType, "image/png");
        assertEquals(local.refType, "local");

        await assertRejects(() => resolveImageRef("../outside.png", { cwd }), Error, "escapes");
        await assertRejects(() => resolveImageRef("attachment:not-a-uuid", { cwd }), Error, "Invalid image attachment");
    } finally {
        await removeTempDir(cwd);
    }
});

test("prepareImagesForModel sends direct images or fallback markers", () => {
    const img = { base64: "a", mimeType: "image/png", ref: "attachment:abc", path: "/session/abc.png" };
    assertEquals(prepareImagesForModel({ text: "look", images: [img], activeModel: { input: ["text", "image"] } }), {
        ok: true,
        text: "look",
        images: [{ type: "image", data: "a", mimeType: "image/png" }],
        mode: "direct",
    });
    assertEquals(
        prepareImagesForModel({
            text: "look",
            images: [img],
            activeModel: { input: ["text"] },
            fallbackModelRef: "v/model",
        }),
        {
            ok: true,
            text: "look\n\n[Image attached: attachment:abc image/png]",
            images: undefined,
            mode: "fallback",
        },
    );
    assertEquals(formatImageAttachmentMarker(img), "[Image attached: attachment:abc image/png]");
});

test("direct image preparation retains portable references but leaves local text and image bytes unchanged", async () => {
    const directory = await fsMkdtemp(join(tmpdir(), "runwield-direct-images-"));
    const pixel = new PhotonImage(new Uint8Array([255, 191, 0, 255]), 1, 1);
    try {
        const bytes = pixel.get_bytes();
        const image = { base64: btoa(String.fromCharCode(...bytes)), mimeType: "image/png" };
        const local = saveImageAttachment(image, directory);
        assert(local.path);
        assert(local.ref);
        assertEquals(new Uint8Array(await fsReadFile(local.path)), bytes);
        const portable = readSessionImageAttachment(local.ref, directory);
        assertEquals(portable, { ...image, ref: local.ref });
        const activeModel = { input: ["text", "image"] };
        const text = "Describe the amber pixel.";
        const modelImage: ImageContent = { type: "image", data: image.base64, mimeType: image.mimeType };
        assertEquals(prepareImagesForModel({ text, images: [local], activeModel }), {
            ok: true,
            text,
            images: [modelImage],
            mode: "direct",
        });
        assertEquals(prepareImagesForModel({ text, images: [portable], activeModel }), {
            ok: true,
            text: `${text}\n\n${formatImageAttachmentMarker(portable)}`,
            images: [modelImage],
            mode: "direct",
        });
        assertEquals(prepareImagesForModel({ text, images: [local, portable, image], activeModel }), {
            ok: true,
            text: `${text}\n\n${formatImageAttachmentMarker(portable)}`,
            images: [modelImage, modelImage, modelImage],
            mode: "direct",
        });
    } finally {
        pixel.free();
        await removeTempDir(directory);
    }
});

test("preflightImageAttachments blocks text-only model without fallback", () => {
    assertEquals(
        preflightImageAttachments([{ base64: "a", mimeType: "image/png" }], { activeModel: { input: ["text"] } }).ok,
        false,
    );
    assertEquals(
        preflightImageAttachments([{ base64: "a", mimeType: "image/png" }], {
            activeModel: { input: ["text"] },
            fallbackModelRef: "v/model",
        }).ok,
        true,
    );
});

async function withVisionSettings(settings: VisionSettings, fn: VisionSettingsCallback) {
    const originalHome = getHomeDir();
    const originalCwd = getCwd();
    const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-vision-settings-home-"));
    const tempProject = await fsMkdtemp(join(tmpdir(), "runwield-vision-settings-project-"));
    try {
        process.env["HOME"] = tempHome;
        process.chdir(tempProject);
        await fsMkdir(".wld", { recursive: true });
        await fsWriteFile(".wld/settings.json", JSON.stringify(settings));
        __resetSettingsForTests();
        await fn(tempHome, tempProject);
    } finally {
        __resetSettingsForTests();
        process.chdir(originalCwd);
        if (originalHome === undefined) delete process.env["HOME"];
        else process.env["HOME"] = originalHome;
        await removeTempDir(tempHome);
        await removeTempDir(tempProject);
    }
}

test("resolveVisionFallbackModel reports unknown, unauthenticated, and non-vision fallback", async () => {
    await withProcessGlobalTestLock(async () => {
        await withVisionSettings({ visionFallback: { model: "test/missing" } }, async () => {
            await assertRejects(
                () =>
                    resolveVisionFallbackModel(
                        {
                            find: () => undefined,
                            hasConfiguredAuth: () => true,
                        } as unknown as RunWieldModelRegistry,
                        NO_MODEL_DISCOVERY_NETWORK,
                        getCwd(),
                    ),
                Error,
                "Unknown visionFallback.model",
            );
        });

        await withVisionSettings({ visionFallback: { model: "test/vision" } }, async () => {
            const model: VisionFixtureModel = { provider: "test", id: "vision", input: ["text", "image"] };
            await assertRejects(
                () =>
                    resolveVisionFallbackModel(
                        {
                            find: () => model,
                            hasConfiguredAuth: () => false,
                        } as unknown as RunWieldModelRegistry,
                        NO_MODEL_DISCOVERY_NETWORK,
                        getCwd(),
                    ),
                Error,
                "No API key configured for visionFallback.model",
            );
        });

        await withVisionSettings({ visionFallback: { model: "test/text" } }, async () => {
            const model: VisionFixtureModel = { provider: "test", id: "text", input: ["text"] };
            await assertRejects(
                () =>
                    resolveVisionFallbackModel(
                        {
                            find: () => model,
                            hasConfiguredAuth: () => true,
                        } as unknown as RunWieldModelRegistry,
                        NO_MODEL_DISCOVERY_NETWORK,
                        getCwd(),
                    ),
                Error,
                "not vision-capable",
            );
        });
    });
});

test("resolveVisionFallbackModel discovers configured provider models", async () => {
    await withProcessGlobalTestLock(async () => {
        await withVisionSettings({ visionFallback: { model: "local/discovered" } }, async (tempHome, tempProject) => {
            await fsMkdir(join(tempHome, ".wld"), { recursive: true });
            await fsWriteFile(
                join(tempHome, ".wld", "models.json"),
                JSON.stringify({
                    providers: {
                        local: {
                            baseUrl: "https://example.invalid/v1",
                            api: "openai-completions",
                            apiKey: "test-key",
                        },
                    },
                }),
            );
            const registry: VisionRegistryFixture = {
                models: [],

                find(provider, id) {
                    return this.models.find((model) => model.provider === provider && model.id === id);
                },
                hasConfiguredAuth: () => true,

                registerProvider(provider, config) {
                    for (const model of config.models) this.models.push({ provider, ...model });
                },
            };
            const network = {
                fetch: (() =>
                    Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ data: [{ id: "discovered" }] }),
                    } as Response)) as FetchRequest,
            };
            const resolved = await resolveVisionFallbackModel(
                registry as unknown as RunWieldModelRegistry,
                network,
                tempProject,
            );
            assertEquals(resolved?.modelRef, "local/discovered");
            assertEquals(resolved?.model.input, ["text", "image"]);
            assertEquals(getCwd().endsWith(tempProject.replace(/^\/private/, "")), true);
        });
    });
});

test("submit-time image preflight blocks non-destructively after fallback disappears", () => {
    const typedText = "draft prompt";
    const images = [{ base64: "a", mimeType: "image/png", ref: "attachment:abc" }];
    const beforeImages = [...images];

    const result = preflightImageAttachments(images, { activeModel: { input: ["text"] } });

    assertEquals(result.ok, false);
    assertEquals(typedText, "draft prompt");
    assertEquals(images, beforeImages);
});
