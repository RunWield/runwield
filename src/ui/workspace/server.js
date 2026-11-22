// @ts-nocheck: existing Workspace composition and dynamic router shapes.
import { ownerPlanContinuationApi } from "./routes/owner-plan-continuation.ts";
import { serveHttp } from "../../shared/http-server.ts";
import { env } from "node:process";

import { join } from "node:path";
import { pathToFileURL as toFileUrl } from "node:url";

import { getCwd } from "../../constants.js";

import {
    boardApi,
    lifecycleActionApi,
    planBodyApi,
    planDetailApi,
    plansApi,
    workspaceApi,
} from "./routes/api/handlers.ts";
import { registerRemoteApiRoutes } from "./routes/remote-api.ts";

import { openRemoteWorkspaceAdapter } from "./server/remote-adapter.ts";

import { withAccessLogger } from "./server-access-logger.ts";
import { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } from "../../shared/work-records/mnemoteca-port.ts";

import { reviewImageApi, reviewImageUploadApi } from "./routes/api/review-image-handlers.ts";

import { reviewFileContentApi, reviewLocalConfigApi, reviewOpenInAppsApi } from "./routes/api/review-file-handlers.ts";

import {
    devicesApi,
    ownerDashboardApi,
    ownerDashboardStreamApi,
    ownerErrorJson,
    ownerProjectBoardApi,
    ownerProjectFileContentApi,
    ownerProjectPlanActionApi,
    ownerProjectPlanDetailApi,
    ownerProjectPlanProgressApi,
    ownerSidebarApi,
    ownerUsageApi,
    ownerUsageSettingsApi,
    ownerUsageSettingsMutationApi,
    ownerWorkspaceSearchApi,
    ownerWorkspaceSearchRefreshApi,
    pairingClaimApi,
    pairingRequestApi,
    pairingStatusApi,
    projectActionApi,
    projectsApi,
    registerProjectApi,
    revokeDeviceApi,
} from "./routes/owner-api.js";
import {
    authenticateOwnerRequest,
    authorizeOwnerUpgradeRequest,
    isOwnerUpgradeRequest,
    renewDeviceCookies,
} from "./server/owner-auth.ts";
import { createWorkspaceSessionContinuationService } from "./server/session-continuation.js";
import {
    ownerNotificationsStreamApi,
    ownerProjectCommandMetricsApi,
    ownerProjectSessionsApi,
    ownerSessionArchiveApi,
    ownerSessionBootstrapApi,
    ownerSessionConfigureApi,
    ownerSessionContinuationStartApi,
    ownerSessionCreateApi,
    ownerSessionForceRecoverApi,
    ownerSessionInteractionAnswerApi,
    ownerSessionLiveApi,
    ownerSessionOperationCancelApi,
    ownerSessionOperationStatusApi,
    ownerSessionOperationStreamApi,
    ownerSessionOptionsApi,
    ownerSessionPlanReviewApi,
    ownerSessionPlanWorkflowApi,
    ownerSessionSteerApi,
    ownerSessionTimelineApi,
    ownerSessionUnarchiveApi,
} from "./routes/owner-session-api.js";
import {
    assertOwnerHost,
    assertOwnerOrigin,
    isStateChangingRequest,
    withOwnerSecurityHeaders,
} from "./server/owner-origin.ts";
import { requireOwnerProjectRoot, sessionBelongsToOwnerProject } from "./server/owner-projects.ts";
import { ownerProjectPlanSessionsApi } from "./server/owner-plan-sessions.ts";
import { createOwnerConnectionRegistry } from "./server/owner-connections.ts";
import { setAstroOwnerWorkspaceSessionContinuation, setAstroOwnerWorkspaceStore } from "./server/astro-owner-data.ts";
import { workspacePwaResponse } from "./server/workspace-pwa.ts";
import { isPublicWorkspaceAsset, WORKSPACE_PWA_PATHS } from "./server/public-workspace-assets.ts";

import { createWorkspaceSearchService } from "./server/workspace-search.ts";
import {
    WORKSPACE_DIR,
    hasWorkspaceToken,
    ctx,
    loadAstroHandle,
    renderAstroPage,
    workspaceBuildUnavailable,
    escapeHtml,
    withWorkspaceCwdHeader,
    handleStaticRoute,
    jsonNotFound,
} from "../../shared/browser-host/page-runtime.ts";
export { hasWorkspaceToken, rebuildRequestWithHeaders } from "../../shared/browser-host/page-runtime.ts";
export {
    createSessionQuestionWorkspaceApp,
    createDocumentReadWorkspaceApp,
    createReviewWorkspaceApp,
    startSessionQuestionWorkspaceServer,
    startReviewWorkspaceServer,
} from "../../shared/browser-host/standalone.ts";

/** @typedef {{ handler: () => (request: Request) => Promise<Response> }} WorkspaceApp */
/** @typedef {WorkspaceApp & { adapter: import("./server/remote-adapter.ts").RemoteWorkspaceAdapter }} RemoteWorkspaceApp */
/** @typedef {Object} OwnerWorkspaceAppOptions
 * @property {"owner"} mode
 * @property {string} publicOrigin
 * @property {import("../../shared/owner-coordination/index.ts").OwnerCoordinationStore} store
 */
const WORKSPACE_PLAN_ADAPTER_URL_KEY = Symbol.for("runwield.workspace.plan-adapter-url");

/** @type {any} */ (globalThis)[WORKSPACE_PLAN_ADAPTER_URL_KEY] = toFileUrl(
    join(WORKSPACE_DIR, "server", "plan-adapter.js"),
).href;

/**
 * @typedef {Object} LocalWorkspaceAppOptions
 * @property {"local"} [mode]
 * @property {string} cwd
 * @property {string} token
 * @property {boolean} [skipTokenCheck]
 * @property {import("../../shared/work-records/mnemoteca-port.ts").WorkRecordMnemotecaPort} mnemotecaPort
 */

/**
 * @typedef {Object} RemoteWorkspaceAppOptions
 * @property {"remote"} mode
 * @property {string} [dbPath]
 * @property {number} [maxRequestBytes]
 * @property {number} [retentionDays]
 */

/** @param {LocalWorkspaceAppOptions | RemoteWorkspaceAppOptions | OwnerWorkspaceAppOptions} options */
export function createWorkspaceApp(options) {
    if (options.mode === "remote") return createRemoteWorkspaceApp(options);
    if (options.mode === "owner") return createOwnerWorkspaceApp(options);
    return createLocalWorkspaceApp(options);
}

/** @param {RemoteWorkspaceAppOptions} options @returns {RemoteWorkspaceApp} */
export function createRemoteWorkspaceApp(options = { mode: "remote" }) {
    const app = createWorkspaceRouter();
    const adapter = openRemoteWorkspaceAdapter({
        dbPath: options.dbPath,
        retention: { days: options.retentionDays },
    });
    registerStaticRoutes(app);
    app.use(async (ctx) => {
        ctx.state.collaboration = adapter;
        ctx.state.maxRequestBytes = options.maxRequestBytes;
        return await ctx.next();
    });
    registerRemoteApiRoutes(app);
    app.get("/healthz", () => remoteJson({ ok: true, mode: "remote" }));
    app.get("/readyz", () => {
        try {
            return remoteJson(adapter.ready());
        } catch {
            return remoteJson({ ok: false, mode: "remote" }, 503);
        }
    });
    app.get("/p/:spaceId", async (ctx) => {
        const astroResponse = await renderAstroPage(ctx.req, getCwd());
        if (astroResponse) return astroResponse;
        return workspaceBuildUnavailable();
    });
    app.notFound(() => jsonNotFound());
    app.adapter = adapter;
    return app;
}

/** @param {OwnerWorkspaceAppOptions} options */
export function createOwnerWorkspaceApp(options) {
    const app = createWorkspaceRouter();
    const store = options.store;
    setAstroOwnerWorkspaceStore(store);
    const connections = createOwnerConnectionRegistry();
    const sessionContinuation = createWorkspaceSessionContinuationService({ store });
    const workspaceSearch = createWorkspaceSearchService({ store });
    setAstroOwnerWorkspaceSessionContinuation(sessionContinuation);
    const pairingRateLimit = createInProcessRateLimit({ limit: 4, windowMs: 60_000 });
    registerStaticRoutes(app);
    app.use(async (ctx) => {
        try {
            assertOwnerHost(ctx.req, { publicOrigin: options.publicOrigin });
            if (isStateChangingRequest(ctx.req)) assertOwnerOrigin(ctx.req, { publicOrigin: options.publicOrigin });
            ctx.state.store = store;
            ctx.state.publicOrigin = options.publicOrigin;
            ctx.state.ownerConnections = connections;
            ctx.state.sessionContinuation = sessionContinuation;
            ctx.state.workspaceSearch = workspaceSearch;
            ctx.state.pairingRateLimit = pairingRateLimit;
            ctx.state.bootstrapProofCookieHeader = (proof) =>
                `rw_pairing_proof=${encodeURIComponent(proof)}; Max-Age=300; Path=/; SameSite=Strict${
                    options.publicOrigin.startsWith("https:") ? "; Secure" : ""
                }; HttpOnly`;
            const path = ctx.url.pathname;
            if (isOwnerUpgradeRequest(ctx.req)) {
                ctx.state.ownerDevice = authorizeOwnerUpgradeRequest(ctx.req, ctx.state);
                return withOwnerSecurityHeaders(await ctx.next());
            }
            const pairingPath = path === "/pair" || path.startsWith("/api/owner/pairing");
            const publicAssetPath = isPublicWorkspaceAsset(path);
            if (path === "/pair" && ctx.req.method === "GET") {
                const device = authenticateOwnerRequest(ctx.req, ctx.state);
                if (device) {
                    return withOwnerSecurityHeaders(
                        renewDeviceCookies(ctx.req, redirectResponse("/"), ctx.state, device.deviceId),
                    );
                }
            }
            if (!pairingPath && !publicAssetPath) {
                const ownerDevice = authenticateOwnerRequest(ctx.req, ctx.state);
                if (!ownerDevice) {
                    if (path.startsWith("/api/")) {
                        return ownerJsonResponse({ error: "Owner Workspace device pairing required." }, 401);
                    }
                    return redirectResponse("/pair");
                }
                ctx.state.ownerDevice = ownerDevice;
            }
            let response = await ctx.next();
            if (
                ctx.state.ownerDevice &&
                ctx.req.method === "GET" &&
                response.headers.get("content-type")?.includes("text/html")
            ) {
                response = renewDeviceCookies(ctx.req, response, ctx.state, ctx.state.ownerDevice.deviceId);
            }
            response = withOwnerSecurityHeaders(response);
            // File-content requests need the live review context, but never send it to another origin.
            if (/^\/projects\/[^/]+\/sessions\/[^/]+\/review\/code$/.test(path)) {
                response.headers.set("referrer-policy", "same-origin");
            }
            return response;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (ctx.url.pathname.startsWith("/api/")) return ownerJsonResponse({ error: message }, 403);
            return ownerHtmlResponse(
                "RunWield Workspace",
                `<section class=\"error-panel\"><h2>Workspace request blocked</h2><p>${escapeHtml(
                    message,
                )}</p></section>`,
                { status: 403 },
            );
        }
    });
    app.get("/api/owner/notifications/stream", ownerNotificationsStreamApi);
    app.get("/", async (ctx) => {
        const headers = new Headers(ctx.req.headers);
        headers.set("x-runwield-owner-dashboard", "true");
        return await renderRequiredOwnerAstroPage({ ...ctx, req: new Request(ctx.req, { headers }) });
    });
    app.get("/pair", renderRequiredOwnerAstroPage);
    app.get("/devices", renderRequiredOwnerAstroPage);
    app.get("/usage", renderRequiredOwnerAstroPage);
    app.get("/usage/settings", renderRequiredOwnerAstroPage);
    app.get("/search", renderRequiredOwnerAstroPage);
    app.get("/projects", renderRequiredOwnerAstroPage);
    app.get("/projects/:projectId/plans", renderRequiredOwnerAstroPage);
    app.get("/projects/:projectId/plans/closed", renderRequiredOwnerAstroPage);
    app.get("/projects/:projectId/plans/on-hold", renderRequiredOwnerAstroPage);
    app.get("/projects/:projectId/plans/:planId", renderRequiredOwnerAstroPage);
    // Settings manages the registration, including missing and disabled roots.
    app.get("/projects/:projectId/settings", renderRequiredOwnerAstroPage);
    app.get("/projects/:projectId/artifacts/:artifactType/:sourceId", renderOwnerProjectArtifactPage);
    app.get("/projects/:projectId/sessions", renderOwnerProjectSessionsPage);
    app.get("/projects/:projectId/sessions/new", renderOwnerProjectSessionNewPage);
    app.get("/projects/:projectId/sessions/:runwieldSessionId/review/code", renderRequiredOwnerAstroPage);
    app.get("/projects/:projectId/sessions/:runwieldSessionId", renderOwnerProjectSessionDetailPage);
    app.get(
        "/projects/:projectId/sessions/:runwieldSessionId/artifacts/:artifactId",
        renderOwnerProjectSessionDetailPage,
    );
    app.post("/api/owner/pairing/request", pairingRequestApi);
    app.get("/api/owner/pairing/status", pairingStatusApi);
    app.post("/api/owner/pairing/claim", pairingClaimApi);
    app.get("/api/owner/projects", projectsApi);
    app.get("/api/owner/dashboard", ownerDashboardApi);
    app.get("/api/owner/usage", ownerUsageApi);
    app.get("/api/owner/usage/settings", ownerUsageSettingsApi);
    app.post("/api/owner/usage/settings/:action", ownerUsageSettingsMutationApi);
    app.post("/api/owner/usage/clear", ownerUsageSettingsMutationApi);
    app.get("/api/owner/dashboard/stream", ownerDashboardStreamApi);
    app.get("/api/owner/sidebar", ownerSidebarApi);
    app.get("/api/owner/search", ownerWorkspaceSearchApi);
    app.post("/api/owner/search/refresh", ownerWorkspaceSearchRefreshApi);
    app.post("/api/owner/projects", registerProjectApi);
    app.post("/api/owner/projects/:projectId/action", projectActionApi);
    app.get("/api/owner/projects/:projectId/plans", ownerProjectBoardApi);
    app.get("/api/owner/projects/:projectId/plans/view/:view", ownerProjectBoardApi);
    app.get("/api/owner/projects/:projectId/plans/:planId/progress", ownerProjectPlanProgressApi);
    app.get("/api/owner/projects/:projectId/plans/:planId/sessions", ownerProjectPlanSessionsApi);
    app.get("/api/owner/projects/:projectId/plans/:planId", ownerProjectPlanDetailApi);
    app.get("/api/owner/projects/:projectId/files/content", ownerProjectFileContentApi);
    app.get("/api/file-content", ownerInSituReviewFileContent);
    app.get("/api/open-in/apps", () => reviewOpenInAppsApi());
    app.post("/api/config", () => reviewLocalConfigApi());
    app.post("/api/upload", (ctx) => reviewImageUploadApi(ctx.req));
    app.get("/api/image", async (ctx) => {
        const projectId = ownerReviewProjectId(ctx.req);
        if (!projectId) return ownerErrorJson(new Error("Review Project context is missing."), 400);
        try {
            const root = requireOwnerProjectRoot(ctx.state.store, projectId);
            return await reviewImageApi(ctx.req, { cwd: root });
        } catch (error) {
            return ownerErrorJson(error, 404);
        }
    });
    app.post("/api/owner/projects/:projectId/plans/:planId/actions", ownerProjectPlanActionApi);
    app.post("/api/owner/projects/:projectId/plans/:planId/workflow", ownerPlanContinuationApi);
    app.get("/api/owner/projects/:projectId/session-options", ownerSessionOptionsApi);
    app.get("/api/owner/projects/:projectId/sessions", ownerProjectSessionsApi);
    app.post("/api/owner/projects/:projectId/sessions", ownerSessionCreateApi);
    app.post("/api/owner/projects/:projectId/sessions/:runwieldSessionId/archive", ownerSessionArchiveApi);
    app.post("/api/owner/projects/:projectId/sessions/:runwieldSessionId/unarchive", ownerSessionUnarchiveApi);
    app.get("/api/owner/projects/:projectId/sessions/:runwieldSessionId/timeline", ownerSessionTimelineApi);
    app.get("/api/owner/projects/:projectId/sessions/:runwieldSessionId/live", ownerSessionLiveApi);
    app.post("/api/owner/projects/:projectId/sessions/:runwieldSessionId/bootstrap", ownerSessionBootstrapApi);
    app.post("/api/owner/projects/:projectId/sessions/:runwieldSessionId/continue", ownerSessionContinuationStartApi);
    app.post("/api/owner/projects/:projectId/sessions/:runwieldSessionId/plan-review", ownerSessionPlanReviewApi);
    app.post("/api/owner/projects/:projectId/sessions/:runwieldSessionId/plan-workflow", ownerSessionPlanWorkflowApi);
    app.post("/api/owner/projects/:projectId/sessions/:runwieldSessionId/configure", ownerSessionConfigureApi);
    app.post("/api/owner/projects/:projectId/sessions/:runwieldSessionId/force-recovery", ownerSessionForceRecoverApi);
    app.post(
        "/api/owner/projects/:projectId/session-operations/:operationId/interactions/:interactionId/answer",
        ownerSessionInteractionAnswerApi,
    );
    app.post("/api/owner/projects/:projectId/session-operations/:operationId/steer", ownerSessionSteerApi);
    app.post("/api/owner/projects/:projectId/command-metrics", ownerProjectCommandMetricsApi);
    app.post("/api/owner/session-operations/:operationId/cancel", ownerSessionOperationCancelApi);
    app.get("/api/owner/session-operations/:operationId/stream", ownerSessionOperationStreamApi);
    app.get("/api/owner/session-operations/:operationId", ownerSessionOperationStatusApi);
    app.get("/api/owner/devices", devicesApi);
    app.post("/api/owner/devices/:deviceId/revoke", revokeDeviceApi);
    app.notFound((ctx) => {
        if (ctx.url.pathname.startsWith("/api/owner/")) {
            return ownerErrorJson(new Error("Owner API route not found."), 404);
        }
        return ownerHtmlResponse("Not found", `<section class=\"error-panel\"><h2>Not found</h2></section>`, {
            status: 404,
        });
    });
    let closePromise;
    const close = () => {
        closePromise ||= Promise.resolve(workspaceSearch.close()).finally(() => {
            connections.closeAll();
            return sessionContinuation.close();
        });
        return closePromise;
    };
    return Object.assign(app, {
        store,
        ownerConnections: connections,
        sessionContinuation,
        workspaceSearch,
        close,
    });
}

/** @param {LocalWorkspaceAppOptions} options */
function createLocalWorkspaceApp({ cwd, token, skipTokenCheck = false, mnemotecaPort }) {
    return {
        handler() {
            /** @param {Request} request */
            return async (request) => {
                const url = new URL(request.url);
                if (isPublicWorkspaceAsset(url.pathname)) return await handleStaticRoute(url.pathname);
                if (!skipTokenCheck && !hasWorkspaceToken(request, token)) {
                    return new Response("Workspace token required.", { status: 401 });
                }
                return await handleLocalWorkspaceRequest(request, { cwd, mnemotecaPort });
            };
        },
    };
}

/** @param {Request} request @param {{ cwd: string, mnemotecaPort: import("../../shared/work-records/mnemoteca-port.ts").WorkRecordMnemotecaPort }} state */
async function handleLocalWorkspaceRequest(request, state) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const apiResponse = await handleLocalApiRequest(request, state, pathname);
    if (apiResponse) return apiResponse;

    if (isAstroPageRoute(pathname)) {
        const astroResponse = await renderAstroPage(request, state.cwd);
        if (astroResponse) return astroResponse;
        return workspaceBuildUnavailable();
    }

    return new Response("Not found", { status: 404 });
}

/** @param {string} pathname */
function isAstroPageRoute(pathname) {
    return pathname === "/" || pathname === "/closed" || pathname === "/on-hold" || pathname.startsWith("/plans/");
}

/** @param {Request} request @param {{ cwd: string, mnemotecaPort: import("../../shared/work-records/mnemoteca-port.ts").WorkRecordMnemotecaPort }} state @param {string} pathname */
async function handleLocalApiRequest(request, state, pathname) {
    if (request.method === "GET" && pathname === "/api/workspace") return await workspaceApi(ctx(request, state));
    if (request.method === "GET" && pathname === "/api/plans") return await plansApi(ctx(request, state));
    if (request.method === "GET" && pathname === "/api/board") return await boardApi(ctx(request, state));

    const planDetailMatch = /^\/api\/plans\/([^/]+)$/.exec(pathname);
    if (request.method === "GET" && planDetailMatch) {
        return await planDetailApi(ctx(request, state, { planId: decodeURIComponent(planDetailMatch[1]) }));
    }

    const lifecycleMatch = /^\/api\/plans\/([^/]+)\/lifecycle-action$/.exec(pathname);
    if (request.method === "POST" && lifecycleMatch) {
        return await lifecycleActionApi(ctx(request, state, { planId: decodeURIComponent(lifecycleMatch[1]) }));
    }

    const bodyMatch = /^\/api\/plans\/([^/]+)\/body$/.exec(pathname);
    if (request.method === "POST" && bodyMatch) {
        return await planBodyApi(ctx(request, state, { planId: decodeURIComponent(bodyMatch[1]) }));
    }

    if (pathname.startsWith("/api/")) return jsonNotFound();
    return null;
}

/** @param {unknown} body @param {number} [status] */
function ownerJsonResponse(body, status = 200) {
    const response = new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
    });
    return withOwnerSecurityHeaders(response);
}

/** @param {string} location */
function redirectResponse(location) {
    return withOwnerSecurityHeaders(new Response(null, { status: 302, headers: { location } }));
}

/**
 * @param {string} title
 * @param {string} body
 * @param {{ status?: number, surfaceTitle?: string }} [options]
 */
function ownerHtmlResponse(title, body, options = {}) {
    const status = options.status ?? 200;
    const headerTitle = options.surfaceTitle
        ? `<strong class="workspace-main-session-name" data-workspace-surface-title>${escapeHtml(
              options.surfaceTitle,
          )}</strong>`
        : `<a class="brand workspace-main-brand" href="/" aria-label="RunWield Workspace home"><img class="brand-logo" src="/brand/logo.svg" alt="" aria-hidden="true"><span>RunWield Workspace</span></a>`;
    const headerClass = options.surfaceTitle
        ? "workspace-main-header workspace-main-surface-header"
        : "workspace-main-header";
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(
        title,
    )}</title><link rel="icon" href="/brand/logo.svg" type="image/svg+xml"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/components.css"><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/theme.css"></head><body class="theme-runwield"><div class="workspace-shell workspace-shell-with-sidebar owner-workspace-shell"><aside class="workspace-sidebar" data-workspace-sidebar aria-label="Workspace navigation"><p class="workspace-sidebar-empty"><span class="rw-thinking-dots" role="status"><span class="rw-thinking-glyph" aria-hidden="true"></span>Loading Workspace</span></p></aside><div class="workspace-main-shell"><header class="${headerClass}"><div class="workspace-main-header-left" data-workspace-main-header-left>${headerTitle}</div></header><main>${body}</main></div></div><script type="module" src="/workspace-shell.js"></script></body></html>`;
    return withOwnerSecurityHeaders(
        new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } }),
    );
}

function createInProcessRateLimit({ limit, windowMs }) {
    const buckets = new Map();
    return {
        /** @param {Request} request */
        check(request) {
            const now = Date.now();
            const url = new URL(request.url);
            const key = `${url.protocol}//${url.host}:${request.headers.get("user-agent") || "unknown"}`;
            const bucket = buckets.get(key) || { count: 0, resetAt: now + windowMs };
            if (bucket.resetAt <= now) {
                bucket.count = 0;
                bucket.resetAt = now + windowMs;
            }
            bucket.count += 1;
            buckets.set(key, bucket);
            if (bucket.count > limit) throw new Error("Too many pairing requests. Wait briefly before retrying.");
        },
    };
}

/** @param {Request} request */
function ownerReviewProjectId(request) {
    const referer = request.headers.get("referer");
    if (!referer) return "";
    try {
        const match = /^\/projects\/([^/]+)\//.exec(new URL(referer).pathname);
        return match ? decodeURIComponent(match[1]) : "";
    } catch {
        return "";
    }
}

/** @param {Request} request */
function ownerCodeReviewContext(request) {
    try {
        const url = new URL(request.headers.get("referer") || "");
        const match = /^\/projects\/([^/]+)\/sessions\/([^/]+)\/review\/code$/.exec(url.pathname);
        const operationId = url.searchParams.get("operation");
        const interactionId = url.searchParams.get("interaction");
        if (!match || !operationId || !interactionId) return null;
        return {
            projectId: decodeURIComponent(match[1]),
            runwieldSessionId: decodeURIComponent(match[2]),
            operationId,
            interactionId,
        };
    } catch {
        return null;
    }
}

/** @param {any} ctx */
async function ownerInSituReviewFileContent(ctx) {
    const projectId = ownerReviewProjectId(ctx.req);
    if (!projectId) return ownerErrorJson(new Error("Review Project context is missing."), 400);
    try {
        const root = requireOwnerProjectRoot(ctx.state.store, projectId);
        const context = ownerCodeReviewContext(ctx.req);
        const checkout = context ? await ctx.state.sessionContinuation.getLiveCodeReviewCheckout(context) : null;
        return await reviewFileContentApi(ctx.req, checkout || { cwd: root });
    } catch (error) {
        return ownerErrorJson(error, 404);
    }
}

/**
 * Owner pages have one production renderer. Unlike the optional local-page
 * bridge, a genuine Astro 404 must remain a 404 instead of looking like a
 * missing build.
 *
 * @param {any} ctx
 * @param {string} [cwd]
 */
async function renderRequiredOwnerAstroPage(ctx, cwd = getCwd()) {
    const handle = await loadAstroHandle();
    if (!handle) return workspaceBuildUnavailable();
    return await handle(withWorkspaceCwdHeader(ctx.req, cwd));
}

/** @param {any} component @param {Record<string, unknown>} props */
/** @param {any} ctx */
async function renderOwnerProjectArtifactPage(ctx) {
    const root = requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
    return await renderRequiredOwnerAstroPage(ctx, root);
}

/** @param {any} ctx */
async function renderOwnerProjectSessionsPage(ctx) {
    const root = requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
    const response = await renderAstroPage(ctx.req, root);
    if (response) return response;
    return ownerHtmlResponse(
        "Project Sessions",
        `<section class="page-header"><a class="detail-back-link" href="/">← Projects</a><h1>Project Sessions</h1><p>Build the Workspace frontend to enable the interactive phone Session list.</p></section><section class="owner-card empty-state"><h2>Workspace build unavailable</h2><p>Run <code>bun run workspace:build</code>, then reopen Sessions.</p></section>`,
        { status: 503 },
    );
}

/** @param {any} ctx */
async function renderOwnerProjectSessionNewPage(ctx) {
    const root = requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
    const response = await renderAstroPage(ctx.req, root);
    if (response) return response;
    return ownerHtmlResponse(
        "New Project Session",
        `<section class="page-header"><a class="detail-back-link" href="/projects/${encodeURIComponent(
            ctx.params.projectId,
        )}/sessions">← Sessions</a><h1>New Session</h1></section><section class="owner-card empty-state"><h2>Workspace build unavailable</h2><p>Run <code>bun run workspace:build</code>, then reopen New Session.</p></section>`,
        { status: 503 },
    );
}

/** @param {any} ctx */
async function renderOwnerProjectSessionDetailPage(ctx) {
    const root = requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
    const session = ctx.state.store.getSessionById(ctx.params.runwieldSessionId);
    if (!session || !sessionBelongsToOwnerProject(ctx.state.store, session, ctx.params.projectId)) {
        return ownerHtmlResponse(
            "Session not found",
            `<section class="error-panel"><h2>Session not found</h2><p>The requested Session is not cataloged under this Project.</p></section>`,
            { status: 404 },
        );
    }
    const response = await renderAstroPage(ctx.req, root);
    if (response) return response;
    return ownerHtmlResponse(
        "Project Session",
        `<section class="page-header"><a class="detail-back-link" href="/projects/${encodeURIComponent(
            ctx.params.projectId,
        )}/sessions">← Sessions</a><h1>Session Continuation</h1><p>Build the Workspace frontend to enable interactive Session continuation.</p></section><section class="owner-card empty-state"><h2>Workspace build unavailable</h2><p>Run <code>bun run workspace:build</code>, then reopen this Session.</p></section>`,
        { status: 503 },
    );
}

function createWorkspaceRouter() {
    const routes = [];
    const middleware = [];
    let notFoundHandler = () => jsonNotFound();
    const add = (method, pattern, handler) => routes.push({ method, pattern, handler });
    return {
        get: (pattern, handler) => add("GET", pattern, handler),
        post: (pattern, handler) => add("POST", pattern, handler),
        use: (handler) => middleware.push(handler),
        notFound: (handler) => {
            notFoundHandler = handler;
        },
        handler: () => async (request) => {
            const url = new URL(request.url);
            const route = routes.find(
                (candidate) => candidate.method === request.method && matchRoute(candidate.pattern, url.pathname),
            );
            const params = route ? matchRoute(route.pattern, url.pathname) : {};
            const state = {};
            const context = {
                req: request,
                request,
                url,
                params,
                state,
                next: async () => await runMiddleware(0),
            };
            const runMiddleware = async (index) => {
                const item = middleware[index];
                if (!item) return route ? await route.handler(context) : await notFoundHandler(context);
                context.next = async () => await runMiddleware(index + 1);
                return await item(context);
            };
            return await runMiddleware(0);
        },
    };
}

/** @param {string} pattern @param {string} pathname */
function matchRoute(pattern, pathname) {
    const patternParts = pattern.split("/").filter(Boolean);
    const pathParts = pathname.split("/").filter(Boolean);
    if (patternParts.length !== pathParts.length) return null;
    const params = {};
    for (let index = 0; index < patternParts.length; index += 1) {
        const patternPart = patternParts[index];
        const pathPart = pathParts[index];
        if (patternPart.startsWith(":")) params[patternPart.slice(1)] = decodeURIComponent(pathPart);
        else if (patternPart !== pathPart) return null;
    }
    return params;
}

/** @param {ReturnType<typeof createWorkspaceRouter>} app */
function registerStaticRoutes(app) {
    for (const path of WORKSPACE_PWA_PATHS) app.get(path, () => workspacePwaResponse(path));
    app.get("/styles.css", async () => await handleStaticRoute("/styles.css"));
    app.get("/tokens.css", async () => await handleStaticRoute("/tokens.css"));
    app.get("/components.css", async () => await handleStaticRoute("/components.css"));
    app.get("/workspace.css", async () => await handleStaticRoute("/workspace.css"));
    app.get("/workspace-shell.js", async () => await handleStaticRoute("/workspace-shell.js"));
    app.get("/design-system/panel-icon.ts", async () => await handleStaticRoute("/design-system/panel-icon.ts"));
    app.get(
        "/design-system/sidebar-motion.js",
        async () => await handleStaticRoute("/design-system/sidebar-motion.js"),
    );
    app.get("/theme.css", async () => await handleStaticRoute("/theme.css"));
    app.get("/brand/logo.svg", async () => await handleStaticRoute("/brand/logo.svg"));
    app.get("/_astro/:asset", async (ctx) => await handleStaticRoute(ctx.url.pathname));
}

/** @param {unknown} data @param {number} [status] */
function remoteJson(data, status = 200) {
    return Response.json(data, {
        status,
        headers: { "cache-control": "no-store" },
    });
}

/** @param {string} host */
function isLoopbackWorkspaceHost(host) {
    const value = String(host || "").toLowerCase();
    return value === "localhost" || value === "127.0.0.1" || value === "::1" || value === "[::1]";
}

/** @param {string} origin */
function normalizeWorkspacePublicOrigin(origin) {
    const url = new URL(origin);
    if (url.pathname !== "/" || url.search || url.hash) {
        throw new Error("Owner Workspace public origin must be an origin only, with no path, query, or fragment.");
    }
    return url.origin;
}

/** @param {{ mode?: string, host: string, port: number, publicOrigin?: string, trustTlsTerminator?: boolean }} options */
function assertWorkspaceServerTransportPolicy(options) {
    if (options.mode !== "owner") return;
    const publicOrigin = normalizeWorkspacePublicOrigin(
        options.publicOrigin || `http://${options.host}:${options.port}`,
    );
    if (isLoopbackWorkspaceHost(options.host)) return;
    if (!options.trustTlsTerminator || !publicOrigin.startsWith("https://")) {
        throw new Error(
            "Non-loopback owner Workspace bind requires trustTlsTerminator: true and an https:// publicOrigin.",
        );
    }
}

/**
 * @param {{ mode?: "local" | "remote" | "owner", cwd?: string, host: string, port: number, token?: string, dbPath?: string, signal?: AbortSignal, maxRequestBytes?: number, retentionDays?: number, publicOrigin?: string, trustTlsTerminator?: boolean, store?: import("../../shared/owner-coordination/index.ts").OwnerCoordinationStore }} options
 */
export function startWorkspaceServer(options) {
    assertWorkspaceServerTransportPolicy(options);
    if (options.mode === "owner" && !options.store) {
        throw new Error("Owner Workspace requires an open owner-coordination store.");
    }
    const ownerPublicOrigin =
        options.mode === "owner"
            ? normalizeWorkspacePublicOrigin(options.publicOrigin || `http://${options.host}:${options.port}`)
            : "";
    const app =
        options.mode === "remote"
            ? createWorkspaceApp({
                  mode: "remote",
                  dbPath: options.dbPath,
                  maxRequestBytes: options.maxRequestBytes,
                  retentionDays: options.retentionDays,
              })
            : options.mode === "owner"
              ? createWorkspaceApp({
                    mode: "owner",
                    store: options.store,
                    publicOrigin: ownerPublicOrigin,
                })
              : createWorkspaceApp({
                    cwd: options.cwd ?? getCwd(),
                    token: options.token ?? "",
                    mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                });
    const server = serveHttp(
        {
            hostname: options.host,
            port: options.port,
            signal: options.signal,
            automaticCompression: true,
        },
        withAccessLogger(app.handler(), {
            mode:
                env.RUNWIELD_LOG_MODE?.toLowerCase() === "prod" || env.RUNWIELD_LOG_MODE?.toLowerCase() === "production"
                    ? "prod"
                    : "dev",
        }),
    );
    if (options.mode !== "owner") return server;
    const finished = server.finished.finally(() => app.close());
    return new Proxy(server, {
        get(target, property) {
            if (property === "finished") return finished;
            if (property === "shutdown") {
                return async () => {
                    await target.shutdown();
                    await app.close();
                };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}
