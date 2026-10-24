import { test } from "node:test";
import { importTestBundle } from "../../../testing/import-test-bundle.ts";
import { notDeepStrictEqual as assertNotEquals } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../../testing/assertions.ts";
import { editHunksToAnnotations, editorCommentToAnnotation } from "./code-review-edit-suggestions.ts";
import { build, stop } from "esbuild";
import { fileURLToPath as fromFileUrl } from "node:url";

// Bundle the real export as the browser does; vendored imports omit extensions.
const bundle = await build({
    entryPoints: [
        fromFileUrl(
            new URL(
                "../../../../third_party/plannotator/packages/review-editor/utils/exportFeedback.ts",
                import.meta.url,
            ),
        ),
    ],
    bundle: true,
    write: false,
    format: "esm",
    alias: {
        "@plannotator/ui": fromFileUrl(new URL("../../../../third_party/plannotator/packages/ui", import.meta.url)),
        "@plannotator/core": fromFileUrl(new URL("../../../../third_party/plannotator/packages/core", import.meta.url)),
        "@plannotator/shared": fromFileUrl(
            new URL("../../../../third_party/plannotator/packages/shared", import.meta.url),
        ),
    },
});
stop();
const { exportReviewFeedback } = await importTestBundle(bundle.outputFiles[0].text);

test("edited regions become distinct new-side suggestion annotations and reach feedback", () => {
    const annotations = editHunksToAnnotations("src/example.ts", [
        { lineStart: 2, lineEnd: 3, originalCode: "before", suggestedCode: "after\nadded" },
        { lineStart: 8, lineEnd: 8, originalCode: "last", suggestedCode: "changed" },
    ]);
    assertEquals(annotations.length, 2);
    assertNotEquals(annotations[0].id, annotations[1].id);
    for (const annotation of annotations) {
        assertEquals(annotation.type, "comment");
        assertEquals(annotation.scope, "line");
        assertEquals(annotation.side, "new");
        assertEquals(annotation.filePath, "src/example.ts");
        assertEquals(typeof annotation.createdAt, "number");
    }
    assertEquals(annotations[0].lineStart, 2);
    assertEquals(annotations[0].lineEnd, 3);
    assertEquals(annotations[0].originalCode, "before");
    assertEquals(annotations[0].suggestedCode, "after\nadded");
    const feedback = exportReviewFeedback(annotations);
    assertStringIncludes(feedback, "src/example.ts");
    assertStringIncludes(feedback, "2-3");
    assertStringIncludes(feedback, "**Suggested code:**\n```\nafter\nadded\n```");
});

test("empty replacements describe deletion and pure insertions omit original code", () => {
    const [deletion, insertion] = editHunksToAnnotations("example.ts", [
        { lineStart: 1, lineEnd: 2, originalCode: "removed", suggestedCode: "" },
        { lineStart: 4, lineEnd: 4, originalCode: "", suggestedCode: "inserted" },
    ]);
    assertEquals(deletion.text, "Suggested change: remove these lines.");
    assertEquals("suggestedCode" in deletion, false);
    assertEquals(deletion.originalCode, "removed");
    assertEquals("originalCode" in insertion, false);
    assertEquals(insertion.suggestedCode, "inserted");
    assertEquals(editHunksToAnnotations("example.ts", []), []);
});

test("editor comments keep their pristine anchor and identify selected edited text", () => {
    const comment = { lineStart: 3, lineEnd: 5, text: "  explain this  ", selectedText: "edited buffer", exact: false };
    const annotation = editorCommentToAnnotation("example.ts", comment)!;
    assertEquals(annotation.type, "comment");
    assertEquals(annotation.scope, "line");
    assertEquals(annotation.side, "new");
    assertEquals(annotation.filePath, "example.ts");
    assertEquals(annotation.lineStart, 3);
    assertEquals(annotation.lineEnd, 5);
    assertEquals(annotation.text, "explain this");
    assertEquals(annotation.selectedText, "edited buffer");
    assertEquals(annotation.selectedTextFromEdits, true);
    assertEquals(
        "selectedTextFromEdits" in editorCommentToAnnotation("example.ts", { ...comment, exact: true })!,
        false,
    );
    assertEquals(editorCommentToAnnotation("example.ts", { ...comment, text: " \n " }), null);
});
