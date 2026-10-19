import { test } from "node:test";
import { assertEquals } from "../../testing/assertions.ts";
import {
    formatChangedFileList,
    getDiffCoverage,
    getFileDiff,
    listDiffFiles,
    parseDiffFiles,
    readReviewDiff,
    summarizeDiffForReview,
} from "./review-diff.ts";

// Literal contract values captured from review-diff-tool.js before extraction.
const DIFF = "diff --git a/a b/a\n@@ -1 +1 @@\n-x\n+😀\n";

test("diff parsing pins byte sizes and changed-line counts", () => {
    assertEquals(parseDiffFiles(DIFF), [
        {
            path: "a",
            changeType: "modified",
            byteLength: 40,
            lineCount: 5,
            hunkLines: { added: 1, removed: 1 },
            text: DIFF,
        },
    ]);
    assertEquals(parseDiffFiles("not a diff"), []);
});

test("diff listing pins truncation and summary text", () => {
    const entries = parseDiffFiles(DIFF);
    assertEquals(listDiffFiles(entries, 39), [
        {
            path: "a",
            changeType: "modified",
            byteLength: 40,
            lineCount: 5,
            hunkLines: { added: 1, removed: 1 },
            truncated: true,
            maxInlineBytes: 39,
        },
    ]);
    assertEquals(listDiffFiles(entries, 40)[0].maxInlineBytes, null);
    assertEquals(listDiffFiles(entries, 40)[0].truncated, false);
    assertEquals(
        formatChangedFileList(entries),
        "**Total:** 1 file(s), 40 B diff, 1 added, 1 removed lines.\n\n  Modified: a — 1 added, 1 removed (40 B)",
    );
    assertEquals(summarizeDiffForReview(entries), {
        changedFiles: 1,
        changedLines: 2,
        addedLines: 1,
        removedLines: 1,
        meaningfulAreas: ["a"],
        lowSignalOnly: false,
        paths: ["a"],
    });
});

test("byte pages do not split UTF-8 and coverage uses returned bounds", () => {
    const entries = parseDiffFiles(DIFF);
    const first = getFileDiff(entries, "a", { maxBytes: 37 });
    if (!first.found) throw new Error(first.message);
    assertEquals(
        [first.content, first.offsetBytes, first.nextOffsetBytes, first.remainingBytes, first.truncated],
        ["diff --git a/a b/a\n@@ -1 +1 @@\n-x\n+", 0, 35, 5, true],
    );
    assertEquals(getDiffCoverage(first, "full"), { scope: "full", path: "a", start: 0, end: 35 });
    const second = getFileDiff(entries, "a", { offsetBytes: 37, maxBytes: 1 });
    if (!second.found) throw new Error(second.message);
    assertEquals(
        [second.content, second.offsetBytes, second.nextOffsetBytes, second.remainingBytes],
        ["😀", 35, 39, 1],
    );
    assertEquals(getDiffCoverage(second, "repair"), { scope: "repair", path: "a", start: 35, end: 39 });
    const eof = getFileDiff(entries, "a", { offsetBytes: 99 });
    if (!eof.found) throw new Error(eof.message);
    assertEquals(
        [eof.content, eof.offsetBytes, eof.nextOffsetBytes, eof.truncated, eof.remainingBytes],
        ["", 40, 40, false, 0],
    );
    assertEquals(getDiffCoverage(eof, "full"), undefined);
});

test("diff paths decode quoted UTF-8 and suffix reads record canonical identity", () => {
    const diff = 'diff --git "a/src/\\303\\251.js" "b/src/\\303\\251.js"\n+ok\n';
    const entries = parseDiffFiles(diff);
    assertEquals(entries[0].path, "src/é.js");
    const page = getFileDiff(entries, "é.js");
    if (!page.found) throw new Error(page.message);
    assertEquals(getDiffCoverage(page, "full")?.path, "src/é.js");
    assertEquals(getFileDiff(entries, "missing"), {
        found: false,
        message: 'File "missing" not found in diff. Use "list" to see available files.',
    });
});

test("pure diff operations preserve absent repair scope and list is not coverage", () => {
    assertEquals(readReviewDiff({ full: DIFF }, { command: "show", scope: "repair", path: "a" }), {
        text: "No repair scope in this round: nothing has been repaired yet, so there is no repair diff to inspect. Use scope 'full'.",
        details: { command: "show", scope: "repair", available: false },
    });
    const listing = readReviewDiff(DIFF, { command: "list" });
    assertEquals(listing.coverage, undefined);
    assertEquals(listing.details, { command: "list", scope: "full", fileCount: 1 });
    assertEquals(readReviewDiff(DIFF, { command: "show", path: "a" }).coverage, {
        scope: "full",
        path: "a",
        start: 0,
        end: 40,
    });
});

test("default byte page is bounded to 64KiB", () => {
    const page = getFileDiff(parseDiffFiles(DIFF + "z".repeat(65536)), "a");
    if (!page.found) throw new Error(page.message);
    assertEquals([page.offsetBytes, page.nextOffsetBytes, page.remainingBytes, page.truncated], [0, 65536, 40, true]);
});
