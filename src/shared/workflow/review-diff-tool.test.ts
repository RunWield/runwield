import { test } from "node:test";
import type { TextContent } from "@earendil-works/pi-ai";
import {
    buildDiffInspectionSection,
    createReviewDiffTool,
    parseDiffFiles,
    requiredReviewDiffFiles,
    ReviewDiffParseError,
} from "./review-diff-tool.ts";
import { assertEquals, assertStringIncludes, assertThrows } from "../../testing/assertions.ts";

import "../settings.ts";
import { ReviewInspection } from "./review-inspection.ts";

interface FixtureDiffParams {
    command: string;
    scope?: string;
    path?: string;
    offsetBytes?: number;
    maxBytes?: number;
}

interface FixtureDiffDetails {
    nextOffsetBytes?: number;
    truncated?: boolean;
    command?: string;
    scope?: string;
    fileCount?: number;
    available?: boolean;
    path?: string;
}

interface FixtureDiffResult {
    content: TextContent[];
    details: FixtureDiffDetails;
    isError?: boolean;
}

type FixtureExecute = (toolCallId: string, params: FixtureDiffParams) => Promise<FixtureDiffResult>;

const SAMPLE_INLINE_DIFF = `diff --git a/src/a.js b/src/a.js
index 1111111..2222222 100644
--- a/src/a.js
+++ b/src/a.js
@@ -1,2 +1,2 @@
-old line
+new line
 context

diff --git a/src/b.js b/src/b.js
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/b.js
@@ -0,0 +1,2 @@
+added line
+another added line

diff --git a/src/c.js b/src/c.js
deleted file mode 100644
index 4444444..0000000
--- a/src/c.js
+++ /dev/null
@@ -1,2 +0,0 @@
-deleted line
-another deleted line

diff --git a/src/old.js b/src/new.js
similarity index 88%
rename from src/old.js
rename to src/new.js
index 5555555..6666666 100644
--- a/src/old.js
+++ b/src/new.js
@@ -1 +1 @@
-old name
+new name

diff --git a/src/binary.png b/src/binary.png
new file mode 100644
index 0000000..7777777
Binary files /dev/null and b/src/binary.png differ
`;

test("review_diff pages preserve UTF-8 content and complete inspection", async () => {
    const diff =
        "diff --git a/src/unicode.js b/src/unicode.js\n--- a/src/unicode.js\n+++ b/src/unicode.js\n@@ -1 +1 @@\n-old\n+" +
        "x".repeat(300) +
        "😀 after\n";
    const bytes = new TextEncoder().encode(diff).byteLength;
    const emojiStart = new TextEncoder().encode(diff.slice(0, diff.indexOf("😀"))).byteLength;
    const inspection = new ReviewInspection([{ scope: "full", path: "src/unicode.js", byteLength: bytes }]);
    const tool = createReviewDiffTool(diff, { inspection });
    const execute = tool.execute as FixtureExecute;
    const first = await execute("first", { command: "show", path: "unicode.js", maxBytes: emojiStart + 2 });
    assertEquals(first.details.path, "src/unicode.js");
    assertEquals(first.details.truncated, true);
    assertEquals(first.details.nextOffsetBytes, emojiStart);
    assertEquals(inspection.unread(), [
        { scope: "full", path: "src/unicode.js", start: emojiStart, end: bytes, byteLength: bytes },
    ]);
    const second = await execute("second", {
        command: "show",
        path: "unicode.js",
        offsetBytes: first.details.nextOffsetBytes,
        maxBytes: 256,
    });
    const pages = [first, second].map(
        (result) => result.content[0].text.split("\x60\x60\x60diff\n")[1].split("\n\x60\x60\x60")[0],
    );
    assertEquals(pages.join(""), diff);
    assertEquals(pages.join("").includes("�"), false);
    assertEquals(second.details.truncated, false);
    assertEquals(inspection.unread(), []);
    const eof = await execute("eof", { command: "show", path: "unicode.js", offsetBytes: bytes + 100 });
    assertEquals(eof.details.truncated, false);
    assertEquals(inspection.unread(), []);
});

test("buildDiffInspectionSection lists changed files without inlining the diff", () => {
    const section = buildDiffInspectionSection(SAMPLE_INLINE_DIFF);

    // The diff is never inlined — the Reviewer reads it through review_diff.
    assertEquals(section.includes("new line"), false);
    assertEquals(section.includes("brand new"), false);
    assertEquals(section.includes("removed line1"), false);

    assertStringIncludes(section, "src/a.js");
    assertStringIncludes(section, "src/b.js");
    assertStringIncludes(section, "src/c.js");
    assertStringIncludes(section, "review_diff");
});

test("buildDiffInspectionSection documents the repair scope only when one exists", () => {
    assertEquals(buildDiffInspectionSection(SAMPLE_INLINE_DIFF).includes('scope: "repair"'), false);
    assertStringIncludes(buildDiffInspectionSection(SAMPLE_INLINE_DIFF, { hasRepairScope: true }), 'scope: "repair"');
});

test("review_diff tool responds to list command", async () => {
    const tool = createReviewDiffTool(SAMPLE_INLINE_DIFF);
    const result = await (tool.execute as FixtureExecute)("test-1", { command: "list" });
    assertStringIncludes(result.content[0].text, "src/a.js");
    assertStringIncludes(result.content[0].text, "src/b.js");
    assertEquals(result.details.command, "list");
    assertEquals(result.details.fileCount, 5);
    for (const row of [
        "src/a.js\x60 | modified | 1 | 1",
        "src/b.js\x60 | added | 2 | 0",
        "src/c.js\x60 | deleted | 0 | 2",
        "src/new.js\x60 | renamed | 1 | 1",
        "src/binary.png\x60 | modified | 0 | 0",
    ])
        assertStringIncludes(result.content[0].text, row);
});

test("review_diff describes full scope as the proposed branch patch", () => {
    const tool = createReviewDiffTool({ full: SAMPLE_INLINE_DIFF, repair: "" });
    const description = tool.description || tool.promptSnippet || "";
    assertStringIncludes(String(description), "entire proposed branch patch");
    assertStringIncludes(
        buildDiffInspectionSection(SAMPLE_INLINE_DIFF, { hasRepairScope: true }),
        "entire proposed branch patch",
    );
});

test("review_diff tool lists the repair scope separately from the full diff", async () => {
    const repairOnly = `diff --git a/src/fix.js b/src/fix.js
index 8888888..9999999 100644
--- a/src/fix.js
+++ b/src/fix.js
@@ -1 +1 @@
-broken
+fixed
`;
    const tool = createReviewDiffTool({ full: SAMPLE_INLINE_DIFF, repair: repairOnly });

    const full = await (tool.execute as FixtureExecute)("scope-1", { command: "list" });
    assertEquals(full.details.scope, "full");
    assertEquals(full.details.fileCount, 5);

    const repair = await (tool.execute as FixtureExecute)("scope-2", { command: "list", scope: "repair" });
    assertEquals(repair.details.scope, "repair");
    assertEquals(repair.details.fileCount, 1);
    assertStringIncludes(repair.content[0].text, "src/fix.js");
});

test("review_diff tool explains the repair scope is absent in the first round", async () => {
    const tool = createReviewDiffTool({ full: SAMPLE_INLINE_DIFF });
    const result = await (tool.execute as FixtureExecute)("scope-3", { command: "list", scope: "repair" });

    assertEquals(result.details.available, false);
    assertEquals(result.isError, undefined);
    assertStringIncludes(result.content[0].text, "No repair scope in this round");
});

test("review_diff tool responds to show command", async () => {
    const tool = createReviewDiffTool(SAMPLE_INLINE_DIFF);
    const result = await (tool.execute as FixtureExecute)("test-2", { command: "show", path: "src/a.js" });
    assertStringIncludes(result.content[0].text, "new line");
    assertEquals(result.details.command, "show");
    assertEquals(result.details.path, "src/a.js");
});

test("review_diff tool reports error for missing path in show", async () => {
    const tool = createReviewDiffTool(SAMPLE_INLINE_DIFF);
    const result = await (tool.execute as FixtureExecute)("test-3", { command: "show" });
    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "required");
});

test("review_diff tool reports error for unknown command", async () => {
    const tool = createReviewDiffTool(SAMPLE_INLINE_DIFF);
    const result = await (tool.execute as FixtureExecute)("test-4", { command: "unknown" });
    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "unknown command");
});

test("review_diff tool reports not-found for nonexistent file", async () => {
    const tool = createReviewDiffTool(SAMPLE_INLINE_DIFF);
    const result = await (tool.execute as FixtureExecute)("test-5", { command: "show", path: "nonexistent.js" });
    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "not found");
});

test("review_diff tool returns no-files message for empty diff", async () => {
    const tool = createReviewDiffTool("");
    const result = await (tool.execute as FixtureExecute)("test-6", { command: "list" });
    assertEquals(result.details.fileCount, 0);
    assertStringIncludes(result.content[0].text, "No changed files");
});

// ─── Large-diff / error-handling integration tests ──────────────────────────

test("required review files are empty only for an empty patch", () => {
    assertEquals(requiredReviewDiffFiles(""), []);
    assertEquals(requiredReviewDiffFiles("  \n"), []);
    assertEquals(requiredReviewDiffFiles(SAMPLE_INLINE_DIFF), parseDiffFiles(SAMPLE_INLINE_DIFF));
});

for (const text of [
    "diff --git x/f y/f\n-old\n+new\n",
    "diff --git f f\n-old\n+new\n",
    "\x1b[1mdiff --git a/f b/f\x1b[m\n-old\n+new\n",
    "external diff output",
]) {
    test(`required review files reject unreadable content: ${JSON.stringify(text)}`, () => {
        assertThrows(() => requiredReviewDiffFiles(text), ReviewDiffParseError, "The change was not approved");
        assertEquals(parseDiffFiles(text), []);
    });
}
