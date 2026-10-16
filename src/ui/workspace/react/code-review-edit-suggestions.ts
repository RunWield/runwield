import type { CodeAnnotation } from "@plannotator/ui/types.ts";
import type { SuggestionHunk } from "../../../../third_party/plannotator/packages/review-editor/edit/deriveSuggestions.ts";
/** Data consumed at the editor callback boundary; no editor runtime types are needed here. */
interface EditSelectionComment {
    lineStart: number;
    lineEnd: number;
    exact: boolean;
    selectedText: string;
    text: string;
}

/** Convert edits of the new-side buffer into ordinary review annotations. */
export function editHunksToAnnotations(filePath: string, hunks: SuggestionHunk[]): CodeAnnotation[] {
    const createdAt = Date.now();
    return hunks.map((hunk) => ({
        id: crypto.randomUUID(),
        type: "comment",
        scope: "line",
        side: "new",
        filePath,
        lineStart: hunk.lineStart,
        lineEnd: hunk.lineEnd,
        ...(hunk.suggestedCode === ""
            ? { text: "Suggested change: remove these lines." }
            : { suggestedCode: hunk.suggestedCode }),
        ...(hunk.originalCode === "" ? {} : { originalCode: hunk.originalCode }),
        createdAt,
    }));
}

/** Selection anchors already refer to the pristine diff, even after Discard. */
export function editorCommentToAnnotation(filePath: string, comment: EditSelectionComment): CodeAnnotation | null {
    const text = comment.text.trim();
    if (!text) return null;
    return {
        id: crypto.randomUUID(),
        type: "comment",
        scope: "line",
        side: "new",
        filePath,
        lineStart: comment.lineStart,
        lineEnd: comment.lineEnd,
        text,
        selectedText: comment.selectedText || undefined,
        ...(comment.exact ? {} : { selectedTextFromEdits: true }),
        createdAt: Date.now(),
    };
}
