/**
 * @module tools/read
 *
 * Wraps the pi-coding-agent `read` tool with RunWield presentation safety so
 * binary/control-byte text does not get projected into terminal output.
 */

import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Buffer } from "node:buffer";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { mimeTypeForImagePath } from "../shared/session/image-attachments.ts";

const BINARY_DISPLAY_SAMPLE_BYTES = 8192;
const BINARY_DISPLAY_SUPPRESSED_DETAIL = "binary_display_suppressed";
const binaryDisplayResults = new WeakSet();

/**
 * @typedef {{ type?: string, text?: string, data?: string, mimeType?: string }} ToolContentPart
 * @typedef {{ base64: string, mimeType: string }} DisplayImage
 * @typedef {{ content?: ToolContentPart[], details?: Record<string, unknown> }} ToolResult
 * @typedef {{ path?: string, file_path?: string }} ReadToolArgs
 */

/**
 * @param {string} text
 * @returns {boolean}
 */
function containsUnsafeDisplayText(text) {
    for (const char of text) {
        const code = char.charCodeAt(0);
        if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
        if (code === 127 || code === 0xfffd) return true;
    }
    return false;
}

/**
 * @param {unknown} result
 * @returns {ToolContentPart[]}
 */
function getResultContent(result) {
    const content = /** @type {ToolResult | undefined} */ (result)?.content;
    return Array.isArray(content) ? content : [];
}

/**
 * @param {unknown} result
 * @returns {boolean}
 */
function resultHasImageContent(result) {
    return getResultContent(result).some((part) => part?.type === "image");
}

/**
 * @param {unknown} result
 * @returns {boolean}
 */
function resultLooksUnsafeForDisplay(result) {
    for (const part of getResultContent(result)) {
        if (part?.type === "text" && typeof part.text === "string" && containsUnsafeDisplayText(part.text)) {
            return true;
        }
    }
    return false;
}

/**
 * @param {unknown} result
 * @returns {boolean}
 */
function resultHasBinaryDisplaySuppression(result) {
    return /** @type {ToolResult | undefined} */ (result)?.details?.runwieldDisplay ===
        BINARY_DISPLAY_SUPPRESSED_DETAIL;
}

/**
 * @param {unknown} result
 */
function markBinaryDisplaySuppressed(result) {
    if (typeof result !== "object" || result === null) return;
    const toolResult = /** @type {ToolResult} */ (result);
    toolResult.details = {
        ...(toolResult.details || {}),
        runwieldDisplay: BINARY_DISPLAY_SUPPRESSED_DETAIL,
    };
    binaryDisplayResults.add(result);
}

/**
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
function bytesLookBinaryForDisplay(bytes) {
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

/**
 * @param {string} absolutePath
 * @returns {Promise<Uint8Array>}
 */
async function readDisplaySampleBytes(absolutePath) {
    const file = await Deno.open(absolutePath, { read: true });
    try {
        const buffer = new Uint8Array(BINARY_DISPLAY_SAMPLE_BYTES);
        const bytesRead = await file.read(buffer);
        return buffer.slice(0, bytesRead ?? 0);
    } finally {
        file.close();
    }
}

/**
 * @param {unknown} args
 * @returns {string | undefined}
 */
function readToolPath(args) {
    const readArgs = /** @type {ReadToolArgs | undefined} */ (args);
    return readArgs?.path ?? readArgs?.file_path;
}

/**
 * @param {string} path
 * @returns {string}
 */
function normalizeReadToolPath(path) {
    return path.startsWith("@") ? path.slice(1) : path;
}

/**
 * @param {string} cwd
 * @param {string} path
 * @returns {string}
 */
function resolveReadToolPath(cwd, path) {
    const normalizedPath = normalizeReadToolPath(path);
    return isAbsolute(normalizedPath) ? normalizedPath : resolvePath(cwd, normalizedPath);
}

/**
 * @param {string} cwd
 * @param {unknown} args
 * @returns {Promise<boolean>}
 */
async function fileLooksBinaryForDisplay(cwd, args) {
    const path = readToolPath(args);
    if (typeof path !== "string" || path.length === 0) return false;

    try {
        const bytes = await readDisplaySampleBytes(resolveReadToolPath(cwd, path));
        return bytesLookBinaryForDisplay(bytes);
    } catch {
        return false;
    }
}

/**
 * @param {string} cwd
 * @param {unknown} args
 * @returns {Promise<DisplayImage | null>}
 */
async function readDisplayImage(cwd, args) {
    const path = readToolPath(args);
    if (typeof path !== "string" || path.length === 0) return null;

    try {
        const mimeType = mimeTypeForImagePath(path);
        const bytes = await Deno.readFile(resolveReadToolPath(cwd, path));
        return { base64: Buffer.from(bytes).toString("base64"), mimeType };
    } catch {
        return null;
    }
}

/**
 * @param {unknown} result
 * @param {DisplayImage} image
 */
function attachImageContent(result, image) {
    if (typeof result !== "object" || result === null) return;
    const toolResult = /** @type {ToolResult} */ (result);
    toolResult.details = {
        ...(toolResult.details || {}),
        runwieldDisplayImages: [image],
    };
    if (!Array.isArray(toolResult.content)) toolResult.content = [];
    if (!resultHasImageContent(toolResult)) {
        toolResult.content.push({ type: "image", data: image.base64, mimeType: image.mimeType });
    }
}

/**
 * @param {string} cwd
 * @returns {import('@earendil-works/pi-coding-agent').ToolDefinition<any, any>}
 */
export function createRunWieldReadToolDefinition(cwd) {
    const original = createReadToolDefinition(cwd);
    const originalExecute = /** @type {any} */ (original.execute);
    const originalRenderResult = /** @type {any} */ (original.renderResult);
    const tool = /** @type {import('@earendil-works/pi-coding-agent').ToolDefinition<any, any>} */ (original);

    tool.description =
        `${original.description} Suppresses binary/control-byte text in terminal rendering while preserving the tool result.`;
    tool.promptGuidelines = [
        ...(original.promptGuidelines || []),
        "Use read for files you need to inspect; terminal rendering may hide binary/control-byte output.",
    ];
    tool.execute = async (toolCallId, args, signal, onUpdate, context) => {
        const result = await originalExecute(toolCallId, args, signal, onUpdate, context);
        const displayImage = !resultHasImageContent(result) ? await readDisplayImage(cwd, args) : null;
        if (displayImage) attachImageContent(result, displayImage);
        if (
            !displayImage && !resultHasImageContent(result) &&
            (resultLooksUnsafeForDisplay(result) || await fileLooksBinaryForDisplay(cwd, args))
        ) {
            markBinaryDisplaySuppressed(result);
        }
        return result;
    };
    tool.renderResult = (result, _options, _theme, context) => {
        const text =
            /** @type {Text} */ (context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0));
        if (
            resultHasBinaryDisplaySuppression(result) || binaryDisplayResults.has(result) ||
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
