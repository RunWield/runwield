import { test } from "node:test";
import {
    buildDiffInspectionSection,
    createReviewDiffTool,
    formatChangedFileList,
    getFileDiff,
    listDiffFiles,
    parseDiffFiles,
} from "./review-diff-tool.js";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";

import { __resetSettingsForTests } from "../settings.js";

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

test("parseDiffFiles parses modified, added, deleted, renamed, and binary files", () => {
    const entries = parseDiffFiles(SAMPLE_INLINE_DIFF);
    assertEquals(entries.length, 5, "expected 5 file entries");

    const modEntry = entries.find((e) => e.path === "src/a.js");
    assertEquals(modEntry?.changeType, "modified");
    assertEquals(modEntry?.hunkLines.added, 1);
    assertEquals(modEntry?.hunkLines.removed, 1);

    const addEntry = entries.find((e) => e.path === "src/b.js");
    assertEquals(addEntry?.changeType, "added");
    assertEquals(addEntry?.hunkLines.added, 2);
    assertEquals(addEntry?.hunkLines.removed, 0);

    const delEntry = entries.find((e) => e.path === "src/c.js");
    assertEquals(delEntry?.changeType, "deleted");
    assertEquals(delEntry?.hunkLines.added, 0);
    assertEquals(delEntry?.hunkLines.removed, 2);

    const renameEntry = entries.find((e) => e.path === "src/new.js");
    assertEquals(renameEntry?.changeType, "renamed");

    const binaryEntry = entries.find((e) => e.path === "src/binary.png");
    assertEquals(binaryEntry?.changeType, "modified");
    assertEquals(binaryEntry?.hunkLines.added, 0);
    assertEquals(binaryEntry?.hunkLines.removed, 0);
});

test("parseDiffFiles returns empty array for empty diff", () => {
    assertEquals(parseDiffFiles(""), []);
    assertEquals(parseDiffFiles("   "), []);
    assertEquals(parseDiffFiles("no header here"), []);
});

test("formatChangedFileList includes all entries with summary info", () => {
    const entries = parseDiffFiles(SAMPLE_INLINE_DIFF);
    const output = formatChangedFileList(entries);
    assertStringIncludes(output, "src/a.js");
    assertStringIncludes(output, "src/b.js");
    assertStringIncludes(output, "src/c.js");
    assertStringIncludes(output, "1 added, 1 removed");
    assertStringIncludes(output, "2 added, 0 removed");
    assertStringIncludes(output, "0 added, 2 removed");
    assertStringIncludes(output, "5 file(s)");
});

test("getFileDiff finds file by exact path", () => {
    const entries = parseDiffFiles(SAMPLE_INLINE_DIFF);
    const result = getFileDiff(entries, "src/a.js");
    assertEquals(result.found, true);
    if (result.found) {
        assertStringIncludes(result.content, "new line");
        assertEquals(result.truncated, false);
    }
});

test("getFileDiff returns not-found for nonexistent file", () => {
    const entries = parseDiffFiles(SAMPLE_INLINE_DIFF);
    const result = getFileDiff(entries, "src/nope.js");
    assertEquals(result.found, false);
    if (!result.found) {
        assertStringIncludes(result.message, "not found");
    }
});

test("getFileDiff supports byte offset for truncated reads", () => {
    const entries = parseDiffFiles(SAMPLE_INLINE_DIFF);
    // Use a very small maxBytes to force truncation
    const result = getFileDiff(entries, "src/a.js", { offsetBytes: 0, maxBytes: 50 });
    assertEquals(result.found, true);
    if (result.found) {
        assertEquals(result.truncated, true);
        assertEquals(result.remainingBytes > 0, true);
    }
});

test("getFileDiff preserves UTF-8 characters across byte pages", () => {
    const diff =
        `diff --git a/src/unicode.js b/src/unicode.js\n--- a/src/unicode.js\n+++ b/src/unicode.js\n@@ -1 +1 @@\n-old\n+before 😀 after\n`;
    const entry = parseDiffFiles(diff)[0];
    const emojiStart = new TextEncoder().encode(entry.text.slice(0, entry.text.indexOf("😀"))).byteLength;
    const first = getFileDiff([entry], entry.path, { maxBytes: emojiStart + 2 });
    assertEquals(first.found, true);
    if (!first.found) return;
    const second = getFileDiff([entry], entry.path, { offsetBytes: first.nextOffsetBytes, maxBytes: 64 });
    assertEquals(second.found, true);
    if (!second.found) return;

    assertEquals(first.content.includes("�"), false);
    assertEquals(second.content.includes("�"), false);
    assertEquals(first.content + second.content, entry.text);
});

test("listDiffFiles marks entries exceeding max inline bytes as truncated", () => {
    const entries = parseDiffFiles(SAMPLE_INLINE_DIFF);
    const summaries = listDiffFiles(entries, 1);

    for (const s of summaries) {
        assertEquals(s.truncated, true);
        assertEquals(s.maxInlineBytes, 1);
    }
});

test("listDiffFiles does not mark small entries as truncated", () => {
    const entries = parseDiffFiles(SAMPLE_INLINE_DIFF);
    const summaries = listDiffFiles(entries, 10_000_000);

    for (const s of summaries) {
        assertEquals(s.truncated, false);
        assertEquals(s.maxInlineBytes, null);
    }
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
    assertStringIncludes(
        buildDiffInspectionSection(SAMPLE_INLINE_DIFF, { hasRepairScope: true }),
        'scope: "repair"',
    );
});

test("review_diff tool responds to list command", async () => {
    const tool = createReviewDiffTool(SAMPLE_INLINE_DIFF);
    const result = await /** @type {any} */ (tool.execute)("test-1", { command: "list" });
    assertStringIncludes(result.content[0].text, "src/a.js");
    assertStringIncludes(result.content[0].text, "src/b.js");
    assertEquals(result.details.command, "list");
    assertEquals(result.details.fileCount, 5);
});

test("review_diff describes full scope as the proposed branch patch", () => {
    const tool = createReviewDiffTool({ full: SAMPLE_INLINE_DIFF, repair: "" });
    const description = /** @type {any} */ (tool).description || /** @type {any} */ (tool).promptSnippet || "";
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

    const full = await /** @type {any} */ (tool.execute)("scope-1", { command: "list" });
    assertEquals(full.details.scope, "full");
    assertEquals(full.details.fileCount, 5);

    const repair = await /** @type {any} */ (tool.execute)("scope-2", { command: "list", scope: "repair" });
    assertEquals(repair.details.scope, "repair");
    assertEquals(repair.details.fileCount, 1);
    assertStringIncludes(repair.content[0].text, "src/fix.js");
});

test("review_diff tool explains the repair scope is absent in the first round", async () => {
    const tool = createReviewDiffTool({ full: SAMPLE_INLINE_DIFF });
    const result = await /** @type {any} */ (tool.execute)("scope-3", { command: "list", scope: "repair" });

    assertEquals(result.details.available, false);
    assertEquals(result.isError, undefined);
    assertStringIncludes(result.content[0].text, "No repair scope in this round");
});

test("review_diff tool responds to show command", async () => {
    const tool = createReviewDiffTool(SAMPLE_INLINE_DIFF);
    const result = await /** @type {any} */ (tool.execute)("test-2", { command: "show", path: "src/a.js" });
    assertStringIncludes(result.content[0].text, "new line");
    assertEquals(result.details.command, "show");
    assertEquals(result.details.path, "src/a.js");
});

test("review_diff tool reports error for missing path in show", async () => {
    const tool = createReviewDiffTool(SAMPLE_INLINE_DIFF);
    const result = await /** @type {any} */ (tool.execute)("test-3", { command: "show" });
    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "required");
});

test("review_diff tool reports error for unknown command", async () => {
    const tool = createReviewDiffTool(SAMPLE_INLINE_DIFF);
    const result = await /** @type {any} */ (tool.execute)("test-4", { command: "unknown" });
    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "unknown command");
});

test("review_diff tool reports not-found for nonexistent file", async () => {
    const tool = createReviewDiffTool(SAMPLE_INLINE_DIFF);
    const result = await /** @type {any} */ (tool.execute)("test-5", { command: "show", path: "nonexistent.js" });
    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "not found");
});

test("review_diff tool returns no-files message for empty diff", async () => {
    const tool = createReviewDiffTool("");
    const result = await /** @type {any} */ (tool.execute)("test-6", { command: "list" });
    assertEquals(result.details.fileCount, 0);
    assertStringIncludes(result.content[0].text, "No changed files");
});

// ─── Large-diff / error-handling integration tests ──────────────────────────
