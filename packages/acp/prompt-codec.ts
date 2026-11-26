import { RequestError } from "@agentclientprotocol/sdk/unstable";
import type { JsonValue } from "@runwield/parsing/jsonc";
import type { ImageAttachment } from "@runwield/session-runtime/events";

export interface AcpPromptBlock {
    type?: JsonValue;
    text?: JsonValue;
    data?: JsonValue;
    mimeType?: JsonValue;
    title?: JsonValue;
    name?: JsonValue;
    uri?: JsonValue;
}

interface ConvertedAcpPrompt {
    text: string;
    images: ImageAttachment[];
}

function invalidPrompt(message: string, data: { contentType?: JsonValue } = {}): never {
    throw new RequestError(-32602, message, data);
}

export function convertAcpPrompt(blocks: readonly AcpPromptBlock[] | JsonValue | undefined): ConvertedAcpPrompt {
    if (!Array.isArray(blocks) || blocks.length === 0) {
        invalidPrompt("session/prompt requires at least one prompt content block");
    }
    const parts: string[] = [];
    const images: ImageAttachment[] = [];
    const content: readonly (AcpPromptBlock | JsonValue)[] = blocks;
    for (const block of content) {
        if (!block || typeof block !== "object") invalidPrompt("Invalid prompt content block");
        const fields = Array.isArray(block) ? {} : block;
        if (fields.type === "text") {
            if (typeof fields.text !== "string") invalidPrompt("ACP text prompt content requires text");
            parts.push(fields.text);
            continue;
        }
        if (fields.type === "image") {
            if (typeof fields.data !== "string" || !fields.data) {
                invalidPrompt("ACP image prompt content requires base64 data", { contentType: fields.type });
            }
            if (typeof fields.mimeType !== "string" || !fields.mimeType) {
                invalidPrompt("ACP image prompt content requires a MIME type", { contentType: fields.type });
            }
            images.push({ base64: fields.data, mimeType: fields.mimeType });
            continue;
        }
        if (fields.type === "resource_link") {
            if (typeof fields.name !== "string" || typeof fields.uri !== "string") {
                invalidPrompt("ACP resource links require name and uri");
            }
            const label = fields.title || fields.name || fields.uri;
            parts.push(`[Resource: ${label} <${fields.uri}>]`);
            continue;
        }
        invalidPrompt(`Unsupported prompt content block type for RunWield ACP MVP: ${fields.type}`, {
            contentType: fields.type,
        });
    }
    return { text: parts.join("\n").trim(), images };
}
