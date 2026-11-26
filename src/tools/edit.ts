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
import { toolRegistry, type ToolParameters } from "@runwield/tools";

const editDocs = toolRegistry.get("edit_docs");
const singleEditSchema = editDocs.definition.parameters;

export type SingleEditToolDefinition = ToolDefinition<typeof singleEditSchema, EditToolDetails | undefined>;

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
    // Pi validates the prepared arguments against the model-facing schema before execute.
    tool.prepareArguments = (input) => editDocs.prepareArguments(input) as ToolParameters<"edit_docs">;
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
