import { test } from "node:test";
import { readFile as fsReadFile } from "node:fs/promises";
import { assertFalse, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";

test("Code Review styles inherited annotation modals with CSS only", async () => {
    const surface = await fsReadFile(new URL("./react/CodeReviewSurface.tsx", import.meta.url), "utf8");
    const workspaceStyles = (await fsReadFile(new URL("./react/plannotator.css", import.meta.url), "utf8"))
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(");
    const designSystemStyles = await fsReadFile(new URL("../design-system/components.css", import.meta.url), "utf8");

    await assertRejects(
        () => fsReadFile(new URL("./react/RunWieldCodeAnnotationPopoverAdapter.tsx", import.meta.url), "utf8"),
        Error,
        "ENOENT",
    );

    assertFalse(surface.includes("RunWieldCodeAnnotationPopoverAdapter"));
    assertFalse(workspaceStyles.includes("MutationObserver"));
    assertFalse(workspaceStyles.includes("rw-code-suggestion-dialog"));
    assertFalse(workspaceStyles.includes("rw-code-suggestion-input"));

    assertStringIncludes(workspaceStyles, ".review-toolbar .review-toolbar-btn.primary");
    assertStringIncludes(workspaceStyles, ".rw-code-review button.review-toolbar-btn.primary");
    assertStringIncludes(workspaceStyles, '.fixed.inset-0[class*="z-"] button.review-toolbar-btn.primary');
    assertStringIncludes(workspaceStyles, "min-height: 2.25rem !important;");
    assertStringIncludes(workspaceStyles, "border-radius: var(--rw-radius-control) !important;");
    assertStringIncludes(workspaceStyles, "background: color-mix(in srgb, var(--primary, var(--rw-accent)) 84%");
    assertStringIncludes(
        workspaceStyles,
        "transition: border-color 150ms ease, background-color 150ms ease, color 150ms ease, opacity 150ms ease !important;",
    );
    assertStringIncludes(workspaceStyles, ".review-toolbar .review-toolbar-btn.primary:hover:not(:disabled)");
    assertStringIncludes(workspaceStyles, ".review-toolbar .review-toolbar-btn.primary:focus-visible");
    assertStringIncludes(workspaceStyles, ".review-toolbar .review-toolbar-btn.primary:disabled");
    assertStringIncludes(
        workspaceStyles,
        "outline: 2px solid color-mix(in srgb, var(--primary, var(--rw-accent)) 70%, transparent) !important;",
    );

    assertStringIncludes(workspaceStyles, ".review-toolbar textarea.suggested-code-input");
    assertStringIncludes(workspaceStyles, "min-height: 4.5rem !important;");
    assertStringIncludes(workspaceStyles, "border: 0 !important;");
    assertStringIncludes(workspaceStyles, "border-radius: 0.5rem !important;");
    assertStringIncludes(workspaceStyles, "padding: 0.5rem 0.75rem !important;");
    assertStringIncludes(workspaceStyles, "background: var(--muted, var(--rw-surface-raised)) !important;");
    assertStringIncludes(workspaceStyles, "font-size: 0.75rem !important;");
    assertStringIncludes(workspaceStyles, "line-height: 1.5rem !important;");
    assertStringIncludes(workspaceStyles, "resize: vertical !important;");
    assertStringIncludes(workspaceStyles, ".review-toolbar textarea.suggested-code-input:focus");
    assertStringIncludes(workspaceStyles, ".fixed.inset-0.z-\\[2000\\] textarea.suggested-code-input");

    assertStringIncludes(workspaceStyles, ".rw-code-review .review-comment-header");
    assertStringIncludes(workspaceStyles, "font-size: 0.6875rem !important;");
    assertStringIncludes(workspaceStyles, "white-space: nowrap !important;");
    assertStringIncludes(workspaceStyles, ".rw-code-review .review-comment-body");
    assertStringIncludes(workspaceStyles, "font-size: 0.8125rem !important;");
    assertStringIncludes(workspaceStyles, "overflow-wrap: anywhere !important;");
    assertStringIncludes(workspaceStyles, ".rw-code-review .suggestion-block-header");
    assertStringIncludes(workspaceStyles, ".rw-code-review .suggestion-block-code,");
    assertStringIncludes(workspaceStyles, ".rw-code-review .suggestion-diff");
    assertStringIncludes(workspaceStyles, "overflow-x: auto !important;");
    assertStringIncludes(workspaceStyles, ".rw-code-review .suggestion-diff-content");
    assertStringIncludes(workspaceStyles, "white-space: pre !important;");

    assertStringIncludes(
        workspaceStyles,
        ".fixed.inset-0.z-\\[2000\\] > .relative:has(.suggestion-modal-original):has(.suggested-code-input)",
    );
    assertStringIncludes(workspaceStyles, "width: min(72rem, 96vw) !important;");
    assertStringIncludes(workspaceStyles, "height: min(52rem, calc(100vh - 3rem)) !important;");
    assertStringIncludes(workspaceStyles, "max-height: calc(100vh - 3rem) !important;");
    assertStringIncludes(workspaceStyles, "overflow: hidden !important;");
    assertStringIncludes(workspaceStyles, "> .flex.flex-1.min-h-0.flex-col > .flex-1");
    assertStringIncludes(workspaceStyles, ".suggestion-modal-original,");
    assertStringIncludes(workspaceStyles, ".suggested-code-input.flex-1");
    assertStringIncludes(workspaceStyles, "min-height: 0 !important;");
    assertStringIncludes(workspaceStyles, "overflow: auto !important;");

    assertStringIncludes(designSystemStyles, ".rw-modal-primary-button");
    assertStringIncludes(designSystemStyles, ".rw-modal-submit-hint");
    assertStringIncludes(designSystemStyles, ".rw-modal-textarea");
});
