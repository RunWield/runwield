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
    NativeWriteToolDefinition["parameters"],
    NativeWriteResult["details"] | null
>;

export type EditDocsToolDefinition = ToolDefinition<
    NativeEditToolDefinition["parameters"],
    NativeEditResult["details"] | null
>;

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
    const originalExecute = original.execute;
    const tool = original as WriteDocsToolDefinition;

    tool.name = "write_docs";
    tool.label = "write_docs";
    tool.description =
        "Write Markdown documentation to a .md file. Creates the file if it doesn't exist, overwrites if it does, and rejects non-.md paths before mutation.";
    tool.promptSnippet = "Create or overwrite Markdown .md documentation files";
    tool.promptGuidelines = [
        "Use write_docs only for new Markdown documents or user-approved full rewrites",
        "The path must end with .md; .markdown, .mdx, extensionless, and non-document paths are rejected",
        "Prefer edit_docs for focused updates to an existing Markdown file",
    ];
    tool.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
        const typedParams = params;
        const validationError = validateMarkdownPath(typedParams.path, "write_docs");
        if (validationError) return blockedResult(validationError);
        return await originalExecute(toolCallId, params, signal, onUpdate, ctx);
    };

    return tool;
}

/** Create an edit tool that only accepts `.md` paths. */
export function createEditDocsToolDefinition(cwd: string): EditDocsToolDefinition {
    const original = createSingleEditToolDefinition(cwd);
    const originalExecute = original.execute;
    const tool = original as EditDocsToolDefinition;

    tool.name = "edit_docs";
    tool.label = "edit_docs";
    tool.description =
        "Edit a Markdown .md file by replacing one exact text block. Rejects non-.md paths before mutation.";
    tool.promptSnippet = "Make one precise exact-text replacement in a Markdown .md file";
    tool.promptGuidelines = [
        "Use edit_docs for focused updates to one Markdown file: path, oldText, newText",
        "The path must end with .md; .markdown, .mdx, extensionless, and non-document paths are rejected",
        "oldText must match exactly one location, including whitespace and newlines",
    ];
    tool.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
        const typedParams = params;
        const validationError = validateMarkdownPath(typedParams.path, "edit_docs");
        if (validationError) return blockedResult(validationError);
        return await originalExecute(toolCallId, params, signal, onUpdate, ctx);
    };

    return tool;
}
