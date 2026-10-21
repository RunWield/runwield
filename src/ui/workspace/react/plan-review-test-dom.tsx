// @ts-nocheck: Browser tests install happy-dom globals around the real review surface.
import { Window } from "happy-dom";
import { act } from "react";
import { build, stop } from "esbuild";
import { fileURLToPath } from "node:url";
import { importTestBundle } from "../../../testing/import-test-bundle.ts";

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

export async function withReview(verify, reviewedPlan, overrides = {}) {
    const browser = new Window({ url: "http://localhost/review" });
    browser.document.fonts = new browser.EventTarget();
    const names = [
        "window",
        "document",
        "navigator",
        "location",
        "history",
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
    let rejectNext = false;
    let heldStatus;
    let releaseStatus;
    let statusEvents = [];
    let pendingReply;
    let pendingError;
    let nextDocuments = overrides.sequenceDocuments;
    let emptyPolls = 0;

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
            if (options?.method === "POST") {
                if (rejectNext) {
                    rejectNext = false;
                    return Promise.resolve(Response.json({ error: "Connection lost. Try again." }, { status: 503 }));
                }
                const decision = JSON.parse(options.body);
                submitted.push(decision.response?._meta || decision);
                revision++;
                if (pendingReply) {
                    statusEvents.push({
                        type: "assistant_text_delta",
                        messageId: `reply-${revision}`,
                        delta: pendingReply,
                    });
                    pendingReply = undefined;
                }
                if (pendingError) {
                    statusEvents.push({
                        type: "system_status",
                        level: "error",
                        message: pendingError,
                        messageId: `error-${revision}`,
                    });
                    pendingError = undefined;
                }
                return Promise.resolve(Response.json({ ok: true }));
            }
            if (String(url) === "/operation") {
                const liveInteraction =
                    revision > 0 && emptyPolls-- <= 0
                        ? {
                              interactionId: `review-${revision}`,
                              request: { type: "plan_review", planReview: { sequenceDocuments: nextDocuments } },
                          }
                        : null;
                return Promise.resolve(Response.json({ status: "completed", events: statusEvents, liveInteraction }));
            }
            if (String(url) === "/detail") return Promise.resolve(Response.json({ plan: { markdown: nextPlan } }));
            if (String(url) === "/status") {
                const response = () =>
                    Response.json({ revision, plan: nextPlan, sequenceDocuments: nextDocuments, events: statusEvents });
                if (heldStatus && revision > 0) return heldStatus.then(response);
                return Promise.resolve(response());
            }
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
            ...overrides,
        };
        const mount = async () => {
            root = createRoot(container);
            await act(() => root.render(<PlanReviewSurface payload={payload} />));
        };
        const button = (text) =>
            [...container.querySelectorAll("button")].find(
                (element) =>
                    !element.closest("[hidden]") &&
                    (element.getAttribute("aria-label") === text || element.textContent.trim() === text),
            );
        const radio = (text) =>
            [...container.querySelectorAll("label")]
                .find((element) => element.textContent.includes(text))
                ?.querySelector("input");
        const openChat = async () => {
            const panel = container.querySelector('[role="tabpanel"]:not([hidden])') || container;
            const opener = panel.querySelector('[aria-label="Open annotations sidebar"]');
            if (opener) await act(() => opener.click());
            const chat = panel.querySelector('button[role="tab"][title="Planner"]');
            if (chat) await act(() => chat.click());
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
            delayRearm: (polls) => {
                emptyPolls = polls;
            },
            failNext: () => {
                rejectNext = true;
            },
            hold: () => {
                heldStatus = new Promise((resolve) => {
                    releaseStatus = resolve;
                });
            },
            release: async () => {
                await act(async () => {
                    releaseStatus?.();
                    heldStatus = null;
                });
            },
            reply: (text) => {
                pendingReply = text;
            },
            failAgent: (message) => {
                pendingError = message;
            },
            reviseDocuments: (documents) => {
                nextDocuments = documents;
            },
            fill: async (field, value) => {
                await act(() => {
                    Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(
                        field,
                        value,
                    );
                    field.dispatchEvent(new browser.Event("input", { bubbles: true }));
                });
            },
            addNote: async (text) => {
                await act(() => button("Global comment").click());
                const note = browser.document.querySelector('textarea[placeholder="Add a global comment..."]');
                await act(() => {
                    Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(
                        note,
                        text,
                    );
                    note.dispatchEvent(new browser.Event("input", { bubbles: true }));
                });
                await act(() =>
                    [...browser.document.querySelectorAll("button")]
                        .find((element) => element.textContent.trim() === "Add")
                        .click(),
                );
            },
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
