import { readControllerRecord } from "../../../shared/workflow/controller-registry.ts";
import { ownerPlanContinuationApi } from "./owner-plan-continuation.ts";
import { resolveWorkflowPlanLocation } from "../../../shared/workflow/plan-location.ts";
/* @module ui/workspace/routes/owner-session-api */

import { ImageSubmissionValidationError } from "../server/session-continuation.js";
import { ownerErrorJson, ownerJson, sanitizeOwnerError } from "./owner-api.js";
import { ownerSecurityHeaders } from "../server/owner-origin.ts";
import { findPlanEvidenceById } from "../../../plan-store.js";
import { requireOwnerProjectRoot, sessionBelongsToOwnerProject } from "../server/owner-projects.ts";
import { getSlashCommandDefinition } from "../../../cmd/registry.js";

const MAX_JSON_BYTES = 12 * 1024 * 1024;

/**
 * @typedef {Object} SessionPlanAssociation
 * @property {string} [planId]
 * @property {number | null} [committedGeneration]
 */

/**
 * @typedef {Object} OwnerSessionSummary
 * @property {string} [runwieldSessionId]
 */

/** @param {Request} request */
async function readJson(request) {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) throw new Error("Request body is too large.");
    return text ? JSON.parse(text) : {};
}

/** @param {unknown} value @param {string} field @param {number} max */
function requireBoundedString(value, field, max) {
    if (typeof value !== "string" || value.length < 1 || value.length > max) {
        throw new Error(`${field} is invalid.`);
    }
    return value;
}

/** @param {unknown} value */
function requireExpectedGeneration(value) {
    const generation = Number(value);
    if (!Number.isInteger(generation) || generation < 0) throw new Error("expectedGeneration is invalid.");
    return generation;
}

/** @param {string | null} value @param {string} field @param {number} fallback @param {number} max */
function readPageValue(value, field, fallback, max) {
    if (value === null || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) throw new Error(`${field} is invalid.`);
    return parsed;
}

/** @param {unknown} value */
function readSubmittedImages(value) {
    if (!Array.isArray(value)) return [];
    return value.map((image) => {
        const source = image && typeof image === "object" ? /** @type {Record<string, unknown>} */ (image) : {};
        const base64 = requireBoundedString(source.base64, "image.base64", 10 * 1024 * 1024);
        const mimeType = requireBoundedString(source.mimeType, "image.mimeType", 80);
        if (!mimeType.startsWith("image/")) throw new Error("Only image attachments are supported.");
        return { base64, mimeType };
    });
}

/** @param {unknown} value */
function safeEvent(value) {
    if (!value || typeof value !== "object") return value;
    const source = /** @type {Record<string, unknown>} */ (value);
    const safe = { ...source };
    delete safe._meta;
    delete safe.args;
    return safe;
}

/** @param {unknown} value */
function safeDiagnostic(value) {
    if (!value || typeof value !== "object") return { code: "catalog_diagnostic", message: String(value || "") };
    const source = /** @type {Record<string, unknown>} */ (value);
    return {
        code: typeof source.code === "string" ? source.code : "catalog_diagnostic",
        message: typeof source.message === "string"
            ? source.message.replaceAll(/(?:[A-Za-z]:)?[/\\][^\s,)]+/g, "[local path]")
            : "Catalog diagnostic recorded.",
    };
}

/** @param {Record<string, unknown>} result */
function safeTimelineResult(result) {
    const safe = { ...result };
    delete safe.segments;
    return safe;
}

/** @param {Record<string, unknown>} body @param {string} field @param {number} maxLength */
function readOptionalBoundedString(body, field, maxLength) {
    return typeof body[field] === "string" && body[field]
        ? requireBoundedString(body[field], field, maxLength)
        : undefined;
}

/** @param {any} ctx */
export async function ownerSessionOptionsApi(ctx) {
    try {
        requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        const result = await ctx.state.sessionContinuation.listSessionOptions(ctx.params.projectId);
        return ownerJson(result);
    } catch (error) {
        return ownerErrorJson(error, 400);
    }
}

/**
 * @param {OwnerSessionSummary} session
 * @param {{ listSessionPlanAssociations?: (runwieldSessionId?: string, projectId?: string) => SessionPlanAssociation[] }} store
 * @param {string} projectId
 * @returns {string[]}
 */
function committedPlanIdsForSession(session, store, projectId) {
    const associations = store.listSessionPlanAssociations?.(session.runwieldSessionId, projectId) || [];
    return associations
        .filter((association) => association.committedGeneration !== null)
        .map((association) => String(association.planId || ""))
        .filter(Boolean);
}

/** @param {any} sessionContinuation @param {string} projectId @param {{ page: number, pageSize: number, includeEmpty: boolean }} options */
async function listAllSessionsForFilter(sessionContinuation, projectId, options) {
    /** @type {OwnerSessionSummary[]} */
    const sessions = [];
    /** @type {Array<{ code?: string, message?: string, source?: string }>} */
    const diagnostics = [];
    let page = 0;
    let hasNext = true;
    while (hasNext) {
        const result = await sessionContinuation.listSessions(projectId, { ...options, page, pageSize: 100 });
        sessions.push(...(result.sessions || []));
        diagnostics.push(...(result.diagnostics || []));
        hasNext = result.hasNext === true;
        page += 1;
    }
    return {
        page: options.page,
        pageSize: options.pageSize,
        total: sessions.length,
        hasNext: false,
        hasPrevious: false,
        diagnostics,
        sessions,
    };
}

/** @param {any} ctx */
export async function ownerProjectSessionsApi(ctx) {
    try {
        requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        const page = readPageValue(ctx.url.searchParams.get("page"), "page", 0, 10_000);
        const pageSize = readPageValue(ctx.url.searchParams.get("pageSize"), "pageSize", 30, 100);
        const archiveState = ctx.url.searchParams.get("archiveState") || "active";
        if (!["active", "archived", "all"].includes(archiveState)) throw new Error("archiveState is invalid.");
        const listOptions = {
            archiveState: ctx.url.searchParams.get("plan") ? "all" : archiveState,
            page,
            pageSize,
            includeEmpty: ctx.url.searchParams.get("includeEmpty") === "true",
            includeTotal: ctx.url.searchParams.get("includeTotal") !== "false",
        };
        const planId = ctx.url.searchParams.get("plan") || "";
        const excludeAssociated = ctx.url.searchParams.get("excludeAssociated") === "true";
        const nestedPlanIds = ctx.url.searchParams.getAll("nestedPlan").filter(Boolean);
        if (!listOptions.includeTotal) {
            const result = await ctx.state.sessionContinuation.listSessions(ctx.params.projectId, {
                ...listOptions,
                planId,
                excludedPlanIds: excludeAssociated ? nestedPlanIds : [],
                excludedSessionIds: ctx.url.searchParams.getAll("excludeSession").filter(Boolean),
            });
            return ownerJson({ ...result, diagnostics: (result.diagnostics || []).map(safeDiagnostic) });
        }
        const result = planId || excludeAssociated
            ? await listAllSessionsForFilter(ctx.state.sessionContinuation, ctx.params.projectId, listOptions)
            : await ctx.state.sessionContinuation.listSessions(ctx.params.projectId, listOptions);
        let sessions = /** @type {OwnerSessionSummary[]} */ (result.sessions || []);
        if (planId || excludeAssociated) {
            const nested = new Set(nestedPlanIds);
            sessions = sessions.filter((session) => {
                const committedPlanIds = committedPlanIdsForSession(session, ctx.state.store, ctx.params.projectId);
                if (planId) return committedPlanIds.includes(planId);
                return nested.size ? !committedPlanIds.some((associatedPlanId) => nested.has(associatedPlanId)) : true;
            });
        }
        if (planId || excludeAssociated) {
            const start = page * pageSize;
            return ownerJson({
                ...result,
                page,
                pageSize,
                total: sessions.length,
                hasNext: start + pageSize < sessions.length,
                hasPrevious: page > 0 && start < sessions.length,
                sessions: sessions.slice(start, start + pageSize),
                diagnostics: (result.diagnostics || []).map(safeDiagnostic),
            });
        }
        return ownerJson({
            ...result,
            sessions,
            diagnostics: (result.diagnostics || []).map(safeDiagnostic),
        });
    } catch (error) {
        return ownerErrorJson(error, 400);
    }
}

/**
 * @typedef {Object} SessionArchiveRouteContext
 * @property {Request} req
 * @property {{ projectId: string, runwieldSessionId: string }} params
 * @property {{ store: import('../../../shared/owner-coordination/index.js').OwnerCoordinationStore, sessionContinuation: import('../server/session-continuation.js').WorkspaceSessionContinuationService }} state
 */
/** @param {SessionArchiveRouteContext} ctx */
export async function ownerSessionArchiveApi(ctx) {
    try {
        requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        const body = await readJson(ctx.req);
        if (body.confirmed !== undefined && typeof body.confirmed !== "boolean") {
            throw new Error("confirmed must be a boolean.");
        }
        return ownerJson(
            await ctx.state.sessionContinuation.archiveSession({
                ...ctx.params,
                confirmed: body.confirmed === true,
            }),
        );
    } catch (error) {
        return ownerErrorJson(error, 409);
    }
}

/** @param {SessionArchiveRouteContext} ctx */
export async function ownerSessionUnarchiveApi(ctx) {
    try {
        requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        return ownerJson(await ctx.state.sessionContinuation.unarchiveSession(ctx.params));
    } catch (error) {
        return ownerErrorJson(error, 409);
    }
}

/** @param {any} ctx */
export async function ownerSessionTimelineApi(ctx) {
    try {
        const cursor = ctx.url.searchParams.get("cursorEventId") || undefined;
        const cursorEventId = cursor ? requireBoundedString(cursor, "cursorEventId", 200) : undefined;
        const rawLimit = ctx.url.searchParams.get("limit");
        const limit = rawLimit ? Math.max(1, Math.min(500, Number(rawLimit) || 200)) : undefined;
        requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        const result = await ctx.state.sessionContinuation.timeline(ctx.params.runwieldSessionId, {
            projectId: ctx.params.projectId,
            cursorEventId,
            limit,
            latest: ctx.url.searchParams.get("latest") === "true",
            beforeEventId: ctx.url.searchParams.get("beforeEventId")
                ? requireBoundedString(ctx.url.searchParams.get("beforeEventId"), "beforeEventId", 200)
                : undefined,
        });
        return ownerJson({ ...safeTimelineResult(result), events: (result.events || []).map(safeEvent) });
    } catch (error) {
        const message = sanitizeOwnerError(error);
        return ownerJson({ error: message }, /reconcile|uncertain|disabled/.test(message) ? 503 : 409);
    }
}

/**
 * @typedef {Object} LiveSessionRouteContext
 * @property {{ projectId: string, runwieldSessionId: string }} params
 * @property {{ store: import('../../../shared/owner-coordination/index.js').OwnerCoordinationStore, sessionContinuation: import('../server/session-continuation.js').WorkspaceSessionContinuationService }} state
 */
/** @param {LiveSessionRouteContext} ctx */
export async function ownerSessionLiveApi(ctx) {
    try {
        requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        const result = await ctx.state.sessionContinuation.liveSession(
            ctx.params.projectId,
            ctx.params.runwieldSessionId,
        );
        return ownerJson({
            ...result,
            operation: result.operation
                ? { ...result.operation, events: result.operation.events.map(safeEvent) }
                : null,
        });
    } catch (error) {
        return ownerErrorJson(error, 404);
    }
}

/** @param {any} ctx */
export async function ownerSessionBootstrapApi(ctx) {
    try {
        const body = await readJson(ctx.req);
        requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        const result = await ctx.state.sessionContinuation.bootstrap({
            deviceId: ctx.state.ownerDevice?.deviceId || null,
            projectId: ctx.params.projectId,
            runwieldSessionId: ctx.params.runwieldSessionId,
            requestId: requireBoundedString(body.requestId, "requestId", 128),
        });
        return ownerJson(result, 202);
    } catch (error) {
        const message = sanitizeOwnerError(error);
        return ownerJson({ error: message }, /not enabled|epoch|uncertain|reconcile/.test(message) ? 503 : 409);
    }
}

/** @param {any} ctx */
export async function ownerSessionCreateApi(ctx) {
    try {
        const body = await readJson(ctx.req);
        requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        const result = await ctx.state.sessionContinuation.createSession({
            deviceId: ctx.state.ownerDevice?.deviceId || null,
            projectId: ctx.params.projectId,
            requestId: requireBoundedString(body.requestId, "requestId", 128),
            text: body.text ? requireBoundedString(body.text, "text", 32_000) : "",
            images: readSubmittedImages(body.images),
            agentName: typeof body.agentName === "string"
                ? requireBoundedString(body.agentName, "agentName", 128)
                : undefined,
            model: typeof body.model === "string" && body.model
                ? requireBoundedString(body.model, "model", 300)
                : undefined,
            provider: typeof body.provider === "string" && body.provider
                ? requireBoundedString(body.provider, "provider", 128)
                : undefined,
            thinkingLevel: typeof body.thinkingLevel === "string" && body.thinkingLevel
                ? requireBoundedString(body.thinkingLevel, "thinkingLevel", 32)
                : undefined,
        });
        return ownerJson(result, 202);
    } catch (error) {
        const message = sanitizeOwnerError(error);
        const status = error instanceof ImageSubmissionValidationError
            ? 422
            : (/not enabled|epoch|uncertain|reconcile/.test(message) ? 503 : 409);
        return ownerJson({ error: message }, status);
    }
}

/** @param {any} ctx */
export async function ownerSessionContinuationStartApi(ctx) {
    try {
        const body = await readJson(ctx.req);
        requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        const result = await ctx.state.sessionContinuation.startContinuation({
            deviceId: ctx.state.ownerDevice?.deviceId || null,
            projectId: ctx.params.projectId,
            runwieldSessionId: ctx.params.runwieldSessionId,
            requestId: requireBoundedString(body.requestId, "requestId", 128),
            expectedGeneration: requireExpectedGeneration(body.expectedGeneration),
            text: typeof body.text === "string" && body.text.length === 0
                ? " "
                : requireBoundedString(body.text, "text", 32_000),
            images: readSubmittedImages(body.images),
        });
        return ownerJson(result, 202);
    } catch (error) {
        const message = sanitizeOwnerError(error);
        const status = error instanceof ImageSubmissionValidationError
            ? 422
            : (/not enabled|epoch|uncertain|reconcile/.test(message) ? 503 : 409);
        return ownerJson({ error: message }, status);
    }
}

/** @param {any} ctx */
export async function ownerSessionPlanReviewApi(ctx) {
    try {
        const body = await readJson(ctx.req);
        requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        const result = await ctx.state.sessionContinuation.startPlanReview({
            deviceId: ctx.state.ownerDevice?.deviceId || null,
            projectId: ctx.params.projectId,
            runwieldSessionId: ctx.params.runwieldSessionId,
            requestId: requireBoundedString(body.requestId, "requestId", 128),
            expectedGeneration: requireExpectedGeneration(body.expectedGeneration),
        });
        return ownerJson(result, result.kind === "starting" ? 202 : 200);
    } catch (error) {
        const message = sanitizeOwnerError(error);
        return ownerJson({ error: message }, /not enabled|epoch|uncertain|reconcile/.test(message) ? 503 : 409);
    }
}

/** @param {any} ctx */
export async function ownerSessionPlanWorkflowApi(ctx) {
    try {
        const body = await readJson(ctx.req);
        const projectRoot = requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        const planId = requireBoundedString(body.planId, "planId", 300);
        if (body.action === "resume_from_hold") {
            return await ownerPlanContinuationApi({
                ...ctx,
                params: { ...ctx.params, planId },
                req: new Request(ctx.req.url, { method: "POST", body: JSON.stringify(body) }),
            });
        }
        const retained = body.action === "retry_work_record"
            ? await readControllerRecord(projectRoot, { planId, planName: "" })
            : null;
        const recording = retained?.planId === planId && retained.state.recordingSource ? retained : null;
        const primary = recording
            ? { planId, planName: recording.planName }
            : await findPlanEvidenceById(projectRoot, planId);
        const plan = recording
            ? { attrs: { planId }, markdown: "", body: "" }
            : (await resolveWorkflowPlanLocation(projectRoot, primary.planName)).plan;
        if (!plan || plan.attrs.planId !== primary.planId) {
            throw new Error("Plan evidence is unavailable. Refresh and try again.");
        }
        const result = await ctx.state.sessionContinuation.startPlanWorkflowHandoff({
            requestId: readOptionalBoundedString(body, "requestId", 128) || crypto.randomUUID(),
            deviceId: ctx.state.ownerDevice?.deviceId || null,
            action: readOptionalBoundedString(body, "action", 32) || "run",
            projectId: ctx.params.projectId,
            runwieldSessionId: ctx.params.runwieldSessionId,
            expectedGeneration: requireExpectedGeneration(body.expectedGeneration),
            planName: primary.planName,
            planContent: plan.markdown || plan.body || "",
            triageMeta: { ...plan.attrs, planId: primary.planId },
        });
        if (result?.error) return ownerJson({ error: result.error }, 409);
        return ownerJson(result, 202);
    } catch (error) {
        const message = sanitizeOwnerError(error);
        return ownerJson({ error: message }, /busy|generation|not found|requires/.test(message) ? 409 : 503);
    }
}

/** @param {any} ctx */
export async function ownerSessionConfigureApi(ctx) {
    try {
        const body = await readJson(ctx.req);
        requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        const result = await ctx.state.sessionContinuation.configureSession({
            projectId: ctx.params.projectId,
            runwieldSessionId: ctx.params.runwieldSessionId,
            expectedGeneration: requireExpectedGeneration(body.expectedGeneration),
            agentName: readOptionalBoundedString(body, "agentName", 128),
            model: readOptionalBoundedString(body, "model", 300),
            provider: readOptionalBoundedString(body, "provider", 128),
            thinkingLevel: readOptionalBoundedString(body, "thinkingLevel", 32),
        });
        return ownerJson(result, 202);
    } catch (error) {
        const message = sanitizeOwnerError(error);
        return ownerJson({ error: message }, /busy|generation|not available|not supported/.test(message) ? 409 : 503);
    }
}

/** @param {any} ctx */
export async function ownerSessionForceRecoverApi(ctx) {
    try {
        const body = await readJson(ctx.req);
        requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        const result = await ctx.state.sessionContinuation.forceRecoverSessionControl({
            projectId: ctx.params.projectId,
            runwieldSessionId: ctx.params.runwieldSessionId,
            expectedGeneration: requireExpectedGeneration(body.expectedGeneration),
            expectedCurrentSegmentId: typeof body.expectedCurrentSegmentId === "string"
                ? requireBoundedString(body.expectedCurrentSegmentId, "expectedCurrentSegmentId", 128)
                : null,
        });
        return ownerJson({ status: "recovered", generation: result.generation?.generation ?? null });
    } catch (error) {
        const message = sanitizeOwnerError(error);
        return ownerJson({ error: message }, /still renewing|not available/.test(message) ? 409 : 503);
    }
}

/** @param {any} ctx */
export async function ownerSessionInteractionAnswerApi(ctx) {
    try {
        const body = await readJson(ctx.req);
        requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        const result = await ctx.state.sessionContinuation.answerInteraction({
            deviceId: ctx.state.ownerDevice?.deviceId || null,
            projectId: ctx.params.projectId,
            operationId: ctx.params.operationId,
            interactionId: ctx.params.interactionId,
            runwieldSessionId: typeof body.runwieldSessionId === "string"
                ? requireBoundedString(body.runwieldSessionId, "runwieldSessionId", 200)
                : null,
            requestId: requireBoundedString(body.requestId, "requestId", 128),
            response: body.response,
        });
        return ownerJson(result, result?.status === "recovery_required" ? 409 : 202);
    } catch (error) {
        return ownerErrorJson(error, 409);
    }
}

/**
 * @typedef {Object} SessionSteerRouteContext
 * @property {Request} req
 * @property {{ projectId: string, operationId: string }} params
 * @property {{ store: import('../../../shared/owner-coordination/index.js').OwnerCoordinationStore, sessionContinuation: import('../server/session-continuation.js').WorkspaceSessionContinuationService }} state
 */
/** @param {SessionSteerRouteContext} ctx */
export async function ownerSessionSteerApi(ctx) {
    try {
        const body = await readJson(ctx.req);
        requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        const result = await ctx.state.sessionContinuation.steerOperation({
            projectId: ctx.params.projectId,
            operationId: ctx.params.operationId,
            requestId: requireBoundedString(body.requestId, "requestId", 128),
            text: body.text ? requireBoundedString(body.text, "text", 32_000) : "",
            images: readSubmittedImages(body.images),
        });
        return ownerJson(result, 202);
    } catch (error) {
        return ownerErrorJson(error, 409);
    }
}

/** @param {any} ctx */
export async function ownerSessionOperationCancelApi(ctx) {
    try {
        const result = await ctx.state.sessionContinuation.cancelOperation({ operationId: ctx.params.operationId });
        return ownerJson(result, 202);
    } catch (error) {
        return ownerErrorJson(error, 409);
    }
}

/** @param {any} ctx */
export async function ownerSessionOperationStatusApi(ctx) {
    const result = await ctx.state.sessionContinuation.refreshOperation(ctx.params.operationId);
    return ownerJson({ ...result, events: (result.events || []).map(safeEvent) });
}

/** @param {any} ctx */
export function ownerSessionOperationStreamApi(ctx) {
    const encoder = new TextEncoder();
    const service = ctx.state.sessionContinuation;
    const operationId = ctx.params.operationId;
    let unsubscribe = () => {};
    let unregister = () => {};
    let closed = false;
    let dirty = true;
    let terminal = false;
    /** @type {Record<string, unknown> | null} */
    let finalResult = null;
    /** @type {ReadableStreamDefaultController<Uint8Array> | null} */
    let streamController = null;
    const detach = () => {
        unsubscribe();
        unregister();
        ctx.req.signal.removeEventListener("abort", close);
    };
    const close = () => {
        if (closed) return;
        closed = true;
        detach();
        finalResult = null;
        try {
            streamController?.close();
        } catch { /* canceled or already closed */ }
    };
    const emit = () => {
        const controller = streamController;
        if (!controller || closed || !dirty || controller.desiredSize === null || controller.desiredSize <= 0) return;
        const result = terminal ? finalResult : service.getOperation(operationId);
        if (!result) {
            close();
            return;
        }
        dirty = false;
        const events = Array.isArray(result.events) ? result.events : [];
        try {
            controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ ...result, events: events.map(safeEvent) })}\n\n`),
            );
            if (terminal) close();
        } catch {
            close();
        }
    };
    const body = new ReadableStream({
        start(controller) {
            streamController = controller;
            if (ctx.req.signal.aborted) {
                close();
                return;
            }
            ctx.req.signal.addEventListener("abort", close, { once: true });
            unregister = ctx.state.ownerConnections.register(ctx.state.ownerDevice.deviceId, { close });
            // A synchronous initial callback may finish before subscribeOperation returns.
            const stop = service.subscribeOperationChanges(operationId, (/** @type {string} */ status) => {
                if (closed) return;
                dirty = true;
                if (["completed", "failed", "unknown"].includes(status)) {
                    terminal = true;
                    finalResult = service.getOperation(operationId);
                    unsubscribe();
                }
                emit();
            });
            unsubscribe = stop;
            if (terminal || closed) unsubscribe();
        },
        pull() {
            emit();
        },
        cancel: close,
    });
    const headers = ownerSecurityHeaders(new Headers());
    headers.set("content-type", "text/event-stream");
    headers.set("connection", "keep-alive");
    return new Response(body, { headers });
}

/**
 * @typedef {Object} NotificationStreamState
 * @property {import('../server/session-continuation.js').WorkspaceSessionContinuationService} sessionContinuation
 * @property {{ deviceId: string }} ownerDevice
 * @property {import('../server/owner-connections.ts').OwnerConnectionRegistry} ownerConnections
 */
/**
 * @typedef {Object} NotificationStreamContext
 * @property {NotificationStreamState} state
 */
/** Live alerts belong to the Workspace, independent of the displayed page. @param {NotificationStreamContext} ctx */
export function ownerNotificationsStreamApi(ctx) {
    const encoder = new TextEncoder();
    let unsubscribe = () => {};
    let unregister = () => {};
    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(": connected\n\n"));
            unregister = ctx.state.ownerConnections.register(ctx.state.ownerDevice.deviceId, {
                close() {
                    unsubscribe();
                    unregister();
                    controller.close();
                },
            });
            unsubscribe = ctx.state.sessionContinuation.subscribeNotifications(
                (
                    /** @type {import('../server/session-continuation.js').WorkspaceAttentionNotification} */ notification,
                ) => {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(notification)}\n\n`));
                },
            );
        },
        cancel() {
            unregister();
            unsubscribe();
        },
    });
    const headers = ownerSecurityHeaders(new Headers());
    headers.set("content-type", "text/event-stream");
    headers.set("cache-control", "no-cache");
    headers.set("connection", "keep-alive");
    return new Response(body, { headers });
}

/**
 * @typedef {Object} OwnerCommandMetricsContext
 * @property {Request} req
 * @property {{ projectId: string }} params
 * @property {{ store: import('../../../shared/owner-coordination/index.js').OwnerCoordinationStore }} state
 */

/**
 * Record slash command metric from Workspace client.
 * @param {OwnerCommandMetricsContext} ctx
 */
export async function ownerProjectCommandMetricsApi(ctx) {
    try {
        const root = requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        const raw = await ctx.req.text();
        if (raw.length > 2048) throw new Error("Command observation is too large.");
        const payload = JSON.parse(raw);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            throw new Error("Invalid command observation.");
        }
        const id = requireBoundedString(payload.invocationId, "invocationId", 128);
        if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id)) throw new Error("Invalid invocationId.");
        if (payload.kind !== "builtin" || !["start", "opened", "dispatched", "finish"].includes(payload.phase)) {
            throw new Error("Invalid command observation.");
        }
        if (
            payload.phase !== "finish" &&
            (payload.outcome !== undefined || payload.durationMs !== undefined || payload.dispatched !== undefined)
        ) {
            throw new Error("Invalid command phase details.");
        }
        if (
            payload.phase === "finish" &&
            (!["succeeded", "failed", "canceled", "rejected"].includes(payload.outcome) ||
                (payload.dispatched !== undefined && typeof payload.dispatched !== "boolean") ||
                !Number.isSafeInteger(payload.durationMs) || payload.durationMs < 0 || payload.durationMs > 86_400_000)
        ) {
            throw new Error("Invalid command outcome or duration.");
        }
        const submittedName = requireBoundedString(payload.command, "command", 128);
        const definition = getSlashCommandDefinition(submittedName, "workspace");
        const command = definition?.name || "unknown";
        if (
            !definition && !(["start", "finish"].includes(payload.phase) &&
                (payload.phase !== "finish" || payload.outcome === "rejected"))
        ) {
            throw new Error("Unknown command observation must be rejected.");
        }
        if (payload.sessionId !== undefined) {
            const sessionId = requireBoundedString(payload.sessionId, "sessionId", 128);
            const session = ctx.state.store.getSessionById(sessionId);
            if (!session || !sessionBelongsToOwnerProject(ctx.state.store, session, ctx.params.projectId)) {
                throw new Error("Session does not belong to this Project.");
            }
        }
        const { recordSlashCommandMetric } = await import("../../../shared/workflow/command-metrics.ts");
        const submittedAlias = typeof payload.alias === "string" &&
                getSlashCommandDefinition(payload.alias, "workspace")?.name === command && payload.alias !== command
            ? payload.alias
            : undefined;
        await recordSlashCommandMetric({
            invocationId: id,
            command,
            alias: submittedAlias || (definition && submittedName !== command ? submittedName : undefined),
            kind: "builtin",
            surface: "workspace",
            projectRoot: root,
            sessionId: payload.sessionId,
            phase: payload.phase,
            outcome: payload.phase === "finish" ? payload.outcome : undefined,
            durationMs: payload.phase === "finish" ? payload.durationMs : undefined,
            dispatched: payload.phase === "finish" ? payload.dispatched : undefined,
            errorReason: !definition
                ? "unknown_command"
                : payload.phase === "finish" && payload.outcome === "rejected"
                ? "rejected"
                : payload.phase === "finish" && payload.outcome === "failed"
                ? "failed"
                : null,
        });
        return ownerJson({ ok: true });
    } catch (error) {
        return ownerErrorJson(error, 400);
    }
}
