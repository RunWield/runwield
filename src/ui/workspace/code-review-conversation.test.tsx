// @ts-nocheck: browser tests install happy-dom globals around the real React surface.
import { importTestBundle } from "../../testing/import-test-bundle.ts";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { Window } from "happy-dom";
import { act } from "react";
import { build, stop } from "esbuild";
import { fileURLToPath } from "node:url";

const requireBanner = `import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const nodeRequire = createRequire(${JSON.stringify(import.meta.url)});
const require = (id) => nodeRequire(id.startsWith("file:") ? fileURLToPath(id) : id);`;

async function withCodeReview(verify, overrides = {}) {
    const bundle = await build({
        entryPoints: [fileURLToPath(new URL("./react/CodeReviewSurface.tsx", import.meta.url))],
        banner: {
            js: requireBanner,
        },
        define: { "import.meta.env": "{}" },
        bundle: true,
        write: false,
        format: "esm",
        jsx: "automatic",
        loader: { ".css": "empty", ".png": "dataurl" },
        alias: {
            "@plannotator/shared": fileURLToPath(
                new URL("../../../third_party/plannotator/packages/shared", import.meta.url),
            ),
            "@plannotator/core": fileURLToPath(
                new URL("../../../third_party/plannotator/packages/core", import.meta.url),
            ),
            "@plannotator/ui": fileURLToPath(new URL("../../../third_party/plannotator/packages/ui", import.meta.url)),
            "@plannotator/guide-viewer": fileURLToPath(
                new URL("../../../third_party/plannotator/packages/guide-viewer", import.meta.url),
            ),
        },
        plugins: [
            {
                name: "shared-react",
                setup(builder) {
                    builder.onResolve({ filter: /\?worker&inline$/ }, (args) => ({
                        path: args.path,
                        namespace: "browser-worker",
                    }));
                    builder.onLoad({ filter: /.*/, namespace: "browser-worker" }, () => ({
                        contents: "export default Worker;",
                        loader: "js",
                    }));
                    builder.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (args) => ({
                        path: import.meta.resolve(args.path),
                        external: true,
                    }));
                },
            },
        ],
    });
    stop();
    const browser = new Window({ url: "http://localhost/review" });
    const names = [
        "addEventListener",
        "removeEventListener",
        "window",
        "document",
        "navigator",
        "location",
        "localStorage",
        "matchMedia",
        "getComputedStyle",
        "HTMLButtonElement",
        "HTMLInputElement",
        "HTMLTextAreaElement",
        "SVGElement",
        "CSSStyleSheet",
        "NodeFilter",
        "customElements",
        "HTMLElement",
        "Element",
        "Node",
        "CustomEvent",
        "MutationObserver",
        "ResizeObserver",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "IS_REACT_ACT_ENVIRONMENT",
        "fetch",
    ];
    browser.document.fonts = new browser.EventTarget();
    const previous = new Map(names.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    let root;
    const submitted = [];
    let revision = 0;
    let heldReply;
    let releaseReply;
    let emptyPolls = 0;
    const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    try {
        for (const name of names) {
            const value =
                name === "IS_REACT_ACT_ENVIRONMENT"
                    ? true
                    : typeof browser[name] === "function"
                      ? browser[name].bind(browser)
                      : browser[name];
            Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
        }
        globalThis.fetch = (url, options) => {
            if (options?.method === "POST") {
                const body = JSON.parse(options.body);
                submitted.push({ url: String(url), ...(body.response?._meta || body) });
                revision++;
                return Promise.resolve(Response.json({ ok: true }));
            }
            if (String(url) === "/operation") {
                const response = () =>
                    Response.json({
                        status: "running",
                        events: revision
                            ? [
                                  {
                                      type: "assistant_text_delta",
                                      messageId: `reply-${revision}`,
                                      delta: "A Set removes duplicate paths.",
                                  },
                              ]
                            : [],
                        liveInteraction:
                            revision && emptyPolls-- > 0
                                ? null
                                : {
                                      interactionId: `review-${revision}`,
                                      request: {
                                          type: "code_review",
                                          codeReview: {
                                              rawPatch: (revision && overrides.revisedRawPatch) || patch,
                                              conversationEvents: [],
                                          },
                                      },
                                  },
                    });
                return revision && heldReply ? heldReply.then(response) : Promise.resolve(response());
            }
            return Promise.resolve(Response.json({ available: false, providers: [] }));
        };
        const { CodeReviewSurface } = await importTestBundle(bundle.outputFiles[0].text);
        const container = browser.document.createElement("div");
        browser.document.body.append(container);
        const { createRoot } = await import("react-dom/client");
        root = createRoot(container);
        await act(
            async () =>
                await root.render(
                    <CodeReviewSurface
                        payload={{
                            mode: "workspace",
                            token: "fixture",
                            rawPatch: patch,
                            gitRef: "old-head",
                            operationStatusUrl: "/operation",
                            interactionId: "review-0",
                            interactionAnswerUrl: "/interactions/review-0/answer",
                            interactionAnswerBaseUrl: "/interactions",
                            agentLabel: "Engineer",
                            guidedReview: { mode: "manual" },
                            guidedReviewFixture: {
                                schemaVersion: "1.0",
                                title: "Retained guide",
                                sections: [],
                                everythingElse: [],
                            },
                            ...overrides,
                        }}
                    />,
                ),
        );
        const button = (text) =>
            [...container.querySelectorAll("button")].find(
                (node) => node.textContent.trim() === text || node.getAttribute("aria-label") === text,
            );
        const enter = async (input, text) => {
            await act(() => {
                const prototype =
                    input.tagName === "INPUT"
                        ? browser.HTMLInputElement.prototype
                        : browser.HTMLTextAreaElement.prototype;
                Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, text);
                input.dispatchEvent(new browser.Event("input", { bubbles: true }));
            });
        };
        const addNote = async (text, image = false) => {
            await act(() => button("Global comment").click());
            await enter(browser.document.querySelector('textarea[placeholder="Add a global comment..."]'), text);
            if (image) {
                await act(() => browser.document.querySelector('button[aria-label="Attachments"]').click());
                const path = browser.document.querySelector('input[placeholder="Paste path or URL..."]');
                await enter(path, "/tmp/review-image.png");
                await act(() =>
                    path.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
                );
                await act(() => browser.document.querySelector('button[aria-label="Attachments"]').click());
            }
            await act(() =>
                [...browser.document.querySelectorAll("button")]
                    .find((node) => node.textContent.trim() === "Add")
                    .click(),
            );
        };
        const send = async (message = "") => {
            if (message) await enter(container.querySelector('textarea[aria-label="Message Engineer"]'), message);
            await act(() => button("Send to Engineer").click());
        };
        const holdReply = () => {
            heldReply = new Promise((resolve) => {
                releaseReply = resolve;
            });
        };
        const resumeReply = async (skipPoll = false) => {
            emptyPolls = skipPoll ? 1 : 0;
            await act(() => releaseReply());
        };
        await verify({ browser, container, button, submitted, enter, addNote, send, holdReply, resumeReply });
        await act(() => root.unmount());
        root = null;
    } finally {
        if (root) await act(() => root.unmount());
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        await browser.happyDOM.close();
    }
}

test("Code Review opens chat and has no feedback or attach action with chat enabled", async () => {
    await withCodeReview(async ({ container, button, addNote }) => {
        assertEquals(
            container.querySelector('button[role="tab"][title="Engineer"]').getAttribute("aria-selected"),
            "true",
        );
        assertEquals(Boolean(container.querySelector('textarea[aria-label="Message Engineer"]')), true);
        await addNote("Check duplicate paths");
        await act(() => container.querySelector('button[role="tab"][title="Annotations"]').click());
        assertEquals(button("Send Annotations"), undefined);
        assertEquals(container.textContent.includes("Add to Engineer chat"), false);
        assertEquals(Boolean(button("OKApprove")), true);
    });
});

test("Code Review includes queued annotations without a separate attach action", async () => {
    await withCodeReview(async ({ container, submitted, addNote, send }) => {
        await addNote("Check duplicate paths");
        assertStringIncludes(container.querySelector('[aria-label="Review Queue"]').textContent, "1 annotations");
        await send();
        assertStringIncludes(submitted[0].feedback, "Check duplicate paths");
        assertEquals(submitted[0].annotations[0].text, "Check duplicate paths");
        assertEquals(submitted[0].conversationTurn, true);
        assertStringIncludes(container.textContent, "A Set removes duplicate paths.");
        assertEquals(container.querySelector('[aria-label="Review Queue"]'), null);
        await send("Thanks");
        assertEquals(submitted[1].url, "/interactions/review-1/answer");
    });
});

test("excluding annotations affects one send and keeps the note for the next send", async () => {
    await withCodeReview(async ({ container, button, submitted, addNote, send }) => {
        await addNote("Keep this note queued");
        await act(() => button("Exclude annotations").click());
        await send("Why a Set?");
        assertEquals(submitted[0].feedback.includes("Keep this note queued"), false);
        assertEquals(submitted[0].annotations, []);
        assertEquals(Boolean(button("Exclude annotations")), true);
        await send();
        assertStringIncludes(submitted[1].feedback, "Keep this note queued");
        assertEquals(container.querySelector('[aria-label="Review Queue"]'), null);
    });
});

for (const excluded of ["annotations", "attachments", null]) {
    test(`Code Review independently queues images and notes: exclude ${excluded || "neither"}`, async () => {
        await withCodeReview(async ({ container, button, submitted, addNote, send }) => {
            await addNote("Image note", true);
            assertStringIncludes(container.querySelector('[aria-label="Review Queue"]').textContent, "1 attachments");
            if (excluded) await act(() => button(`Exclude ${excluded}`).click());
            await send("Please inspect");
            assertEquals(submitted[0].feedback.includes("Image note"), excluded !== "annotations");
            assertEquals(submitted[0].feedback.includes("/tmp/review-image.png"), excluded !== "attachments");
            assertEquals(submitted[0].annotations[0].images?.length || 0, excluded === "attachments" ? 0 : 1);
            if (excluded) {
                assertEquals(Boolean(button(`Exclude ${excluded}`)), true);
                await send();
                assertEquals(submitted[1].feedback.includes("Image note"), excluded === "annotations");
                assertEquals(submitted[1].feedback.includes("/tmp/review-image.png"), excluded === "attachments");
            }
            assertEquals(container.querySelector('[aria-label="Review Queue"]'), null);
        });
    });
}

test("Code Review keeps feedback submission when chat is disabled", async () => {
    await withCodeReview(
        async ({ button, addNote, submitted }) => {
            await addNote("No chat feedback");
            await act(() => button("Send Annotations").click());
            assertEquals(submitted[0].approved, false);
            assertEquals(submitted[0].conversationTurn, undefined);
            assertStringIncludes(submitted[0].feedback, "No chat feedback");
        },
        { operationStatusUrl: undefined, interactionAnswerBaseUrl: undefined },
    );
});

test("an unchanged reopened patch keeps viewed files and the current guide", async () => {
    await withCodeReview(async ({ container, button, send }) => {
        await act(() => container.querySelector('[role="checkbox"][aria-label="Mark as viewed"]').click());
        await act(() => button("Guided Review ready").click());
        assertStringIncludes(container.textContent, "Retained guide");
        await send("Why a Set?");
        assertStringIncludes(container.textContent, "A Set removes duplicate paths.");
        assertStringIncludes(container.textContent, "Retained guide");
        assertEquals(container.textContent.includes("Generated on a different version of this branch"), false);
        await act(() => button("Files").click());
        assertEquals(
            container.querySelector('[role="checkbox"][aria-label="Viewed — unmark"]').getAttribute("aria-checked"),
            "true",
        );
        await act(() => button("Collapse annotations sidebar").click());
        assertEquals(container.querySelector('textarea[aria-label="Message Engineer"]'), null);
        await act(() => button("Annotations").click());
        assertEquals(
            container.querySelector('button[role="tab"][title="Engineer"]').getAttribute("aria-selected"),
            "true",
        );
    });
});

test("Code Review keeps a collapsed chat closed when a delayed unchanged round reopens", async () => {
    await withCodeReview(async ({ container, button, send, submitted, holdReply, resumeReply }) => {
        holdReply();
        await send("Why a Set?");
        assertStringIncludes(container.textContent, "Engineer is reviewing");
        await act(() => button("Collapse annotations sidebar").click());
        const now = Date.now;
        try {
            // A real agent response can take hours. Elapsed wall time must not end the wait.
            Date.now = () => now() + 3_600_000;
            await resumeReply(true);
            await act(() => new Promise((resolve) => setTimeout(resolve, 850)));
        } finally {
            Date.now = now;
        }
        assertEquals(container.querySelector('textarea[aria-label="Message Engineer"]'), null);
        await act(() => button("Annotations").click());
        assertStringIncludes(container.textContent, "A Set removes duplicate paths.");
        assertEquals(container.querySelector('[role="alert"]'), null);
        assertEquals(container.querySelector('textarea[aria-label="Message Engineer"]').disabled, false);
        await send("Continue the review");
        assertEquals(submitted[1].url, "/interactions/review-1/answer");
    });
});

test("a changed reopened patch makes the retained guide stale and clears viewed files", async () => {
    await withCodeReview(
        async ({ container, button, send }) => {
            await act(() => container.querySelector('[role="checkbox"][aria-label="Mark as viewed"]').click());
            await act(() => button("Guided Review ready").click());
            await send("Change the value");
            assertStringIncludes(container.textContent, "Generated on a different version of this branch");
            await act(() => button("Files").click());
            assertEquals(
                container.querySelector('[role="checkbox"][aria-label="Mark as viewed"]').getAttribute("aria-checked"),
                "false",
            );
        },
        { revisedRawPatch: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+revised\n" },
    );
});
