// @ts-nocheck: Deno test imports browser-shell helpers with a small fake DOM.
import { readFile as fsReadFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert, strictEqual as assertStrictEquals } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import {
    applyActiveRoute,
    applySessionName,
    clampSidebarWidth,
    currentRouteFromUrl,
    installSidebarResize,
    installWorkspaceShellBrowser,
    LAST_SESSION_KEY,
    loadMoreSidebarSessions,
    refreshSidebarForPage,
    renderSidebar,
    shouldApplySidebarRefresh,
    sidebarProjectOrder,
    sidebarSessionOrder,
} from "./static/workspace-shell.ts";

test("Workspace sidebar resizing respects panel and conversation bounds", () => {
    assertEquals(clampSidebarWidth(100, 1440), 220);
    assertEquals(clampSidebarWidth(360, 1440), 360);
    assertEquals(clampSidebarWidth(700, 1440), 480);
    assertEquals(clampSidebarWidth(480, 870), 450);
});

test("Workspace home stays on the Attention Dashboard and reuses its sidebar", async () => {
    const { document, sidebar } = installFakeBrowser("/");
    const stored = new Map([[
        LAST_SESSION_KEY,
        JSON.stringify({ projectId: "project-a", runwieldSessionId: "session-a" }),
    ]]);
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: { getItem: (key) => stored.get(key) || null, setItem: (key, value) => stored.set(key, value) },
    });
    const previousFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = (url) => {
        requests.push(url);
        return Promise.resolve(Response.json({
            projects: [{
                projectId: "project-a",
                displayName: "Project A",
                enabled: true,
                sessions: [{ runwieldSessionId: "session-a", displayName: "Recent conversation" }],
            }],
        }));
    };
    const destinations = [];
    document.addEventListener("runwield:workspace-navigate", (event) => {
        event.preventDefault();
        destinations.push(event.detail.href);
        assert(sidebar.querySelector('[data-sidebar-session="session-a"]'));
        globalThis.location.pathname = event.detail.href;
        globalThis.location.href = `http://workspace.local${event.detail.href}`;
    });
    try {
        await refreshSidebarForPage();
        const row = sidebar.querySelector('[data-sidebar-session="session-a"]');
        await refreshSidebarForPage();
        assertEquals(destinations, []);
        assertEquals(requests.filter((url) => url === "/api/owner/sidebar").length, 2);
        assertEquals(requests.filter((url) => url === "/api/owner/projects").length, 2);
        assertStrictEquals(sidebar.querySelector('[data-sidebar-session="session-a"]'), row);
        assertEquals(
            document.querySelector('[aria-label="RunWield Workspace home"]').href,
            "/projects/project-a/sessions/session-a",
        );
    } finally {
        globalThis.fetch = previousFetch;
    }
});

class FakeClassList {
    constructor(element) {
        this.element = element;
    }
    _classes() {
        return new Set(String(this.element.className || "").split(/\s+/).filter(Boolean));
    }
    add(...names) {
        const classes = this._classes();
        names.forEach((name) => classes.add(name));
        this.element.className = [...classes].join(" ");
    }
    remove(...names) {
        const classes = this._classes();
        names.forEach((name) => classes.delete(name));
        this.element.className = [...classes].join(" ");
    }
    contains(name) {
        return this._classes().has(name);
    }
    toggle(name, force) {
        const shouldHave = force === undefined ? !this.contains(name) : Boolean(force);
        if (shouldHave) this.add(name);
        else this.remove(name);
    }
}

class FakeElement {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.parentElement = null;
        this.attributes = new Map();
        this.listeners = new Map();
        this.styles = new Map();
        this.style = { setProperty: (name, value) => this.styles.set(name, value) };
        this.className = "";
        this.dataset = new Proxy({}, {
            set: (_target, key, value) => {
                this.setAttribute(
                    `data-${String(key).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
                    value,
                );
                return true;
            },
            deleteProperty: (_target, key) => {
                this.removeAttribute(`data-${String(key).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
                return true;
            },
            get: (_target, key) =>
                this.getAttribute(`data-${String(key).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`),
        });
        this.classList = new FakeClassList(this);
        this._textContent = "";
    }
    set textContent(value) {
        this.children = [];
        this._textContent = String(value);
    }
    get textContent() {
        return this._textContent || this.children.map((child) => child.textContent).join("");
    }
    get childNodes() {
        return this.children;
    }
    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }
    dispatchEvent(event) {
        for (const listener of this.listeners.get(event.type) || []) listener(event);
        return !event.defaultPrevented;
    }
    focus() {
        globalThis.document.activeElement = this;
    }
    getBoundingClientRect() {
        return { left: 0, width: 1440 };
    }
    setPointerCapture(pointerId) {
        this.capturedPointer = pointerId;
    }
    set innerHTML(value) {
        this.children = [];
        this._textContent = String(value).replace(/<[^>]+>/g, "");
        for (const className of String(value).matchAll(/class="([^"]+)"/g)) {
            const child = new FakeElement("span");
            child.className = className[1];
            this.append(child);
        }
    }
    append(...nodes) {
        for (const node of nodes) {
            node.parentElement?.removeChild(node);
            node.parentElement = this;
            this.children.push(node);
        }
    }
    prepend(...nodes) {
        for (const node of nodes) {
            node.parentElement?.removeChild(node);
            node.parentElement = this;
        }
        this.children.unshift(...nodes);
    }
    before(...nodes) {
        const parent = this.parentElement;
        if (!parent) return;
        const index = parent.children.indexOf(this);
        for (const node of nodes) {
            node.parentElement?.removeChild(node);
            node.parentElement = parent;
        }
        parent.children.splice(index, 0, ...nodes);
    }
    replaceChildren(...nodes) {
        this._textContent = "";
        this.children.forEach((child) => child.parentElement = null);
        this.children = [];
        this.append(...nodes);
    }
    removeChild(node) {
        const index = this.children.indexOf(node);
        if (index >= 0) this.children.splice(index, 1);
        node.parentElement = null;
    }
    remove() {
        this.parentElement?.removeChild(this);
    }
    setAttribute(name, value) {
        if (name === "class") this.className = String(value);
        else this.attributes.set(name, String(value));
    }
    getAttribute(name) {
        if (name === "class") return this.className;
        return this.attributes.get(name) ?? null;
    }
    removeAttribute(name) {
        if (name === "class") this.className = "";
        else this.attributes.delete(name);
    }
    closest(selector) {
        return this._matches(selector) ? this : this.parentElement?.closest(selector) || null;
    }
    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }
    querySelectorAll(selector) {
        const direct = selector.startsWith(":scope > ");
        const simple = direct ? selector.slice(9) : selector;
        const candidates = direct ? [...this.children] : this._descendants();
        return candidates.filter((node) => node._matches(simple));
    }
    _descendants() {
        return this.children.flatMap((child) => [child, ...child._descendants()]);
    }
    _matches(selector) {
        if (selector === "span" || selector === "small") return this.tagName.toLowerCase() === selector;
        if (selector.startsWith(".")) return String(this.className).split(/\s+/).includes(selector.slice(1));
        const attrEquals = /^\[([^=\]]+)="([^"]*)"\]$/.exec(selector);
        if (attrEquals) return this.getAttribute(attrEquals[1]) === attrEquals[2];
        const attr = /^\[([^\]]+)\]$/.exec(selector);
        if (attr) return this.getAttribute(attr[1]) !== null;
        return false;
    }
}

class FakeDocument extends FakeElement {
    constructor() {
        super("document");
        this.readyState = "complete";
        this.listeners = new Map();
    }
    createElement(tagName) {
        return new FakeElement(tagName);
    }
    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }
    dispatchEvent(event) {
        for (const listener of this.listeners.get(event.type) || []) listener(event);
        return !event.defaultPrevented;
    }
}

function installFakeBrowser(pathname = "/projects/project-a/sessions/session-a") {
    const document = new FakeDocument();
    const shell = document.createElement("div");
    shell.className = "workspace-shell-with-sidebar";
    const sidebar = document.createElement("aside");
    sidebar.className = "workspace-sidebar";
    sidebar.dataset.workspaceSidebar = "";
    sidebar.append(
        Object.assign(document.createElement("p"), {
            className: "workspace-sidebar-empty",
            textContent: "Loading Workspace…",
        }),
    );
    const header = document.createElement("div");
    header.dataset.workspaceMainHeaderLeft = "";
    shell.append(sidebar, header);
    document.append(shell);
    globalThis.document = document;
    globalThis.location = { href: `http://workspace.local${pathname}`, pathname, assign() {}, replace() {} };
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        writable: true,
        value: { getItem: () => null, setItem() {} },
    });
    globalThis.CSS = { escape: (value) => String(value) };
    return { document, sidebar };
}

test("Workspace shell maps owner review and artifact routes back to the owning Session", () => {
    assertEquals(currentRouteFromUrl("http://workspace.local/projects/project-a/sessions/session-a"), {
        kind: "session",
        projectId: "project-a",
        runwieldSessionId: "session-a",
    });
    assertEquals(currentRouteFromUrl("http://workspace.local/projects/project-a/sessions/session-a/review/code"), {
        kind: "session",
        projectId: "project-a",
        runwieldSessionId: "session-a",
    });
    assertEquals(
        currentRouteFromUrl("http://workspace.local/projects/project-a/sessions/session-a/artifacts/artifact-a"),
        {
            kind: "session",
            projectId: "project-a",
            runwieldSessionId: "session-a",
        },
    );
    assertEquals(currentRouteFromUrl("http://workspace.local/projects/project-a/plans/plan-a?session=session-a"), {
        kind: "session",
        projectId: "project-a",
        runwieldSessionId: "session-a",
    });
});

test("an older Session uses its persisted name even outside the sidebar's first page", () => {
    const { document } = installFakeBrowser("/projects/project-a/sessions/older-session");
    const current = currentRouteFromUrl(globalThis.location.href);
    const payload = { projects: [{ projectId: "project-a", displayName: "Project A", enabled: true, sessions: [] }] };
    renderSidebar(payload, current);
    applySessionName({ projectId: "project-a", runwieldSessionId: "older-session", name: "Saved older Session" });
    assertEquals(document.querySelector("[data-workspace-main-session-name]").textContent, "Saved older Session");
    renderSidebar(payload, current);
    assertEquals(document.querySelector("[data-workspace-main-session-name]").textContent, "Saved older Session");
    assertStringIncludes(
        document.querySelector('[data-sidebar-session="older-session"]').textContent,
        "Saved older Session",
    );
});

test("Workspace sidebar refreshes reject stale navigation responses", () => {
    assertEquals(shouldApplySidebarRefresh(2, 2, "http://workspace.local/a", "http://workspace.local/a"), true);
    assertEquals(shouldApplySidebarRefresh(1, 2, "http://workspace.local/a", "http://workspace.local/a"), false);
    assertEquals(shouldApplySidebarRefresh(2, 2, "http://workspace.local/a", "http://workspace.local/b"), false);
});

test("Workspace sidebar reconciliation keeps only loaded older Sessions while inserting new server rows first", () => {
    const order = sidebarSessionOrder(
        {
            projectId: "project-a",
            sessions: [
                { runwieldSessionId: "ordinary", displayName: "Ordinary" },
                { runwieldSessionId: "loaded-old", displayName: "Loaded old", loaded: true },
            ],
        },
        {
            projectId: "project-a",
            sessions: [{ runwieldSessionId: "new", displayName: "New Session" }],
        },
    );
    assertEquals(order.map((session) => session.runwieldSessionId), ["new", "loaded-old"]);
});

test("Workspace sidebar drops active omitted Sessions after the user navigates away", () => {
    const { sidebar } = installFakeBrowser("/projects/project-a/sessions/omitted");
    const payload = {
        projects: [{
            projectId: "project-a",
            displayName: "Project A",
            enabled: true,
            hasMoreSessions: true,
            sessions: [
                { runwieldSessionId: "session-a", displayName: "Alpha", state: "idle" },
            ],
        }],
    };

    applySessionName({ projectId: "project-a", runwieldSessionId: "omitted", name: "An older conversation" });
    renderSidebar(payload, { kind: "session", projectId: "project-a", runwieldSessionId: "omitted" });

    const omitted = sidebar.querySelector('[data-sidebar-session="omitted"]');
    assert(omitted);
    assertEquals(omitted.getAttribute("data-sidebar-loaded"), null);

    renderSidebar(payload, { kind: "session", projectId: "project-a", runwieldSessionId: "session-a" });

    assertEquals(sidebar.querySelector('[data-sidebar-session="omitted"]'), null);
});

test("Workspace sidebar project reconciliation removes Projects omitted by the server", () => {
    const order = sidebarProjectOrder(
        [{ projectId: "project-a", sessions: [] }, { projectId: "loaded-project", sessions: [] }],
        [{ projectId: "project-a", displayName: "Project A", enabled: true, sessions: [] }],
    );
    assertEquals(order.map((project) => project.projectId), ["project-a"]);
});

test("Workspace sidebar updates rows in place, inserts new Sessions, removes stale rows, and preserves expansion", () => {
    const { sidebar } = installFakeBrowser();
    const current = { kind: "session", projectId: "project-a", runwieldSessionId: "session-a" };
    renderSidebar({
        projects: [{
            projectId: "project-a",
            displayName: "Project A",
            enabled: true,
            sessions: [
                { runwieldSessionId: "session-a", displayName: "Alpha", state: "idle" },
                { runwieldSessionId: "ordinary", displayName: "Ordinary", state: "idle" },
            ],
        }],
    }, current);
    const project = sidebar.querySelector('[data-sidebar-project="project-a"]');
    project.setAttribute("open", "");
    const alpha = sidebar.querySelector('[data-sidebar-session="session-a"]');

    renderSidebar({
        projects: [{
            projectId: "project-a",
            displayName: "Project A",
            enabled: true,
            sessions: [
                { runwieldSessionId: "new-session", displayName: "New", state: "idle" },
                { runwieldSessionId: "session-a", displayName: "Alpha Renamed", state: "busy" },
            ],
        }],
    }, current);

    assertStrictEquals(sidebar.querySelector('[data-sidebar-session="session-a"]'), alpha);
    assertEquals(alpha.querySelector("span").textContent, "Alpha Renamed");
    assertEquals(alpha.querySelector("small").textContent, "busy");
    assert(sidebar.querySelector('[data-sidebar-session="new-session"]'));
    assertEquals(sidebar.querySelector('[data-sidebar-session="ordinary"]'), null);
    assertEquals(project.getAttribute("open"), "");
    assertEquals(sidebar.querySelectorAll(":scope > .workspace-sidebar-empty").length, 0);
});

test("Workspace sidebar refresh keeps focus on Show more controls", () => {
    const { document, sidebar } = installFakeBrowser("/projects/project-a/plans/plan-1");
    const payload = {
        projects: [{
            projectId: "project-a",
            displayName: "Project A",
            enabled: true,
            plans: Array.from({ length: 6 }, (_, index) => ({
                planId: `plan-${index + 1}`,
                title: `Plan ${index + 1}`,
                status: "ready_for_work",
                statusLabel: "Ready",
            })),
            sessions: [],
        }],
    };

    renderSidebar(payload, currentRouteFromUrl(globalThis.location.href));
    const button = sidebar.querySelector('[data-show-more-plans="project-a"]');
    button.focus();
    renderSidebar(payload, currentRouteFromUrl(globalThis.location.href));

    assertEquals(document.activeElement.getAttribute("data-show-more-plans"), "project-a");
    assertEquals(document.activeElement.getAttribute("data-sidebar-plan"), null);
});

test("Workspace sidebar active route uses both Project and Session keys", () => {
    installFakeBrowser("/projects/project-b/sessions/shared");
    renderSidebar({
        projects: [
            {
                projectId: "project-a",
                displayName: "Project A",
                enabled: true,
                sessions: [{ runwieldSessionId: "shared", displayName: "Wrong" }],
            },
            {
                projectId: "project-b",
                displayName: "Project B",
                enabled: true,
                sessions: [{ runwieldSessionId: "shared", displayName: "Right" }],
            },
        ],
    }, { kind: "session", projectId: "project-b", runwieldSessionId: "shared" });
    applyActiveRoute({ kind: "session", projectId: "project-b", runwieldSessionId: "shared" });
    const rows = globalThis.document.querySelectorAll('[data-sidebar-session="shared"]');
    assertEquals(rows.map((row) => row.classList.contains("active")), [false, true]);
    assertStringIncludes(globalThis.document.querySelector("[data-workspace-main-session-name]").textContent, "Right");
});

test("Plan Board navigation stays active across board views and clears on Session navigation", () => {
    const { document } = installFakeBrowser("/projects/project-a/plans");
    const payload = {
        projects: ["project-a", "project-b"].map((projectId) => ({
            projectId,
            displayName: projectId,
            enabled: true,
            sessions: [],
        })),
    };
    renderSidebar(payload, currentRouteFromUrl("/projects/project-a/plans"));
    const first = document.querySelector('[data-sidebar-plan-board="project-a"]');
    const second = document.querySelector('[data-sidebar-plan-board="project-b"]');
    assert(first.classList.contains("active"));
    assertEquals(first.getAttribute("aria-current"), "page");
    assertEquals(second.classList.contains("active"), false);
    for (const suffix of ["", "/closed", "/on-hold/"]) {
        const route = currentRouteFromUrl(`/projects/project-b/plans${suffix}?q=search`);
        applyActiveRoute(route);
        assertEquals(first.classList.contains("active"), false);
        assertEquals(first.getAttribute("aria-current"), null);
        assert(second.classList.contains("active"));
        assertEquals(second.getAttribute("aria-current"), "page");
    }
    applyActiveRoute(currentRouteFromUrl("/projects/project-b/sessions/session-a"));
    assertEquals(second.classList.contains("active"), false);
    assertEquals(second.getAttribute("aria-current"), null);
    assertEquals(currentRouteFromUrl("/projects/project-b/plans/a-plan").kind, "plan");
});

test("Workspace shell shares startup requests and preserves scroll across page swaps", async () => {
    const { document, sidebar } = installFakeBrowser();
    let refreshes = 0;
    globalThis.fetch = () => {
        refreshes += 1;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ projects: [] }) });
    };
    installWorkspaceShellBrowser();
    installWorkspaceShellBrowser();
    document.dispatchEvent(new CustomEvent("astro:page-load"));
    document.dispatchEvent(new CustomEvent("astro:page-load"));
    await Promise.resolve();
    assertEquals(refreshes, 1);
    for (const scrollTop of [812, 547]) {
        sidebar.scrollTop = scrollTop;
        document.dispatchEvent(new CustomEvent("astro:before-swap"));
        // Moving a persisted element between document bodies can reset its scroll.
        sidebar.scrollTop = 0;
        document.dispatchEvent(new CustomEvent("astro:after-swap"));
        assertEquals(sidebar.scrollTop, scrollTop);
    }
});

test("Workspace sidebar resize supports keyboard, pointer, and persisted width", () => {
    const { document } = installFakeBrowser();
    const stored = new Map();
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: { getItem: (key) => stored.get(key) || null, setItem: (key, value) => stored.set(key, value) },
    });
    installSidebarResize();
    installSidebarResize();
    const shell = document.querySelector(".workspace-shell-with-sidebar");
    const handles = shell.querySelectorAll(".workspace-sidebar-resizer");
    assertEquals(handles.length, 1);
    const handle = handles[0];
    handle.dispatchEvent({ type: "keydown", key: "ArrowRight", preventDefault() {} });
    assertEquals(handle.getAttribute("aria-valuenow"), "296");
    handle.dispatchEvent({ type: "pointerdown", button: 0, pointerId: 1, preventDefault() {} });
    handle.dispatchEvent({ type: "pointermove", clientX: 380 });
    handle.dispatchEvent({ type: "pointerup" });
    assertEquals(shell.styles.get("--rw-workspace-sidebar-width"), "380px");
    assertEquals(stored.get("runwield:owner:sidebar-width"), "380");
    handle.remove();
    installSidebarResize();
    assertEquals(shell.querySelector(".workspace-sidebar-resizer").getAttribute("aria-valuenow"), "380");
});

test("Workspace shell is event-driven and does not poll the sidebar", async () => {
    const shell = await fsReadFile(new URL("./static/workspace-shell.ts", import.meta.url), "utf8");
    assertStringIncludes(shell, 'document.addEventListener("astro:page-load", installWorkspaceShell)');
    assertStringIncludes(shell, 'ownerJson("/api/owner/sidebar"');
    assertEquals(/setInterval\s*\(/.test(shell), false);
    assertEquals(shell.includes("setTimeout(()"), false);
    assertEquals(/visibilitychange[^\n]+sidebar/.test(shell), false);
});

test("Workspace owner layout persists the real sidebar and owns navigation", async () => {
    const layout = await fsReadFile(new URL("./layouts/WorkspaceLayout.astro", import.meta.url), "utf8");
    assertStringIncludes(layout, 'import { ClientRouter } from "astro:transitions";');
    assertStringIncludes(layout, "<ClientRouter />");
    assertStringIncludes(layout, 'transition:name="workspace-sidebar" transition:persist');
    assertStringIncludes(layout, 'document.addEventListener("runwield:workspace-navigate"');
    assertEquals(layout.includes("__runwieldWorkspaceNavigate"), false);
    assertStringIncludes(layout, '<script is:inline type="module" src="/workspace-shell.js"></script>');
});

test("artifact and review headers keep one surface title and a reachable Workspace restore control", () => {
    const { document } = installFakeBrowser("/projects/project-a/sessions/session-a/artifacts/artifact-a");
    const header = document.querySelector("[data-workspace-main-header-left]");
    const title = document.createElement("strong");
    title.dataset.workspaceSurfaceTitle = "";
    title.textContent = "Artifact title";
    header.append(title);
    const payload = { projects: [{ projectId: "project-a", displayName: "Project A", enabled: true, sessions: [] }] };
    const current = currentRouteFromUrl(globalThis.location.href);
    renderSidebar(payload, current);
    renderSidebar(payload, current);
    assertEquals(header.querySelector("[data-workspace-main-session-name]"), null);
    assertEquals(header.children.length, 2);
    assertStrictEquals(header.children[1], title);
    assertEquals(header.children[0].getAttribute("aria-label"), "Open Workspace sidebar");
});

test("Workspace mobile navigation fills each Project before slow workflow details arrive", async () => {
    const { document, sidebar } = installFakeBrowser("/");
    const originalFetch = globalThis.fetch;
    const originalMatchMedia = globalThis.matchMedia;
    globalThis.matchMedia = () => ({ matches: true });
    const pending = new Map();
    globalThis.fetch = (url) => new Promise((resolve) => pending.set(url, resolve));
    const settle = async (url, value, status = 200) => {
        assert(pending.has(url), `Missing request: ${url}`);
        pending.get(url)(Response.json(value, { status }));
        for (let index = 0; index < 30; index++) await Promise.resolve();
    };
    try {
        const refresh = refreshSidebarForPage();
        assert(sidebar.querySelector(".workspace-sidebar-new"));
        assert(document.querySelector("[data-workspace-sidebar-restore]"));
        assert(sidebar.querySelector("[data-workspace-sidebar-collapse]"));
        document.querySelector(".workspace-shell-with-sidebar").classList.add("workspace-sidebar-overlay-open");
        assertStringIncludes(sidebar.textContent, "Loading Projects");
        assertEquals(sidebar.textContent.includes("No Projects"), false);
        const projects = ["a", "b"].map((id) => ({ projectId: id, displayName: `Project ${id}`, enabled: true }));
        await settle("/api/owner/projects", { projects });
        assertEquals(sidebar.querySelector(".workspace-sidebar-new").href, "/projects/a/sessions/new");
        assert(sidebar.querySelector('[data-sidebar-project="a"]'));
        assertStringIncludes(sidebar.textContent, "Loading Sessions");
        assertEquals(sidebar.textContent.includes("No active Plans"), false);
        await settle("/api/owner/projects/b/sessions?pageSize=5&includeTotal=false", {
            sessions: [{ runwieldSessionId: "recent-b", displayName: "Continue this Session" }],
            hasNext: true,
        });
        const row = sidebar.querySelector('[data-sidebar-session="recent-b"]');
        assert(row);
        assertEquals(row.href, "/projects/b/sessions/recent-b");
        const project = sidebar.querySelector('[data-sidebar-project="b"]');
        project.setAttribute("open", "");
        sidebar.scrollTop = 312;
        await settle("/api/owner/sidebar", { error: "Workflow reader unavailable" }, 503);
        assertStrictEquals(sidebar.querySelector('[data-sidebar-session="recent-b"]'), row);
        assertStringIncludes(sidebar.textContent, "Plans unavailable.");
        await settle("/api/owner/projects/a/sessions?pageSize=5&includeTotal=false", { sessions: [], hasNext: false });
        await refresh;
        assert(sidebar.querySelector(".workspace-sidebar-new"));
        assertEquals(project.getAttribute("open"), "");
        assertEquals(sidebar.scrollTop, 312);
        assert(
            document.querySelector(".workspace-shell-with-sidebar").classList.contains(
                "workspace-sidebar-overlay-open",
            ),
        );
        assertStringIncludes(sidebar.textContent, "No Sessions yet.");
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.matchMedia = originalMatchMedia;
    }
});

test("Workspace sidebar keeps controls when Projects fail to load", async () => {
    const { document, sidebar } = installFakeBrowser("/projects/project-a/sessions/session-a");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(Response.json({ error: "Unavailable" }, { status: 503 }));
    try {
        await refreshSidebarForPage();
        assertEquals(sidebar.querySelector(".workspace-sidebar-new").href, "/projects/project-a/sessions/new");
        assert(document.querySelector("[data-workspace-sidebar-restore]"));
        assertStringIncludes(sidebar.textContent, "Projects failed to load.");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("Show more loads five unseen Sessions, survives refresh and failure, and keeps paging", async () => {
    const { sidebar } = installFakeBrowser("/projects/project-a/sessions/s1");
    const sessions = Array.from(
        { length: 5 },
        (_, i) => ({ runwieldSessionId: `s${i + 1}`, displayName: `Session ${i + 1}` }),
    );
    const payload = {
        projects: [{
            projectId: "project-a",
            displayName: "A",
            enabled: true,
            hasMoreSessions: true,
            sessions,
            plans: [{ planId: "nested", title: "Nested", status: "ready_for_work", sessions: [] }],
        }],
    };
    const current = currentRouteFromUrl(globalThis.location.href);
    renderSidebar(payload, current);
    const button = sidebar.querySelector("[data-show-more-sessions]");
    const originalFetch = globalThis.fetch;
    const pending = Promise.withResolvers();
    const urls = [];
    try {
        globalThis.fetch = (url) => {
            urls.push(new URL(url, "http://workspace.local"));
            return pending.promise;
        };
        const first = loadMoreSidebarSessions(button);
        await loadMoreSidebarSessions(button);
        assertEquals(urls.length, 1);
        assertEquals(urls[0].searchParams.get("pageSize"), "5");
        assertEquals(urls[0].searchParams.get("includeTotal"), "false");
        assertEquals(urls[0].searchParams.getAll("excludeSession"), ["s1", "s2", "s3", "s4", "s5"]);
        assertEquals(urls[0].searchParams.getAll("nestedPlan"), ["nested"]);
        renderSidebar(payload, current);
        assertEquals(button.getAttribute("disabled"), "true");
        assertStringIncludes(button.textContent, "Loading");
        pending.resolve(
            Response.json({
                sessions: Array.from(
                    { length: 5 },
                    (_, i) => ({ runwieldSessionId: `s${i + 6}`, displayName: `Session ${i + 6}` }),
                ),
                hasNext: true,
            }),
        );
        await first;
        assertEquals(sidebar.querySelectorAll("[data-sidebar-session]").length, 10);
        assertEquals(button.hidden, false);
        globalThis.fetch = () => Promise.resolve(Response.json({ error: "Workspace unavailable" }, { status: 503 }));
        await loadMoreSidebarSessions(button);
        assertEquals(sidebar.querySelectorAll("[data-sidebar-session]").length, 10);
        assertEquals(button.textContent, "Retry loading Sessions");
        globalThis.fetch = (url) => {
            assertEquals(new URL(url, "http://workspace.local").searchParams.getAll("excludeSession").length, 10);
            return Promise.resolve(
                Response.json({
                    sessions: [{ runwieldSessionId: "s11", displayName: "Last Session" }],
                    hasNext: false,
                }),
            );
        };
        await loadMoreSidebarSessions(button);
        renderSidebar(payload, current);
        assertEquals(sidebar.querySelectorAll("[data-sidebar-session]").length, 11);
        assertEquals(button.hidden, true);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("New Session link prefers current enabled Project, then remembered enabled Project", () => {
    const { document } = installFakeBrowser("/projects/project-a/sessions/new");
    const projects = [
        { projectId: "project-a", displayName: "A", enabled: true, sessions: [] },
        { projectId: "project-b", displayName: "B", enabled: true, sessions: [] },
    ];
    let remembered = "project-b";
    globalThis.localStorage = { getItem: () => JSON.stringify({ projectId: remembered }), setItem() {} };
    const link = () => document.querySelector(".workspace-sidebar-new").href;
    renderSidebar({ projects }, { kind: "project", projectId: "project-a" });
    assertEquals(link(), "/projects/project-a/sessions/new");
    renderSidebar({ projects }, { kind: "home" });
    assertEquals(link(), "/projects/project-b/sessions/new");
    remembered = "removed";
    renderSidebar({ projects }, { kind: "home" });
    assertEquals(link(), "/projects/project-a/sessions/new");
    renderSidebar({ projects: projects.map((project) => ({ ...project, enabled: false })) }, { kind: "home" });
    assertEquals(link(), "/projects");
});

test("Plan-associated sidebar Sessions keep open links and show Archived status", () => {
    const { document } = installFakeBrowser();
    renderSidebar({
        projects: [{
            projectId: "project-a",
            displayName: "Project A",
            enabled: true,
            sessions: [],
            plans: [{
                planId: "plan-a",
                title: "Plan A",
                sessions: [{
                    runwieldSessionId: "saved",
                    displayName: "Saved conversation",
                    state: "idle",
                    archivedAt: "2026-10-02",
                }],
            }],
        }],
    }, { kind: "plan", projectId: "project-a", planId: "plan-a" });
    const row = document.querySelector('[data-sidebar-session="saved"]');
    assertEquals(row.href, "/projects/project-a/sessions/saved");
    assertEquals(row.querySelector("small").textContent, "Archived");
});
