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

const packagePayload = {
    documentRevision: "package-revision",
    planId: "overview",
    planName: "sequence",
    linkedFiles: {
        "context.md": "# Canonical overview\n\nHome context prose.\n",
        "validation.md": "# Validation\n\n[Context](context.md)\n",
    },
};

test("package review preserves Sequence tabs and grouped decisions after reading evidence", async () => {
    await withReview(
        async ({ browser, container, button, submitted }) => {
            const tab = () =>
                container.querySelector('[role="tab"][data-value="child"]') ||
                [...container.querySelectorAll('[role="tab"]')].find((node) => node.textContent.includes("Child Plan"));
            assertEquals(Boolean(tab()), true);
            await act(() => tab().focus());
            assertStringIncludes(container.querySelector('[role="tabpanel"]:not([hidden])').textContent, "Child body");
            assertStringIncludes(container.textContent, "Sequence and 1 Plans");
            const select = container.querySelector("#review-document");
            await act(() => {
                select.value = "validation.md";
                select.dispatchEvent(new browser.Event("change", { bubbles: true }));
            });
            await act(() => {
                select.value = "context.md";
                select.dispatchEvent(new browser.Event("change", { bubbles: true }));
            });
            assertEquals(tab().getAttribute("aria-selected"), "true");
            assertEquals(Boolean(button("Approve & Execute")), true);
            await act(() => button("Approve & Execute").click());
            assertEquals(
                submitted[0].documents.map((document) => document.planId),
                ["overview", "child"],
            );
        },
        packagePayload.linkedFiles["context.md"],
        {
            ...packagePayload,
            sequenceDocuments: [
                {
                    planId: "overview",
                    planName: "sequence",
                    plan: packagePayload.linkedFiles["context.md"],
                    frontmatter: { classification: "PROJECT" },
                },
                {
                    planId: "child",
                    planName: "sequence/child",
                    plan: "# Child Plan\n\nChild body\n",
                    frontmatter: { classification: "PLANNED_CHANGE" },
                },
            ],
        },
    );
});

test("package evidence links open canonical context in the shared reader without navigation", async () => {
    const nativeFetch = globalThis.fetch;
    await withReview(
        async ({ browser, container }) => {
            const select = container.querySelector("#review-document");
            await act(() => {
                select.value = "validation.md";
                select.dispatchEvent(new browser.Event("change", { bubbles: true }));
            });
            const fallbackFetch = globalThis.fetch;
            globalThis.fetch = (url, options) =>
                String(url).startsWith("data:") ? nativeFetch(url, options) : fallbackFetch(url, options);
            const link = [...container.querySelectorAll("a")].find(
                (node) => !node.closest("[hidden]") && node.textContent === "Context",
            );
            await act(async () => {
                link.click();
                await new Promise((resolve) => setTimeout(resolve, 50));
            });
            assertStringIncludes(
                [...browser.document.querySelectorAll("diffs-container")]
                    .map((node) => node.shadowRoot?.textContent || "")
                    .join(""),
                "Home context prose.",
            );
            assertEquals(browser.location.pathname, "/review");
        },
        packagePayload.linkedFiles["context.md"],
        packagePayload,
    );
});
