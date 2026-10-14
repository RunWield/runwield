import { test } from "node:test";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { getDiffCoverage, getFileDiff, parseDiffFiles } from "./review-diff.ts";
import { type ReviewDiffSize, type ReviewDiffSpan, ReviewInspection } from "./review-inspection.ts";

interface UnreadDiffSpan extends ReviewDiffSpan {
    byteLength: number;
}

const DIFF = "diff --git a/a b/a\n@@ -1 +1 @@\n-x\n+😀\n";
const FILES: ReviewDiffSize[] = [{ scope: "repair", path: "a", byteLength: 40 }];
const SPAN: ReviewDiffSpan = { scope: "repair", path: "a", start: 0, end: 40 };

test("recorded inspection matches live pages for unread bytes and correction text", () => {
    const entries = parseDiffFiles(DIFF);
    const live = new ReviewInspection(FILES);
    const spans: ReviewDiffSpan[] = [];
    // Out-of-order and repeated reads must merge just as they do live.
    for (const options of [{ offsetBytes: 37, maxBytes: 1 }, { offsetBytes: 37, maxBytes: 1 }, { maxBytes: 10 }]) {
        const page = getFileDiff(entries, "a", options);
        if (!page.found) throw new Error(page.message);
        const span = getDiffCoverage(page, "repair");
        if (!span) throw new Error("Expected coverage");
        spans.push(span);
        live.record(span.scope, span.path, span.start, span.end);
    }
    const rebuilt = ReviewInspection.fromRecorded(FILES, "repair", spans);
    const expectedUnread: UnreadDiffSpan[] = [
        { scope: "repair", path: "a", byteLength: 40, start: 10, end: 35 },
        { scope: "repair", path: "a", byteLength: 40, start: 39, end: 40 },
    ];
    assertEquals(rebuilt.unread(), expectedUnread);
    assertEquals(rebuilt.unread(), live.unread());
    assertEquals(rebuilt.feedback(), live.feedback());
    assertEquals(
        rebuilt.feedback(),
        "Review is incomplete. Read every remaining diff chunk before approving or rejecting. Keep findings already collected.\n" +
            'a (repair), unread bytes 10–34: review_diff({"command":"show","scope":"repair","path":"a","offsetBytes":10,"maxBytes":256})\n' +
            'a (repair), unread bytes 39–39: review_diff({"command":"show","scope":"repair","path":"a","offsetBytes":39,"maxBytes":256})\n' +
            "After reading these chunks, call review_complete again. Listing files does not count as reading them.",
    );
});

test("recorded full coverage accepts overlaps and leaves no feedback", () => {
    const inspection = ReviewInspection.fromRecorded(FILES, "repair", [
        { ...SPAN, start: 20 },
        { ...SPAN, end: 25 },
        { ...SPAN, start: 20, end: 25 },
        { ...SPAN, start: 40 },
    ]);
    assertEquals(inspection.unread(), []);
    assertEquals(inspection.feedback(), "");
    assertEquals(ReviewInspection.fromRecorded([], "full", []).unread(), []);
});

test("empty recorded coverage does not satisfy inspection", () => {
    const inspection = ReviewInspection.fromRecorded(FILES, "repair", []);
    const expectedUnread = [{ ...SPAN, byteLength: 40 }];
    assertEquals(inspection.unread(), expectedUnread);
});

test("recorded coverage rejects another scope even if that scope exists in the diff", () => {
    assertThrows(
        () =>
            ReviewInspection.fromRecorded([...FILES, { ...FILES[0], scope: "full" }], "repair", [
                {
                    ...SPAN,
                    scope: "full",
                },
            ]),
        Error,
        "Invalid review coverage scope: full; required repair.",
    );
});

test("recorded coverage requires exact diff paths, not suffixes or other files", () => {
    for (const path of ["missing", "../a", "", "b"]) {
        assertThrows(
            () => ReviewInspection.fromRecorded(FILES, "repair", [{ ...SPAN, path }]),
            Error,
            "Invalid review coverage path:",
        );
    }
    assertThrows(
        () => ReviewInspection.fromRecorded([{ ...FILES[0], path: "src/a" }], "repair", [SPAN]),
        Error,
        "Invalid review coverage path: a.",
    );
});

const BAD_RANGES: [string, number, number][] = [
    ["negative start", -1, 40],
    ["negative end", 0, -1],
    ["reversed", 20, 10],
    ["beyond actual diff", 0, 41],
    ["start beyond EOF", 41, 41],
    ["fractional start", 0.5, 40],
    ["fractional end", 0, 39.5],
    ["NaN", NaN, 40],
    ["infinite", 0, Infinity],
    ["unsafe integer", 0, Number.MAX_SAFE_INTEGER + 1],
];
for (const [label, start, end] of BAD_RANGES) {
    test(`recorded coverage rejects ${label}`, () => {
        assertThrows(
            () => ReviewInspection.fromRecorded(FILES, "repair", [{ ...SPAN, start, end }]),
            Error,
            "Invalid review coverage range for a:",
        );
    });
}
