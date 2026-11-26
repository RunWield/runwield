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

const writeDocs = toolRegistry.get("write_docs");
const editDocs = toolRegistry.get("edit_docs");

type NativeWriteToolDefinition = ReturnType<typeof createWriteToolDefinition>;
type NativeEditToolDefinition = ReturnType<typeof createSingleEditToolDefinition>;
type NativeWriteResult = Awaited<ReturnType<NativeWriteToolDefinition["execute"]>>;
type NativeEditResult = Awaited<ReturnType<NativeEditToolDefinition["execute"]>>;

interface BlockedDocsResult {
    content: TextContent[];
    details: null;
    isError: true;
}

export type WriteDocsToolDefinition = ToolDefinition<
    typeof writeDocs.definition.parameters,
    NativeWriteResult["details"] | null
>;

export type EditDocsToolDefinition = ToolDefinition<
    typeof editDocs.definition.parameters,
    NativeEditResult["details"] | null
>;

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
        ...writeDocs.definition,
        promptGuidelines: [...writeDocs.definition.promptGuidelines],
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const validationError = writeDocs.validatePath(params.path);
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
        ...editDocs.definition,
        promptGuidelines: [...editDocs.definition.promptGuidelines],
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const validationError = editDocs.validatePath(params.path);
            if (validationError) return blockedResult(validationError);
            return await original.execute(toolCallId, params, signal, onUpdate, ctx);
        },
    };
}
