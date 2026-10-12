// @ts-nocheck: local wrapper includes a tiny Fresh-free router and production Astro bridge with dynamic handler shapes.
import { ownerPlanContinuationApi } from "./routes/owner-plan-continuation.ts";
/**
 * Programmatic Workspace server composition.
 *
 * Local Workspace serving is RunWield-owned: token checks, cwd state,
 * static/theme routes, and JSON APIs stay in this wrapper while page SSR can
 * delegate to the Astro Deno adapter output when it is available.
 */

import { readWorkspaceStyles } from "./workspace-styles.ts";
import { sessionArtifactKindLabel } from "../../shared/session/session-sidebar.ts";
import { basename, dirname, extname, join, toFileUrl } from "@std/path";
import { parseWorkRecordMarkdown } from "../../shared/work-records/markdown.js";
import { workRecordNotices } from "../../shared/work-records/list.ts";
import { isEpicArtifactPlanName } from "../../shared/epic-artifacts.ts";
import { RUNWIELD_ROOT, RUNWIELD_SOURCE_ROOT } from "../../../runtime-root.js";
import { PLAN_UI_TOKEN_HEADER, PLAN_UI_TOKEN_QUERY } from "../../constants.js";
import { getWorktreeReviewDiff, WorktreeReviewComparisonError } from "../../shared/workflow/git-snapshot.ts";
import {
    boardApi,
    lifecycleActionApi,
    planBodyApi,
    planDetailApi,
    plansApi,
    workspaceApi,
} from "./routes/api/handlers.ts";
import { registerRemoteApiRoutes } from "./routes/remote-api.js";
import {
    registerReviewDecisionPromise,
    resolveReviewDecision,
    reviewDecisionApi,
    reviewDenyApi,
    reviewExitApi,
    reviewFeedbackApi,
} from "./routes/api/review-handlers.js";
import { openRemoteWorkspaceAdapter } from "./server/remote-adapter.js";
import { escapeReviewPayloadJson } from "./server/review-payload-json.ts";
import { withAccessLogger } from "./server-access-logger.ts";
import { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } from "../../shared/work-records/mnemoteca-port.ts";
import { renderRunWieldThemeCss } from "../design-system/theme-bridge.ts";
import { reviewImageApi, reviewImageUploadApi } from "./routes/api/review-image-handlers.ts";
import {
    cleanupReviewAgentState,
    createReviewAgentState,
    reviewAgentApi,
    runConfiguredGuideCommand,
} from "./routes/api/review-agent-handlers.js";
import {
    resolveWorkspaceFile,
    reviewFileContentApi,
    reviewLocalConfigApi,
    reviewOpenInAppsApi,
} from "./routes/api/review-file-handlers.ts";
import { reviewWidgetApi } from "./routes/api/review-widget-handlers.js";
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
import { setAstroOwnerWorkspaceSessionContinuation, setAstroOwnerWorkspaceStore } from "./server/astro-owner-data.js";
import { WORKSPACE_PWA_PATHS, workspacePwaResponse } from "./server/workspace-pwa.ts";
import { createWorkspaceSearchService } from "./server/workspace-search.ts";

const WORKSPACE_DIR = join(RUNWIELD_SOURCE_ROOT, "ui", "workspace");
const ROOT_DIR = RUNWIELD_ROOT;
const DESIGN_SYSTEM_DIR = join(WORKSPACE_DIR, "..", "design-system");
const STYLES_PATH = join(WORKSPACE_DIR, "static", "styles.css");
const TOKENS_CSS_PATH = join(DESIGN_SYSTEM_DIR, "tokens.css");
const COMPONENTS_CSS_PATH = join(DESIGN_SYSTEM_DIR, "components.css");
const WORKSPACE_CSS_PATH = join(WORKSPACE_DIR, "static", "workspace.css");
const WORKSPACE_SHELL_JS_PATH = join(WORKSPACE_DIR, "static", "workspace-shell.ts");
const LOGO_PATH = join(ROOT_DIR, "brand", "logo.svg");
const ASTRO_SOURCE_DIST_DIR = join(ROOT_DIR, "dist", "workspace");
const ASTRO_RUNTIME_DIR = join(ROOT_DIR, "dist", "workspace-runtime");
const ASTRO_SOURCE_ENTRY_PATH = join(ASTRO_SOURCE_DIST_DIR, "server", "entry.mjs");
const ASTRO_RUNTIME_ENTRY_PATH = join(ASTRO_RUNTIME_DIR, "server.mjs");
const ASTRO_SOURCE_CLIENT_ASSET_DIR = join(ASTRO_SOURCE_DIST_DIR, "client", "_astro");
const ASTRO_RUNTIME_CLIENT_ASSET_DIR = join(ASTRO_RUNTIME_DIR, "client", "_astro");
const WORKSPACE_CWD_HEADER = "x-runwield-workspace-cwd";
const WORKSPACE_PLAN_ADAPTER_URL_KEY = Symbol.for("runwield.workspace.plan-adapter-url");

/** @type {any} */ (globalThis)[WORKSPACE_PLAN_ADAPTER_URL_KEY] = toFileUrl(
    join(WORKSPACE_DIR, "server", "plan-adapter.js"),
).href;

/** @typedef {{ handler: () => (request: Request) => Promise<Response> }} WorkspaceApp */
/** @typedef {WorkspaceApp & { adapter: import("./server/remote-adapter.js").RemoteWorkspaceAdapter }} RemoteWorkspaceApp */
const REVIEW_PAYLOAD_HEADER = "x-runwield-review-payload";
const QUESTION_PAYLOAD_HEADER = "x-runwield-question-payload";

/**
 * @typedef {Object} ReviewServerOutput
 * @property {"stdout" | "stderr"} stream
 * @property {string} text
 */

/** @typedef {(output: ReviewServerOutput) => void} ReviewServerOutputListener */

/**
 * @typedef {Object} OwnerWorkspaceAppOptions
 * @property {"owner"} mode
 * @property {string} publicOrigin
 * @property {import("../../shared/owner-coordination/index.js").OwnerCoordinationStore} store
 */

/**
 * @param {Request} request
 * @param {string} expectedToken
 */
export function hasWorkspaceToken(request, expectedToken) {
    const url = new URL(request.url);
    return url.searchParams.get(PLAN_UI_TOKEN_QUERY) === expectedToken ||
        request.headers.get(PLAN_UI_TOKEN_HEADER) === expectedToken;
}

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
        const astroResponse = await renderAstroPage(ctx.req, Deno.cwd());
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
                ctx.state.ownerDevice && ctx.req.method === "GET" &&
                response.headers.get("content-type")?.includes("text/html")
            ) {
                response = renewDeviceCookies(ctx.req, response, ctx.state, ctx.state.ownerDevice.deviceId);
            }
            return withOwnerSecurityHeaders(response);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (ctx.url.pathname.startsWith("/api/")) return ownerJsonResponse({ error: message }, 403);
            return ownerHtmlResponse(
                "RunWield Workspace",
                `<section class=\"error-panel\"><h2>Workspace request blocked</h2><p>${
                    escapeHtml(message)
                }</p></section>`,
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
    app.get(
        "/projects/:projectId/sessions/:runwieldSessionId/review/code",
        renderRequiredOwnerAstroPage,
    );
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
    app.store = store;
    app.ownerConnections = connections;
    app.sessionContinuation = sessionContinuation;
    app.workspaceSearch = workspaceSearch;
    let closePromise;
    app.close = () => {
        closePromise ||= Promise.resolve(workspaceSearch.close()).finally(() => {
            connections.closeAll();
            return sessionContinuation.close();
        });
        return closePromise;
    };
    return app;
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

/**
 * @param {{ cwd: string, token: string, reviewPayload: Record<string, unknown>, reviewType: "plan" | "code", reviewConversation?: { id: string, agentLabel: string, revision: number, events: Array<{ type: string, delta: string, messageId: string, agentName: string }> } }} options
 */
/**
 * @param {{ cwd: string, token: string, questionPayload: Record<string, unknown>, answerQuestion: (request: Request) => Promise<Response>|Response }} options
 */
export function createSessionQuestionWorkspaceApp({ cwd, token, questionPayload, answerQuestion }) {
    return {
        handler() {
            /** @param {Request} request */
            return async (request) => {
                const url = new URL(request.url);
                if (isPublicWorkspaceAsset(url.pathname)) return await handleStaticRoute(url.pathname);
                if (!hasWorkspaceToken(request, token)) {
                    return new Response("Question token required.", { status: 401 });
                }
                if (request.method === "POST" && url.pathname === "/api/session-question/answer") {
                    return await answerQuestion(request);
                }
                if (request.method === "GET" && url.pathname === "/session-question") {
                    const payload = {
                        ...questionPayload,
                        action: `/api/session-question/answer?${PLAN_UI_TOKEN_QUERY}=${encodeURIComponent(token)}`,
                    };
                    const astroResponse = await renderAstroQuestionPage(request, cwd, payload);
                    if (astroResponse) return astroResponse;
                    return workspaceBuildUnavailable();
                }
                return new Response("Not found", { status: 404 });
            };
        },
    };
}

/**
 * @typedef {Object} DocumentReadWorkspaceAppOptions
 * @property {string} cwd Canonical active Project root.
 * @property {string} token Active host bearer token.
 */

/**
 * Passive, current-file reader. It owns no review decisions or lifecycle actions.
 * @param {DocumentReadWorkspaceAppOptions} options
 * @returns {WorkspaceApp}
 */
export function createDocumentReadWorkspaceApp({ cwd, token }) {
    return {
        handler() {
            /** @param {Request} request */
            return async (request) => {
                const url = new URL(request.url);
                if (isPublicWorkspaceAsset(url.pathname)) return await handleStaticRoute(url.pathname);
                const headers = { "cache-control": "no-store", "referrer-policy": "same-origin" };
                const imageRequest = request.method === "GET" && url.pathname === "/api/image";
                let authenticated = hasWorkspaceToken(request, token);
                if (imageRequest && !authenticated) {
                    try {
                        const referer = new URL(request.headers.get("referer") || "");
                        authenticated = referer.origin === url.origin && referer.pathname === "/review/plan" &&
                            referer.searchParams.get(PLAN_UI_TOKEN_QUERY) === token;
                    } catch {
                        authenticated = false;
                    }
                }
                if (!authenticated) return new Response("Document token required.", { status: 401, headers });
                if (imageRequest) return await reviewImageApi(request, { cwd, projectOnly: true });
                if (request.method !== "GET" || url.pathname !== "/review/plan") {
                    return new Response("Not found", { status: 404, headers });
                }
                const path = url.searchParams.get("path") || "";
                try {
                    if (extname(path).toLowerCase() !== ".md") {
                        return new Response("Markdown document required.", { status: 400, headers });
                    }
                    const file = resolveWorkspaceFile(cwd, path);
                    if (!file || extname(file.absolutePath).toLowerCase() !== ".md") {
                        return new Response("Document not found.", { status: 404, headers });
                    }
                    const markdown = await Deno.readTextFile(file.absolutePath);
                    const artifactKind = linkedDocumentKind(file.path);
                    let notices = [];
                    if (artifactKind === "work-record" && dirname(file.path) === "docs/work-records") {
                        try {
                            const record = parseWorkRecordMarkdown(markdown, { relativePath: file.path });
                            notices = workRecordNotices(record);
                        } catch {
                            notices = ["WARNING: Work Record metadata could not be read."];
                        }
                    }
                    const payload = {
                        surface: "artifact-read",
                        launch: "linked",
                        mode: "workflow",
                        token,
                        markdown,
                        artifactKind,
                        title: markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || basename(file.path),
                        artifactPath: file.path,
                        imageBaseDir: dirname(file.path),
                        notices,
                    };
                    const response = await renderAstroReviewPage(request, cwd, payload) ||
                        renderStaticReviewFallback("plan", payload);
                    response.headers.set("cache-control", "no-store");
                    response.headers.set("referrer-policy", "same-origin");
                    return response;
                } catch (error) {
                    const status = error instanceof Deno.errors.PermissionDenied
                        ? 403
                        : error instanceof Deno.errors.NotFound || error instanceof Deno.errors.NotADirectory
                        ? 404
                        : 500;
                    return new Response(
                        status === 403
                            ? "Document path is outside this Project."
                            : status === 404
                            ? "Document not found."
                            : "Unable to read document.",
                        { status, headers },
                    );
                }
            };
        },
    };
}

/** @param {string} path */
function linkedDocumentKind(path) {
    if (path.startsWith("docs/plans/")) {
        return isEpicArtifactPlanName(path.slice("docs/plans/".length)) ? "epic-artifact" : "plan";
    }
    if (path.startsWith("docs/prd/")) return "prd";
    if (path.startsWith("docs/adr/")) return "adr";
    if (path.startsWith("docs/work-records/")) return "work-record";
    return "document";
}

/** @param {ReviewWorkspaceServerOptions} options */
export function createReviewWorkspaceApp(options) {
    const { cwd, token, reviewPayload, reviewType, reviewConversation } = options;
    const reviewAgentState = reviewType === "code"
        ? createReviewAgentState({ cwd, token, reviewPayload, runGuideCommand: runConfiguredGuideCommand })
        : null;
    return {
        cleanup: () => reviewAgentState ? cleanupReviewAgentState(reviewAgentState) : Promise.resolve(),
        handler() {
            /** @param {Request} request */
            return async (request) => {
                const url = new URL(request.url);
                if (isPublicWorkspaceAsset(url.pathname)) return await handleStaticRoute(url.pathname);
                if (request.method === "POST" && url.pathname === "/api/upload") {
                    if (!hasReviewAssetToken(request, token)) {
                        return new Response("Review token required.", { status: 401 });
                    }
                    return await reviewImageUploadApi(request);
                }
                if (request.method === "GET" && url.pathname === "/api/image") {
                    if (!hasReviewAssetToken(request, token)) {
                        return new Response("Review token required.", { status: 401 });
                    }
                    return await reviewImageApi(request, { cwd });
                }
                if (request.method === "GET" && url.pathname === "/api/file-content") {
                    if (!hasReviewAssetToken(request, token)) {
                        return new Response("Review token required.", { status: 401 });
                    }
                    return await reviewFileContentApi(request, { cwd });
                }
                if (request.method === "GET" && url.pathname === "/api/open-in/apps") {
                    if (!hasReviewAssetToken(request, token)) {
                        return new Response("Review token required.", { status: 401 });
                    }
                    return reviewOpenInAppsApi();
                }
                if (request.method === "POST" && url.pathname === "/api/config") {
                    if (!hasReviewAssetToken(request, token)) {
                        return new Response("Review token required.", { status: 401 });
                    }
                    return reviewLocalConfigApi();
                }
                if (request.method === "GET" && url.pathname === "/api/review/revision") {
                    if (!reviewPayload.reviewRevisionUrl || !hasReviewAssetToken(request, token)) {
                        return new Response("Review revision unavailable.", { status: 404 });
                    }
                    return Response.json({ revision: reviewPayload.reviewRevision }, {
                        headers: { "cache-control": "no-store" },
                    });
                }
                if (request.method === "GET" && url.pathname === "/api/review/conversation") {
                    if (!reviewConversation || !hasReviewAssetToken(request, token)) {
                        return new Response("Review conversation unavailable.", { status: 404 });
                    }
                    return Response.json({
                        agentLabel: reviewConversation.agentLabel,
                        revision: reviewConversation.revision,
                        sequenceDocuments: reviewPayload.sequenceDocuments,
                        plan: typeof reviewPayload.plan === "string" ? reviewPayload.plan : "",
                        rawPatch: typeof reviewPayload.rawPatch === "string" ? reviewPayload.rawPatch : "",
                        gitRef: typeof reviewPayload.gitRef === "string" ? reviewPayload.gitRef : "",
                        reviewStatus: reviewPayload.reviewStatus || null,
                        events: reviewConversation.events.map((event) => ({ ...event })),
                    }, { headers: { "cache-control": "no-store" } });
                }
                if (
                    reviewType === "code" &&
                    (url.pathname.startsWith("/api/agents/") || url.pathname.startsWith("/api/guide/"))
                ) {
                    if (
                        !hasReviewAssetToken(request, token) && request.headers.get("x-runwield-review-token") !== token
                    ) {
                        return new Response("Review token required.", { status: 401 });
                    }
                    const response = await reviewAgentApi(request, url, reviewAgentState);
                    if (response) return response;
                }
                if (reviewType === "code" && url.pathname.startsWith("/api/review/widgets/")) {
                    if (
                        !hasReviewAssetToken(request, token) && request.headers.get("x-runwield-review-token") !== token
                    ) {
                        return new Response("Review token required.", { status: 401 });
                    }
                    const response = reviewWidgetApi(request, url, {
                        token,
                        reviewPayload,
                        widgets: reviewAgentState.widgets,
                    });
                    if (response) return response;
                }
                if (url.pathname.startsWith("/api/review/") || isLegacyReviewApiPath(url.pathname)) {
                    return await handleReviewApiRequest(
                        request,
                        { cwd, reviewToken: token, reviewPayload, onDecision: options.onDecision },
                        url.pathname,
                    );
                }
                if (!hasWorkspaceToken(request, token)) return new Response("Review token required.", { status: 401 });
                const expectedPath = reviewType === "plan" ? "/review/plan" : "/review/code";
                if (url.pathname === expectedPath) {
                    const opened = await options.onReviewOpen?.();
                    if (opened instanceof Response) return opened;
                    const payload = await currentReviewPagePayload({ cwd, reviewPayload, reviewType, token });
                    const astroResponse = await renderAstroReviewPage(request, cwd, payload);
                    if (astroResponse) return astroResponse;
                    return renderStaticReviewFallback(reviewType, payload);
                }
                return new Response("Not found", { status: 404 });
            };
        },
    };
}

/**
 * Refresh Code Review from the working tree on every document request. The
 * recorded target branch is resolved for each refresh.
 *
 * @param {{ cwd: string, reviewPayload: Record<string, unknown>, reviewType: "plan" | "code", token: string }} options
 */
async function currentReviewPagePayload({ cwd, reviewPayload, reviewType, token }) {
    const payload = { ...reviewPayload, token, mode: "workflow" };
    if (reviewType === "code" && typeof reviewPayload.targetBranch === "string") {
        try {
            payload.rawPatch = await getWorktreeReviewDiff(cwd, reviewPayload.targetBranch);
        } catch (error) {
            if (error instanceof WorktreeReviewComparisonError) throw error;
            // Keep the last complete patch if the checkout is temporarily unreadable.
        }
    }
    delete payload.targetBranch;
    delete payload.agentCwd;
    return payload;
}

/** @param {Request} request @param {string} token */
function hasReviewAssetToken(request, token) {
    if (hasWorkspaceToken(request, token)) return true;
    const referer = request.headers.get("referer");
    if (!referer) return false;
    try {
        return new URL(referer).searchParams.get(PLAN_UI_TOKEN_QUERY) === token;
    } catch {
        return false;
    }
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

/** @param {Request} request @param {{ cwd: string }} state @param {string} pathname */
async function handleReviewApiRequest(request, state, pathname) {
    if (request.method === "POST" && (pathname === "/api/review/decision" || pathname === "/api/decision")) {
        return await reviewDecisionApi(ctx(request, state));
    }
    if (request.method === "POST" && (pathname === "/api/review/deny" || pathname === "/api/deny")) {
        return await reviewDenyApi(ctx(request, state));
    }
    if (request.method === "POST" && (pathname === "/api/review/feedback" || pathname === "/api/feedback")) {
        return await reviewFeedbackApi(ctx(request, state));
    }
    if (request.method === "POST" && (pathname === "/api/review/exit" || pathname === "/api/exit")) {
        return await reviewExitApi(ctx(request, state));
    }
    return jsonNotFound();
}

/**
 * @template {import('./routes/api/handlers.ts').WorkspaceApiState} State
 * @param {Request} req
 * @param {State} state
 * @param {Record<string, string>} [params]
 */
function ctx(req, state, params = {}) {
    return { req, request: req, url: new URL(req.url), state, params };
}

let astroHandlePromise;
let astroImportFailure = false;

function loadAstroHandle() {
    if (Deno.env.get("WLD_WORKSPACE_DISABLE_BUILT_SERVER") === "1") return null;
    if (!astroHandlePromise) {
        astroHandlePromise = (async () => {
            const entryPaths = Deno.build.standalone
                ? [ASTRO_RUNTIME_ENTRY_PATH, ASTRO_SOURCE_ENTRY_PATH]
                : [ASTRO_SOURCE_ENTRY_PATH, ASTRO_RUNTIME_ENTRY_PATH];
            for (const entryPath of entryPaths) {
                try {
                    if (!await isAstroEntryImportable(entryPath)) continue;
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
        })().then((handle) => {
            if (!handle) astroHandlePromise = null;
            return handle;
        }, (error) => {
            astroHandlePromise = null;
            throw error;
        });
    }
    return astroHandlePromise;
}

async function isAstroEntryImportable(entryPath) {
    try {
        const source = await Deno.readTextFile(entryPath);
        return source.includes('"key":');
    } catch {
        return false;
    }
}

/** @param {Request} request @param {string} cwd */
async function renderAstroPage(request, cwd) {
    const handle = await loadAstroHandle();
    if (!handle) return null;
    const response = await handle(withWorkspaceCwdHeader(request, cwd));
    return response.status === 404 ? null : response;
}

/** @param {Request} request @param {string} cwd @param {Record<string, unknown>} payload */
async function renderAstroReviewPage(request, cwd, payload) {
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
async function renderAstroQuestionPage(request, cwd, payload) {
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
function isLegacyReviewApiPath(pathname) {
    return pathname === "/api/decision" ||
        pathname === "/api/deny" ||
        pathname === "/api/feedback" ||
        pathname === "/api/exit";
}

/**
 * @param {"plan" | "code"} reviewType
 * @param {Record<string, unknown>} payload
 */
function renderStaticReviewFallback(reviewType, payload) {
    const title = payload?.surface === "artifact-read"
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

function workspaceBuildUnavailable() {
    return new Response(
        astroImportFailure
            ? "Workspace renderer module evaluation failed. Repair the build and restart the Workspace server; JavaScript may cache the failure."
            : "Workspace Astro build unavailable. Run `deno task workspace:build` before serving page routes.",
        {
            status: 503,
            headers: { "content-type": "text/plain; charset=utf-8" },
        },
    );
}

/** @param {string} value */
function escapeHtml(value) {
    return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll(
        '"',
        "&quot;",
    );
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
        ? `<strong class="workspace-main-session-name" data-workspace-surface-title>${
            escapeHtml(options.surfaceTitle)
        }</strong>`
        : `<a class="brand workspace-main-brand" href="/" aria-label="RunWield Workspace home"><img class="brand-logo" src="/brand/logo.svg" alt="" aria-hidden="true"><span>RunWield Workspace</span></a>`;
    const headerClass = options.surfaceTitle
        ? "workspace-main-header workspace-main-surface-header"
        : "workspace-main-header";
    const html =
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${
            escapeHtml(title)
        }</title><link rel="icon" href="/brand/logo.svg" type="image/svg+xml"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/components.css"><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/theme.css"></head><body class="theme-runwield"><div class="workspace-shell workspace-shell-with-sidebar owner-workspace-shell"><aside class="workspace-sidebar" data-workspace-sidebar aria-label="Workspace navigation"><p class="workspace-sidebar-empty"><span class="rw-thinking-dots" role="status"><span class="rw-thinking-glyph" aria-hidden="true"></span>Loading Workspace</span></p></aside><div class="workspace-main-shell"><header class="${headerClass}"><div class="workspace-main-header-left" data-workspace-main-header-left>${headerTitle}</div></header><main>${body}</main></div></div><script type="module" src="/workspace-shell.js"></script></body></html>`;
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

/** @param {any} ctx */
async function ownerInSituReviewFileContent(ctx) {
    const projectId = ownerReviewProjectId(ctx.req);
    if (!projectId) return ownerErrorJson(new Error("Review Project context is missing."), 400);
    try {
        const root = requireOwnerProjectRoot(ctx.state.store, projectId);
        return await reviewFileContentApi(ctx.req, { cwd: root });
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
async function renderRequiredOwnerAstroPage(ctx, cwd = Deno.cwd()) {
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
        `<section class="page-header"><a class="detail-back-link" href="/">← Projects</a><h1>Project Sessions</h1><p>Build the Workspace frontend to enable the interactive phone Session list.</p></section><section class="owner-card empty-state"><h2>Workspace build unavailable</h2><p>Run <code>deno task workspace:build</code>, then reopen Sessions.</p></section>`,
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
        `<section class="page-header"><a class="detail-back-link" href="/projects/${
            encodeURIComponent(ctx.params.projectId)
        }/sessions">← Sessions</a><h1>New Session</h1></section><section class="owner-card empty-state"><h2>Workspace build unavailable</h2><p>Run <code>deno task workspace:build</code>, then reopen New Session.</p></section>`,
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
        `<section class="page-header"><a class="detail-back-link" href="/projects/${
            encodeURIComponent(ctx.params.projectId)
        }/sessions">← Sessions</a><h1>Session Continuation</h1><p>Build the Workspace frontend to enable interactive Session continuation.</p></section><section class="owner-card empty-state"><h2>Workspace build unavailable</h2><p>Run <code>deno task workspace:build</code>, then reopen this Session.</p></section>`,
        { status: 503 },
    );
}

/** @param {Request} request @param {string} cwd */
function withWorkspaceCwdHeader(request, cwd) {
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
            const route = routes.find((candidate) =>
                candidate.method === request.method && matchRoute(candidate.pattern, url.pathname)
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
    app.get(
        "/design-system/sidebar-motion.js",
        async () => await handleStaticRoute("/design-system/sidebar-motion.js"),
    );
    app.get("/theme.css", async () => await handleStaticRoute("/theme.css"));
    app.get("/brand/logo.svg", async () => await handleStaticRoute("/brand/logo.svg"));
    app.get("/_astro/:asset", async (ctx) => await handleStaticRoute(ctx.url.pathname));
}

/** @param {string} pathname */
async function handleStaticRoute(pathname) {
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
    const assetPaths = Deno.build.standalone
        ? [
            join(ASTRO_RUNTIME_CLIENT_ASSET_DIR, runtimeAssetName),
            join(ASTRO_SOURCE_CLIENT_ASSET_DIR, assetName),
        ]
        : [
            join(ASTRO_SOURCE_CLIENT_ASSET_DIR, assetName),
            join(ASTRO_RUNTIME_CLIENT_ASSET_DIR, runtimeAssetName),
        ];
    for (const assetPath of assetPaths) {
        try {
            const body = await Deno.readFile(assetPath);
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
        const body = path === WORKSPACE_CSS_PATH ? await readWorkspaceStyles(path) : await Deno.readTextFile(path);
        return new Response(body, { headers: { "content-type": contentType } });
    } catch {
        return new Response("Not found", { status: 404 });
    }
}

/** @param {string} pathname */
function isPublicWorkspaceAsset(pathname) {
    return WORKSPACE_PWA_PATHS.includes(pathname) || pathname === "/styles.css" ||
        pathname === "/tokens.css" ||
        pathname === "/components.css" ||
        pathname === "/workspace.css" ||
        pathname === "/workspace-shell.js" ||
        pathname === "/design-system/sidebar-motion.js" ||
        pathname === "/theme.css" ||
        pathname === "/brand/logo.svg" ||
        pathname.startsWith("/_astro/");
}

function jsonNotFound() {
    return Response.json({ error: "not_found", message: "Not found.", status: 404 }, {
        status: 404,
        headers: { "cache-control": "no-store" },
    });
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
 * @param {{ mode?: "local" | "remote" | "owner", cwd?: string, host: string, port: number, token?: string, dbPath?: string, signal?: AbortSignal, maxRequestBytes?: number, retentionDays?: number, publicOrigin?: string, trustTlsTerminator?: boolean, store?: import("../../shared/owner-coordination/index.js").OwnerCoordinationStore }} options
 */
export function startWorkspaceServer(options) {
    assertWorkspaceServerTransportPolicy(options);
    if (options.mode === "owner" && !options.store) {
        throw new Error("Owner Workspace requires an open owner-coordination store.");
    }
    const ownerPublicOrigin = options.mode === "owner"
        ? normalizeWorkspacePublicOrigin(options.publicOrigin || `http://${options.host}:${options.port}`)
        : "";
    const app = options.mode === "remote"
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
            cwd: options.cwd ?? Deno.cwd(),
            token: options.token ?? "",
            mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
        });
    const server = Deno.serve(
        {
            hostname: options.host,
            port: options.port,
            signal: options.signal,
            automaticCompression: true,
        },
        withAccessLogger(app.handler(), {
            mode: Deno.env.get("RUNWIELD_LOG_MODE")?.toLowerCase() === "prod" ||
                    Deno.env.get("RUNWIELD_LOG_MODE")?.toLowerCase() === "production"
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

/**
 * @param {{ cwd?: string, token: string, questionPayload: Record<string, unknown>, answerQuestion: (request: Request) => Promise<Response>|Response, host?: string, port?: number, signal?: AbortSignal }} options
 */
export function startSessionQuestionWorkspaceServer(options) {
    const host = options.host ?? "127.0.0.1";
    const app = createSessionQuestionWorkspaceApp({
        cwd: options.cwd ?? Deno.cwd(),
        token: options.token,
        questionPayload: options.questionPayload,
        answerQuestion: options.answerQuestion,
    });
    return Deno.serve({
        hostname: host,
        port: options.port ?? 0,
        signal: options.signal,
        automaticCompression: true,
        onListen() {},
    }, app.handler());
}

/**
 * @typedef {Object} ReviewWorkspaceConversationEvent
 * @property {string} type
 * @property {string} delta
 * @property {string} messageId
 * @property {string} agentName
 *
 * @typedef {Object} ReviewWorkspaceConversation
 * @property {string} id
 * @property {string} agentLabel
 * @property {number} revision
 * @property {ReviewWorkspaceConversationEvent[]} events
 *
 * @callback ReviewPageOpenListener
 * @returns {Promise<void | Response>}
 *
 * @typedef {Object} ReviewWorkspaceServerOptions
 * @property {string} [cwd]
 * @property {string} token
 * @property {Record<string, unknown>} reviewPayload
 * @property {"plan" | "code"} reviewType
 * @property {ReviewWorkspaceConversation} [reviewConversation]
 * @property {string} [host]
 * @property {number} [port]
 * @property {AbortSignal} [signal]
 * @property {ReviewServerOutputListener} [onOutput]
 * @property {import("./routes/api/review-handlers.js").ReviewDecisionSink} [onDecision]
 * @property {ReviewPageOpenListener} [onReviewOpen]
 */

/** @param {ReviewWorkspaceServerOptions} options */
export function startReviewWorkspaceServer(options) {
    const cwd = options.cwd ?? Deno.cwd();
    const host = options.host ?? "127.0.0.1";
    let decision = registerReviewDecisionPromise(options.token);
    const appOptions = { ...options, cwd };
    const app = createReviewWorkspaceApp(appOptions);
    let server;
    try {
        server = Deno.serve({
            hostname: host,
            port: options.port ?? 0,
            automaticCompression: true,
            onListen(address) {
                options.onOutput?.({
                    stream: "stdout",
                    text: `Listening on http://${address.hostname}:${address.port}/\n`,
                });
            },
            onError(error) {
                const text = error instanceof Error ? error.stack || error.message : String(error);
                options.onOutput?.({ stream: "stderr", text: `${text}\n` });
                return new Response("Internal Server Error", { status: 500 });
            },
        }, app.handler());
    } catch (error) {
        const text = error instanceof Error ? error.stack || error.message : String(error);
        options.onOutput?.({ stream: "stderr", text: `${text}\n` });
        throw error;
    }
    const port = server.addr.port;
    const url = `http://${host}:${port}`;
    /** @type {Promise<void> | null} */
    let stopPromise = null;

    const stop = () => {
        options.signal?.removeEventListener("abort", onAbort);
        const canceledDecision = options.reviewType === "plan"
            ? { approved: false, feedback: "", exit: true, canceled: true }
            : { approved: false, feedback: "", annotations: [], exit: true, canceled: true };
        resolveReviewDecision(options.token, canceledDecision);
        stopPromise ??= Promise.resolve(app.cleanup()).then(() => server.shutdown()).catch((error) => {
            const text = error instanceof Error ? error.stack || error.message : String(error);
            options.onOutput?.({ stream: "stderr", text: `${text}\n` });
            throw error;
        });
        return stopPromise;
    };
    const onAbort = () => {
        void stop().catch(() => {});
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    return {
        url,
        waitForDecision: () => decision.promise,
        beginReviewRound({ reviewPayload, reviewConversation, onDecision, onReviewOpen }) {
            appOptions.onDecision = onDecision;
            appOptions.onReviewOpen = onReviewOpen;
            const priorRevision = options.reviewPayload.reviewRevision;
            for (const key of Object.keys(options.reviewPayload)) delete options.reviewPayload[key];
            Object.assign(options.reviewPayload, reviewPayload);
            if (reviewPayload.reviewRevisionUrl) options.reviewPayload.reviewRevision = (priorRevision ?? 0) + 1;
            if (options.reviewConversation && reviewConversation) {
                options.reviewConversation.agentLabel = reviewConversation.agentLabel;
                options.reviewConversation.revision += 1;
            }
            decision = registerReviewDecisionPromise(options.token);
        },
        stop,
    };
}
