/** Online-only Workspace installation and connection fallback. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RUNWIELD_SOURCE_ROOT } from "../../../../runtime-root.js";
import { renderRunWieldThemeCss } from "../../design-system/theme-bridge.ts";
import { DARK_BROWSER_THEME } from "../../design-system/themes/dark.ts";

export const WORKSPACE_PWA_PATHS = [
    "/workspace.webmanifest",
    "/workspace-worker.js",
    "/workspace-pwa.js",
    "/connection-required",
    "/pwa/icon-192.png",
    "/pwa/icon-512.png",
    "/pwa/icon-maskable-512.png",
    "/pwa/apple-touch-icon.png",
];

export const WORKSPACE_MANIFEST = {
    id: "/",
    name: "RunWield Workspace",
    short_name: "RunWield",
    description: "Your RunWield Projects, Sessions, and Plans. Requires a connection to Workspace.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: DARK_BROWSER_THEME.colors["--rw-page-bg"],
    theme_color: DARK_BROWSER_THEME.colors["--rw-surface"],
    icons: [
        { src: "/pwa/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/pwa/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/pwa/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
};

export async function workspaceConnectionPage() {
    const designRoot = join(RUNWIELD_SOURCE_ROOT, "ui", "design-system");
    const [tokens, components] = await Promise.all([
        readFile(join(designRoot, "tokens.css"), "utf8"),
        readFile(join(designRoot, "components.css"), "utf8"),
    ]);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="${WORKSPACE_MANIFEST.theme_color}">
<title>Connection needed · RunWield</title>
<style>${renderRunWieldThemeCss()}\n${tokens}\n${components}</style></head>
<body class="theme-runwield rw-connection-page"><main class="rw-connection-message">
<p class="rw-connection-brand">RunWield Workspace</p>
<h1>Connect to Workspace</h1>
<p>Workspace needs a connection to load. Check your internet connection and make sure Workspace is running.</p>
<p>If you use Tailscale, check that it’s connected too.</p>
<button class="rw-toolbar-button" type="button" onclick="location.reload()">Try again</button>
<p role="status" id="connection-status"></p>
</main><script>
addEventListener('online', () => {
    document.getElementById('connection-status').textContent = 'Your network is back. Try connecting again.';
});
</script></body></html>`;
}

export function workspaceWorkerSource(connectionPage: string) {
    return `const CONNECTION_PAGE = ${JSON.stringify(connectionPage)};
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil((async () => {
        const url = new URL(event.notification.data?.url || '/', self.location.origin);
        if (url.origin !== self.location.origin) return;
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const existing = windows.find((client) => client.url === url.href);
        if (existing) await existing.focus();
        else await self.clients.openWindow(url.href);
    })());
});
async function tellPage(event, connected) {
    const client = await self.clients.get(event.clientId);
    client?.postMessage({ type: 'runwield:connection', connected });
}
function connectionResponse() {
    return new Response(CONNECTION_PAGE, {
        status: 503,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
    });
}
self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    // No caches, offline data, background sync, or automatic retries of writes.
    event.respondWith((async () => {
        try {
            const response = await fetch(request, {
                cache: 'no-store',
                referrer: request.referrer,
                referrerPolicy: request.referrerPolicy,
                ...(request.mode === 'navigate' ? { signal: AbortSignal.timeout(10000) } : {})
            });
            event.waitUntil(tellPage(event, response.status < 500));
            if (request.mode === 'navigate' && response.status >= 500) return connectionResponse();
            return response;
        } catch (error) {
            if (request.signal.aborted) return Response.error();
            event.waitUntil(tellPage(event, false));
            if (request.mode === 'navigate') return connectionResponse();
            if (url.pathname.startsWith('/api/')) {
                return Response.json({ error: 'Workspace is unreachable. Check your connection and try again.' }, { status: 503 });
            }
            return Response.error();
        }
    })());
});`;
}

export async function workspacePwaResponse(pathname: string) {
    if (!WORKSPACE_PWA_PATHS.includes(pathname)) return new Response("Not found", { status: 404 });
    const headers = new Headers({ "cache-control": "no-store" });
    if (pathname === "/workspace.webmanifest") {
        headers.set("content-type", "application/manifest+json");
        return new Response(JSON.stringify(WORKSPACE_MANIFEST), { headers });
    }
    if (pathname === "/workspace-worker.js") {
        headers.set("content-type", "text/javascript; charset=utf-8");
        headers.set("service-worker-allowed", "/");
        return new Response(workspaceWorkerSource(await workspaceConnectionPage()), { headers });
    }
    if (pathname === "/connection-required") {
        headers.set("content-type", "text/html; charset=utf-8");
        return new Response(await workspaceConnectionPage(), { headers });
    }
    const sourceName = pathname === "/workspace-pwa.js" ? "workspace-pwa.ts" : pathname.slice(1);
    const path = join(RUNWIELD_SOURCE_ROOT, "ui", "workspace", "static", sourceName);
    headers.set("content-type", pathname.endsWith(".png") ? "image/png" : "text/javascript; charset=utf-8");
    return new Response(new Uint8Array(await readFile(path)), { headers });
}
