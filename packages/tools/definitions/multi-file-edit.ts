import { Type, type Static } from "typebox";

const fileEditSchema = Type.Object(
    {
        path: Type.String({
            description: "Path to the file for this replacement, relative to root or the session cwd.",
        }),
        oldText: Type.String({
            description: "Exact text to replace in this file. It must match one unique, non-overlapping region.",
        }),
        newText: Type.String({ description: "Replacement text for oldText." }),
    },
    { additionalProperties: false },
);

const PARAMETERS = Type.Object(
    {
        root: Type.Optional(
            Type.String({
                description:
                    "Optional base directory for relative edit paths. Defaults to the session working directory.",
            }),
        ),
        edits: Type.Array(fileEditSchema, {
            minItems: 1,
            description:
                "One or more replacements. Use edit instead when there is exactly one replacement in one file.",
        }),
    },
    { additionalProperties: false },
);

export const multiFileEditDefinition = {
    name: "multi_file_edit",
    label: "multi_file_edit",
    description:
        "Edit one or more files by applying multiple exact-text replacements. Each edits[] item includes its own path, oldText, and newText. Use edit for a single replacement in a single file.",
    promptSnippet:
        "Apply multiple exact-text replacements across one or more files with edits[].path, edits[].oldText, and edits[].newText",
    promptGuidelines: [
        "Use multi_file_edit when a task needs multiple replacements or touches multiple files",
        "Each edits[] item must include path, oldText, and newText",
        "Use edit instead for exactly one replacement in one file",
        "Within each file, oldText entries are matched against the original file content and must not overlap",
    ],
    parameters: PARAMETERS,
} as const;

export type MultiFileEditParams = Static<typeof multiFileEditDefinition.parameters>;
