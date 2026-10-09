/** Image upload and read handlers for Workspace-hosted review surfaces. */

import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

export interface ReviewImageOptions {
    cwd?: string;
}

const MAX_REVIEW_IMAGE_BYTES = 20 * 1024 * 1024;
const REVIEW_UPLOAD_DIR = join(tmpdir(), "runwield-plan-review");
const IMAGE_CONTENT_TYPES = new Map([
    [".png", "image/png"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".gif", "image/gif"],
    [".webp", "image/webp"],
]);

export function reviewUploadDir(): string {
    return REVIEW_UPLOAD_DIR;
}

export async function reviewImageUploadApi(request: Request): Promise<Response> {
    try {
        const formData = await request.formData();
        const file = formData.get("file");
        if (!(file instanceof File)) return new Response("No image provided.", { status: 400 });
        if (file.size > MAX_REVIEW_IMAGE_BYTES) {
            return new Response("Image exceeds the 20 MB upload limit.", { status: 413 });
        }

        const extension = normalizedImageExtension(file.name);
        if (!extension) return new Response("Unsupported image type.", { status: 400 });

        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!hasValidImageMagic(bytes, extension)) return new Response("Invalid image content.", { status: 400 });

        await Deno.mkdir(REVIEW_UPLOAD_DIR, { recursive: true });
        const path = join(REVIEW_UPLOAD_DIR, `${crypto.randomUUID()}${extension}`);
        await Deno.writeFile(path, bytes);
        return Response.json({ path, originalName: file.name }, {
            headers: { "cache-control": "no-store" },
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Image upload failed.";
        return Response.json({ error: message }, {
            status: 500,
            headers: { "cache-control": "no-store" },
        });
    }
}

export async function reviewImageApi(request: Request, options: ReviewImageOptions = {}): Promise<Response> {
    const url = new URL(request.url);
    const rawPath = url.searchParams.get("path")?.trim();
    if (!rawPath) return new Response("Image path required.", { status: 400 });

    const extension = normalizedImageExtension(rawPath);
    if (!extension) return new Response("Unsupported image type.", { status: 400 });

    const cwd = resolve(options.cwd || Deno.cwd());
    const base = url.searchParams.get("base")?.trim();
    const path = isAbsolute(rawPath) ? resolve(rawPath) : resolve(base || cwd, rawPath);
    if (!isPathInside(path, REVIEW_UPLOAD_DIR) && !isPathInside(path, cwd)) {
        return new Response("Image path is outside this review workspace.", { status: 403 });
    }

    try {
        const bytes = await Deno.readFile(path);
        return new Response(bytes, {
            headers: {
                "content-type": IMAGE_CONTENT_TYPES.get(extension) || "application/octet-stream",
                "cache-control": "no-store",
            },
        });
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return new Response("Image not found.", { status: 404 });
        return new Response("Unable to read image.", { status: 500 });
    }
}

function hasValidImageMagic(bytes: Uint8Array, extension: string): boolean {
    if (extension === ".png") {
        return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d &&
            bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
    }
    if (extension === ".jpg" || extension === ".jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8;
    if (extension === ".gif") return bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46;
    if (extension === ".webp") {
        return bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
    }
    return false;
}

function normalizedImageExtension(path: string): string {
    const extension = extname(path).toLowerCase();
    return IMAGE_CONTENT_TYPES.has(extension) ? extension : "";
}

function isPathInside(path: string, root: string): boolean {
    const rel = relative(resolve(root), resolve(path));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
