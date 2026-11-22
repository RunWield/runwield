import { Type } from "typebox";

const MAX_READ_BYTES = 64 * 1024;

export const reviewDiffDefinition = {
    name: "review_diff",
    label: "Review Diff",
    description:
        "Bounded, read-only access to the current workflow diff. Use 'list' to see changed files with sizes, or 'show' to read the diff for a specific file path. Does not run git commands.",
    promptSnippet:
        "review_diff(list|show): List changed files or read the diff for one file. Prefer 'list' first to see what changed, then 'show <path>' to inspect specific files.",
    parameters: Type.Object({
        command: Type.Enum(["list", "show"]),
        scope: Type.Optional(
            Type.Enum(["full", "repair"], {
                description:
                    "Which diff to inspect. 'full' (default) shows the proposed branch patch from its common ancestor with the recorded target through current worktree files. 'repair' is only what the most recent repair changed, and is available from the second review round onward.",
            }),
        ),
        path: Type.Optional(
            Type.String({
                description:
                    "Required for 'show'. The file path to inspect. Accepts partial path matches for convenience.",
            }),
        ),
        offsetBytes: Type.Optional(
            Type.Integer({
                minimum: 0,
                description:
                    "Byte offset into the file's diff content. Use to page through large per-file diffs. Default: 0.",
            }),
        ),
        maxBytes: Type.Optional(
            Type.Integer({
                minimum: 256,
                maximum: MAX_READ_BYTES,
                description: `Maximum bytes to return for this file's diff. Default: ${MAX_READ_BYTES}. Max: ${MAX_READ_BYTES}.`,
            }),
        ),
    }),
} as const;
