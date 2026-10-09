import { getCwd, getHomeDir } from "../../constants.js";
import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
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

Deno.test("modelSupportsImageInput checks image modality", () => {
    assertEquals(modelSupportsImageInput({ input: ["text", "image"] }), true);
    assertEquals(modelSupportsImageInput({ input: ["text"] }), false);
    assertEquals(modelSupportsImageInput({}), false);
});

Deno.test("persistImageAttachment stores session-scoped file and resolves attachment ref", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = getHomeDir();
        const tempHome = await Deno.makeTempDir({ prefix: "runwield-images-home-" });
        const cwd = await Deno.makeTempDir({ prefix: "runwield-images-project-" });
        try {
            Deno.env.set("HOME", tempHome);
            const sessionManager = makeSessionManager("abc");
            const stored = await persistImageAttachment(
                { base64: btoa("hello"), mimeType: "image/png" },
                /** @type {any} */ (sessionManager),
                cwd,
            );
            assertEquals(stored.ref?.startsWith("attachment:"), true);
            assertEquals(await Deno.readTextFile(stored.path || ""), "hello");
            assertEquals(stored.path?.startsWith(getSessionImageDir(/** @type {any} */ (sessionManager), cwd)), true);

            const resolved = await resolveImageRef(stored.ref || "", {
                sessionManager: /** @type {any} */ (sessionManager),
                cwd,
            });
            assertEquals(resolved.mimeType, "image/png");
            assertEquals(resolved.refType, "attachment");
        } finally {
            if (originalHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", originalHome);
            await removeTempDir(tempHome);
            await removeTempDir(cwd);
        }
    });
});

Deno.test("resolveImageRef resolves safe project-relative paths and rejects escapes", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "runwield-image-path-" });
    try {
        await Deno.writeFile(join(cwd, "screenshot.png"), new Uint8Array([1, 2, 3]));
        const local = await resolveImageRef("@screenshot.png", { cwd });
        assertEquals(local.mimeType, "image/png");
        assertEquals(local.refType, "local");

        await assertRejects(() => resolveImageRef("../outside.png", { cwd }), Error, "escapes");
        await assertRejects(() => resolveImageRef("attachment:not-a-uuid", { cwd }), Error, "Invalid image attachment");
    } finally {
        await removeTempDir(cwd);
    }
});

Deno.test("prepareImagesForModel sends direct images or fallback markers", () => {
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

Deno.test("preflightImageAttachments blocks text-only model without fallback", () => {
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
    const tempHome = await Deno.makeTempDir({ prefix: "runwield-vision-settings-home-" });
    const tempProject = await Deno.makeTempDir({ prefix: "runwield-vision-settings-project-" });
    try {
        Deno.env.set("HOME", tempHome);
        Deno.chdir(tempProject);
        await Deno.mkdir(".wld", { recursive: true });
        await Deno.writeTextFile(".wld/settings.json", JSON.stringify(settings));
        __resetSettingsForTests();
        await fn(tempHome, tempProject);
    } finally {
        __resetSettingsForTests();
        Deno.chdir(originalCwd);
        if (originalHome === undefined) Deno.env.delete("HOME");
        else Deno.env.set("HOME", originalHome);
        await removeTempDir(tempHome);
        await removeTempDir(tempProject);
    }
}

Deno.test("resolveVisionFallbackModel reports unknown, unauthenticated, and non-vision fallback", async () => {
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

Deno.test("resolveVisionFallbackModel discovers configured provider models", async () => {
    await withProcessGlobalTestLock(async () => {
        await withVisionSettings({ visionFallback: { model: "local/discovered" } }, async (tempHome, tempProject) => {
            await Deno.mkdir(join(tempHome, ".wld"), { recursive: true });
            await Deno.writeTextFile(
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
                fetch: /** @type {typeof fetch} */ (() =>
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

Deno.test("submit-time image preflight blocks non-destructively after fallback disappears", () => {
    const typedText = "draft prompt";
    const images = [{ base64: "a", mimeType: "image/png", ref: "attachment:abc" }];
    const beforeImages = [...images];

    const result = preflightImageAttachments(images, { activeModel: { input: ["text"] } });

    assertEquals(result.ok, false);
    assertEquals(typedText, "draft prompt");
    assertEquals(images, beforeImages);
});
