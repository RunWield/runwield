import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { build, stop } from "esbuild";
import { fileURLToPath } from "node:url";
import { importTestBundle } from "../../testing/import-test-bundle.ts";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import {
    UsageSettings,
    CLEAR_HISTORY_STATEMENT,
    REVOKE_STATEMENT,
    CHANGE_DESTINATION_STATEMENT,
} from "./react/UsageSettings.tsx";
import type { UsageSettingsView } from "./server/owner-usage-settings.ts";

function view(): UsageSettingsView {
    return {
        exportAvailable: true,
        unavailableReason: null,
        recording: {
            globalEnabled: false,
            projects: [{ projectId: "a", label: "A", enabled: false, setBy: "default" }],
        },
        exporters: [
            {
                exporterKey: "exporter",
                id: "langfuse",
                version: "1.0",
                state: "approved",
                credentialFields: [{ key: "secretKey", label: "Secret key", secret: true }],
            },
        ],
        destinations: [
            {
                destinationId: "destination",
                exporterId: "langfuse",
                exporterApproved: true,
                endpoint: "https://example.com/",
                insecureLocalEndpoint: false,
                externalProject: "External project",
                projects: [],
                unavailableProjectCount: 2,
                credentials: { configured: true },
                credentialFields: [{ key: "secretKey", label: "Secret key", secret: true }],
                counts: { pending: 3, accepted: 12, confirmed: 10, unconfirmed: 1, rejected: 2 },
                latestCodes: ["process_lost"],
                lastAttemptAt: null,
            },
        ],
    };
}
for (const state of ["none", "installed_unapproved", "approved"] as const) {
    test(`usage settings renders ${state} exporters with no browser approval control`, () => {
        const fixture = view();
        if (state === "none") fixture.exporters = [];
        else fixture.exporters[0].state = state;
        const html = renderToStaticMarkup(createElement(UsageSettings, { initialView: fixture }));
        if (state === "none") assertStringIncludes(html, "No metrics exporter is installed");
        if (state === "installed_unapproved") assertStringIncludes(html, "Approve it on the host: run");
        if (state === "approved") assertStringIncludes(html, "Approved on this host");
        assertEquals(html.includes(">Add destination<"), state === "approved");
        assertEquals(html.includes(">Approve exporter<"), false);
    });
}

test("settings explain unconfirmed, correction, and unavailable Projects without resend controls", () => {
    const html = renderToStaticMarkup(createElement(UsageSettings, { initialView: view() }));
    for (const text of [
        "Delivery unconfirmed",
        "The destination may or may not have the item.",
        "This is an export state, not a workflow failure.",
        "updating the credentials lets those items send again",
        "Removing or disabling a Project in Workspace does not change export approval",
        "2 approved Projects are not available",
        "Not exported",
        "Confirmed",
        "process_lost (export process ended)",
        "Configured",
    ])
        assertStringIncludes(html, text);
    assertEquals(html.includes("Retry all"), false);
    assertEquals(html.includes(">Resend<"), false);
    assertStringIncludes(html, 'type="password"');
    assertStringIncludes(html, 'autoComplete="new-password"');
    assertEquals(html.includes('value="sk-'), false);
});

test("exporters with no declared fields have no credential inputs", () => {
    const fixture = view();
    fixture.destinations[0].credentialFields = [];
    const html = renderToStaticMarkup(createElement(UsageSettings, { initialView: fixture }));
    assertStringIncludes(html, "This exporter needs no credentials");
    assertEquals(html.includes('type="password"'), false);
});

async function withSettings(fixture: UsageSettingsView, check: (container: HTMLDivElement) => Promise<void>) {
    const browser = new Window({ url: "http://localhost/usage/settings" });
    const names = [
        "window",
        "document",
        "Node",
        "Element",
        "HTMLElement",
        "HTMLInputElement",
        "HTMLButtonElement",
        "MutationObserver",
        "NodeFilter",
        "CustomEvent",
        "Event",
        "getComputedStyle",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "FormData",
        "fetch",
        "IS_REACT_ACT_ENVIRONMENT",
    ];
    const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    let root: ReturnType<typeof createRoot> | undefined;
    try {
        const globals = {
            window: browser,
            document: browser.document,
            Node: browser.Node,
            Element: browser.Element,
            HTMLElement: browser.HTMLElement,
            HTMLInputElement: browser.HTMLInputElement,
            HTMLButtonElement: browser.HTMLButtonElement,
            MutationObserver: browser.MutationObserver,
            NodeFilter: browser.NodeFilter,
            CustomEvent: browser.CustomEvent,
            Event: browser.Event,
            getComputedStyle: browser.getComputedStyle.bind(browser),
            requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
            cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
            FormData: browser.FormData,
            fetch: async () => Response.json(fixture),
            IS_REACT_ACT_ENVIRONMENT: true,
        };
        for (const [name, value] of Object.entries(globals))
            Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
        const container = document.createElement("div");
        document.body.append(container);
        // Load Radix after the browser globals exist, as it does in the browser.
        const bundle = await build({
            entryPoints: [fileURLToPath(new URL("./react/UsageSettings.tsx", import.meta.url))],
            bundle: true,
            write: false,
            format: "esm",
            jsx: "automatic",
            loader: { ".css": "empty" },
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
        const component: typeof import("./react/UsageSettings.tsx") = await importTestBundle(
            bundle.outputFiles[0].text,
        );
        root = createRoot(container);
        await act(async () => {
            root!.render(createElement(component.UsageSettings));
        });
        await check(container);
    } finally {
        if (root) await act(() => root!.unmount());
        // Radix returns focus on the next timer turn after unmount.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
        });
        for (const [name, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
        await browser.happyDOM.close();
    }
}

async function selectTab(container: ParentNode, label: string) {
    const control = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
        (element) => element.textContent === label,
    );
    assert(control, `Missing tab: ${label}`);
    await act(() => control.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 })));
}

test("settings credentials clear after save and each destructive dialog states its consequences", async () => {
    await withSettings(view(), async (container) => {
        function button(label: string) {
            const control = [...document.querySelectorAll("button")].find((element) => element.textContent === label);
            assert(control, `Missing button: ${label}`);
            return control;
        }
        await selectTab(container, "Credentials");
        const secret = container.querySelector<HTMLInputElement>('input[type="password"]');
        assert(secret);
        secret.value = "sk-SECRET-rendering";
        const form = secret.closest("form");
        assert(form);
        await act(async () => {
            form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        });
        assertEquals(secret.value, "");
        assertEquals(document.documentElement.outerHTML.includes("sk-SECRET-rendering"), false);
        await selectTab(container, "Destination");
        for (const [trigger, statement] of [
            ["Clear history", CLEAR_HISTORY_STATEMENT],
            ["Revoke destination", REVOKE_STATEMENT],
        ]) {
            await act(() => button(trigger).click());
            assertStringIncludes(document.querySelector('[role="dialog"]')?.textContent || "", statement);
            await act(() => button("Cancel").click());
        }
        await selectTab(container, "Destination");
        await act(() => button("Edit endpoint or external project").click());
        await act(() => button("Review destination change").click());
        assertStringIncludes(
            document.querySelector('[role="dialog"]')?.textContent || "",
            CHANGE_DESTINATION_STATEMENT,
        );
        await act(() => button("Cancel").click());
    });
});

function scaleView() {
    const fixture = view();
    fixture.recording.projects = Array.from({ length: 80 }, (_, index) => ({
        projectId: `project-${index}`,
        label: `Service ${String(index).padStart(2, "0")}`,
        enabled: false,
        setBy: "default" as const,
    }));
    fixture.destinations[0].projects = [{ projectId: "project-0", label: "Service 00" }];
    fixture.destinations.push({
        ...structuredClone(fixture.destinations[0]),
        destinationId: "archive",
        exporterId: "archive",
    });
    return fixture;
}

test("destination tabs keep independent state and unsaved credential drafts", async () => {
    await withSettings(scaleView(), async (container) => {
        const cards = container.querySelectorAll("article");
        assertEquals(cards.length, 2);
        function tab(card: Element, label: string) {
            const control = [...card.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
                (element) => element.textContent === label,
            );
            assert(control);
            return control;
        }
        await selectTab(cards[0], "Credentials");
        const secret = cards[0].querySelector<HTMLInputElement>('input[type="password"]');
        assert(secret);
        secret.value = "sk-unsaved";
        await selectTab(cards[0], "Delivery status");
        assertEquals(
            cards[0].querySelector('[role="tabpanel"]:not([hidden])')?.textContent?.includes("process_lost"),
            true,
        );
        assertEquals(cards[1].querySelector('[role="tab"][aria-selected="true"]')?.textContent, "Approved Projects");
        await selectTab(cards[0], "Credentials");
        assertEquals(secret.value, "sk-unsaved");
        const panel = cards[0].querySelector('[role="tabpanel"]:not([hidden])');
        assert(panel?.contains(secret));
        assertEquals(panel.getAttribute("aria-labelledby"), tab(cards[0], "Credentials").id);
    });
});

test("Project search keeps approvals outside the visible results and saves the full selection", async () => {
    const fixture = scaleView();
    await withSettings(fixture, async (container) => {
        const card = container.querySelector("article");
        assert(card);
        const search = card.querySelector<HTMLInputElement>('input[type="search"]');
        assert(search);
        await act(() => search.focus());
        await act(() => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
            assert(setter);
            setter.call(search, "Service 79");
            search.dispatchEvent(new Event("input", { bubbles: true }));
            search.dispatchEvent(new window.KeyboardEvent("keyup", { bubbles: true, key: "9" }));
        });
        const options = card.querySelector(".rw-usage-project-options");
        assertEquals(options?.querySelectorAll('input[type="checkbox"]').length, 1);
        const checkbox = options?.querySelector<HTMLInputElement>('input[type="checkbox"]');
        assert(checkbox);
        await act(() => checkbox.click());
        let savedIds: string[] = [];
        globalThis.fetch = async (_input, init) => {
            assert(typeof init?.body === "string");
            const request: { projectIds: string[] } = JSON.parse(init.body);
            savedIds = request.projectIds;
            return Response.json(fixture);
        };
        const form = search.closest("form");
        assert(form);
        await act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
        assertEquals(savedIds, ["project-0", "project-79"]);
    });
});
