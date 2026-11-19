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
import { getCwd, getHomeDir } from "../../constants.ts";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { join } from "node:path";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import {
    formatImageAttachmentMarker,
    getSessionImageDir,
    persistImageAttachment,
    prepareImagesForModel,
    readSessionImageAttachment,
    resolveImageRef,
    resolveVisionFallbackModel,
    saveImageAttachment,
} from "./image-attachments.ts";
import { __resetSettingsForTests } from "../settings.ts";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { RunWieldModelRegistry } from "../models/model-registry.ts";
import type { FetchRequest } from "../fetch-request.ts";

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
    return SessionManager.inMemory(`/tmp/${id}`);
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
        for (const scenario of [
            { id: "missing", models: [], apiKey: "test-key", expected: "Unknown visionFallback.model" },
            {
                id: "vision",
                models: [{ id: "vision", input: ["text", "image"] }],
                apiKey: undefined,
                expected: "No API key configured",
            },
            {
                id: "text",
                models: [{ id: "text", input: ["text"] }],
                apiKey: "test-key",
                expected: "not vision-capable",
            },
        ]) {
            await withVisionSettings(
                { visionFallback: { model: `fixture-vision/${scenario.id}` } },
                async (home, cwd) => {
                    const configDir = join(home, ".wld");
                    await fsMkdir(configDir, { recursive: true });
                    await fsWriteFile(
                        join(configDir, "models.json"),
                        JSON.stringify({
                            providers: {
                                "fixture-vision": {
                                    baseUrl: "https://example.invalid/v1",
                                    api: "openai-completions",
                                    apiKey: scenario.apiKey,
                                    models: scenario.models,
                                },
                            },
                        }),
                    );
                    const registry = new RunWieldModelRegistry({ configDir });
                    await assertRejects(
                        () => resolveVisionFallbackModel(registry, NO_MODEL_DISCOVERY_NETWORK, cwd),
                        Error,
                        scenario.expected,
                    );
                },
            );
        }
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
            const registry = new RunWieldModelRegistry({ configDir: join(tempHome, ".wld") });
            const network = {
                fetch: (() =>
                    Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ data: [{ id: "discovered" }] }),
                    } as Response)) as FetchRequest,
            };
            const resolved = await resolveVisionFallbackModel(registry, network, tempProject);
            assertEquals(resolved?.modelRef, "local/discovered");
            assertEquals(resolved?.model.input, ["text", "image"]);
            assertEquals(getCwd().endsWith(tempProject.replace(/^\/private/, "")), true);
        });
    });
});
