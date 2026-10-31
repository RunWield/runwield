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
import { mapReviewAnnotations } from "../../shared/standalone-review/forge-review.ts";

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

async function withReviewSurface(standaloneReview, verify, network) {
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
            const response = network?.(url, options);
            if (response) return Promise.resolve(response);
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

test("Code Review validation page retains approval and sends annotations through chat", async () => {
    await withReviewSurface(undefined, async ({ browser, container, button }) => {
        await addModeAnnotation({ browser, button });
        assertEquals(actionLabels(container), ["OKApprove"]);
        assertEquals(button("OKApprove").disabled, false);
        assertEquals(button("Send to Engineer").disabled, false);
    });
});

function aiReviewNetwork() {
    const state = { launches: 0, polls: 0, deleted: [], pending: false, error: "", revision: 0, resultPending: null };
    const annotation = (id, scope = "general") => ({
        id,
        type: "comment",
        scope,
        filePath: scope === "line" ? "a.ts" : null,
        lineStart: scope === "line" ? 1 : null,
        lineEnd: scope === "line" ? 1 : null,
        side: "old",
        text: `**Tests · blocking** — ${id}`,
        author: "AI review",
        source: "ai-review",
        severity: "issue",
        createdAt: Date.now(),
    });
    const network = (url, options) => {
        const path = new URL(url, "http://localhost").pathname;
        if (path === "/api/agents/capabilities")
            return Response.json({ available: true, providers: [{ id: "ai-review", available: true }] });
        if (path === "/api/agents/jobs" && options?.method === "POST") {
            state.launches++;
            return Response.json(
                {
                    job: {
                        id: `job-${state.launches}`,
                        status: "running",
                        provider: "ai-review",
                        model: "fixture-model",
                    },
                },
                { status: 202 },
            );
        }
        if (path === "/api/agents/jobs") {
            state.polls++;
            return Response.json({
                jobs: [
                    {
                        id: `job-${state.launches}`,
                        status: state.pending ? "running" : state.error ? "failed" : "done",
                        error: state.error,
                        elapsedMs: 800,
                        providerName: "fixture-host",
                        model: "fixture-model",
                        usageState: "available",
                        tokens: { inputTokens: 10, outputTokens: 20 },
                        cost: { usd: 0.001 },
                    },
                ],
            });
        }
        if (path.startsWith("/api/agents/jobs/") && options?.method === "DELETE") {
            state.deleted.push(path);
            if (state.cancelPending) return state.cancelPending.then(() => Response.json({ ok: true }));
            return Response.json({ ok: true });
        }
        if (path.startsWith("/api/ai-review/")) {
            const result = {
                specSource: null,
                counts: { standards: 0, spec: 0, tests: 3 },
                annotations: [
                    annotation(`keep-${state.launches}`),
                    annotation(`replace-${state.launches}`),
                    annotation(`inline-${state.launches}`, "line"),
                ],
            };
            if (state.empty) {
                result.annotations = [];
                result.counts.tests = 0;
            }
            if (state.resultPending) return state.resultPending.then(() => Response.json(result));
            return Response.json(result);
        }
    };
    return { state, network };
}

async function waitForUi(check) {
    for (let attempt = 0; attempt < 160; attempt++) {
        if (check()) return;
        await act(() => new Promise((resolve) => setTimeout(resolve, 25)));
    }
    throw new Error("Review UI did not reach the expected state");
}

async function enterComment(browser, input, text) {
    await act(() => {
        Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(input, text);
        input.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
}

test("AI review is manual and standalone-only even when the provider is advertised", async () => {
    const { state, network } = aiReviewNetwork();
    await withReviewSurface(
        undefined,
        ({ button }) => {
            assertEquals(button("Run AI Review"), undefined);
        },
        network,
    );
    await withReviewSurface(
        { mode: "branch" },
        ({ button }) => {
            assertEquals(Boolean(button("Run AI Review")), true);
            assertStringIncludes(button("Run AI Review").title, "additional LLM call");
            assertEquals(state.launches, 0);
        },
        network,
    );
});

test("AI review annotations can be edited, deleted, rerun, and posted with line and side intact", async () => {
    const { state, network } = aiReviewNetwork();
    await withReviewSurface(
        { mode: "pr", forge: { available: true, postEnabled: true } },
        async ({ browser, container, button, submitted }) => {
            await addModeAnnotation({ browser, button });
            await act(() => button("Run AI Review").click());
            assertEquals(Boolean(button("Cancel")), true);
            await waitForUi(() => Boolean(button("Run AI Review")));
            assertStringIncludes(container.textContent, "Standards 0 · Spec 0 · Tests 3");
            assertStringIncludes(container.textContent, "spec: no spec");
            assertStringIncludes(container.textContent, "fixture-model");
            assertStringIncludes(container.textContent, "cost $0.001");
            const note = [...container.querySelectorAll(".review-comment-markdown")].find((node) =>
                node.textContent.includes("keep-1"),
            );
            assertStringIncludes(note.parentElement.textContent, "AI review");
            await act(() => note.click());
            const input = browser.document.querySelector('textarea[placeholder="Add a global comment..."]');
            assertEquals(Boolean(input), true);
            assertEquals(browser.document.querySelector('button[title="Attachments"]'), null);
            await enterComment(browser, input, "Owner edited finding");
            await act(() =>
                [...browser.document.querySelectorAll("button")]
                    .find((node) => node.textContent.trim() === "Add")
                    .click(),
            );
            await act(() => button("Run AI Review").click());
            await waitForUi(() => Boolean(button("Run AI Review")));
            assertEquals(state.launches, 2);
            assertStringIncludes(container.textContent, "Owner edited finding");
            assertStringIncludes(container.textContent, "Mode review note");
            assertEquals(container.textContent.includes("replace-1"), false);
            assertStringIncludes(container.textContent, "replace-2");
            const removeNote = [...container.querySelectorAll(".review-comment-markdown")].find((node) =>
                node.textContent.includes("replace-2"),
            );
            const card = removeNote.parentElement;
            const deleteButton =
                card.querySelector('button[title="Delete"]') || card.querySelector('button[aria-label="Delete"]');
            await act(() => deleteButton.click());
            assertEquals(container.textContent.includes("replace-2"), false);
            await act(() => button("Post comments").click());
            const posted = submitted[0].annotations;
            assertEquals(
                posted.some((annotation) => annotation.text.includes("replace-2")),
                false,
            );
            assertEquals(posted.find((annotation) => annotation.text === "Owner edited finding").edited, true);
            const mapped = mapReviewAnnotations("", posted);
            assertEquals(mapped.fileComments, [
                { path: "a.ts", line: 1, side: "LEFT", body: "**Tests · blocking** — inline-2" },
            ]);
            assertStringIncludes(mapped.body, "Owner edited finding");
        },
        network,
    );
});

test("AI review Cancel stops a running job without adding findings", async () => {
    const { state, network } = aiReviewNetwork();
    state.pending = true;
    await withReviewSurface(
        { mode: "branch" },
        async ({ container, button }) => {
            await act(() => button("Run AI Review").click());
            await act(() => button("Cancel").click());
            await waitForUi(() => Boolean(button("Run AI Review")));
            assertEquals(state.deleted.length, 1);
            assertStringIncludes(container.textContent, "AI review canceled");
            assertEquals(container.textContent.includes("keep-1"), false);
        },
        network,
    );
});

test("failed AI review preserves existing annotations and can be retried", async () => {
    const { state, network } = aiReviewNetwork();
    state.error = "Model unavailable";
    await withReviewSurface(
        { mode: "branch" },
        async ({ browser, container, button }) => {
            await addModeAnnotation({ browser, button });
            await act(() => button("Run AI Review").click());
            await waitForUi(() => Boolean(button("Run AI Review")));
            assertStringIncludes(container.textContent, "Model unavailable");
            assertStringIncludes(container.textContent, "Mode review note");
            state.error = "";
            await act(() => button("Run AI Review").click());
            await waitForUi(() => Boolean(button("Run AI Review")));
            assertStringIncludes(container.textContent, "keep-2");
        },
        network,
    );
});

test("AI review drops a result after the active diff changes", async () => {
    const { state, network } = aiReviewNetwork();
    let release;
    state.resultPending = new Promise((resolve) => {
        release = resolve;
    });
    let statusReads = 0;
    const refreshNetwork = (url, options) => {
        if (String(url).includes("/status")) {
            statusReads++;
            return Response.json({
                revision: statusReads > 1 ? 1 : 0,
                gitRef: statusReads > 1 ? "new-head" : "old-head",
                rawPatch: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+updated\n",
                standaloneReview: { mode: "pr", forge: { available: true, postEnabled: true } },
            });
        }
        return network(url, options);
    };
    await withReviewSurface(
        { mode: "pr", forge: { available: true, postEnabled: true } },
        async ({ container, button }) => {
            await act(() => button("Run AI Review").click());
            await waitForUi(() => state.polls > 0);
            await act(() => button("Post comments").click());
            await act(() => release());
            await waitForUi(() => Boolean(button("Run AI Review")));
            assertStringIncludes(container.textContent, "AI review results are for an older diff");
            assertEquals(container.textContent.includes("keep-1"), false);
        },
        refreshNetwork,
    );
});

test("AI review sends its remaining annotations to Engineer through ordinary feedback", async () => {
    const { network } = aiReviewNetwork();
    await withReviewSurface(
        { mode: "branch" },
        async ({ button, submitted }) => {
            await act(() => button("Run AI Review").click());
            await waitForUi(() => Boolean(button("Run AI Review")));
            await act(() => button("Send to Engineer").click());
            assertEquals(submitted[0].annotations.length, 3);
            assertEquals(
                submitted[0].annotations.every(
                    (annotation) => annotation.source === "ai-review" && annotation.text.includes("Tests · blocking"),
                ),
                true,
            );
        },
        network,
    );
});

test("an empty AI rerun reports no issues and clears only unedited AI annotations", async () => {
    const { state, network } = aiReviewNetwork();
    await withReviewSurface(
        { mode: "branch" },
        async ({ browser, container, button }) => {
            await addModeAnnotation({ browser, button });
            await act(() => button("Run AI Review").click());
            await waitForUi(() => Boolean(button("Run AI Review")));
            assertStringIncludes(container.textContent, "keep-1");
            state.empty = true;
            await act(() => button("Run AI Review").click());
            await waitForUi(() => Boolean(button("Run AI Review")));
            assertStringIncludes(container.textContent, "AI review found no issues");
            assertStringIncludes(container.textContent, "Mode review note");
            assertEquals(container.textContent.includes("keep-1"), false);
        },
        network,
    );
});

test("Cancel discards completion even while the server cancellation request is pending", async () => {
    const { state, network } = aiReviewNetwork();
    let releaseResult;
    let releaseCancel;
    state.resultPending = new Promise((resolve) => {
        releaseResult = resolve;
    });
    state.cancelPending = new Promise((resolve) => {
        releaseCancel = resolve;
    });
    await withReviewSurface(
        { mode: "branch" },
        async ({ container, button }) => {
            await act(() => button("Run AI Review").click());
            await waitForUi(() => state.polls > 0);
            await act(() => button("Cancel").click());
            await act(() => releaseResult());
            assertEquals(container.textContent.includes("keep-1"), false);
            await act(() => releaseCancel());
            await waitForUi(() => Boolean(button("Run AI Review")));
            assertStringIncludes(container.textContent, "AI review canceled");
            assertEquals(container.textContent.includes("keep-1"), false);
        },
        network,
    );
});
