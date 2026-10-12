/**
 * @module shared/session/image-attachments
 * Helpers for session-scoped image attachments and vision fallback routing.
 */

import { basename, extname, isAbsolute, join, normalize, relative, resolve } from "@std/path";
import { discoverProviderModel } from "../models/model-registry.ts";
import { assertModelExecutionBackendSupported } from "../models/model-execution.ts";
import { parseProviderModel } from "../models/model-validation.ts";
import { getResolvedVisionFallbackModelSetting } from "../settings.js";
import { getRemoteSessionSaveBridge, getRunWieldSessionDir } from "./root-session.js";
import { MAX_SESSION_BYTES } from "../remote/session-protocol.ts";
import { Buffer } from "node:buffer";

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ImageAttachment } from "./types.js";
import type { ModelDiscoveryNetworkPort, RunWieldModel, RunWieldModelRegistry } from "../models/model-registry.ts";

export interface ImageInputModel {
    input?: string[];
}
export interface ImageReferenceOptions {
    sessionManager?: SessionManager;
    cwd: string;
}
export interface ResolvedImageReference {
    path: string;
    mimeType: string;
    refType: "attachment" | "local";
}
export interface ImageRoutingOptions {
    activeModel?: ImageInputModel | null;
    fallbackModelRef?: string;
}
export interface PrepareImagesOptions extends ImageRoutingOptions {
    text: string;
    images?: ImageAttachment[];
}
export type ImageRoutingMode = "direct" | "fallback" | "none";
export interface PreparedImages {
    ok: true;
    text: string;
    images: ImageContent[] | undefined;
    mode: ImageRoutingMode;
}
export interface ImageRoutingFailure {
    ok: false;
    message: string;
}
export interface ImagePreflightSuccess {
    ok: true;
    warning?: string;
    mode: ImageRoutingMode;
}
export interface VisionFallbackModel {
    model: RunWieldModel;
    modelRef: string;
}

export const IMAGE_FALLBACK_BLOCK_MESSAGE =
    "Cannot attach image: current model does not support vision and no visionFallback.model is configured.\nSee https://docs.runwield.dev/settings/#visionfallback to configure an image fallback model.";

const MIME_TO_EXT = new Map([
    ["image/png", ".png"],
    ["image/jpeg", ".jpg"],
    ["image/jpg", ".jpg"],
    ["image/gif", ".gif"],
    ["image/webp", ".webp"],
]);

const EXT_TO_MIME = new Map([
    [".png", "image/png"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".gif", "image/gif"],
    [".webp", "image/webp"],
]);

export function modelSupportsImageInput(model: ImageInputModel | null | undefined): boolean {
    const input = (model || {}).input;
    return Array.isArray(input) && input.includes("image");
}

export function extensionForMimeType(mimeType: string): string {
    const ext = MIME_TO_EXT.get(String(mimeType || "").toLowerCase());
    if (!ext) throw new Error(`Unsupported image MIME type: ${mimeType}`);
    return ext;
}

export function mimeTypeForImagePath(filePath: string): string {
    const mimeType = EXT_TO_MIME.get(extname(filePath).toLowerCase());
    if (!mimeType) throw new Error(`Unsupported image file type: ${filePath}`);
    return mimeType;
}

export function getSessionImageDir(sessionManager: SessionManager | undefined, cwd: string): string {
    if (!sessionManager || typeof sessionManager.getSessionId !== "function") {
        throw new Error("Cannot persist image attachment: no active session is available.");
    }
    if (getRemoteSessionSaveBridge(sessionManager)) {
        throw new Error("Session attachment files are owned by the laptop");
    }
    return join(getRunWieldSessionDir(cwd), `${sessionManager.getSessionId()}_images`);
}

// Keep the Promise API; the laptop-owned save itself must complete synchronously.
// deno-lint-ignore require-await
export async function persistImageAttachment(
    image: ImageAttachment,
    sessionManager: SessionManager | undefined,
    cwd: string,
): Promise<ImageAttachment> {
    const bridge = getRemoteSessionSaveBridge(sessionManager);
    if (bridge) {
        const response = bridge.request(
            "attachment",
            JSON.stringify({ base64: image.base64, mimeType: image.mimeType }),
        );
        return JSON.parse(response.contents);
    }
    return saveImageAttachment(image, getSessionImageDir(sessionManager, cwd));
}

/** Save Session-owned bytes before any transcript can refer to them. */
export function saveImageAttachment(image: ImageAttachment, directory: string): ImageAttachment {
    const ext = extensionForMimeType(image.mimeType);
    const uuid = crypto.randomUUID();
    const bytes = Uint8Array.from(atob(image.base64), (char) => char.charCodeAt(0));
    Deno.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${uuid}${ext}`);
    const file = Deno.openSync(path, { createNew: true, write: true, mode: 0o600 });
    try {
        let written = 0;
        while (written < bytes.length) written += file.writeSync(bytes.subarray(written));
        file.syncSync();
    } finally {
        file.close();
    }
    return { ...image, ref: `attachment:${uuid}`, path };
}

function parseAttachmentRef(imageRef: string): string | null {
    const match = /^attachment:([0-9a-fA-F-]{32,36})$/.exec(imageRef.trim());
    return match ? match[1] : null;
}

/** Read laptop-owned attachment bytes without exposing a laptop path to a remote caller. */
export function readSessionImageAttachment(imageRef: string, directory: string): ImageAttachment {
    const ref = String(imageRef || "").trim();
    const uuid = parseAttachmentRef(ref);
    if (!uuid) throw new Error(`Invalid image attachment reference: ${ref}`);
    const resolved = resolveAttachmentPath(ref, uuid, directory);
    return { ...readImageFile(resolved.path, resolved.mimeType), ref };
}

function resolveAttachmentPath(ref: string, uuid: string, directory: string): ResolvedImageReference {
    for (const ext of EXT_TO_MIME.keys()) {
        const candidate = join(directory, `${uuid}${ext}`);
        try {
            if (Deno.statSync(candidate).isFile) {
                return { path: candidate, mimeType: mimeTypeForImagePath(candidate), refType: "attachment" };
            }
        } catch { /* try next extension */ }
    }
    throw new Error(`Image attachment not found in this session: ${ref}`);
}

/** Bound file reads even if a file grows after it is opened. The wire carries base64, not paths. */
function readImageFile(path: string, mimeType: string): ImageAttachment {
    const file = Deno.openSync(path, { read: true });
    try {
        const size = file.statSync().size;
        if (size > MAX_SESSION_BYTES) throw new Error("Session image exceeds the read limit");
        const bytes = new Uint8Array(size + 1);
        let length = 0;
        while (length < bytes.length) {
            const count = file.readSync(bytes.subarray(length));
            if (count === null) break;
            length += count;
        }
        if (length > size) throw new Error("Session image changed during read");
        return { base64: Buffer.from(bytes.subarray(0, length)).toString("base64"), mimeType };
    } finally {
        file.close();
    }
}

/** Byte-reading contract for vision callers; path-based callers keep resolveImageRef. */
export async function readImageRef(imageRef: string, opts: ImageReferenceOptions): Promise<ImageAttachment> {
    const ref = String(imageRef || "").trim();
    if (!ref) throw new Error("imageRef is required.");
    const bridge = getRemoteSessionSaveBridge(opts.sessionManager);
    if (bridge && ref.startsWith("attachment:")) {
        if (!parseAttachmentRef(ref)) throw new Error(`Invalid image attachment reference: ${ref}`);
        const response = bridge.request("attachment-read", ref);
        try {
            const image: ImageAttachment = JSON.parse(response.contents);
            if (
                !image || Object.keys(image).sort().join(",") !== "base64,mimeType,ref" ||
                typeof image.base64 !== "string" || typeof image.mimeType !== "string" || image.ref !== ref ||
                image.base64.length > Math.ceil(MAX_SESSION_BYTES / 3) * 4
            ) throw new Error("Invalid Session attachment read acknowledgement");
            const bytes = Buffer.from(image.base64, "base64");
            if (bytes.length > MAX_SESSION_BYTES || bytes.toString("base64") !== image.base64) {
                throw new Error("Invalid Session attachment bytes");
            }
            extensionForMimeType(image.mimeType);
            return image;
        } catch (error) {
            return bridge.fail(error instanceof Error ? error : new Error(String(error)));
        }
    }
    const resolved = await resolveImageRef(ref, opts);
    const bytes = await Deno.readFile(resolved.path);
    return { base64: Buffer.from(bytes).toString("base64"), mimeType: resolved.mimeType, ref };
}

export async function resolveImageRef(imageRef: string, opts: ImageReferenceOptions): Promise<ResolvedImageReference> {
    const ref = String(imageRef || "").trim();
    if (!ref) throw new Error("imageRef is required.");

    const attachmentUuid = parseAttachmentRef(ref);
    if (attachmentUuid) {
        return resolveAttachmentPath(ref, attachmentUuid, getSessionImageDir(opts.sessionManager, opts.cwd));
    }

    if (ref.startsWith("attachment:")) throw new Error(`Invalid image attachment reference: ${ref}`);
    if (isAbsolute(ref)) throw new Error("Local image paths must be project-relative.");

    const cleaned = ref.startsWith("@") ? ref.slice(1) : ref;
    const normalized = normalize(cleaned);
    if (normalized.startsWith("..") || normalized === ".." || isAbsolute(normalized)) {
        throw new Error("Local image path escapes the project directory.");
    }

    const root = resolve(opts.cwd);
    const path = resolve(root, normalized);
    const rel = relative(root, path);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Local image path escapes the project directory.");

    const stat = await Deno.stat(path).catch(() => null);
    if (!stat?.isFile) throw new Error(`Image file not found: ${cleaned}`);
    return { path, mimeType: mimeTypeForImagePath(path), refType: "local" };
}

export function formatImageAttachmentMarker(image: ImageAttachment): string {
    const ref = image.ref || (image.path ? basename(image.path) : "unpersisted-image");
    return `[Image attached: ${ref} ${image.mimeType}]`;
}

export function prepareImagesForModel(opts: PrepareImagesOptions): PreparedImages | ImageRoutingFailure {
    const images = opts.images || [];
    if (images.length === 0) return { ok: true, text: opts.text, images: undefined, mode: "none" };
    if (modelSupportsImageInput(opts.activeModel)) {
        const markers = images.filter((image) => image.ref && !image.path).map(formatImageAttachmentMarker).join("\n");
        return {
            ok: true,
            text: markers ? `${opts.text}\n\n${markers}` : opts.text,
            images: images.map((img) => ({ type: "image", data: img.base64, mimeType: img.mimeType })),
            mode: "direct",
        };
    }
    if (opts.fallbackModelRef) {
        const markers = images.map(formatImageAttachmentMarker).join("\n");
        return { ok: true, text: `${opts.text}\n\n${markers}`, images: undefined, mode: "fallback" };
    }
    return { ok: false, message: IMAGE_FALLBACK_BLOCK_MESSAGE };
}

export function preflightImageAttachments(
    images: ImageAttachment[],
    opts: ImageRoutingOptions,
): ImagePreflightSuccess | ImageRoutingFailure {
    if (!images || images.length === 0) return { ok: true, mode: "none" };
    if (modelSupportsImageInput(opts.activeModel)) return { ok: true, mode: "direct" };
    if (opts.fallbackModelRef) {
        return {
            ok: true,
            mode: "fallback",
            warning:
                `Current model does not support vision. Images will be described using visionFallback.model: ${opts.fallbackModelRef}.`,
        };
    }
    return { ok: false, message: IMAGE_FALLBACK_BLOCK_MESSAGE };
}

export async function resolveVisionFallbackModel(
    modelRegistry: RunWieldModelRegistry,
    network: ModelDiscoveryNetworkPort,
    projectRoot: string,
): Promise<VisionFallbackModel | undefined> {
    const configured = getResolvedVisionFallbackModelSetting(projectRoot);
    if (!configured) return undefined;

    const parsed = parseProviderModel(configured);
    if (!parsed.ok) throw new Error(`Invalid visionFallback.model: ${configured}. Use provider/id.`);
    assertModelExecutionBackendSupported({ provider: parsed.provider, id: parsed.id });

    let found = modelRegistry.find(parsed.provider, parsed.id);
    if (!found) {
        try {
            // The fallback model is explicitly configured for vision, so register
            // discovered models with image input even though /models can't report it.
            found = await discoverProviderModel(
                modelRegistry,
                parsed.provider,
                parsed.id,
                network,
                {
                    input: ["text", "image"],
                },
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Unknown visionFallback.model: ${configured}. ${message}`);
        }
    }
    if (!found) throw new Error(`Unknown visionFallback.model: ${configured}`);
    if (!modelRegistry.hasConfiguredAuth(found)) {
        throw new Error(`No API key configured for visionFallback.model: ${configured}`);
    }
    if (!modelSupportsImageInput(found)) throw new Error(`visionFallback.model is not vision-capable: ${configured}`);
    return { model: found, modelRef: `${found.provider}/${found.id}` };
}
