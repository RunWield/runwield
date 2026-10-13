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
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import {
    formatImageAttachmentMarker,
    getSessionImageDir,
    modelSupportsImageInput,
    persistImageAttachment,
    preflightImageAttachments,
    prepareImagesForModel,
    resolveImageRef,
    resolveVisionFallbackModel,
} from "./image-attachments.ts";
import { __resetSettingsForTests } from "../settings.js";

const NO_MODEL_DISCOVERY_NETWORK = {
    fetch: () => Promise.reject(new Error("Unexpected model discovery network call")),
};

function makeSessionManager(id = "session-1") {
    return { getSessionId: () => id };
}

/** @param {string} path */
async function removeTempDir(path) {
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            await fsRm(path, { recursive: true });
            return;
        } catch (error) {
            if ((error instanceof Error && "code" in error && error.code === "ENOENT")) return;
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
                /** @type {any} */ (sessionManager),
                cwd,
            );
            assertEquals(stored.ref?.startsWith("attachment:"), true);
            assertEquals(await fsReadFile(stored.path || "", "utf8"), "hello");
            assertEquals(stored.path?.startsWith(getSessionImageDir(/** @type {any} */ (sessionManager), cwd)), true);

            const resolved = await resolveImageRef(stored.ref || "", {
                sessionManager: /** @type {any} */ (sessionManager),
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
    const img = { base64: "a", mimeType: "image/png", ref: "attachment:abc" };
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

/**
 * @param {Record<string, unknown>} settings
 * @param {(tempHome: string, tempProject: string) => Promise<void>} fn
 */
async function withVisionSettings(settings, fn) {
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
                        /** @type {import("../models/model-registry.ts").RunWieldModelRegistry} */ (/** @type {unknown} */ ({
                            find: () => undefined,
                            hasConfiguredAuth: () => true,
                        })),
                        NO_MODEL_DISCOVERY_NETWORK,
                        getCwd(),
                    ),
                Error,
                "Unknown visionFallback.model",
            );
        });

        await withVisionSettings({ visionFallback: { model: "test/vision" } }, async () => {
            const model = { provider: "test", id: "vision", input: ["text", "image"] };
            await assertRejects(
                () =>
                    resolveVisionFallbackModel(
                        /** @type {import("../models/model-registry.ts").RunWieldModelRegistry} */ (/** @type {unknown} */ ({
                            find: () => model,
                            hasConfiguredAuth: () => false,
                        })),
                        NO_MODEL_DISCOVERY_NETWORK,
                        getCwd(),
                    ),
                Error,
                "No API key configured for visionFallback.model",
            );
        });

        await withVisionSettings({ visionFallback: { model: "test/text" } }, async () => {
            const model = { provider: "test", id: "text", input: ["text"] };
            await assertRejects(
                () =>
                    resolveVisionFallbackModel(
                        /** @type {import("../models/model-registry.ts").RunWieldModelRegistry} */ (/** @type {unknown} */ ({
                            find: () => model,
                            hasConfiguredAuth: () => true,
                        })),
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
            const registry = {
                /** @type {any[]} */
                models: [],
                /** @param {string} provider @param {string} id */
                find(provider, id) {
                    return this.models.find((model) => model.provider === provider && model.id === id);
                },
                hasConfiguredAuth: () => true,
                /** @param {string} provider @param {{ models: any[] }} config */
                registerProvider(provider, config) {
                    for (const model of config.models) this.models.push({ provider, ...model });
                },
            };
            const network = {
                fetch: /** @type {import("../fetch-request.ts").FetchRequest} */ (() =>
                    Promise.resolve(
                        /** @type {Response} */ ({
                            ok: true,
                            json: () => Promise.resolve({ data: [{ id: "discovered" }] }),
                        }),
                    )),
            };
            const resolved = await resolveVisionFallbackModel(/** @type {any} */ (registry), network, tempProject);
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
