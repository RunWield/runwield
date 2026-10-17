// @ts-nocheck: Browser tests install happy-dom globals around the real review surface.
import { test } from "node:test";
import { Window } from "happy-dom";
import { act } from "react";
import { build, stop } from "esbuild";
import { fileURLToPath } from "node:url";
import { importTestBundle } from "../../../testing/import-test-bundle.ts";
import { assertEquals, assertStringIncludes } from "../../../testing/assertions.ts";

const plan =
    '# Review links\n\n```wld-question\n{"id":"scope","type":"multiple_choice","prompt":"Who can use links?","choices":[{"value":"admins","label":"Admins only"},{"value":"all","label":"All members"}],"default":"admins"}\n```\n\n```wld-question\n{"id":"keep","type":"yes_no","prompt":"Keep old links?","default":true}\n```\n';
let modulePromise;
async function reviewModule() {
    modulePromise ??= (async () => {
        const bundle = await build({
            entryPoints: [fileURLToPath(new URL("./PlanReviewSurface.tsx", import.meta.url))],
            bundle: true,
            write: false,
            format: "esm",
            jsx: "automatic",
            banner: {
                js: `import { createRequire } from "node:module"; const require = createRequire(${JSON.stringify(import.meta.url)});`,
            },
            define: { "import.meta.env": "{}" },
            loader: { ".css": "empty", ".png": "dataurl" },
            alias: {
                "@plannotator/shared": fileURLToPath(
                    new URL("../../../../third_party/plannotator/packages/shared", import.meta.url),
                ),
                "@plannotator/core": fileURLToPath(
                    new URL("../../../../third_party/plannotator/packages/core", import.meta.url),
                ),
                "@plannotator/ui": fileURLToPath(
                    new URL("../../../../third_party/plannotator/packages/ui", import.meta.url),
                ),
            },
            plugins: [
                {
                    name: "browser-runtime",
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
        return await importTestBundle(bundle.outputFiles[0].text);
    })();
    return await modulePromise;
}

async function withReview(verify, reviewedPlan = plan) {
    const browser = new Window({ url: "http://localhost/review" });
    browser.document.fonts = new browser.EventTarget();
    const names = [
        "window",
        "document",
        "navigator",
        "location",
        "localStorage",
        "matchMedia",
        "getComputedStyle",
        "addEventListener",
        "removeEventListener",
        "HTMLElement",
        "HTMLButtonElement",
        "HTMLInputElement",
        "HTMLTextAreaElement",
        "Element",
        "Node",
        "NodeFilter",
        "SVGElement",
        "CSSStyleSheet",
        "customElements",
        "CustomEvent",
        "MutationObserver",
        "ResizeObserver",
        "IntersectionObserver",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "IS_REACT_ACT_ENVIRONMENT",
        "fetch",
        "confirm",
    ];
    const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const submitted = [];
    const confirmations = [];
    let confirmResult = false;
    let revision = 0;
    let nextPlan = reviewedPlan;
    let root;
    try {
        for (const name of names)
            Object.defineProperty(globalThis, name, {
                configurable: true,
                writable: true,
                value:
                    name === "IS_REACT_ACT_ENVIRONMENT"
                        ? true
                        : typeof browser[name] === "function"
                          ? browser[name].bind(browser)
                          : browser[name],
            });
        globalThis.confirm = (message) => {
            confirmations.push(message);
            return confirmResult;
        };
        globalThis.fetch = (url, options) => {
            if (String(url) === "/decision") {
                submitted.push(JSON.parse(options.body));
                revision++;
                return Promise.resolve(Response.json({ ok: true }));
            }
            if (String(url) === "/status")
                return Promise.resolve(Response.json({ revision, plan: nextPlan, events: [] }));
            return Promise.resolve(Response.json({ available: false, providers: [] }));
        };
        const { PlanReviewSurface } = await reviewModule();
        const { createRoot } = await import("react-dom/client");
        const container = browser.document.createElement("div");
        browser.document.body.append(container);
        const payload = {
            mode: "standalone",
            token: "questions",
            plan: reviewedPlan,
            classification: "PLANNED_CHANGE",
            executionPolicy: {
                classification: "PLANNED_CHANGE",
                executionAgent: "frontend-engineer",
                collaborationRecommendation: "pair",
            },
            submitUrl: "/decision",
            conversationStatusUrl: "/status",
        };
        const mount = async () => {
            root = createRoot(container);
            await act(() => root.render(<PlanReviewSurface payload={payload} />));
        };
        const button = (text) =>
            [...container.querySelectorAll("button")].find(
                (element) => element.getAttribute("aria-label") === text || element.textContent.trim() === text,
            );
        const radio = (text) =>
            [...container.querySelectorAll("label")]
                .find((element) => element.textContent.includes(text))
                ?.querySelector("input");
        const openChat = async () => {
            await act(() => container.querySelector('[aria-label="Open annotations sidebar"]').click());
            await act(() => container.querySelector('button[role="tab"][title="Planner"]').click());
        };
        await mount();
        await verify({
            browser,
            container,
            button,
            radio,
            openChat,
            submitted,
            confirmations,
            revise: (markdown) => {
                nextPlan = markdown;
            },
            confirm: (value) => {
                confirmResult = value;
            },
            reload: async () => {
                await act(() => root.unmount());
                await mount();
            },
        });
    } finally {
        if (root) await act(() => root.unmount());
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        await browser.happyDOM.close();
    }
}

test("question forms mount through the real Viewer and update answers instead of exposing raw code", async () => {
    await withReview(async ({ container, radio }) => {
        assertEquals(container.querySelectorAll(".rw-question-card").length, 2);
        assertEquals(container.querySelector(".rw-plan-question-mounted pre").hidden, true);
        await act(() => radio("All members").click());
        assertEquals(radio("All members").checked, true);
        await act(() => radio("Other").click());
        assertEquals(Boolean(container.querySelector('textarea[aria-label="Other answer: Who can use links?"]')), true);
    });
});

test("answers restore after reload and attach to chat without a manual attach action", async () => {
    await withReview(async ({ container, radio, reload, openChat }) => {
        await act(() => radio("All members").click());
        await act(async () => await new Promise((resolve) => setTimeout(resolve, 550)));
        await reload();
        assertEquals(radio("All members").checked, true);
        await openChat();
        assertStringIncludes(container.textContent, "1 question answer attached");
    });
});

test("chat Send carries answers and removing the context chip excludes them", async () => {
    await withReview(async ({ browser, container, button, radio, openChat, submitted }) => {
        await act(() => radio("All members").click());
        await openChat();
        await act(() => button("Send to Planner").click());
        assertStringIncludes(submitted[0].feedback, "### Question answers");
        assertStringIncludes(submitted[0].feedback, "All members");
        await act(() => container.querySelector('[aria-label="Remove attached annotations"]').click());
        const composer = container.querySelector('textarea[placeholder="Message Planner…"]');
        await act(() => {
            Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(
                composer,
                "Keep the Plan.",
            );
            composer.dispatchEvent(new browser.Event("input", { bubbles: true }));
        });
        await act(() => button("Send to Planner").click());
        assertEquals(submitted[1].feedback.includes("### Question answers"), false);
    });
});

test("approval warns about open questions, cancel stays open, and confirm sends structured answers", async () => {
    await withReview(async ({ button, radio, submitted, confirmations, confirm }) => {
        await act(() => radio("All members").click());
        await act(() => button("Approve & Run").click());
        assertEquals(submitted.length, 0);
        assertStringIncludes(confirmations[0], "1 question is not answered. The recommended answers will be used.");
        confirm(true);
        await act(() => button("Approve & Run").click());
        assertEquals(submitted[0].questionAnswers, [{ id: "scope", value: "all" }]);
    });
});

test("invalid questions keep the real Viewer code block with a visible parse error", async () => {
    await withReview(({ container }) => {
        assertEquals(container.querySelectorAll(".rw-question-card").length, 0);
        assertEquals(container.querySelector("pre").hidden, false);
        assertStringIncludes(container.querySelector('[role="note"]').textContent, "Question needs an id.");
    }, '# Plan\n\n```wld-question\n{"type":"text","prompt":"Which message?"}\n```\n');
});

test("text questions accept free text and mark the recommendation without using it as an owner answer", async () => {
    await withReview(async ({ browser, container, openChat }) => {
        const field = container.querySelector('textarea[aria-label="Which message?"]');
        assertEquals(field.value, "");
        assertStringIncludes(container.textContent, "Recommended: Follow the link.");
        await act(() => {
            Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(
                field,
                "Opening the saved Plan.",
            );
            field.dispatchEvent(new browser.Event("input", { bubbles: true }));
        });
        await openChat();
        assertStringIncludes(container.textContent, "1 question answer attached");
    }, '# Plan\n\n```wld-question\n{"id":"message","type":"text","prompt":"Which message?","default":"Follow the link."}\n```\n');
});

test("a Planner revision drops answers for removed question ids", async () => {
    await withReview(async ({ container, button, radio, openChat, submitted, revise, confirm }) => {
        await act(() => radio("All members").click());
        await openChat();
        revise(plan.replace(/```wld-question[\s\S]*?```\n\n/, "Audience: All members.\n\n"));
        await act(() => button("Send to Planner").click());
        assertEquals(Boolean(container.querySelector(".rw-artifact-conversation-context")), false);
        await act(() => button("View").click());
        assertEquals(container.querySelectorAll(".rw-question-card").length, 1);
        confirm(true);
        await act(() => button("Approve & Run").click());
        assertEquals(submitted[1].questionAnswers, []);
    });
});

test("question answers combine with attached notes and annotation-only Send stays available", async () => {
    await withReview(async ({ browser, container, button, radio, submitted }) => {
        await act(() => button("Global comment").click());
        const note = browser.document.querySelector('textarea[placeholder="Add a global comment..."]');
        await act(() => {
            Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(
                note,
                "Clarify the link rules.",
            );
            note.dispatchEvent(new browser.Event("input", { bubbles: true }));
        });
        const add = [...browser.document.querySelectorAll("button")].find(
            (element) => element.textContent.trim() === "Add",
        );
        await act(() => add.click());
        await act(() => button("Add to Planner chat").click());
        assertStringIncludes(container.textContent, "1 review note attached");
        assertEquals(button("Send to Planner").disabled, false);
        await act(() => radio("All members").click());
        assertStringIncludes(container.textContent, "1 review note and 1 question answer attached");
        await act(() => button("Send to Planner").click());
        assertStringIncludes(submitted[0].feedback, "Clarify the link rules.");
        assertStringIncludes(submitted[0].feedback, "### Question answers");
    });
});

test("Send Annotations includes answered questions without a chat message", async () => {
    await withReview(async ({ container, button, radio, submitted }) => {
        await act(() => radio("All members").click());
        await act(() => container.querySelector('[aria-label="Open annotations sidebar"]').click());
        await act(() => button("Send Annotations").click());
        assertStringIncludes(submitted[0].feedback, "### Question answers");
        assertStringIncludes(submitted[0].feedback, "All members");
    });
});

test("question forms mount at their source location after an indented example", async () => {
    const example = '    ```wld-question\n    {"id":"scope","type":"text","prompt":"Example only"}\n    ```\n\n';
    await withReview(
        ({ container }) => {
            const codeBlocks = [...container.querySelectorAll("[data-block-id]")].filter((element) =>
                element.querySelector("pre"),
            );
            assertEquals(codeBlocks.length, 3);
            assertEquals(codeBlocks[0].querySelector("pre").hidden, false);
            assertEquals(codeBlocks[0].querySelector(".rw-question-card"), null);
            assertStringIncludes(codeBlocks[1].querySelector(".rw-question-card").textContent, "Who can use links?");
            assertStringIncludes(codeBlocks[2].querySelector(".rw-question-card").textContent, "Keep old links?");
        },
        "---\ntitle: Review\n---\n\n" + example + plan,
    );
});

for (const detach of [false, true]) {
    test(`answer-only chat preserves ${detach ? "detached" : "unattached"} notes and their saved draft`, async () => {
        await withReview(async ({ browser, container, button, radio, submitted, reload }) => {
            await act(() => button("Global comment").click());
            const note = browser.document.querySelector('textarea[placeholder="Add a global comment..."]');
            await act(() => {
                Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(
                    note,
                    "Keep this review note.",
                );
                note.dispatchEvent(new browser.Event("input", { bubbles: true }));
            });
            await act(() =>
                [...browser.document.querySelectorAll("button")]
                    .find((element) => element.textContent.trim() === "Add")
                    .click(),
            );
            if (detach) {
                await act(() => button("Add to Planner chat").click());
                await act(() => container.querySelector('[aria-label="Remove attached annotations"]').click());
            } else {
                await act(() => container.querySelector('button[role="tab"][title="Planner"]').click());
            }
            await act(() => radio("All members").click());
            await act(() => button("Send to Planner").click());
            assertEquals(submitted[0].feedback.includes("Keep this review note."), false);
            assertStringIncludes(submitted[0].feedback, "### Question answers");
            await act(() => container.querySelector('button[role="tab"][title="Annotations"]').click());
            assertStringIncludes(container.textContent, "Keep this review note.");
            await act(async () => await new Promise((resolve) => setTimeout(resolve, 550)));
            await reload();
            await act(() => button("Restore draft").click());
            assertStringIncludes(container.textContent, "Keep this review note.");
        });
    });
}
