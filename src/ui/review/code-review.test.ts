import { mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { formatCodeReviewAnnotations, normalizeCodeReviewDecision, runCodeReview } from "./code-review.ts";
import type { BrowserPort } from "../../shared/browser-port.ts";
import { createScriptedReviewBrowser } from "./review-test-fixture.ts";

test("normalizeCodeReviewDecision handles approvals, annotations, and cancellation", () => {
    assertEquals(
        normalizeCodeReviewDecision({
            approved: true,
            feedback: "ship it",
            annotations: [{ file: "src/a.js", line: 3, text: "nice" }],
        }),
        {
            approved: true,
            feedback: "ship it",
            annotations: [{ file: "src/a.js", line: 3, text: "nice" }],
            exit: false,
            canceled: false,
        },
    );
    assertEquals(normalizeCodeReviewDecision({ canceled: true }), {
        approved: false,
        feedback: "",
        annotations: [],
        exit: true,
        canceled: true,
    });
    assertEquals(
        normalizeCodeReviewDecision({
            approved: false,
            feedback: "Revise this.",
            annotations: [],
            conversationTurn: true,
        }),
        {
            approved: false,
            feedback: "Revise this.",
            annotations: [],
            exit: false,
            canceled: false,
            conversationTurn: true,
        },
    );
});

test("formatCodeReviewAnnotations renders file, line, and text", () => {
    assertEquals(
        formatCodeReviewAnnotations([
            { file: "src/a.js", line: 12, text: "Rename this." },
            { path: "src/b.js", comment: "Missing test." },
        ]),
        "1. src/a.js:12\nRename this.\n\n2. src/b.js\nMissing test.",
    );
});

test("runCodeReview serves the real review surface and loads submitted image bytes", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-code-review-"));
    const imagePath = join(projectRoot, "review.png");
    await fsWriteFile(imagePath, new Uint8Array([137, 80, 78, 71]));
    const scriptedBrowser = createScriptedReviewBrowser("feedback", {
        approved: false,
        feedback: "Use the attached reference.",
        annotations: [
            {
                filePath: "src/a.js",
                lineStart: 1,
                text: "Compare with the fixture.",
                images: [{ path: imagePath, name: "review" }],
            },
        ],
    });
    try {
        let reviewUrl = "";
        const result = await runCodeReview({
            planName: "image-review-plan",
            diffText: "diff --git a/src/a.js b/src/a.js\n+change",
            executionCwd: projectRoot,
            browser: scriptedBrowser.browser,
            onSurfaceReady: (surface) => (reviewUrl = surface.url),
        });

        assertEquals(result.feedback, "Use the attached reference.");
        assertEquals(result.images, [{ base64: "iVBORw==", mimeType: "image/png", name: "review" }]);
        assertEquals(scriptedBrowser.urls.length, 1);
        assertStringIncludes(scriptedBrowser.urls[0], "/review/code?token=");
        assertEquals(reviewUrl, scriptedBrowser.urls[0]);
    } finally {
        await fsRm(projectRoot, { recursive: true });
    }
});

test("runCodeReview cancellation stops the real review server", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-code-review-cancel-"));
    const controller = new AbortController();
    let markOpened: () => void = () => {};
    const opened = new Promise<void>((resolveOpened) => (markOpened = resolveOpened));
    const browser: BrowserPort = {
        open: (_url: string) => {
            markOpened();
            return Promise.resolve(true);
        },
    };
    try {
        const pending = runCodeReview({
            planName: "cancel-review",
            diffText: "diff",
            executionCwd: projectRoot,
            signal: controller.signal,
            browser,
        });
        await opened;
        controller.abort();

        assertEquals(await pending, {
            approved: false,
            feedback: "",
            annotations: [],
            exit: true,
            canceled: true,
        });
    } finally {
        await fsRm(projectRoot, { recursive: true });
    }
});

test("standalone actions survive normalization even without feedback or approval", () => {
    for (const reviewAction of ["post_comments", "approve_pr", "approve_commit"]) {
        const decision = normalizeCodeReviewDecision({ reviewAction });
        assertEquals(decision.reviewAction, reviewAction);
        assertEquals(decision.exit, false);
    }
    assertEquals(normalizeCodeReviewDecision({ reviewAction: "request_changes" }).reviewAction, undefined);
});
