/** Image loading shared by single and grouped review decisions. */
import { isAbsolute, resolve } from "node:path";
import { mimeTypeForImagePath } from "../session/image-attachments.ts";
export interface ReviewImageInput {
    path?: string;
    name?: string;
}

export interface ReviewAnnotationInput {
    images?: ReviewImageInput[];
}

export interface LoadedReviewImage {
    base64: string;
    mimeType: string;
    name: string;
}

export interface ReviewImageDecision {
    images?: ReviewImageInput[];
    globalAttachments?: ReviewImageInput[];
    annotations?: ReviewAnnotationInput[];
    codeAnnotations?: ReviewAnnotationInput[];
}
const MAX_REVIEW_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Read image attachments while the review decision and its temp files are
 * still available. Invalid attachments stay fail-soft so text feedback is not
 * lost when one image cannot be loaded.
 */
export async function loadReviewFeedbackImages(
    decision: ReviewImageDecision,
    cwd: string,
): Promise<LoadedReviewImage[]> {
    const attachments = collectReviewImageAttachments(decision);
    const images: LoadedReviewImage[] = [];
    for (const attachment of attachments) {
        try {
            const path = isAbsolute(attachment.path) ? attachment.path : resolve(cwd, attachment.path);
            const stat = await Deno.stat(path);
            if (!stat.isFile || stat.size > MAX_REVIEW_IMAGE_BYTES) {
                throw new Error(stat.size > MAX_REVIEW_IMAGE_BYTES ? "image exceeds 20 MB" : "path is not a file");
            }
            const bytes = await Deno.readFile(path);
            images.push({
                base64: bytesToBase64(bytes),
                mimeType: mimeTypeForImagePath(path),
                name: attachment.name,
            });
        } catch (_error) {
            // Text feedback remains valid if an uploaded image disappears.
        }
    }
    return images;
}

/** Return paths for readable attachments without putting image bytes in a workflow record. */
export async function loadReviewFeedbackImagePaths(decision: ReviewImageDecision, cwd: string): Promise<string[]> {
    const paths: string[] = [];
    for (const image of collectReviewImageAttachments(decision)) {
        if ((await loadReviewFeedbackImages({ images: [image] }, cwd)).length > 0) {
            paths.push(resolve(cwd, image.path));
        }
    }
    return paths;
}

function collectReviewImageAttachments(decision: ReviewImageDecision): Array<{ path: string; name: string }> {
    const candidates = [
        ...readReviewImageAttachments(decision?.images),
        ...readReviewImageAttachments(decision?.globalAttachments),
        ...(Array.isArray(decision?.annotations) ? decision.annotations.flatMap(readAnnotationImageAttachments) : []),
        ...(Array.isArray(decision?.codeAnnotations)
            ? decision.codeAnnotations.flatMap(readAnnotationImageAttachments)
            : []),
    ];
    const seen = new Set<string>();
    return candidates.filter((image) => {
        if (seen.has(image.path)) return false;
        seen.add(image.path);
        return true;
    });
}

function readAnnotationImageAttachments(annotation: ReviewAnnotationInput): Array<{ path: string; name: string }> {
    return readReviewImageAttachments(annotation?.images);
}

function readReviewImageAttachments(value?: ReviewImageInput[]): Array<{ path: string; name: string }> {
    if (!Array.isArray(value)) return [];
    return value.flatMap((image) => {
        const path = typeof image.path === "string" ? image.path.trim() : "";
        if (!path) return [];
        const name = typeof image?.name === "string" && image.name.trim() ? image.name.trim() : "image";
        return [{ path, name }];
    });
}

function bytesToBase64(bytes: Uint8Array): string {
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
    }
    return btoa(chunks.join(""));
}
