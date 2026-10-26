import { mkdtemp as fsMkdtemp, rm as fsRm } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ok as assert, strictEqual as assertStrictEquals } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { runInNewContext } from "node:vm";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { createOwnerWorkspaceApp } from "./server.js";
import { WORKSPACE_MANIFEST, workspaceConnectionPage, workspaceWorkerSource } from "./server/workspace-pwa.ts";

test("Workspace installation assets are public without exposing owner data", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "workspace-pwa-"));
    const store = openOwnerCoordinationStore({ dbPath: `${dir}/owner.sqlite3` });
    const ownerApp = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: "http://127.0.0.1:8787", store });
    try {
        const app = ownerApp.handler();
        const response = await app(new Request("http://127.0.0.1:8787/workspace.webmanifest"));
        assertEquals(response.status, 200);
        assertStringIncludes(response.headers.get("content-type"), "application/manifest+json");
        const manifest = await response.json();
        assertEquals(manifest.start_url, "/");
        assertEquals(manifest.scope, "/");
        assertEquals(manifest.id, "/");
        assertEquals(manifest.display, "standalone");
        for (const icon of [...manifest.icons, { src: "/pwa/apple-touch-icon.png", sizes: "180x180" }]) {
            const image = await app(new Request(`http://127.0.0.1:8787${icon.src}`));
            assertEquals(image.status, 200);
            assertEquals(image.headers.get("content-type"), "image/png");
            const bytes = await image.arrayBuffer();
            const png = new DataView(bytes);
            assertEquals(png.getUint32(0), 0x89504e47);
            assertEquals(`${png.getUint32(16)}x${png.getUint32(20)}`, icon.sizes);
        }
        const worker = await app(new Request("http://127.0.0.1:8787/workspace-worker.js"));
        assertEquals(worker.status, 200);
        assertEquals(worker.headers.get("service-worker-allowed"), "/");
        assertEquals(worker.headers.get("cache-control"), "no-store");
        assertStringIncludes(await worker.text(), "Connect to Workspace");
        const pair = await app(new Request("http://127.0.0.1:8787/pair"));
        const page = await pair.text();
        assertStringIncludes(page, 'rel="manifest"');
        assertStringIncludes(page, 'src="/workspace-pwa.js"');
        assertEquals((await app(new Request("http://127.0.0.1:8787/api/owner/dashboard"))).status, 401);
        assertEquals((await app(new Request("http://unexpected.test/workspace-worker.js"))).status, 403);
    } finally {
        await ownerApp.close();
        store.close();
        await fsRm(dir, { recursive: true });
    }
});

/** @typedef {{type: string, connected: boolean}} ConnectionMessage */
/**
 * @typedef {Object} WorkerFetchEvent
 * @property {Request} request
 * @property {string} clientId
 * @property {(response: Promise<Response>) => void} respondWith
 * @property {(task: Promise<void>) => void} waitUntil
 */

function workerHarness() {
    /** @type {Map<string, (event: WorkerFetchEvent) => void>} */
    const listeners = new Map();
    /** @type {ConnectionMessage[]} */
    const messages = [];
    /** @type {Request[]} */
    const requests = [];
    /** @type {RequestInit[]} */
    const forwardingOptions = [];
    let available = true;
    let networkResponse = new Response("current server content");
    const context = {
        self: {
            location: { origin: "https://workspace.test" },
            addEventListener: listeners.set.bind(listeners),
            clients: {
                get: () =>
                    Promise.resolve({
                        postMessage: (/** @type {ConnectionMessage} */ message) => messages.push(message),
                    }),
                claim: () => Promise.resolve(),
            },
            skipWaiting: () => Promise.resolve(),
        },
        URL,
        Response,
        AbortSignal,
        fetch: (/** @type {Request} */ request, /** @type {RequestInit} */ options) => {
            requests.push(request);
            forwardingOptions.push(options);
            assertEquals(options.cache, "no-store");
            if (!available) return Promise.reject(new TypeError("Network unavailable"));
            return Promise.resolve(networkResponse.clone());
        },
        // Any accidental offline storage access fails the test.
        get caches() {
            throw new Error("Workspace must not cache responses");
        },
        get indexedDB() {
            throw new Error("Workspace must not queue offline actions");
        },
    };
    runInNewContext(workspaceWorkerSource("<h1>Connect to Workspace</h1><button>Try again</button>"), context);
    return {
        messages,
        requests,
        forwardingOptions,
        offline: () => {
            available = false;
        },
        online: () => {
            available = true;
        },
        reply: (/** @type {Response} */ response) => {
            networkResponse = response;
        },
        async request(/** @type {Request} */ request) {
            /** @type {Promise<Response>[]} */
            const responses = [];
            /** @type {Promise<void>[]} */
            const pending = [];
            listeners.get("fetch")?.({
                request,
                clientId: "page",
                respondWith: (value) => {
                    responses.push(value);
                },
                waitUntil: (value) => {
                    pending.push(value);
                },
            });
            const response = await (responses[0] || Promise.resolve(null));
            await Promise.all(pending);
            return response;
        },
    };
}

/** @param {string} [path] */
function navigation(path = "/projects/project/sessions/session") {
    const request = new Request(`https://workspace.test${path}`);
    Object.defineProperty(request, "mode", { value: "navigate" });
    return request;
}

test("installed Workspace opens a connection page offline and retries the original destination online", async () => {
    const worker = workerHarness();
    const request = navigation();
    assertEquals(await (await worker.request(request)).text(), "current server content");
    worker.offline();
    const offline = await worker.request(request);
    assertEquals(offline.status, 503);
    assertStringIncludes(offline.headers.get("content-type"), "text/html");
    assertStringIncludes(await offline.text(), "Connect to Workspace");
    assertEquals(worker.messages.at(-1).connected, false);
    worker.online();
    worker.reply(new Response("updated server content"));
    assertEquals(await (await worker.request(request)).text(), "updated server content");
    assertEquals(worker.messages.at(-1).connected, true);
    assertEquals(worker.requests.length, 3);
    assert(worker.requests.every((sent) => sent.url === request.url));
});

test("Workspace worker forwards review referrers and preserves requests that suppress them", async () => {
    const worker = workerHarness();
    const referrer =
        "https://workspace.test/projects/project/sessions/session/review/code?operation=review&interaction=code";
    // Supply browser-owned Request fields that Bun's Request constructor does not retain.
    const reviewRequest = new Request("https://workspace.test/api/file-content?path=modified.ts");
    Object.defineProperties(reviewRequest, {
        referrer: { value: referrer },
        referrerPolicy: { value: "same-origin" },
    });
    await worker.request(reviewRequest);
    assertEquals(worker.forwardingOptions[0].referrer, referrer);
    assertEquals(worker.forwardingOptions[0].referrerPolicy, "same-origin");
    const privateRequest = new Request("https://workspace.test/api/owner/dashboard");
    Object.defineProperties(privateRequest, {
        referrer: { value: "" },
        referrerPolicy: { value: "no-referrer" },
    });
    await worker.request(privateRequest);
    assertEquals(worker.forwardingOptions[1].referrer, "");
    assertEquals(worker.forwardingOptions[1].referrerPolicy, "no-referrer");
});

test("failed Workspace writes are reported once, never queued or replayed", async () => {
    const worker = workerHarness();
    worker.offline();
    const write = new Request("https://workspace.test/api/owner/session/start", {
        method: "POST",
        body: "private draft",
    });
    const response = await worker.request(write);
    assertEquals(response.status, 503);
    assertStringIncludes((await response.json()).error, "Check your connection");
    assertStrictEquals(worker.requests[0], write);
    worker.online();
    await worker.request(new Request("https://workspace.test/workspace.webmanifest"));
    assertEquals(worker.requests.filter((request) => request.method === "POST").length, 1);
});

test("Workspace worker preserves authentication and server errors and leaves other origins alone", async () => {
    const worker = workerHarness();
    worker.reply(new Response("Pairing required", { status: 401 }));
    assertEquals((await worker.request(navigation())).status, 401);
    worker.reply(new Response("Bad gateway", { status: 502 }));
    assertStringIncludes(await (await worker.request(navigation())).text(), "Connect to Workspace");
    assertEquals(
        await (await worker.request(new Request("https://workspace.test/api/owner/test"))).text(),
        "Bad gateway",
    );
    assertEquals(await worker.request(new Request("https://other.test/")), null);
    assertEquals(worker.requests.length, 3);
});

test("connection fallback is self-contained and retries without changing the route", async () => {
    const html = await workspaceConnectionPage();
    assertStringIncludes(html, "location.reload()");
    assertStringIncludes(html, "Tailscale");
    assertStringIncludes(html, "--rw-page-bg");
    assertEquals(/<(?:link|script)[^>]+(?:href|src)=/.test(html), false);
    assertEquals(
        WORKSPACE_MANIFEST.icons.some((icon) => icon.purpose === "maskable"),
        true,
    );
});

/**
 * @typedef {Object} WorkerNotificationEvent
 * @property {{data: {url: string}, close: () => void}} notification
 * @property {(task: Promise<void>) => void} waitUntil
 */

test("notification clicks focus the originating Session or reopen it, and reject external URLs", async () => {
    /** @type {Map<string, (event: WorkerNotificationEvent) => void>} */
    const listeners = new Map();
    const sessionUrl = "https://workspace.test/projects/project/sessions/session";
    /** @type {string[]} */
    const opened = [];
    let focused = 0;
    let closed = 0;
    let hasSessionWindow = true;
    runInNewContext(workspaceWorkerSource("Connection needed"), {
        self: {
            location: { origin: "https://workspace.test" },
            addEventListener: listeners.set.bind(listeners),
            clients: {
                matchAll: () => Promise.resolve(hasSessionWindow ? [{ url: sessionUrl, focus: () => focused++ }] : []),
                openWindow: (/** @type {string} */ url) => opened.push(url),
            },
        },
        URL,
    });
    const click = async (/** @type {string} */ url) => {
        /** @type {Promise<void>[]} */
        const pending = [];
        listeners.get("notificationclick")?.({
            notification: { data: { url }, close: () => closed++ },
            waitUntil: (task) => pending.push(task),
        });
        await Promise.all(pending);
    };
    await click(sessionUrl);
    assertEquals(focused, 1);
    assertEquals(opened, []);
    hasSessionWindow = false;
    await click(sessionUrl);
    assertEquals(opened, [sessionUrl]);
    await click("https://untrusted.test/");
    assertEquals(opened, [sessionUrl]);
    assertEquals(closed, 3);
});
