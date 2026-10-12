// @ts-nocheck: browser component tests provide a small DOM boundary.
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { Window } from "happy-dom";
import { RunWieldSearchDialog } from "../design-system/components/react/RunWieldSearchPrimitives.tsx";
import { fullSearchHref, resultHref, UnifiedWorkspaceSearch } from "./react/UnifiedWorkspaceSearch.tsx";

function payload(query: string, page = 1, title = query) {
    return {
        query,
        page,
        pageSize: 20,
        total: 25,
        projects: [{ projectId: "project-1", name: "Project One" }],
        contentTypes: ["plan", "work-record"],
        states: [{ projectId: "project-1", state: "ready" }],
        results: [{
            id: `project-1:work-record:${title}`,
            projectId: "project-1",
            projectName: "Project One",
            contentType: "work-record",
            sourceId: "record-1",
            title,
            snippet: "Current result",
            destination: "/projects/project-1/artifacts/work-record/cmVjb3JkLTE",
            freshness: "current",
            completionMode: "done_enough",
            sourceLinks: ["source-plan"],
            notices: ["Deferred work remains."],
        }],
    };
}

function response(body: unknown) {
    return Promise.resolve(
        new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
        }),
    );
}

test("full Search pages page results and show Work Record evidence", async () => {
    const previous = {
        document: globalThis.document,
        location: globalThis.location,
        history: globalThis.history,
        fetch: globalThis.fetch,
        act: globalThis.IS_REACT_ACT_ENVIRONMENT,
    };
    const requested: string[] = [];
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.document = { cookie: "" };
    globalThis.location = { search: "?q=needle", origin: "http://workspace.test", assign() {} };
    globalThis.history = {
        state: null,
        replaceState(_state, _unused, href) {
            this.href = href;
        },
    };
    globalThis.fetch = (input) => {
        const url = String(input);
        requested.push(url);
        const page = Number(new URL(url, "http://workspace.test").searchParams.get("page") || 1);
        return response(payload("needle", page, `Needle page ${page}`));
    };
    const { createElement } = await import("react");
    const { act, create } = await import("react-test-renderer");
    let renderer;
    try {
        await act(() => {
            renderer = create(createElement(UnifiedWorkspaceSearch, { fullPage: true }));
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 150));
        });
        const text = JSON.stringify(renderer.toJSON());
        assertStringIncludes(text, "Completion confidence: ");
        assertStringIncludes(text, "done enough");
        assertStringIncludes(text, "source-plan");
        assertStringIncludes(text, "Deferred work remains.");
        const next = renderer.root.findAllByType("button").find((button) => button.children.includes("Next"));
        await act(() => {
            next.props.onClick();
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 150));
        });
        assertEquals(requested.some((url) => url.includes("page=2")), true);
        assertEquals(globalThis.history.href, "/search?q=needle&page=2");
        const pagination = renderer.root.findByProps({ "aria-label": "Search result pages" });
        assertEquals(pagination.findByType("span").children.join(""), "Page 2 of 2");
    } finally {
        if (renderer) await act(() => renderer.unmount());
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete globalThis[key];
            else globalThis[key] = value;
        }
    }
});

test("a refresh response cannot replace a newer Search query", async () => {
    const previous = {
        document: globalThis.document,
        location: globalThis.location,
        history: globalThis.history,
        fetch: globalThis.fetch,
        act: globalThis.IS_REACT_ACT_ENVIRONMENT,
    };
    let releaseRefresh;
    let oldGets = 0;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.document = { cookie: "rw_owner_csrf=token" };
    globalThis.location = { search: "?q=old", origin: "http://workspace.test", assign() {} };
    globalThis.history = { state: null, replaceState() {} };
    globalThis.fetch = (input, init = {}) => {
        const url = String(input);
        if (url === "/api/owner/search/refresh" && init.method === "POST") {
            return new Promise((resolve) =>
                releaseRefresh = () =>
                    resolve(
                        new Response('{"refreshed":true}', { status: 200 }),
                    )
            );
        }
        const query = new URL(url, "http://workspace.test").searchParams.get("q") || "";
        if (query === "old") oldGets += 1;
        return response(payload(query, 1, query === "old" && oldGets > 1 ? "Stale old result" : `${query} result`));
    };
    const { createElement } = await import("react");
    const { act, create } = await import("react-test-renderer");
    let renderer;
    try {
        await act(() => {
            renderer = create(createElement(UnifiedWorkspaceSearch, { fullPage: true }));
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 150));
        });
        const refresh = renderer.root.findAllByType("button").find((button) => button.children.includes("Refresh"));
        await act(() => {
            refresh.props.onClick();
        });
        const input = renderer.root.findByType("input");
        await act(() => {
            input.props.onChange({ target: { value: "new" } });
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 150));
        });
        await act(async () => {
            releaseRefresh();
            await new Promise((resolve) => setTimeout(resolve, 10));
        });
        const rendered = JSON.stringify(renderer.toJSON());
        assertStringIncludes(rendered, "new result");
        assertEquals(rendered.includes("Stale old result"), false);
    } finally {
        if (renderer) await act(() => renderer.unmount());
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete globalThis[key];
            else globalThis[key] = value;
        }
    }
});

test("quick Search View all results carries the query and filters", async () => {
    const previous = {
        location: globalThis.location,
        act: globalThis.IS_REACT_ACT_ENVIRONMENT,
    };
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.location = { search: "", origin: "http://workspace.test", assign() {} };
    const { createElement } = await import("react");
    const { act, create } = await import("react-test-renderer");
    let renderer;
    try {
        await act(() => {
            renderer = create(createElement(UnifiedWorkspaceSearch, {}));
        });
        const input = renderer.root.findByType("input");
        await act(() => {
            input.props.onChange({ target: { value: "needle" } });
        });
        const selects = renderer.root.findAllByType("select");
        await act(() => {
            selects[0].props.onChange({ target: { value: "project-1" } });
        });
        await act(() => {
            selects[1].props.onChange({ target: { value: "plan" } });
        });
        const link = renderer.root.findAllByType("a").find((anchor) => anchor.children.includes("View all results"));
        assertEquals(link.props.href, "/search?q=needle&project=project-1&type=plan");
    } finally {
        if (renderer) await act(() => renderer.unmount());
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete globalThis[key];
            else globalThis[key] = value;
        }
    }
});

test("quick and full Search keep result order and support focus and keyboard navigation", async () => {
    const previous = {
        document: globalThis.document,
        location: globalThis.location,
        history: globalThis.history,
        fetch: globalThis.fetch,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        addEventListener: globalThis.addEventListener,
        removeEventListener: globalThis.removeEventListener,
        act: globalThis.IS_REACT_ACT_ENVIRONMENT,
    };
    let shortcutListener;
    let focused = false;
    let assigned = "";
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.document = { cookie: "" };
    globalThis.location = {
        search: "?q=needle",
        origin: "http://workspace.test",
        assign(href) {
            assigned = href;
        },
    };
    globalThis.history = { state: null, replaceState() {} };
    globalThis.requestAnimationFrame = (callback) => {
        callback(0);
        return 1;
    };
    globalThis.addEventListener = (type, listener) => {
        if (type === "keydown") shortcutListener = listener;
    };
    globalThis.removeEventListener = () => {};
    const ordered = payload("needle");
    ordered.total = 2;
    ordered.results = [
        { ...ordered.results[0], id: "first", sourceId: "first", title: "First result" },
        {
            ...ordered.results[0],
            id: "second",
            sourceId: "second",
            title: "Second result",
            destination: "/projects/project-1/artifacts/work-record/c2Vjb25k",
        },
    ];
    globalThis.fetch = () => response(ordered);
    const { createElement } = await import("react");
    const { act, create } = await import("react-test-renderer");
    const titles = (renderer) => renderer.root.findAllByType("strong").map((node) => node.children.join(""));
    let fullRenderer;
    let quickRenderer;
    try {
        await act(() => {
            fullRenderer = create(createElement(UnifiedWorkspaceSearch, { fullPage: true }));
        });
        await act(async () => await new Promise((resolve) => setTimeout(resolve, 150)));
        const fullOrder = titles(fullRenderer);

        globalThis.location.search = "";
        await act(() => {
            quickRenderer = create(createElement(UnifiedWorkspaceSearch, {}), {
                createNodeMock(element) {
                    if (element.type === "input") return { focus: () => focused = true };
                    if (element.type === "dialog") {
                        return {
                            open: false,
                            showModal() {
                                this.open = true;
                            },
                            close() {
                                this.open = false;
                            },
                        };
                    }
                    return {};
                },
            });
        });
        await act(() => {
            shortcutListener({ metaKey: true, ctrlKey: false, key: "k", preventDefault() {} });
        });
        const input = quickRenderer.root.findByType("input");
        await act(() => input.props.onChange({ target: { value: "needle" } }));
        await act(async () => await new Promise((resolve) => setTimeout(resolve, 150)));
        assertEquals(focused, true);
        assertEquals(titles(quickRenderer), fullOrder);

        await act(() => input.props.onKeyDown({ key: "ArrowDown", preventDefault() {} }));
        await act(() => input.props.onKeyDown({ key: "Enter", preventDefault() {} }));
        assertStringIncludes(assigned, "c2Vjb25k");
        await act(() => input.props.onKeyDown({ key: "Escape", preventDefault() {} }));
        assertEquals(quickRenderer.root.findByType(RunWieldSearchDialog).props.open, false);
    } finally {
        if (fullRenderer) await act(() => fullRenderer.unmount());
        if (quickRenderer) await act(() => quickRenderer.unmount());
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete globalThis[key];
            else globalThis[key] = value;
        }
    }
});

test("quick Search dialog traps focus and restores the opening control", async () => {
    const window = new Window();
    const browserGlobals = [
        "window",
        "document",
        "Node",
        "Element",
        "HTMLElement",
        "HTMLDialogElement",
        "Event",
        "KeyboardEvent",
    ];
    const previous = Object.fromEntries(browserGlobals.map((key) => [key, globalThis[key]]));
    const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
    for (const key of browserGlobals) globalThis[key] = key === "window" ? window : window[key];
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;

    const openingControl = window.document.createElement("button");
    const container = window.document.createElement("div");
    window.document.body.append(openingControl, container);
    openingControl.focus();

    const { createElement, act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container);
    const dialog = (open) =>
        createElement(
            RunWieldSearchDialog,
            { open, onClose() {} },
            createElement("button", { id: "first" }, "First"),
            createElement("button", { id: "last" }, "Last"),
        );
    try {
        await act(() => root.render(dialog(false)));
        await act(() => root.render(dialog(true)));
        const first = window.document.querySelector("#first");
        const last = window.document.querySelector("#last");

        last.focus();
        last.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
        assertEquals(window.document.activeElement, first);

        first.focus();
        first.dispatchEvent(
            new window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
        );
        assertEquals(window.document.activeElement, last);

        await act(() => root.render(dialog(false)));
        assertEquals(window.document.activeElement, openingControl);
    } finally {
        await act(() => root.unmount());
        await window.happyDOM.abort();
        for (const key of browserGlobals) {
            if (previous[key] === undefined) delete globalThis[key];
            else globalThis[key] = previous[key];
        }
        if (previousAct === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
        else globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
    }
});

test("quick Search destinations preserve one Search return URL", () => {
    const previousLocation = globalThis.location;
    globalThis.location = { origin: "http://workspace.test" };
    try {
        const state = fullSearchHref("needle", "project-1", "plan", 3);
        assertEquals(state, "/search?q=needle&project=project-1&type=plan&page=3");
        for (const contentType of ["plan", "session"]) {
            const href = resultHref(
                {
                    contentType,
                    destination: `/projects/project-1/${contentType}s/item-1`,
                },
                "needle",
                "project-1",
                contentType,
                3,
            );
            assertStringIncludes(href, "return=%2Fsearch%3Fq%3Dneedle");
            assertStringIncludes(href, "%26page%3D3");
        }
    } finally {
        if (previousLocation === undefined) delete globalThis.location;
        else globalThis.location = previousLocation;
    }
});
