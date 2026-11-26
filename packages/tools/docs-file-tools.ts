import type { Static } from "typebox";
import type { editDocsDefinition } from "./definitions/docs-file-tools.ts";

type SingleEditArguments = Static<typeof editDocsDefinition.parameters>;

interface LegacyEditChange<Input> {
    oldText?: Input;
    newText?: Input;
}

interface LegacyEditArguments<Input> extends LegacyEditChange<Input> {
    path?: Input;
    file_path?: Input;
    edits?: LegacyEditChange<Input>[];
}

/** Accept legacy arguments before the caller validates the single-replacement schema. */
export function prepareSingleEditArguments<Input>(input: Input): Input | SingleEditArguments {
    if (!input || typeof input !== "object") return input;

    const args = input as Input & LegacyEditArguments<Input>;
    const path = typeof args.path === "string" ? args.path : args.file_path;
    if (typeof path === "string" && typeof args.oldText === "string" && typeof args.newText === "string") {
        return { path, oldText: args.oldText, newText: args.newText };
    }
    if (typeof path === "string" && Array.isArray(args.edits) && args.edits.length === 1) {
        const edit = args.edits[0];
        if (typeof edit?.oldText === "string" && typeof edit?.newText === "string") {
            return { path, oldText: edit.oldText, newText: edit.newText };
        }
    }
    return input;
}

function validateMarkdownPath<Path>(path: Path, toolName: "edit_docs" | "write_docs"): string | null {
    if (typeof path !== "string" || !path.trim()) {
        return `${toolName}: path is required and must end with .md.`;
    }
    const fileName = path.replace(/\\/g, "/").split("/").pop() || "";
    if (!fileName.toLowerCase().endsWith(".md")) {
        return `${toolName}: only Markdown .md files can be modified. Received: ${path}`;
    }
    return null;
}

/** Return the write tool's validation message for an invalid Markdown target. */
export function validateWriteDocsPath<Path>(path: Path): string | null {
    return validateMarkdownPath(path, "write_docs");
}

/** Return the edit tool's validation message for an invalid Markdown target. */
export function validateEditDocsPath<Path>(path: Path): string | null {
    return validateMarkdownPath(path, "edit_docs");
}
