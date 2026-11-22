import { Type } from "typebox";

const markdownPathGuideline =
    "The path must end with .md; .markdown, .mdx, extensionless, and non-document paths are rejected";

// Match the native write tool's schema so the adapter can forward these arguments directly.
const writeParameters = Type.Object({
    path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
    content: Type.String({ description: "Content to write to the file" }),
});

const singleEditParameters = Type.Object(
    {
        path: Type.String({ description: "Path to the file to edit (relative or absolute)." }),
        oldText: Type.String({
            description: "Exact text to replace. It must match one unique region in the file.",
        }),
        newText: Type.String({ description: "Replacement text for oldText." }),
    },
    { additionalProperties: false },
);

export const writeDocsDefinition = {
    name: "write_docs",
    label: "write_docs",
    description:
        "Write Markdown documentation to a .md file. Creates the file if it doesn't exist, overwrites if it does, and rejects non-.md paths before mutation.",
    promptSnippet: "Create or overwrite Markdown .md documentation files",
    promptGuidelines: [
        "Use write_docs only for new Markdown documents or user-approved full rewrites",
        markdownPathGuideline,
        "Prefer edit_docs for focused updates to an existing Markdown file",
    ],
    parameters: writeParameters,
} as const;

export const editDocsDefinition = {
    name: "edit_docs",
    label: "edit_docs",
    description: "Edit a Markdown .md file by replacing one exact text block. Rejects non-.md paths before mutation.",
    promptSnippet: "Make one precise exact-text replacement in a Markdown .md file",
    promptGuidelines: [
        "Use edit_docs for focused updates to one Markdown file: path, oldText, newText",
        markdownPathGuideline,
        "oldText must match exactly one location, including whitespace and newlines",
    ],
    parameters: singleEditParameters,
} as const;
