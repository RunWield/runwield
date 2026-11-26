import { link as fsLink, open as fsOpen } from "node:fs/promises";
import {
    lstat as fsLstat,
    mkdir as fsMkdir,
    readFile as fsReadFile,
    realpath as fsRealpath,
    rm as fsRm,
    stat as fsStat,
} from "node:fs/promises";
import { loadPhoton } from "./photon-loader.ts";
import { Buffer } from "node:buffer";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { codingAgent, type GeneratedImage } from "@runwield/pi-ai/coding-agent";
import type { TurnImage } from "@runwield/pi-ai/turn";
import { parseProviderModel } from "@runwield/pi-ai";
import { isRemovedAgyProvider, removedAgyModelError } from "@runwield/pi-ai/models";
import { resolveImageGenerationSettings } from "./image-generation-settings.ts";
import { getSessionImageDir, mimeTypeForImagePath, resolveImageRef } from "./session/image-attachments.ts";
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
    preview?: TurnImage;
    usage?: GeneratedImage["usage"];
}

/** Refuse escaping or symlinked destinations before spending image quota. */
async function outputDestination(cwd: string, outputPath: string): Promise<string> {
    if (!outputPath.trim()) throw new Error("outputPath is required.");
    const root = await fsRealpath(cwd);
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
            const stat = await fsLstat(current);
            if (!stat.isDirectory() || stat.isSymbolicLink()) {
                throw new Error("outputPath cannot traverse symlinks or non-directories.");
            }
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
            await fsMkdir(current);
        }
    }
    try {
        await fsLstat(path);
        throw new Error(`Output already exists: ${outputPath}. Choose a new path.`);
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    return path;
}

/** Decode real raster bytes and encode the exact format requested by the path. */
export function encodeCreatedImage(image: TurnImage, mimeType: string) {
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
        bytes.length > 32 * 1024 * 1024 ||
        !dimensions ||
        dimensions.widthPx < 1 ||
        dimensions.heightPx < 1 ||
        dimensions.widthPx * dimensions.heightPx > 40_000_000
    ) {
        throw new Error("Provider returned an invalid or oversized raster image.");
    }
    const decoded = loadPhoton().PhotonImage.new_from_byteslice(bytes);
    try {
        const width = decoded.get_width();
        const height = decoded.get_height();
        const output =
            image.mimeType === mimeType
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
    if (isRemovedAgyProvider(selected.provider))
        throw removedAgyModelError(settings.model, "Choose a supported imageGeneration.model or remove that setting.");
    if (!request.prompt.trim()) throw new Error("An image prompt is required.");
    request.signal?.throwIfAborted();
    const outputPath = await outputDestination(request.cwd, request.outputPath);
    const images: TurnImage[] = [];
    const references: string[] = [];
    for (const ref of request.imageRefs || []) {
        const resolved = await resolveImageRef(ref, request);
        const path = await fsRealpath(resolved.path);
        const root = await fsRealpath(
            resolved.refType === "attachment" ? getSessionImageDir(request.sessionManager, request.cwd) : request.cwd,
        );
        const local = relative(root, path);
        if (isAbsolute(local) || local === ".." || local.startsWith("../") || local.startsWith("..\\")) {
            throw new Error("Reference image escapes its project or session directory through a symlink.");
        }
        const stat = await fsStat(path);
        if (!stat.isFile() || stat.size > 32 * 1024 * 1024) {
            throw new Error("Reference image must be a file under 32 MiB.");
        }
        const bytes = await fsReadFile(path);
        if (bytes.length > 32 * 1024 * 1024) throw new Error("Reference image exceeds 32 MiB.");
        references.push(path);
        images.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: resolved.mimeType });
    }
    let image: TurnImage;
    let usage: GeneratedImage["usage"];
    if (["codex-cli", "openai-codex"].includes(selected.provider)) {
        image = await generateCodexImage({
            model: selected.id,
            settings,
            prompt: request.prompt,
            referencePaths: references,
            signal: request.signal,
        });
    } else if (selected.provider === "opencode") {
        image = await generateOpenCodeImage({
            model: selected.id,
            settings,
            input: { text: request.prompt, images },
            signal: request.signal,
        });
    } else {
        const generated = await codingAgent.generateImage(
            { text: request.prompt, images },
            {
                provider: selected.provider,
                modelId: selected.id,
                modelRef: settings.model,
                temperature: settings.temperature,
                thinkingLevel: settings.thinkingLevel,
                signal: request.signal,
            },
        );
        image = generated.image;
        usage = generated.usage;
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
    const staging = join(dirname(outputPath), `.runwield-image-${crypto.randomUUID()}`);
    const file = await fsOpen(staging, "wx", 0o600);
    try {
        await file.writeFile(encoded.bytes);
        await file.close();
        request.signal?.throwIfAborted();
        await fsLink(staging, outputPath);
    } finally {
        await file.close();
        await fsRm(staging);
    }
    return {
        path: relative(await fsRealpath(request.cwd), outputPath),
        model: settings.model,
        mimeType,
        width: encoded.width,
        height: encoded.height,
        ...(preview ? { preview: { type: "image" as const, data: preview.data, mimeType: preview.mimeType } } : {}),
        ...(usage ? { usage } : {}),
    };
}
