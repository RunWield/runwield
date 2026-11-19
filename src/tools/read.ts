import { open as fsOpen, readFile as fsReadFile } from "node:fs/promises";
/**
 * @module tools/read
 *
 * Wraps the pi-coding-agent `read` tool with RunWield presentation safety so
 * binary/control-byte text does not get projected into terminal output.
 */

import { createReadToolDefinition, type ReadToolDetails } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Buffer } from "node:buffer";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { mimeTypeForImagePath } from "../shared/session/image-attachments.ts";

const BINARY_DISPLAY_SAMPLE_BYTES = 8192;
const BINARY_DISPLAY_SUPPRESSED_DETAIL = "binary_display_suppressed";
const binaryDisplayResults = new WeakSet<ToolResult>();

export interface ToolContentPart {
    type?: string;
    text?: string;
    data?: string;
    mimeType?: string;
}

export interface DisplayImage {
    base64: string;
    mimeType: string;
}

interface ToolResultDetails extends ReadToolDetails {
    runwieldDisplay?: string;
    runwieldDisplayImages?: DisplayImage[];
}

interface ToolResult {
    content?: ToolContentPart[];
    details?: ToolResultDetails;
}

export interface ReadToolArgs {
    path?: string;
    file_path?: string;
}

function containsUnsafeDisplayText(text: string): boolean {
    for (const char of text) {
        const code = char.charCodeAt(0);
        if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
        if (code === 127 || code === 0xfffd) return true;
    }
    return false;
}

function getResultContent(result: unknown): ToolContentPart[] {
    const content = (result as ToolResult | undefined)?.content;
    return Array.isArray(content) ? content : [];
}

function resultHasImageContent(result: unknown): boolean {
    return getResultContent(result).some((part) => part?.type === "image");
}

function resultLooksUnsafeForDisplay(result: unknown): boolean {
    for (const part of getResultContent(result)) {
        if (part?.type === "text" && typeof part.text === "string" && containsUnsafeDisplayText(part.text)) {
            return true;
        }
    }
    return false;
}

function resultHasBinaryDisplaySuppression(result: unknown): boolean {
    return (result as ToolResult | undefined)?.details?.runwieldDisplay === BINARY_DISPLAY_SUPPRESSED_DETAIL;
}

function markBinaryDisplaySuppressed(result: unknown) {
    if (typeof result !== "object" || result === null) return;
    const toolResult = result as ToolResult;
    toolResult.details = {
        ...(toolResult.details || {}),
        runwieldDisplay: BINARY_DISPLAY_SUPPRESSED_DETAIL,
    };
    binaryDisplayResults.add(result);
}

function bytesLookBinaryForDisplay(bytes: Uint8Array): boolean {
    if (bytes.length === 0) return false;
    for (const byte of bytes) {
        if (byte === 0) return true;
        if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) return true;
        if (byte === 127) return true;
    }

    try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return containsUnsafeDisplayText(text);
    } catch {
        return true;
    }
}

async function readDisplaySampleBytes(absolutePath: string): Promise<Uint8Array> {
    const file = await fsOpen(absolutePath, "r");
    try {
        const buffer = new Uint8Array(BINARY_DISPLAY_SAMPLE_BYTES);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        return buffer.slice(0, bytesRead ?? 0);
    } finally {
        await file.close();
    }
}

function readToolPath(args: unknown): string | undefined {
    const readArgs = args as ReadToolArgs | undefined;
    return readArgs?.path ?? readArgs?.file_path;
}

function normalizeReadToolPath(path: string): string {
    return path.startsWith("@") ? path.slice(1) : path;
}

function resolveReadToolPath(cwd: string, path: string): string {
    const normalizedPath = normalizeReadToolPath(path);
    return isAbsolute(normalizedPath) ? normalizedPath : resolvePath(cwd, normalizedPath);
}

async function fileLooksBinaryForDisplay(cwd: string, args: unknown): Promise<boolean> {
    const path = readToolPath(args);
    if (typeof path !== "string" || path.length === 0) return false;

    try {
        const bytes = await readDisplaySampleBytes(resolveReadToolPath(cwd, path));
        return bytesLookBinaryForDisplay(bytes);
    } catch {
        return false;
    }
}

async function readDisplayImage(cwd: string, args: unknown): Promise<DisplayImage | null> {
    const path = readToolPath(args);
    if (typeof path !== "string" || path.length === 0) return null;

    try {
        const mimeType = mimeTypeForImagePath(path);
        const bytes = await fsReadFile(resolveReadToolPath(cwd, path));
        return { base64: Buffer.from(bytes).toString("base64"), mimeType };
    } catch {
        return null;
    }
}

function attachImageContent(result: unknown, image: DisplayImage) {
    if (typeof result !== "object" || result === null) return;
    const toolResult = result as ToolResult;
    toolResult.details = {
        ...(toolResult.details || {}),
        runwieldDisplayImages: [image],
    };
    if (!Array.isArray(toolResult.content)) toolResult.content = [];
    if (!resultHasImageContent(toolResult)) {
        toolResult.content.push({ type: "image", data: image.base64, mimeType: image.mimeType });
    }
}

export function createRunWieldReadToolDefinition(cwd: string) {
    const original = createReadToolDefinition(cwd);
    const originalExecute = original.execute;
    const originalRenderResult = original.renderResult;
    const tool = original;

    tool.description = `${original.description} Suppresses binary/control-byte text in terminal rendering while preserving the tool result.`;
    tool.promptGuidelines = [
        ...(original.promptGuidelines || []),
        "Use read for files you need to inspect; terminal rendering may hide binary/control-byte output.",
    ];
    tool.execute = async (toolCallId, args, signal, onUpdate, context) => {
        const result = await originalExecute(toolCallId, args, signal, onUpdate, context);
        const displayImage = !resultHasImageContent(result) ? await readDisplayImage(cwd, args) : null;
        if (displayImage) attachImageContent(result, displayImage);
        if (
            !displayImage &&
            !resultHasImageContent(result) &&
            (resultLooksUnsafeForDisplay(result) || (await fileLooksBinaryForDisplay(cwd, args)))
        ) {
            markBinaryDisplaySuppressed(result);
        }
        return result;
    };
    tool.renderResult = (result, _options, _theme, context) => {
        const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
        if (
            resultHasBinaryDisplaySuppression(result) ||
            binaryDisplayResults.has(result) ||
            (!resultHasImageContent(result) && resultLooksUnsafeForDisplay(result))
        ) {
            text.setText("");
            return text;
        }
        return originalRenderResult?.(result, _options, _theme, context) ?? text;
    };

    return tool;
}

export const __test = {
    containsUnsafeDisplayText,
    resultLooksUnsafeForDisplay,
    resultHasBinaryDisplaySuppression,
};
