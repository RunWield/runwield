// @ts-nocheck: Browser tests install happy-dom globals around the real review surface.
import { test } from "node:test";
import { act } from "react";
import { assertEquals, assertStringIncludes } from "../../../testing/assertions.ts";
import { withReview } from "./plan-review-test-dom.tsx";

const plan =
    "---\nclassification: FEATURE\nsummary: Display metadata\n---\n\n# Review display\n\nKeep the Plan body visible.\n";

test("Plan Review starts wide with hidden front matter and can show and hide it", async () => {
    await withReview(async ({ container, button }) => {
        const article = () => container.querySelector('article[data-print-region="article"]');
        assertEquals(container.querySelector("[data-plan-width]").dataset.planWidth, "wide");
        assertStringIncludes(article().textContent, "Keep the Plan body visible.");
        assertEquals(article().textContent.includes("Display metadata"), false);
        assertEquals(button("Show front matter").getAttribute("aria-expanded"), "false");
        assertEquals(button("Show front matter").classList.contains("rw-review-toolbar-trigger"), true);
        assertEquals(Boolean(button("Show front matter").querySelector('svg[aria-hidden="true"]')), true);
        await act(() => button("Show front matter").click());
        assertStringIncludes(article().textContent, "Display metadata");
        assertEquals(button("Hide front matter").getAttribute("aria-expanded"), "true");
        await act(() => button("Hide front matter").click());
        assertEquals(article().textContent.includes("Display metadata"), false);
        assertStringIncludes(article().textContent, "Keep the Plan body visible.");
    }, plan);
});

test("Edit keeps front matter available while its View card is hidden", async () => {
    await withReview(async ({ container, button }) => {
        await act(() => button("Edit").click());
        assertEquals(button("Show front matter"), undefined);
        const editor = container.querySelector('[role="textbox"]');
        assertStringIncludes(editor.textContent, "classification");
        assertStringIncludes(editor.textContent, "FEATURE");
        assertStringIncludes(editor.textContent, "Display metadata");
    }, plan);
});

test("Plan Review has no front matter control when the Plan has none", async () => {
    await withReview(({ container, button }) => {
        assertEquals(button("Show front matter"), undefined);
        assertEquals(button("Hide front matter"), undefined);
        assertStringIncludes(container.textContent, "Body without metadata.");
    }, "# Review display\n\nBody without metadata.\n");
});
