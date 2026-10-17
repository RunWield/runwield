// @ts-nocheck: happy-dom supplies browser globals for the real React island.
import { importTestBundle } from "../../testing/import-test-bundle.ts";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import { fileURLToPath } from "node:url";
import { build, stop } from "esbuild";
import { Window } from "happy-dom";
import { act } from "react";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./islands/ProjectRootForm.tsx", import.meta.url))],
    bundle: true,
    write: false,
    format: "esm",
    jsx: "automatic",
    plugins: [
        {
            name: "shared-react",
            setup(builder) {
                builder.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (args) => ({
                    path: import.meta.resolve(args.path),
                    external: true,
                }));
            },
        },
    ],
});
stop();

for (const projectId of [undefined, "relink-project"]) {
    test(`${projectId ? "relink" : "add"} root form preserves input on Quit and Escape, confirms once, and disables pending actions`, async () => {
        await withProcessGlobalTestLock(async () => {
            const browser = new Window({ url: "http://127.0.0.1:8787/projects" });
            const names = [
                "window",
                "document",
                "location",
                "HTMLElement",
                "HTMLDialogElement",
                "Element",
                "Node",
                "Event",
                "CustomEvent",
                "fetch",
                "IS_REACT_ACT_ENVIRONMENT",
            ];
            const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
            let root;
            try {
                for (const name of names) {
                    Object.defineProperty(globalThis, name, {
                        configurable: true,
                        writable: true,
                        value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : browser[name],
                    });
                }
                const { createRoot } = await import("react-dom/client");
                const { default: ProjectRootForm } = await importTestBundle(bundle.outputFiles[0].text);
                // happy-dom does not implement the native modal lifecycle.
                browser.HTMLDialogElement.prototype.showModal = function () {
                    this.open = true;
                };
                browser.HTMLDialogElement.prototype.close = function () {
                    this.open = false;
                };
                const requests = [];
                let finish;
                globalThis.fetch = (_url, options) => {
                    requests.push(JSON.parse(options.body));
                    if (requests.at(-1).directoryConfirmation) {
                        return new Promise((resolve) => {
                            finish = resolve;
                        });
                    }
                    return Promise.resolve(
                        new Response(
                            JSON.stringify({
                                code: "directory_confirmation_required",
                                error: "System or home folder detected. Continue?",
                                confirmation: "opaque-token",
                            }),
                            { status: 409 },
                        ),
                    );
                };
                let navigations = 0;
                document.addEventListener("runwield:workspace-navigate", (event) => {
                    navigations++;
                    event.preventDefault();
                });
                const container = document.createElement("div");
                document.body.append(container);
                root = createRoot(container);
                await act(() => root.render(<ProjectRootForm projectId={projectId} />));
                const input = container.querySelector("input");
                const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set;
                await act(() => {
                    setter.call(input, "/entered/home");
                    input.dispatchEvent(new browser.Event("input", { bubbles: true }));
                });
                const form = container.querySelector("form");
                const submit = container.querySelector('button[type="submit"]');
                const send = async () => {
                    submit.focus();
                    await act(() => {
                        form.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }));
                    });
                };
                const button = (label) =>
                    [...container.querySelectorAll("button")].find((node) => node.textContent === label);
                await send();
                assert(container.querySelector("dialog"));
                assertEquals(document.activeElement, button("Quit"));
                await act(() => button("Quit").click());
                assertEquals(container.querySelector("dialog"), null);
                assertEquals(input.value, "/entered/home");
                assertEquals(document.activeElement, submit);
                await send();
                await act(() =>
                    container.querySelector("dialog").dispatchEvent(new browser.Event("cancel", { cancelable: true })),
                );
                assertEquals(container.querySelector("dialog"), null);
                assertEquals(input.value, "/entered/home");
                await send();
                await act(() => button("Continue").click());
                assertEquals(requests.at(-1).directoryConfirmation, "opaque-token");
                assertEquals(submit.disabled, true);
                const count = requests.length;
                await act(() => form.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })));
                assertEquals(requests.length, count);
                await act(() =>
                    finish(new Response(JSON.stringify({ error: "Root changed; try again." }), { status: 409 })),
                );
                assertEquals(submit.disabled, false);
                assertEquals(container.querySelector('[role="status"]').textContent, "Root changed; try again.");
                await act(() => {
                    setter.call(input, "/changed/root");
                    input.dispatchEvent(new browser.Event("input", { bubbles: true }));
                });
                await send();
                assertEquals(requests.at(-1).directoryConfirmation, undefined);
                await act(() => button("Continue").click());
                await act(() =>
                    finish(
                        new Response(JSON.stringify({ project: { projectId: "linked-project" } }), {
                            status: projectId ? 200 : 201,
                        }),
                    ),
                );
                assertEquals(navigations, 1);
            } finally {
                if (root) await act(() => root.unmount());
                await browser.happyDOM.close();
                for (const [name, descriptor] of previous) {
                    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                    else Reflect.deleteProperty(globalThis, name);
                }
            }
        });
    });
}
