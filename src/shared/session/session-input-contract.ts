/** Browser-safe byte-transfer limits. Local filesystem paths are not image authority. */
export const SESSION_TEXT_LIMIT = 65_536;
export const SESSION_IMAGE_BYTE_LIMIT = 7 * 1024 * 1024;
export const SESSION_IMAGE_BASE64_LIMIT = 10 * 1024 * 1024;
export const SESSION_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export interface SessionImageTransfer {
    mimeType: string;
    base64: string;
}
export function validateSessionInput(text: string, images: SessionImageTransfer[] = []): void {
    if (text.length > SESSION_TEXT_LIMIT) throw new Error("Message exceeds 65,536 characters.");
    if (!text.trim() && !images.length) throw new Error("A message or image is required.");
    let total = 0;
    for (const image of images) {
        if (
            Object.keys(image).some((key) => key !== "mimeType" && key !== "base64") ||
            !SESSION_IMAGE_MIME_TYPES.some((mime) => mime === image.mimeType) ||
            typeof image.base64 !== "string" ||
            !image.base64.length ||
            image.base64.length % 4 !== 0 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.base64)
        )
            throw new Error("Malformed image transfer.");
        total += image.base64.length;
        const padding = image.base64.endsWith("==") ? 2 : image.base64.endsWith("=") ? 1 : 0;
        if ((image.base64.length / 4) * 3 - padding > SESSION_IMAGE_BYTE_LIMIT) throw new Error("Image exceeds 7 MiB.");
        if (total > SESSION_IMAGE_BASE64_LIMIT) throw new Error("Images exceed 10 MiB of base64.");
    }
}

export interface SessionCommandSelection {
    agentName?: string;
    model?: string;
    provider?: string;
    thinkingLevel?: string;
}
export interface SessionCommandResult {
    action: "message" | "new" | "agent" | "model" | "configure";
    message?: string;
    selection?: SessionCommandSelection;
}
