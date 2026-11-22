/**
 * @module tools/docs-file-tools
 *
 * Markdown-restricted adapters for file mutation tools. These tools preserve the
 * native write/edit interfaces while validating the target path before any
 * filesystem mutation is delegated to the underlying tool implementation.
 */

import { createWriteToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createSingleEditToolDefinition } from "./edit.ts";
import type { TextContent } from "@earendil-works/pi-ai";
import { toolRegistry } from "@runwield/tools";

const writeDocs = toolRegistry.get("write_docs").definition;
const editDocs = toolRegistry.get("edit_docs").definition;

type NativeWriteToolDefinition = ReturnType<typeof createWriteToolDefinition>;
type NativeEditToolDefinition = ReturnType<typeof createSingleEditToolDefinition>;
type NativeWriteResult = Awaited<ReturnType<NativeWriteToolDefinition["execute"]>>;
type NativeEditResult = Awaited<ReturnType<NativeEditToolDefinition["execute"]>>;

interface BlockedDocsResult {
    content: TextContent[];
    details: null;
    isError: true;
}

export type WriteDocsToolDefinition = ToolDefinition<typeof writeDocs.parameters, NativeWriteResult["details"] | null>;

export type EditDocsToolDefinition = ToolDefinition<typeof editDocs.parameters, NativeEditResult["details"] | null>;

function validateMarkdownPath(path: unknown, toolName: string): string | null {
    if (typeof path !== "string" || !path.trim()) {
        return `${toolName}: path is required and must end with .md.`;
    }

    const normalized = path.replace(/\\/g, "/");
    const fileName = normalized.split("/").pop() || "";
    if (!fileName.toLowerCase().endsWith(".md")) {
        return `${toolName}: only Markdown .md files can be modified. Received: ${path}`;
    }

    return null;
}

function blockedResult(message: string): BlockedDocsResult {
    return {
        content: [{ type: "text", text: message }],
        details: null,
        isError: true,
    };
}

/** Create a write tool that only accepts `.md` paths. */
export function createWriteDocsToolDefinition(cwd: string): WriteDocsToolDefinition {
    const original = createWriteToolDefinition(cwd);
    const tool = original as WriteDocsToolDefinition;

    return {
        ...tool,
        ...writeDocs,
        promptGuidelines: [...writeDocs.promptGuidelines],
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const validationError = validateMarkdownPath(params.path, writeDocs.name);
            if (validationError) return blockedResult(validationError);
            return await original.execute(toolCallId, params, signal, onUpdate, ctx);
        },
    };
}

/** Create an edit tool that only accepts `.md` paths. */
export function createEditDocsToolDefinition(cwd: string): EditDocsToolDefinition {
    const original = createSingleEditToolDefinition(cwd);
    const tool = original as EditDocsToolDefinition;

    return {
        ...tool,
        ...editDocs,
        promptGuidelines: [...editDocs.promptGuidelines],
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const validationError = validateMarkdownPath(params.path, editDocs.name);
            if (validationError) return blockedResult(validationError);
            return await original.execute(toolCallId, params, signal, onUpdate, ctx);
        },
    };
}
