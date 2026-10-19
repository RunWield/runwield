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

export async function withReview(verify, reviewedPlan) {
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
