import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, join, relative, resolve, toFileUrl } from "@std/path";
import type { PhotonImage } from "@silvia-odwyer/photon-node";
import { RUNWIELD_ROOT } from "../../runtime-root.js";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ImageContent, ImagesInputContent, ImagesOptions, Usage } from "@earendil-works/pi-ai";
import { getModelRuntime } from "./models/model-registry.ts";
import { parseProviderModel } from "./models/model-validation.ts";
import { resolveImageGenerationSettings } from "./image-generation-settings.ts";
import type { ImageGenerationSettings } from "./image-generation-settings.ts";
import { getSessionImageDir, mimeTypeForImagePath, resolveImageRef } from "./session/image-attachments.ts";
import { generateAgyImage } from "./session/backends/agy-cli/image-generation.ts";
import { generateCodexImage } from "./image-generation/codex.ts";
import { generateOpenCodeImage } from "./image-generation/opencode.ts";
import { remotePersonalResourcesActive } from "./remote/personal-resources.ts";

interface CreateImageRequest {
    cwd: string;
    prompt: string;
    outputPath: string;
    imageRefs?: string[];
    sessionManager?: SessionManager;
    signal?: AbortSignal;
}

export interface CreatedImage {
    path: string;
    model: string;
    mimeType: string;
    width: number;
    height: number;
    preview?: ImageContent;
    usage?: Usage;
}

interface OpenRouterImagePayload {
    temperature?: number;
    reasoning?: { effort: string };
    provider?: { require_parameters: boolean };
}

interface PhotonModule {
    PhotonImage: typeof PhotonImage;
}

/** Keep Photon's CommonJS/WASM loader outside Deno's ESM compile bundle. */
function loadPhoton(): PhotonModule {
    const entry = toFileUrl(join(RUNWIELD_ROOT, "node_modules", "@silvia-odwyer", "photon-node", "photon_rs.js"));
    return createRequire(entry)("./photon_rs.js") as PhotonModule;
}

/** Verified mappings, not a claim that all image models accept chat options. */
function piOptions(provider: string, id: string, settings: ImageGenerationSettings): ImagesOptions {
    const gemini = provider === "openrouter" &&
        ["google/gemini-2.5-flash-image", "google/gemini-3.1-flash-image"].includes(id);
    if (settings.temperature !== undefined && !gemini) {
        throw new Error(`temperature is not supported by create_image for ${provider}/${id}. Remove it.`);
    }
    if (
        settings.thinkingLevel !== undefined &&
        !(gemini && id === "google/gemini-3.1-flash-image" && ["minimal", "high"].includes(settings.thinkingLevel))
    ) {
        throw new Error(
            `thinkingLevel is not supported for ${provider}/${id}. Gemini 3.1 Flash Image supports minimal or high.`,
        );
    }
    return {
        // An ambiguous retry may generate and charge for another image.
        maxRetries: 0,
        timeoutMs: 300_000,
        onPayload: (payload) => {
            const request = payload as OpenRouterImagePayload;
            if (settings.temperature !== undefined) request.temperature = settings.temperature;
            if (settings.thinkingLevel !== undefined) request.reasoning = { effort: settings.thinkingLevel };
            if (settings.temperature !== undefined || settings.thinkingLevel !== undefined) {
                request.provider = { require_parameters: true };
            }
            return request;
        },
    };
}

/** Refuse escaping or symlinked destinations before spending image quota. */
async function outputDestination(cwd: string, outputPath: string): Promise<string> {
    if (!outputPath.trim()) throw new Error("outputPath is required.");
    const root = await Deno.realPath(cwd);
    const path = resolve(root, outputPath);
    const local = relative(root, path);
    if (!local || isAbsolute(local) || local === ".." || local.startsWith("../") || local.startsWith("..\\")) {
        throw new Error("outputPath must stay inside the current project.");
    }
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(extname(path).toLowerCase())) {
        throw new Error("outputPath must end in .png, .jpg, .jpeg or .webp.");
    }
    let current = root;
    const parts = relative(root, dirname(path)).split(/[\\/]/).filter(Boolean);
    for (const part of parts) {
        current = join(current, part);
        try {
            const stat = await Deno.lstat(current);
            if (!stat.isDirectory || stat.isSymlink) {
                throw new Error("outputPath cannot traverse symlinks or non-directories.");
            }
        } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
            await Deno.mkdir(current);
        }
    }
    try {
        await Deno.lstat(path);
        throw new Error(`Output already exists: ${outputPath}. Choose a new path.`);
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return path;
}

/** Decode real raster bytes and encode the exact format requested by the path. */
export function encodeCreatedImage(image: ImageContent, mimeType: string) {
    if (image.data.length > 45 * 1024 * 1024) throw new Error("Generated image exceeds the 32 MiB limit.");
    const bytes = Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0));
    const signature = Buffer.from(bytes.subarray(0, 12));
    const actualMimeType = signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? "image/png"
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        ? "image/jpeg"
        : signature.toString("ascii", 0, 4) === "RIFF" && signature.toString("ascii", 8, 12) === "WEBP"
        ? "image/webp"
        : ["GIF87a", "GIF89a"].includes(signature.toString("ascii", 0, 6))
        ? "image/gif"
        : undefined;
    if (!actualMimeType || actualMimeType !== image.mimeType) {
        throw new Error("Provider returned image bytes that do not match their MIME type.");
    }
    const dimensions = getImageDimensions(image.data, image.mimeType);
    if (
        bytes.length > 32 * 1024 * 1024 || !dimensions || dimensions.widthPx < 1 || dimensions.heightPx < 1 ||
        dimensions.widthPx * dimensions.heightPx > 40_000_000
    ) {
        throw new Error("Provider returned an invalid or oversized raster image.");
    }
    const decoded = loadPhoton().PhotonImage.new_from_byteslice(bytes);
    try {
        const width = decoded.get_width();
        const height = decoded.get_height();
        const output = image.mimeType === mimeType
            ? bytes
            : mimeType === "image/png"
            ? decoded.get_bytes()
            : mimeType === "image/jpeg"
            ? decoded.get_bytes_jpeg(95)
            : decoded.get_bytes_webp();
        return { bytes: output, width, height };
    } finally {
        decoded.free();
    }
}

/** One configured generation, validated bytes, and an atomic no-overwrite project file. */
export async function createImage(request: CreateImageRequest): Promise<CreatedImage> {
    if (remotePersonalResourcesActive()) {
        throw new Error("create_image is not yet available in bounded remote Sessions.");
    }
    const settings = resolveImageGenerationSettings(request.cwd);
    if (!settings) throw new Error("Configure imageGeneration.model to enable create_image.");
    const selected = parseProviderModel(settings.model);
    if (!selected.ok) throw new Error("imageGeneration.model must use provider/model format.");
    if (!request.prompt.trim()) throw new Error("An image prompt is required.");
    request.signal?.throwIfAborted();
    const outputPath = await outputDestination(request.cwd, request.outputPath);
    const input: ImagesInputContent[] = [{ type: "text", text: request.prompt }];
    const references: string[] = [];
    for (const ref of request.imageRefs || []) {
        const resolved = await resolveImageRef(ref, request);
        const path = await Deno.realPath(resolved.path);
        const root = await Deno.realPath(
            resolved.refType === "attachment" ? getSessionImageDir(request.sessionManager, request.cwd) : request.cwd,
        );
        const local = relative(root, path);
        if (isAbsolute(local) || local === ".." || local.startsWith("../") || local.startsWith("..\\")) {
            throw new Error("Reference image escapes its project or session directory through a symlink.");
        }
        const stat = await Deno.stat(path);
        if (!stat.isFile || stat.size > 32 * 1024 * 1024) {
            throw new Error("Reference image must be a file under 32 MiB.");
        }
        const bytes = await Deno.readFile(path);
        if (bytes.length > 32 * 1024 * 1024) throw new Error("Reference image exceeds 32 MiB.");
        references.push(path);
        input.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: resolved.mimeType });
    }
    let image: ImageContent;
    let usage: Usage | undefined;
    if (selected.provider === "agy-cli") {
        image = await generateAgyImage({
            model: selected.id,
            settings,
            prompt: request.prompt,
            referencePaths: references,
            signal: request.signal,
        });
    } else if (["codex-cli", "openai-codex"].includes(selected.provider)) {
        image = await generateCodexImage({
            model: selected.id,
            settings,
            prompt: request.prompt,
            referencePaths: references,
            signal: request.signal,
        });
    } else if (selected.provider === "opencode") {
        image = await generateOpenCodeImage({ model: selected.id, settings, input, signal: request.signal });
    } else {
        const options = piOptions(selected.provider, selected.id, settings);
        const runtime = await getModelRuntime();
        const model = runtime.getModelOfType("image", selected.provider, selected.id);
        if (!model) {
            throw new Error(
                `Not a configured Pi image-output model: ${settings.model}. A vision/chat model is not an image generator.`,
            );
        }
        if (references.length && !model.input.includes("image")) {
            throw new Error(`${settings.model} does not accept reference images.`);
        }
        const result = await runtime.generateImages(model, { input }, { ...options, signal: request.signal });
        if (result.stopReason !== "stop") {
            throw new Error(result.errorMessage || `Image generation ${result.stopReason}.`);
        }
        const images = result.output.filter((block): block is ImageContent => block.type === "image");
        if (images.length !== 1) {
            throw new Error(`Expected one generated image; provider returned ${images.length}. No file was written.`);
        }
        image = images[0];
        usage = result.usage;
    }
    request.signal?.throwIfAborted();
    const mimeType = mimeTypeForImagePath(outputPath);
    const encoded = encodeCreatedImage(image, mimeType);
    const preview = await resizeImage(encoded.bytes, mimeType, {
        maxWidth: 1024,
        maxHeight: 1024,
        maxBytes: 1024 * 1024,
    });
    request.signal?.throwIfAborted();
    // Recheck after generation, including parent symlinks introduced while waiting.
    await outputDestination(request.cwd, request.outputPath);
    const staging = await Deno.makeTempFile({ dir: dirname(outputPath), prefix: ".runwield-image-" });
    try {
        await Deno.writeFile(staging, encoded.bytes);
        request.signal?.throwIfAborted();
        await Deno.link(staging, outputPath);
    } finally {
        await Deno.remove(staging);
    }
    return {
        path: relative(await Deno.realPath(request.cwd), outputPath),
        model: settings.model,
        mimeType,
        width: encoded.width,
        height: encoded.height,
        ...(preview ? { preview: { type: "image" as const, data: preview.data, mimeType: preview.mimeType } } : {}),
        ...(usage ? { usage } : {}),
    };
}
