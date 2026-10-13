import { versions } from "node:process";
import { mkdir as fsMkdir, readFile as fsReadFile, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { readWorkspaceStyles } from "./workspace-styles.ts";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { workspaceMetadata as _workspaceMetadata } from "./server/plan-adapter.js";

import { createWorkspaceApp } from "./server.js";

import {
    buildRemoteCommentPayload,
    normalizeRemoteCommentPayload,
    remoteCommentToPlannotatorAnnotation,
} from "./react/remote-review-payload.js";
import { RemoteCommentStateList } from "./react/RemoteCommentStateList.tsx";

test("remote review legacy anchors stay in Plannotator sidebar without fallback highlighting metadata", () => {
    const annotation = remoteCommentToPlannotatorAnnotation({
        id: "legacy-comment",
        resolved: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "comment",
        displayName: "Alice",
        body: "Legacy comment body",
        originalText: "duplicate text",
        anchor: { blockId: "legacy-block", startOffset: 7, endOffset: 21 },
        anchorMissing: true,
        unreadable: false,
    });

    assertEquals(annotation.blockId, "__missing_legacy_anchor_legacy-comment");
    assertEquals(annotation.startMeta, undefined);
    assertEquals(annotation.endMeta, undefined);
    assertEquals(annotation.text, "Legacy comment body");
});

test("remote review Plannotator sidebar does not expose delete controls", async () => {
    const panelSource = await fsReadFile(new URL("./react/RemoteCommentPanel.tsx", import.meta.url), "utf8");
    const plannotatorCss = await fsReadFile(new URL("./react/plannotator.css", import.meta.url), "utf8");
    const workspaceCss = await readWorkspaceStyles(new URL("./static/workspace.css", import.meta.url));
    const reviewSource = await fsReadFile(new URL("./react/RemotePlanReview.tsx", import.meta.url), "utf8");

    assertEquals(panelSource.includes("onDelete={(id) => onResolve(id)}"), false);
    assertStringIncludes(panelSource, "onDelete={() => {}}");
    assertStringIncludes(plannotatorCss, '.rw-remote-annotation-panel [title="Delete annotation"]');
    assertStringIncludes(plannotatorCss, "display: none !important");
    assertStringIncludes(workspaceCss, '.rw-remote-annotation-panel [title="Delete annotation"]');
    assertEquals(reviewSource.includes("RemoteLegacyAnchors"), false);
    assertEquals(reviewSource.includes("applyLegacyAnchorHighlights"), false);
    assertEquals(reviewSource.includes("updateSharedSpaceLifecycle"), false);
    assertStringIncludes(reviewSource, "const metadata = await client.getSharedSpace(spaceId);");
    assertStringIncludes(reviewSource, "setSpace(normalizeSpace(metadata));");
    assertEquals(reviewSource.includes('action: "delete"'), false);
    assertEquals(/unshare/i.test(reviewSource), false);
});

test("remote review comment panel renders closed read-only controls and revision-scoped comments", () => {
    const revisionOneComment = {
        id: "comment-rev-1",
        resolved: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "comment",
        displayName: "Alice",
        body: "Revision one only",
        originalText: "Selected text",
        anchor: { blockId: "block-1", startOffset: 0, endOffset: 13 },
        anchorMissing: false,
        unreadable: false,
    };
    const revisionTwoComment = {
        ...revisionOneComment,
        id: "comment-rev-2",
        body: "Revision two only",
    };
    const closedMarkup = renderToStaticMarkup(
        React.createElement(RemoteCommentStateList, {
            comments: /** @type {any} */ ([revisionOneComment]),
            selectedId: "comment-rev-1",
            closed: true,
            pendingId: null,
            onSelect: () => {},
            onResolve: () => {},
            onReopen: () => {},
        }),
    );
    assertStringIncludes(closedMarkup, "Comments remain readable, but updates are disabled");
    assertStringIncludes(closedMarkup, "Open");
    assertStringIncludes(closedMarkup, "disabled");
    assertEquals(closedMarkup.includes("Revision one only"), false);
    assertEquals(closedMarkup.includes("Revision two only"), false);

    const revisionTwoMarkup = renderToStaticMarkup(
        React.createElement(RemoteCommentStateList, {
            comments: /** @type {any} */ ([revisionTwoComment]),
            selectedId: "comment-rev-2",
            closed: false,
            pendingId: null,
            onSelect: () => {},
            onResolve: () => {},
            onReopen: () => {},
        }),
    );
    assertStringIncludes(revisionTwoMarkup, "Resolve");
    assertEquals(revisionTwoMarkup.includes("Revision two only"), false);
    assertEquals(revisionTwoMarkup.includes("Revision one only"), false);
});

test("remote review comment panel renders tampered and missing-anchor placeholders", () => {
    const unreadableComment = {
        id: "unreadable-comment",
        resolved: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "global_comment",
        displayName: "",
        body: "",
        originalText: "",
        anchor: null,
        anchorMissing: false,
        unreadable: true,
    };
    const missingAnchorComment = {
        id: "missing-anchor-comment",
        resolved: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "comment",
        displayName: "Bob",
        body: "Anchor is gone",
        originalText: "Gone text",
        anchor: { blockId: "block-missing", startOffset: 0, endOffset: 9 },
        anchorMissing: true,
        unreadable: false,
    };
    const unreadableMarkup = renderToStaticMarkup(
        React.createElement(RemoteCommentStateList, {
            comments: /** @type {any} */ ([unreadableComment, missingAnchorComment]),
            selectedId: "unreadable-comment",
            closed: false,
            pendingId: null,
            onSelect: () => {},
            onResolve: () => {},
            onReopen: () => {},
        }),
    );
    assertStringIncludes(unreadableMarkup, "This comment could not be decrypted");

    const missingAnchorMarkup = renderToStaticMarkup(
        React.createElement(RemoteCommentStateList, {
            comments: /** @type {any} */ ([unreadableComment, missingAnchorComment]),
            selectedId: "missing-anchor-comment",
            closed: false,
            pendingId: null,
            onSelect: () => {},
            onResolve: () => {},
            onReopen: () => {},
        }),
    );
    assertStringIncludes(missingAnchorMarkup, "Anchor not found in this revision");
    assertEquals(missingAnchorMarkup.includes("Anchor is gone"), false);
});

test("remote review comment payload helper keeps semantic fields inside encrypted body shape", () => {
    const payload = buildRemoteCommentPayload({
        displayName: "Alice",
        body: "Please clarify this paragraph.",
        selection: {
            blockId: "b-2",
            startOffset: 5,
            endOffset: 18,
            originalText: "selected text",
            prefix: "some ",
            suffix: " after",
            startMeta: { parentTagName: "P", parentIndex: 0, textOffset: 5 },
            endMeta: { parentTagName: "P", parentIndex: 0, textOffset: 18 },
        },
    });
    assertEquals(payload.schemaVersion, 1);
    assertEquals(payload.type, "comment");
    assertEquals(payload.displayName, "Alice");
    assertEquals(payload.originalText, "selected text");
    assertEquals(payload.anchor?.blockId, "b-2");
    assertEquals(payload.anchor?.startOffset, 5);

    const normalized = normalizeRemoteCommentPayload(payload);
    assertEquals(normalized.body, "Please clarify this paragraph.");
    assertEquals(normalized.anchor?.suffix, " after");
    assertEquals(normalized.anchor?.startMeta?.parentTagName, "P");

    const annotationPayload = buildRemoteCommentPayload({
        displayName: "Bob",
        annotation: {
            id: "ann-1",
            blockId: "block-1",
            startOffset: 2,
            endOffset: 8,
            type: "COMMENT",
            text: "Annotation body",
            originalText: "target",
            createdA: Date.parse("2026-01-01T00:00:00.000Z"),
            startMeta: { parentTagName: "P", parentIndex: 0, textOffset: 2 },
            endMeta: { parentTagName: "P", parentIndex: 0, textOffset: 8 },
        },
    });
    assertEquals(annotationPayload.body, "Annotation body");
    assertEquals(annotationPayload.anchor?.endMeta?.textOffset, 8);
});

test("remote review payload helper maps encrypted comments to Plannotator annotations", () => {
    const annotation = remoteCommentToPlannotatorAnnotation({
        id: "comment-1",
        resolved: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "comment",
        displayName: "Alice",
        body: "Looks good",
        originalText: "selected text",
        anchor: {
            blockId: "block-1",
            startOffset: 4,
            endOffset: 17,
            startMeta: { parentTagName: "P", parentIndex: 0, textOffset: 4 },
            endMeta: { parentTagName: "P", parentIndex: 0, textOffset: 17 },
        },
    });
    assertEquals(annotation.type, "COMMENT");
    assertEquals(annotation.author, "Alice");
    assertEquals(annotation.text, "Looks good");
    assertEquals(/** @type {{ textOffset: number }} */ (annotation.startMeta).textOffset, 4);
});

test("remote review comment payload helper rejects tampered or unsupported payloads", () => {
    for (
        const value of [
            null,
            { schemaVersion: 2, type: "comment", displayName: "Alice", body: "Body", originalText: "x", anchor: {} },
            { schemaVersion: 1, type: "comment", displayName: "Alice", body: "Body", originalText: "x", anchor: null },
            { schemaVersion: 1, type: "global_comment", displayName: "", body: "Body", originalText: "", anchor: null },
        ]
    ) {
        let failed = false;
        try {
            normalizeRemoteCommentPayload(value);
        } catch {
            failed = true;
        }
        assertEquals(failed, true);
    }
});

test("remote Workspace wrapper serves built Astro client assets", async () => {
    const assetDir = new URL(
        `../../../dist/${versions.bun ? "workspace-bun" : "workspace"}/client/_astro/`,
        import.meta.url,
    );
    const assetPath = new URL("remote-review-test.js", assetDir);
    await fsMkdir(assetDir, { recursive: true });
    await fsWriteFile(assetPath, "console.log('remote review asset');");
    try {
        const app = createWorkspaceApp({ mode: "remote" }).handler();
        const response = await app(new Request("http://localhost/_astro/remote-review-test.js"));
        assertEquals(response.status, 200);
        assertEquals(response.headers.get("content-type"), "text/javascript; charset=utf-8");
        assertEquals(await response.text(), "console.log('remote review asset');");
    } finally {
        await fsRm(assetPath).catch(() => {});
    }
});
