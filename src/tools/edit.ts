/**
 * @module tools/edit
 *
 * Adapts the pi-coding-agent `edit` tool to RunWield's single-replacement schema.
 * Failed edits propagate the original error without appending file contents.
 *
 * Registered as a custom tool named "edit" which overrides the built-in
 * via pi-coding-agent's tool registry (custom tools take precedence).
 */

import { createEditToolDefinition, type EditToolDetails, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
const singleEditSchema = Type.Object(
    {
        path: Type.String({ description: "Path to the file to edit (relative or absolute)." }),
        oldText: Type.String({
            description: "Exact text to replace. It must match one unique region in the file.",
        }),
        newText: Type.String({ description: "Replacement text for oldText." }),
    },
    { additionalProperties: false },
);

type SingleEditArguments = Static<typeof singleEditSchema>;
export type SingleEditToolDefinition = ToolDefinition<typeof singleEditSchema, EditToolDetails | undefined>;

interface LegacyEditChange {
    oldText?: unknown;
    newText?: unknown;
}

interface LegacyEditArguments {
    path?: unknown;
    file_path?: unknown;
    oldText?: unknown;
    newText?: unknown;
    edits?: LegacyEditChange[];
}

/** Accept stale/legacy argument shapes while advertising a single-edit schema. */
function prepareSingleEditArguments(input: unknown): SingleEditArguments {
    if (!input || typeof input !== "object") {
        return input as SingleEditArguments;
    }

    const args = input as LegacyEditArguments;
    const path =
        typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;

    if (typeof path === "string" && typeof args.oldText === "string" && typeof args.newText === "string") {
        return { path, oldText: args.oldText, newText: args.newText };
    }

    if (typeof path === "string" && Array.isArray(args.edits) && args.edits.length === 1) {
        const edit = args.edits[0];
        if (typeof edit?.oldText === "string" && typeof edit?.newText === "string") {
            return { path, oldText: edit.oldText, newText: edit.newText };
        }
    }

    return input as SingleEditArguments;
}

/** Create a single-replacement edit tool that preserves upstream errors. */
export function createSingleEditToolDefinition(cwd: string): SingleEditToolDefinition {
    const original = createEditToolDefinition(cwd);
    const originalExecute = original.execute;
    const tool: SingleEditToolDefinition = original as unknown as SingleEditToolDefinition;

    tool.description =
        "Edit a single file by replacing one exact text block. Use multi_file_edit for multiple replacements or multiple files.";
    tool.promptSnippet = "Make one precise exact-text replacement in one file";
    tool.promptGuidelines = [
        "Use edit for a single replacement in a single file: path, oldText, newText",
        "Use multi_file_edit when you need more than one replacement or need to touch more than one file",
        "oldText must match exactly one location, including whitespace and newlines",
    ];
    tool.parameters = singleEditSchema;
    tool.prepareArguments = prepareSingleEditArguments;
    tool.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
        const singleEditParams = params;
        const editParams = {
            path: singleEditParams.path,
            edits: [{ oldText: singleEditParams.oldText, newText: singleEditParams.newText }],
        };
        return await originalExecute(toolCallId, editParams, signal, onUpdate, ctx);
    };

    return tool;
}
