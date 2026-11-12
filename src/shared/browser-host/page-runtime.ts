// @ts-nocheck: extracted existing browser page runtime.

import { env, versions } from "node:process";
import { readFile } from "node:fs/promises";
import { readWorkspaceStyles } from "./workspace-styles.ts";
import { sessionArtifactKindLabel } from "../session/session-sidebar.ts";
import { extname, join } from "node:path";
import { pathToFileURL as toFileUrl } from "node:url";

import { RUNWIELD_ROOT, RUNWIELD_SOURCE_ROOT } from "../../../runtime-root.js";
import { PLAN_UI_TOKEN_HEADER, PLAN_UI_TOKEN_QUERY } from "../../constants.js";

import { escapeReviewPayloadJson } from "./review-payload-json.ts";

import { renderRunWieldThemeCss } from "../../ui/design-system/theme-bridge.ts";

/**
 * Shared browser page runtime for standalone hosts and the Workspace adapter.
 * Page rendering and local assets do not load the owner Workspace HTTP server.
 */

export const WORKSPACE_DIR = join(RUNWIELD_SOURCE_ROOT, "ui", "workspace");

const ROOT_DIR = RUNWIELD_ROOT;

const DESIGN_SYSTEM_DIR = join(WORKSPACE_DIR, "..", "design-system");

const STYLES_PATH = join(WORKSPACE_DIR, "static", "styles.css");

const TOKENS_CSS_PATH = join(DESIGN_SYSTEM_DIR, "tokens.css");

const COMPONENTS_CSS_PATH = join(DESIGN_SYSTEM_DIR, "components.css");

const WORKSPACE_CSS_PATH = join(WORKSPACE_DIR, "static", "workspace.css");

const WORKSPACE_SHELL_JS_PATH = join(WORKSPACE_DIR, "static", "workspace-shell.ts");

const LOGO_PATH = join(ROOT_DIR, "brand", "logo.svg");

const ASTRO_SOURCE_DIST_DIR = join(ROOT_DIR, "dist", versions.bun ? "workspace-bun" : "workspace");

const ASTRO_RUNTIME_DIR = join(ROOT_DIR, "dist", "workspace-runtime");

const ASTRO_SOURCE_ENTRY_PATH = join(ASTRO_SOURCE_DIST_DIR, "server", "entry.mjs");

const ASTRO_RUNTIME_ENTRY_PATH = join(ASTRO_RUNTIME_DIR, "server.mjs");

const ASTRO_SOURCE_CLIENT_ASSET_DIR = join(ASTRO_SOURCE_DIST_DIR, "client", "_astro");

const ASTRO_RUNTIME_CLIENT_ASSET_DIR = join(ASTRO_RUNTIME_DIR, "client", "_astro");

const WORKSPACE_CWD_HEADER = "x-runwield-workspace-cwd";

const REVIEW_PAYLOAD_HEADER = "x-runwield-review-payload";
const QUESTION_PAYLOAD_HEADER = "x-runwield-question-payload";

/** @param {Request} request @param {string} expectedToken */
export function hasWorkspaceToken(request, expectedToken) {
    const url = new URL(request.url);
    return (
        url.searchParams.get(PLAN_UI_TOKEN_QUERY) === expectedToken ||
        request.headers.get(PLAN_UI_TOKEN_HEADER) === expectedToken
    );
}

/**
 * @template State
 * @param {Request} req
 * @param {State} state
 * @param {Record<string, string>} [params]
 */
export function ctx(req, state, params = {}) {
    return { req, request: req, url: new URL(req.url), state, params };
}

let astroHandlePromise;

let astroImportFailure = false;

export function loadAstroHandle() {
    if (env.WLD_WORKSPACE_DISABLE_BUILT_SERVER === "1") return null;
    if (!astroHandlePromise) {
        astroHandlePromise = (async () => {
            const entryPaths = [ASTRO_SOURCE_ENTRY_PATH, ASTRO_RUNTIME_ENTRY_PATH];
            for (const entryPath of entryPaths) {
                try {
                    if (!(await isAstroEntryImportable(entryPath))) continue;
                    const entry = await import(/* @vite-ignore */ toFileUrl(entryPath).href);
                    if (typeof entry.handle === "function") return entry.handle;
                } catch (error) {
                    astroImportFailure = true;
                    console.error(
                        `Workspace renderer module evaluation failed at ${entryPath}. Repair the build and restart the Workspace server; JavaScript may cache this failure.`,
                        error,
                    );
                    // Try the source build after the opaque runtime build, or vice versa.
                }
            }
            return null;
        })().then(
            (handle) => {
                if (!handle) astroHandlePromise = null;
                return handle;
            },
            (error) => {
                astroHandlePromise = null;
                throw error;
            },
        );
    }
    return astroHandlePromise;
}

async function isAstroEntryImportable(entryPath) {
    try {
        const source = await readFile(entryPath, "utf8");
        return source.includes('"key":');
    } catch {
        return false;
    }
}

/** @param {Request} request @param {string} cwd */
export async function renderAstroPage(request, cwd) {
    const handle = await loadAstroHandle();
    if (!handle) return null;
    const response = await handle(withWorkspaceCwdHeader(request, cwd));
    return response.status === 404 ? null : response;
}

/** @param {Request} request @param {string} cwd @param {Record<string, unknown>} payload */
export async function renderAstroReviewPage(request, cwd, payload) {
    const handle = await loadAstroHandle();
    if (!handle) return null;
    const headers = new Headers(request.headers);
    headers.set(WORKSPACE_CWD_HEADER, cwd);
    headers.set(REVIEW_PAYLOAD_HEADER, encodeURIComponent(JSON.stringify(payload)));
    try {
        const response = await handle(rebuildRequestWithHeaders(request, headers));
        return response.status === 404 ? null : response;
    } catch {
        return null;
    }
}

/** @param {Request} request @param {string} cwd @param {Record<string, unknown>} payload */
export async function renderAstroQuestionPage(request, cwd, payload) {
    const handle = await loadAstroHandle();
    if (!handle) return null;
    const headers = new Headers(request.headers);
    headers.set(WORKSPACE_CWD_HEADER, cwd);
    headers.set(QUESTION_PAYLOAD_HEADER, encodeURIComponent(JSON.stringify(payload)));
    try {
        const response = await handle(rebuildRequestWithHeaders(request, headers));
        return response.status === 404 ? null : response;
    } catch {
        return null;
    }
}

/** @param {string} pathname */
export function isLegacyReviewApiPath(pathname) {
    return (
        pathname === "/api/decision" ||
        pathname === "/api/deny" ||
        pathname === "/api/feedback" ||
        pathname === "/api/exit"
    );
}

/**
 * @param {"plan" | "code"} reviewType
 * @param {Record<string, unknown>} payload
 */
export function renderStaticReviewFallback(reviewType, payload) {
    const title =
        payload?.surface === "artifact-read"
            ? `${sessionArtifactKindLabel(payload.artifactKind)} · RunWield Workspace`
            : reviewType === "plan"
              ? "Plan Review · RunWield Workspace"
              : "Code Review · RunWield Workspace";
    const payloadAttribute = reviewType === "plan" ? "data-review-payload" : "data-code-review-payload";
    const payloadJson = escapeReviewPayloadJson(JSON.stringify(payload));
    return new Response(
        `<!doctype html>
<html lang="en">
    <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(title)}</title>
        <link rel="icon" href="/brand/logo.svg" type="image/svg+xml" />
        <link rel="stylesheet" href="/tokens.css" />
        <link rel="stylesheet" href="/components.css" />
        <link rel="stylesheet" href="/workspace.css" />
        <link rel="stylesheet" href="/theme.css" />
    </head>
    <body>
        <main class="review-shell" data-astro-review-shell>
            <script type="application/json" ${payloadAttribute}>${payloadJson}</script>
            <section class="empty-state">
                <h1>${escapeHtml(title)}</h1>
                <p>Workspace review UI assets are unavailable in this environment.</p>
            </section>
        </main>
    </body>
</html>`,
        {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
        },
    );
}

export function workspaceBuildUnavailable() {
    return new Response(
        astroImportFailure
            ? "Workspace renderer module evaluation failed. Repair the build and restart the Workspace server; JavaScript may cache the failure."
            : "Workspace Astro build unavailable. Run `bun run workspace:build` before serving page routes.",
        {
            status: 503,
            headers: { "content-type": "text/plain; charset=utf-8" },
        },
    );
}

/** @param {string} value */
export function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

/** @param {Request} request @param {string} cwd */
export function withWorkspaceCwdHeader(request, cwd) {
    const headers = new Headers(request.headers);
    headers.set(WORKSPACE_CWD_HEADER, cwd);
    return rebuildRequestWithHeaders(request, headers);
}

/**
 * Rebuild a server request with replacement headers without inheriting its
 * signal. Cloning a Deno.serve request also clones the runtime's legacy abort
 * signal, which emits a native stderr warning after every successful response
 * unless the parent process was started with an unstable flag.
 *
 * @param {Request} request
 * @param {Headers} headers
 * @returns {Request}
 */
export function rebuildRequestWithHeaders(request, headers) {
    /** @type {RequestInit} */
    const init = {
        method: request.method,
        headers,
        redirect: request.redirect,
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
        init.body = request.body;
    }
    return new Request(request.url, init);
}

/** @param {string} pathname */
export async function handleStaticRoute(pathname) {
    if (pathname === "/design-system/panel-icon.ts") {
        return await textFileResponse(join(DESIGN_SYSTEM_DIR, "panel-icon.ts"), "text/javascript; charset=utf-8");
    }
    if (pathname === "/design-system/sidebar-motion.js") {
        return await textFileResponse(join(DESIGN_SYSTEM_DIR, "sidebar-motion.js"), "text/javascript; charset=utf-8");
    }
    if (pathname === "/styles.css") return await textFileResponse(STYLES_PATH, "text/css; charset=utf-8");
    if (pathname === "/tokens.css") return await textFileResponse(TOKENS_CSS_PATH, "text/css; charset=utf-8");
    if (pathname === "/components.css") return await textFileResponse(COMPONENTS_CSS_PATH, "text/css; charset=utf-8");
    if (pathname === "/workspace.css") return await textFileResponse(WORKSPACE_CSS_PATH, "text/css; charset=utf-8");
    if (pathname === "/workspace-shell.js") {
        return await textFileResponse(WORKSPACE_SHELL_JS_PATH, "text/javascript; charset=utf-8");
    }
    if (pathname === "/theme.css") {
        const css = renderRunWieldThemeCss();
        return new Response(css, {
            headers: {
                "content-type": "text/css; charset=utf-8",
                "cache-control": "no-store",
            },
        });
    }
    if (pathname === "/brand/logo.svg") return await textFileResponse(LOGO_PATH, "image/svg+xml; charset=utf-8");
    if (pathname.startsWith("/_astro/")) return await handleAstroAsset(pathname);
    return new Response("Not found", { status: 404 });
}

/** @param {string} pathname */
async function handleAstroAsset(pathname) {
    const encodedName = pathname.slice("/_astro/".length);
    let assetName = "";
    try {
        assetName = decodeURIComponent(encodedName);
    } catch {
        return new Response("Not found", { status: 404 });
    }
    if (!assetName || assetName.includes("..") || assetName.includes("/")) {
        return new Response("Not found", { status: 404 });
    }

    const runtimeAssetName = getOpaqueWorkspaceAssetName(assetName);
    const assetPaths = [
        join(ASTRO_SOURCE_CLIENT_ASSET_DIR, assetName),
        join(ASTRO_RUNTIME_CLIENT_ASSET_DIR, runtimeAssetName),
    ];
    for (const assetPath of assetPaths) {
        try {
            const body = await readFile(assetPath);
            return new Response(body, {
                headers: {
                    "content-type": contentTypeForAsset(assetName),
                    "cache-control": "public, max-age=31536000, immutable",
                },
            });
        } catch {
            // Try the source build after the opaque runtime build, or vice versa.
        }
    }
    return new Response("Not found", { status: 404 });
}

/** @param {string} name */
function getOpaqueWorkspaceAssetName(name) {
    return [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"].includes(extname(name).toLowerCase())
        ? `${name}.asset`
        : name;
}

/** @param {string} path */
function contentTypeForAsset(path) {
    const extension = extname(path);
    if (extension === ".css") return "text/css; charset=utf-8";
    if (extension === ".js" || extension === ".mjs") return "text/javascript; charset=utf-8";
    if (extension === ".svg") return "image/svg+xml; charset=utf-8";
    if (extension === ".png") return "image/png";
    if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
    if (extension === ".webp") return "image/webp";
    if (extension === ".woff2") return "font/woff2";
    return "application/octet-stream";
}

/** @param {string} path @param {string} contentType */
async function textFileResponse(path, contentType) {
    try {
        const body = path === WORKSPACE_CSS_PATH ? await readWorkspaceStyles(path) : await readFile(path, "utf8");
        return new Response(body, { headers: { "content-type": contentType } });
    } catch {
        return new Response("Not found", { status: 404 });
    }
}

export function jsonNotFound() {
    return Response.json(
        { error: "not_found", message: "Not found.", status: 404 },
        {
            status: 404,
            headers: { "cache-control": "no-store" },
        },
    );
}
