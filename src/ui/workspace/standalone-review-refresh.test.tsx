// @ts-nocheck: browser tests install happy-dom globals around the real React surface.
import { importTestBundle } from "../../testing/import-test-bundle.ts";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { Window } from "happy-dom";
import { act } from "react";
import { build, stop } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDirectory } from "../../testing/temp-file.ts";

const requireBanner = `import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const nodeRequire = createRequire(${JSON.stringify(import.meta.url)});
const require = (id) => nodeRequire(id.startsWith("file:") ? fileURLToPath(id) : id);`;

test("review bundle require resolves encoded file URLs and shares React", async () => {
    const directory = await makeTempDirectory();
    try {
        const path = join(directory, "review fixture % #.cjs");
        await writeFile(path, 'module.exports = "encoded fixture";');
        const loaded = await importTestBundle(`${requireBanner}
export const fixture = require(${JSON.stringify(pathToFileURL(path).href)});
export const reactAct = require("react").act;`);
        assertEquals(loaded.fixture, "encoded fixture");
        assertEquals(loaded.reactAct, act);
    } finally {
        await rm(directory, { recursive: true });
    }
});

async function withReviewSurface(standaloneReview, verify) {
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
            if (String(url).includes("/feedback") || String(url).includes("/deny")) {
                submitted.push(JSON.parse(options.body));
                revision++;
                return Promise.resolve(Response.json({ ok: true }));
            }
            if (String(url).includes("/status")) {
                return Promise.resolve(
                    Response.json({
                        revision,
                        gitRef: revision ? "next-head" : "old-head",
                        rawPatch: patch,
                        standaloneReview: {
                            mode: "pr",
                            forge: { available: true, postEnabled: true },
                            resultMessage: "PR head changed",
                        },
                    }),
                );
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
                            mode: "standalone",
                            token: "fixture",
                            rawPatch: patch,
                            gitRef: "old-head",
                            conversationStatusUrl: "/status",
                            feedbackUrl: "/feedback",
                            denyUrl: "/deny",
                            agentLabel: "Engineer",
                            standaloneReview,
                            guidedReview: { mode: "manual" },
                            guidedReviewFixture: {
                                schemaVersion: "1.0",
                                title: "Retained guide",
                                sections: [],
                                everythingElse: [],
                            },
                        }}
                    />,
                ),
        );
        const button = (text) =>
            [...container.querySelectorAll("button")].find((node) => node.textContent.trim() === text);
        await verify({ browser, container, button, submitted });
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

async function verifyRefresh(engineerTurn) {
    await withReviewSurface(
        { mode: "pr", forge: { available: true, postEnabled: true } },
        async ({ browser, container, button, submitted }) => {
            await act(() => button("Global comment").click());
            const input = browser.document.querySelector('textarea[placeholder="Add a global comment..."]');
            await act(() => {
                Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(
                    input,
                    "old anchored note",
                );
                input.dispatchEvent(new browser.Event("input", { bubbles: true }));
            });
            const add = [...browser.document.querySelectorAll("button")].find(
                (node) => node.textContent.trim() === "Add",
            );
            await act(() => add.click());
            assertStringIncludes(container.textContent, "old anchored note");
            if (engineerTurn) {
                await act(() => container.querySelector('button[role="tab"][title="Engineer"]').click());
                const composer = browser.document.querySelector('textarea[placeholder="Message Engineer…"]');
                await act(() => {
                    Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(
                        composer,
                        "Edit, commit, and push the file",
                    );
                    composer.dispatchEvent(new browser.Event("input", { bubbles: true }));
                });
                await act(() => button("Send to Engineer").click());
                assertEquals(submitted[0].annotations, []);
                await act(() => container.querySelector('button[role="tab"][title="Annotations"]').click());
            } else {
                await act(() => button("Post comments").click());
                assertEquals(submitted[0].annotations.length, 1);
            }
            assertEquals(container.textContent.includes("old anchored note"), false);
            await act(() => button("Guided Review ready").click());
            assertStringIncludes(container.textContent, "Generated on a different version of this branch");
            await act(() => button("Post comments").click());
            assertEquals(submitted[1].annotations, []);
        },
    );
}

test("refused PR post invalidates old annotations and marks the retained guide stale", () => verifyRefresh(false));
test("unattached Engineer turn clears retained annotations before posting", () => verifyRefresh(true));

async function addModeAnnotation({ browser, button }) {
    await act(() => button("Global comment").click());
    const input = browser.document.querySelector('textarea[placeholder="Add a global comment..."]');
    await act(() => {
        Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(
            input,
            "Mode review note",
        );
        input.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
    await act(() =>
        [...browser.document.querySelectorAll("button")].find((node) => node.textContent.trim() === "Add").click(),
    );
}

function actionLabels(container) {
    return [...container.querySelectorAll(".rw-plannotator-actions button, .rw-review-feedback-action button")].map(
        (node) => node.textContent.trim(),
    );
}

test("Code Review PR destination keeps only Forge actions, then switches to Engineer feedback", async () => {
    await withReviewSurface(
        { mode: "pr", forge: { available: true, postEnabled: true } },
        async ({ browser, container, button }) => {
            await addModeAnnotation({ browser, button });
            assertEquals(actionLabels(container), ["Post to PR", "Engineer", "Post comments", "Approve"]);
            await act(() => button("Engineer").click());
            assertEquals(actionLabels(container), [
                "Post to PR",
                "Engineer",
                "Send to Engineer",
                "Send to Engineer",
                "Add to Engineer chat",
            ]);
        },
    );
});

test("Code Review branch page has Engineer feedback and no approval or Open PR", async () => {
    await withReviewSurface({ mode: "branch" }, async ({ browser, container, button }) => {
        await addModeAnnotation({ browser, button });
        assertEquals(actionLabels(container), ["Send to Engineer", "Send to Engineer", "Add to Engineer chat"]);
        assertEquals(container.textContent.includes("Open PR"), false);
    });
});

test("Code Review uncommitted page has Engineer feedback and Operator approval", async () => {
    await withReviewSurface(
        { mode: "uncommitted", commit: { enabled: true } },
        async ({ browser, container, button }) => {
            await addModeAnnotation({ browser, button });
            assertEquals(actionLabels(container), [
                "Send to Engineer",
                "Approve & Commit",
                "Send to Engineer",
                "Add to Engineer chat",
            ]);
            assertEquals(button("Approve & Commit").disabled, false);
            assertEquals(
                button("Approve & Commit").title,
                "The Operator writes a commit message, commits, and pushes these changes.",
            );
        },
    );
});

test("Code Review validation page retains approval and annotation feedback", async () => {
    await withReviewSurface(undefined, async ({ browser, container, button }) => {
        await addModeAnnotation({ browser, button });
        assertEquals(actionLabels(container), ["OKApprove", "Send Annotations", "Add to Engineer chat"]);
        assertEquals(button("OKApprove").disabled, false);
        assertEquals(button("Send Annotations").disabled, false);
    });
});
