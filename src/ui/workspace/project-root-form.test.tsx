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

async function withRootForm(projectId, check) {
    await withProcessGlobalTestLock(async () => {
        const browser = new Window({ url: "http://workspace.test/projects/project/settings?tab=general" });
        const names = [
            "window",
            "document",
            "location",
            "HTMLElement",
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
            const navigations = [];
            document.addEventListener("runwield:workspace-navigate", (event) => {
                event.preventDefault();
                navigations.push(event.detail);
            });
            const container = document.createElement("div");
            document.body.append(container);
            root = createRoot(container);
            await act(() => root.render(<ProjectRootForm projectId={projectId} />));
            const inputs = [...container.querySelectorAll("input")];
            const values = projectId ? ["/entered/project"] : ["/entered/project", "Example"];
            const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set;
            await act(() => {
                for (const [index, input] of inputs.entries()) {
                    setter.call(input, values[index]);
                    input.dispatchEvent(new browser.Event("input", { bubbles: true }));
                }
            });
            const button = container.querySelector('button[type="submit"]');
            const status = container.querySelector('p[role="status"]');
            const send = () =>
                act(() =>
                    container
                        .querySelector("form")
                        .dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })),
                );
            assertEquals(container.querySelector(".rw-thinking-glyph"), null);
            await check({ container, inputs, values, button, status, navigations, send });
        } finally {
            if (root) await act(() => root.unmount());
            await browser.happyDOM.close();
            for (const [name, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        }
    });
}

for (const projectId of [undefined, "relink-project"]) {
    const operation = projectId ? "relink" : "link";
    test(`Project ${operation}: rejected fetch preserves input and a successful retry navigates`, async () => {
        await withRootForm(projectId, async ({ container, inputs, values, button, status, navigations, send }) => {
            globalThis.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
            await send();
            assertEquals(
                status.textContent,
                `Project ${operation} could not be confirmed. Check your connection and try again.`,
            );
            assertEquals(
                inputs.map((input) => input.value),
                values,
            );
            assertEquals(
                inputs.map((input) => input.disabled),
                values.map(() => false),
            );
            assertEquals(button.disabled, false);
            assertEquals(navigations, []);
            assertEquals(container.querySelector(".rw-thinking-glyph"), null);
            globalThis.fetch = () => Promise.resolve(Response.json({ project: { projectId: "linked-project" } }));
            await send();
            assertEquals(status.textContent, "");
            assertEquals(navigations, [
                {
                    href: projectId ? "/projects/project/settings?tab=general" : "/projects/linked-project/settings",
                    history: projectId ? "replace" : "push",
                },
            ]);
            assertEquals(container.querySelector(".rw-thinking-glyph"), null);
        });
    });

    test(`Project ${operation}: pending shows the shared loader and blocks duplicate submission`, async () => {
        await withRootForm(projectId, async ({ container, inputs, button, status, navigations, send }) => {
            let finish;
            const requests = [];
            globalThis.fetch = (_url, options) => {
                requests.push(JSON.parse(options.body));
                return new Promise((resolve) => {
                    finish = resolve;
                });
            };
            await send();
            const loader = container.querySelector(".rw-thinking-dots");
            assertEquals(loader?.getAttribute("aria-label"), projectId ? "Relinking Project" : "Linking Project");
            assertEquals(loader?.getAttribute("role"), "status");
            assertEquals(loader?.querySelector(".rw-thinking-glyph")?.getAttribute("aria-hidden"), "true");
            assertEquals(status.textContent, "");
            assertEquals(button.disabled, true);
            assert(inputs.every((input) => input.disabled));
            await send();
            assertEquals(requests.length, 1);
            assertEquals(
                requests[0],
                projectId
                    ? { action: "relink", newRoot: "/entered/project" }
                    : { root: "/entered/project", displayName: "Example" },
            );
            await act(() => finish(Response.json({ project: { projectId: "linked-project" } })));
            assertEquals(container.querySelector(".rw-thinking-glyph"), null);
            assertEquals(button.disabled, false);
            assert(inputs.every((input) => !input.disabled));
            assertEquals(navigations.length, 1);
        });
    });

    test(`Project ${operation}: non-JSON HTTP errors show the fallback without navigation`, async () => {
        await withRootForm(projectId, async ({ container, button, status, navigations, send }) => {
            globalThis.fetch = () => Promise.resolve(new Response("Server unavailable", { status: 500 }));
            await send();
            assertEquals(status.textContent, "Project operation failed.");
            assertEquals(button.disabled, false);
            assertEquals(navigations, []);
            assertEquals(container.querySelector(".rw-thinking-glyph"), null);
        });
    });

    test(`Project ${operation}: interrupted successful response preserves input without navigation`, async () => {
        await withRootForm(projectId, async ({ container, inputs, values, button, status, navigations, send }) => {
            globalThis.fetch = () =>
                Promise.resolve(
                    new Response(
                        new ReadableStream({
                            start(controller) {
                                controller.error(new TypeError("Connection lost while reading response"));
                            },
                        }),
                        { status: 200 },
                    ),
                );
            await send();
            assertEquals(
                status.textContent,
                `Project ${operation} could not be confirmed. Check your connection and try again.`,
            );
            assertEquals(
                inputs.map((input) => input.value),
                values,
            );
            assert(inputs.every((input) => !input.disabled));
            assertEquals(button.disabled, false);
            assertEquals(navigations, []);
            assertEquals(container.querySelector(".rw-thinking-glyph"), null);
        });
    });

    test(`Project ${operation}: HTTP errors retain server feedback without navigation`, async () => {
        await withRootForm(projectId, async ({ container, button, status, navigations, send }) => {
            globalThis.fetch = () =>
                Promise.resolve(Response.json({ error: "Project is not available." }, { status: 409 }));
            await send();
            assertEquals(status.textContent, "Project is not available.");
            assertEquals(button.disabled, false);
            assertEquals(navigations, []);
            assertEquals(container.querySelector(".rw-thinking-glyph"), null);
        });
    });
}
