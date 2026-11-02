/** @module ui/workspace/routes/remote-api */

import { MAINTAINER_SCOPE, REVIEWER_SCOPE } from "../../../shared/collaboration/capabilities.ts";
import {
    assertNonEmptyString,
    assertPositiveInteger,
    normalizeAppendCommentPayload,
    normalizeAppendRevisionPayload,
    normalizeCommentStateChangePayload,
    normalizeCreateSharedSpacePayload,
    normalizeSharedSpaceLifecyclePayload,
} from "../../../shared/collaboration/protocol.js";
import { RemoteWorkspaceError } from "../server/remote-adapter.js";

import type { CapabilityScope } from "../../../shared/collaboration/capabilities.ts";
import type { RemoteWorkspaceAdapter } from "../server/remote-adapter.js";

export interface RemoteApiRouterOptions {
    maxRequestBytes?: number;
}

export interface RemoteApiState extends RemoteApiRouterOptions {
    collaboration: RemoteWorkspaceAdapter;
}

export interface RemoteApiRouteParams {
    [name: string]: string;
}

export interface RemoteApiContext {
    req: Request;
    request: Request;
    url: URL;
    params: RemoteApiRouteParams | null;
    state: RemoteApiState;
}

export type RemoteApiRouteHandler = (context: RemoteApiContext) => Response | Promise<Response>;

export interface RemoteApiRouter {
    get: (pattern: string, handler: RemoteApiRouteHandler) => void;
    post: (pattern: string, handler: RemoteApiRouteHandler) => void;
}

/** Raw JSON fields are spread before the existing protocol normalizers validate them. */
interface RemoteApiJsonFields {
    [name: string]: unknown;
    commentId?: unknown;
    spaceId?: unknown;
    action?: unknown;
}

export const DEFAULT_REMOTE_MAX_REQUEST_BYTES = 5 * 1024 * 1024;

export function registerRemoteApiRoutes(app: RemoteApiRouter) {
    app.post("/api/spaces", createSpaceApi);
    app.get("/api/spaces/:spaceId", getSpaceApi);
    app.get("/api/spaces/:spaceId/revisions/:revision", getRevisionApi);
    app.post("/api/spaces/:spaceId/revisions", appendRevisionApi);
    app.get("/api/spaces/:spaceId/revisions/:revision/comments", listCommentsApi);
    app.post("/api/spaces/:spaceId/revisions/:revision/comments", appendCommentApi);
    app.post("/api/spaces/:spaceId/comments/:commentId/state", setCommentStateApi);
    app.post("/api/spaces/:spaceId/lifecycle", lifecycleApi);
}

async function createSpaceApi(ctx: RemoteApiContext) {
    try {
        const payload = normalizeCreateSharedSpacePayload(await readJson(ctx));
        const hasReviewer = payload.capabilities.some((capability) => capability.scope === REVIEWER_SCOPE);
        const hasMaintainer = payload.capabilities.some((capability) => capability.scope === MAINTAINER_SCOPE);
        if (!hasReviewer || !hasMaintainer) throw new Error("capabilities must include reviewer and maintainer hashes");
        const result = ctx.state.collaboration.createSharedSpace({
            planId: payload.planId,
            payloadCiphertext: payload.initialRevision.payloadCiphertext,
            capabilities: payload.capabilities,
        });
        return json(result, 201);
    } catch (error) {
        return errorJson(error);
    }
}

async function getSpaceApi(ctx: RemoteApiContext) {
    try {
        const spaceId = assertNonEmptyString(ctx.params!.spaceId, "spaceId");
        await requireCapability(ctx, spaceId, REVIEWER_SCOPE);
        return json(ctx.state.collaboration.getSharedSpace(spaceId));
    } catch (error) {
        return errorJson(error);
    }
}

async function getRevisionApi(ctx: RemoteApiContext) {
    try {
        const spaceId = assertNonEmptyString(ctx.params!.spaceId, "spaceId");
        const revision = assertRevisionParam(ctx.params!.revision);
        await requireCapability(ctx, spaceId, REVIEWER_SCOPE);
        return json({ revision: ctx.state.collaboration.getRevision(spaceId, revision) });
    } catch (error) {
        return errorJson(error);
    }
}

async function appendRevisionApi(ctx: RemoteApiContext) {
    try {
        const spaceId = assertNonEmptyString(ctx.params!.spaceId, "spaceId");
        await requireCapability(ctx, spaceId, MAINTAINER_SCOPE);
        const payload = normalizeAppendRevisionPayload(await readJson(ctx));
        return json(
            {
                revision: ctx.state.collaboration.appendRevision(
                    spaceId,
                    payload.payloadCiphertext,
                    payload.expectedRevision,
                ),
            },
            201,
        );
    } catch (error) {
        return errorJson(error);
    }
}

async function listCommentsApi(ctx: RemoteApiContext) {
    try {
        const spaceId = assertNonEmptyString(ctx.params!.spaceId, "spaceId");
        const revision = assertRevisionParam(ctx.params!.revision);
        await requireCapability(ctx, spaceId, REVIEWER_SCOPE);
        return json({ comments: ctx.state.collaboration.listComments(spaceId, revision) });
    } catch (error) {
        return errorJson(error);
    }
}

async function appendCommentApi(ctx: RemoteApiContext) {
    try {
        const spaceId = assertNonEmptyString(ctx.params!.spaceId, "spaceId");
        const revision = assertRevisionParam(ctx.params!.revision);
        await requireCapability(ctx, spaceId, REVIEWER_SCOPE);
        const payload = normalizeAppendCommentPayload(await readJson(ctx));
        return json({ comment: ctx.state.collaboration.appendComment(spaceId, revision, payload.ciphertext) }, 201);
    } catch (error) {
        return errorJson(error);
    }
}

async function setCommentStateApi(ctx: RemoteApiContext) {
    try {
        const spaceId = assertNonEmptyString(ctx.params!.spaceId, "spaceId");
        await requireCapability(ctx, spaceId, REVIEWER_SCOPE);
        const commentId = assertNonEmptyString(ctx.params!.commentId, "commentId");
        const payload = normalizeCommentStateChangePayload({
            commentId,
            ...((await readJson(ctx)) as RemoteApiJsonFields),
        });
        return json({ comment: ctx.state.collaboration.setCommentState(spaceId, commentId, payload.action) });
    } catch (error) {
        return errorJson(error);
    }
}

async function lifecycleApi(ctx: RemoteApiContext) {
    try {
        const spaceId = assertNonEmptyString(ctx.params!.spaceId, "spaceId");
        await requireCapability(ctx, spaceId, MAINTAINER_SCOPE);
        const payload = normalizeSharedSpaceLifecyclePayload({
            spaceId,
            ...((await readJson(ctx)) as RemoteApiJsonFields),
        });
        if (payload.action === "close") return json(ctx.state.collaboration.closeSharedSpace(spaceId));
        ctx.state.collaboration.deleteSharedSpace(spaceId);
        return json({ deleted: true, spaceId });
    } catch (error) {
        return errorJson(error);
    }
}

async function readJson(ctx: RemoteApiContext): Promise<unknown> {
    const request = ctx.req;
    const maxBytes = Number(ctx.state.maxRequestBytes ?? DEFAULT_REMOTE_MAX_REQUEST_BYTES);
    const contentLength = request.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) > maxBytes) throw tooLarge(maxBytes);
    try {
        return JSON.parse(await readBoundedText(request, maxBytes));
    } catch (error) {
        if (error instanceof RemoteWorkspaceError) throw error;
        throw new RemoteWorkspaceError("invalid_json", "Request body must be valid JSON.", 400);
    }
}

async function readBoundedText(request: Request, maxBytes: number) {
    if (!request.body) return "";
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = "";
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            try {
                await reader.cancel();
            } catch {
                /* ignore cancel failures */
            }
            throw tooLarge(maxBytes);
        }
        text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
}

function tooLarge(maxBytes: number) {
    return new RemoteWorkspaceError(
        "request_too_large",
        `Remote Workspace request body exceeds the ${maxBytes} byte limit.`,
        413,
    );
}

async function requireCapability(ctx: RemoteApiContext, spaceId: string, scope: CapabilityScope) {
    const capability = extractBearerCapability(ctx.req);
    await ctx.state.collaboration.verifyCapability(spaceId, capability, scope);
}

function extractBearerCapability(request: Request) {
    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) throw new RemoteWorkspaceError("unauthorized", "Bearer capability is required.", 401);
    return match[1].trim();
}

function assertRevisionParam(value: unknown) {
    const revision = Number(value);
    return assertPositiveInteger(revision, "revision");
}

function json(data: unknown, status = 200) {
    return Response.json(data, {
        status,
        headers: { "cache-control": "no-store" },
    });
}

function errorJson(error: unknown) {
    if (error instanceof RemoteWorkspaceError) {
        return json({ error: error.code, message: error.message, status: error.status }, error.status);
    }
    const message = error instanceof Error ? error.message : "Invalid request.";
    return json({ error: "bad_request", message, status: 400 }, 400);
}
