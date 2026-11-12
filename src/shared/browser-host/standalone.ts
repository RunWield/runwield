// @ts-nocheck: extracted existing standalone browser host composition.

import { serveHttp } from "../http-server.ts";

import { readFile } from "node:fs/promises";

import { basename, dirname, extname, relative, resolve } from "node:path";

import { parseWorkRecordMarkdown } from "../work-records/markdown.ts";
import { workRecordNotices } from "../work-records/list.ts";
import { isEpicArtifactPlanName } from "../epic-artifacts.ts";

import { getCwd, PLAN_UI_TOKEN_QUERY } from "../../constants.js";
import { getWorktreeReviewDiff, WorktreeReviewComparisonError } from "../workflow/git-snapshot.ts";

import {
    registerReviewDecisionPromise,
    resolveReviewDecision,
    reviewDecisionApi,
    reviewDenyApi,
    reviewExitApi,
    reviewFeedbackApi,
} from "./review-handlers.ts";

import { reviewImageApi, reviewImageUploadApi } from "./review-image-handlers.ts";
import {
    cleanupReviewAgentState,
    createReviewAgentState,
    reviewAgentApi,
    getGuideRunner,
} from "./review-agent-handlers.ts";
import {
    resolveWorkspaceFile,
    reviewFileContentApi,
    reviewLocalConfigApi,
    reviewOpenInAppsApi,
} from "./review-file-handlers.ts";
import { reviewWidgetApi } from "./review-widget-handlers.ts";

import { isPublicWorkspaceAsset } from "./public-workspace-assets.ts";
import { reviewHost } from "./review-host.ts";

import {
    hasWorkspaceToken,
    ctx,
    renderAstroReviewPage,
    renderAstroQuestionPage,
    isLegacyReviewApiPath,
    renderStaticReviewFallback,
    workspaceBuildUnavailable,
    handleStaticRoute,
    jsonNotFound,
} from "./page-runtime.ts";

/** @typedef {{ handler: () => (request: Request) => Promise<Response> }} WorkspaceApp */
/** @typedef {Object} ReviewServerOutput
 * @property {"stdout" | "stderr"} stream
 * @property {string} text
 */
/** @typedef {(output: ReviewServerOutput) => void} ReviewServerOutputListener */
/**
 * @param {{ cwd: string, token: string, reviewPayload: Record<string, unknown>, reviewType: "plan" | "code", reviewConversation?: import("../../ui/review/review-launcher.ts").ReviewConversation }} options
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
                        authenticated =
                            referer.origin === url.origin &&
                            referer.pathname === "/review/plan" &&
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
                    const markdown = await readFile(file.absolutePath, "utf8");
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
                    const response =
                        (await renderAstroReviewPage(request, cwd, payload)) ||
                        renderStaticReviewFallback("plan", payload);
                    response.headers.set("cache-control", "no-store");
                    response.headers.set("referrer-policy", "same-origin");
                    return response;
                } catch (error) {
                    const status = ["EACCES", "EPERM"].includes(error.code)
                        ? 403
                        : ["ENOENT", "ENOTDIR"].includes(error.code)
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
    const { cwd = getCwd(), token, reviewPayload, reviewType, reviewConversation } = options;
    const reviewAgentState =
        reviewType === "code"
            ? createReviewAgentState({ cwd, token, reviewPayload, runGuideCommand: getGuideRunner() })
            : null;
    return {
        cleanup: () => (reviewAgentState ? cleanupReviewAgentState(reviewAgentState) : Promise.resolve()),
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
                    const source = reviewPayload.standaloneReview;
                    return await reviewFileContentApi(request, {
                        cwd: source && typeof reviewPayload.agentCwd === "string" ? reviewPayload.agentCwd : cwd,
                        headRef:
                            source &&
                            typeof source === "object" &&
                            "headRef" in source &&
                            typeof source.headRef === "string"
                                ? source.headRef
                                : undefined,
                        targetBranch:
                            typeof reviewPayload.targetBranch === "string" ? reviewPayload.targetBranch : undefined,
                        targetBaseRef:
                            typeof reviewPayload.targetBaseRef === "string" ? reviewPayload.targetBaseRef : undefined,
                    });
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
                    return Response.json(
                        { revision: reviewPayload.reviewRevision },
                        {
                            headers: { "cache-control": "no-store" },
                        },
                    );
                }
                if (
                    request.method === "POST" &&
                    url.pathname === "/api/review/exit" &&
                    reviewPayload.standaloneReview &&
                    reviewConversation?.onExit
                ) {
                    if (!hasReviewAssetToken(request, token)) {
                        return new Response("Review token required.", { status: 401 });
                    }
                    reviewConversation.onExit();
                    return Response.json({ ok: true });
                }
                if (request.method === "GET" && url.pathname === "/api/review/conversation") {
                    if (!reviewConversation || !hasReviewAssetToken(request, token)) {
                        return new Response("Review conversation unavailable.", { status: 404 });
                    }
                    await reviewConversation.refresh?.();
                    if (reviewConversation.completed) reviewConversation.completionDelivered = true;
                    return Response.json(
                        {
                            completed: reviewConversation.completed,
                            resultMessage: reviewConversation.resultMessage,
                            standaloneReview: reviewPayload.standaloneReview,
                            agentLabel: reviewConversation.agentLabel,
                            revision: reviewConversation.revision,
                            reviewRevision: reviewPayload.reviewRevision,
                            ...(reviewConversation.turns && {
                                turns: reviewConversation.turns,
                                pending: reviewConversation.pending,
                            }),
                            error: reviewConversation.error,
                            sequenceDocuments: reviewPayload.sequenceDocuments,
                            plan: typeof reviewPayload.plan === "string" ? reviewPayload.plan : "",
                            rawPatch: typeof reviewPayload.rawPatch === "string" ? reviewPayload.rawPatch : "",
                            gitRef: typeof reviewPayload.gitRef === "string" ? reviewPayload.gitRef : "",
                            reviewStatus: reviewPayload.reviewStatus || null,
                            events: reviewConversation.events.map((event) => ({ ...event })),
                        },
                        { headers: { "cache-control": "no-store" } },
                    );
                }
                if (
                    reviewType === "code" &&
                    (url.pathname.startsWith("/api/agents/") ||
                        url.pathname.startsWith("/api/guide/") ||
                        url.pathname.startsWith("/api/ai-review/"))
                ) {
                    if (
                        !hasReviewAssetToken(request, token) &&
                        request.headers.get("x-runwield-review-token") !== token
                    ) {
                        return new Response("Review token required.", { status: 401 });
                    }
                    const response = await reviewAgentApi(request, url, reviewAgentState);
                    if (response) return response;
                }
                if (reviewType === "code" && url.pathname.startsWith("/api/review/widgets/")) {
                    if (
                        !hasReviewAssetToken(request, token) &&
                        request.headers.get("x-runwield-review-token") !== token
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
                        {
                            cwd,
                            reviewToken: token,
                            reviewType,
                            reviewPayload,
                            onDecision: options.onDecision,
                            keepConversationTurns: Boolean(reviewConversation?.refresh),
                        },
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
    if (reviewType === "plan") {
        const relativePlanPath = (path) =>
            typeof path === "string" ? relative(cwd, resolve(cwd, path)).replaceAll("\\", "/") : path;
        payload.planPath = relativePlanPath(payload.planPath);
        if (Array.isArray(payload.sequenceDocuments)) {
            payload.sequenceDocuments = payload.sequenceDocuments.map((document) => ({
                ...document,
                planPath: relativePlanPath(document.planPath),
            }));
        }
    }
    if (reviewType === "code" && typeof reviewPayload.targetBranch === "string") {
        try {
            payload.rawPatch = await getWorktreeReviewDiff(
                cwd,
                reviewPayload.targetBranch,
                typeof reviewPayload.targetBaseRef === "string" ? reviewPayload.targetBaseRef : undefined,
            );
        } catch (error) {
            if (error instanceof WorktreeReviewComparisonError) throw error;
            // Keep the last complete patch if the checkout is temporarily unreadable.
        }
    }
    delete payload.targetBranch;
    delete payload.targetBaseRef;
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
 * @param {{ cwd?: string, token: string, questionPayload: Record<string, unknown>, answerQuestion: (request: Request) => Promise<Response>|Response, host?: string, port?: number, signal?: AbortSignal }} options
 */
export function startSessionQuestionWorkspaceServer(options) {
    const host = options.host ?? "127.0.0.1";
    const app = createSessionQuestionWorkspaceApp({
        cwd: options.cwd ?? getCwd(),
        token: options.token,
        questionPayload: options.questionPayload,
        answerQuestion: options.answerQuestion,
    });
    return serveHttp(
        {
            hostname: host,
            port: options.port ?? 0,
            signal: options.signal,
            automaticCompression: true,
            onListen() {},
        },
        app.handler(),
    );
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
 * @property {import("../../ui/review/review-launcher.ts").ReviewConversation} [reviewConversation]
 * @property {string} [host]
 * @property {number} [port]
 * @property {AbortSignal} [signal]
 * @property {ReviewServerOutputListener} [onOutput]
 * @property {import("./review-handlers.ts").ReviewDecisionSink} [onDecision]
 * @property {ReviewPageOpenListener} [onReviewOpen]
 */

/** @param {ReviewWorkspaceServerOptions} options */
export function startReviewWorkspaceServer(options) {
    const cwd = options.cwd ?? getCwd();
    if (options.reviewType === "code") options.reviewPayload.reviewRevision = 0;
    let decision = registerReviewDecisionPromise(options.token);
    const appOptions = { ...options, cwd };
    const app = createReviewWorkspaceApp(appOptions);
    let registration;
    try {
        registration = reviewHost.register(options.token, app.handler(), {
            onError(error) {
                const text = error instanceof Error ? error.stack || error.message : String(error);
                options.onOutput?.({ stream: "stderr", text: `${text}\n` });
                return new Response("Internal Server Error", { status: 500 });
            },
        });
    } catch (error) {
        const text = error instanceof Error ? error.stack || error.message : String(error);
        options.onOutput?.({ stream: "stderr", text: `${text}\n` });
        throw error;
    }
    const url = registration.origin;
    options.onOutput?.({ stream: "stdout", text: `Listening on ${url}/\n` });
    /** @type {Promise<void> | null} */
    let stopPromise = null;

    const stop = () => {
        options.signal?.removeEventListener("abort", onAbort);
        const canceledDecision =
            options.reviewType === "plan"
                ? { approved: false, feedback: "", exit: true, canceled: true }
                : { approved: false, feedback: "", annotations: [], exit: true, canceled: true };
        resolveReviewDecision(options.token, canceledDecision);
        stopPromise ??= Promise.resolve(app.cleanup())
            .then(() => registration.release())
            .catch((error) => {
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
            if (options.reviewType === "code" || reviewPayload.reviewRevisionUrl)
                options.reviewPayload.reviewRevision = (priorRevision ?? 0) + 1;
            if (options.reviewConversation && reviewConversation) {
                options.reviewConversation.agentLabel = reviewConversation.agentLabel;
                options.reviewConversation.revision += 1;
            }
            decision = registerReviewDecisionPromise(options.token);
        },
        stop,
    };
}
