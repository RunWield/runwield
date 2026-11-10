/** @module ui/workspace/routes/owner-session-api */

import { readControllerRecord } from "../../../shared/workflow/controller-registry.ts";
import { ownerPlanContinuationApi } from "./owner-plan-continuation.ts";
import { resolveWorkflowPlanLocation } from "../../../shared/workflow/plan-location.ts";
import {
    ImageSubmissionValidationError,
    type WorkspaceSessionContinuationService,
    type SessionListOptions,
} from "../server/session-continuation.ts";
import {
    ownerErrorJson,
    ownerJson,
    sanitizeOwnerError,
    type OwnerParamsContext,
    type OwnerRouteContext,
    type OwnerSessionState,
    type OwnerStateContext,
    type OwnerStoreState,
    type OwnerUrlContext,
    type ProjectParams,
} from "./owner-api.ts";
import { ownerSecurityHeaders } from "../server/owner-origin.ts";
import { findPlanEvidenceById } from "../../../plan-store.js";
import { requireOwnerProjectRoot, sessionBelongsToOwnerProject } from "../server/owner-projects.ts";
import { getSlashCommandDefinition } from "../../../cmd/registry.ts";

import type { JsonValue } from "../../../shared/jsonc.ts";
import type { CatalogDiagnostic } from "../../../shared/session/file-session-store-types.ts";
import type { RuntimeToolStartEvent, SessionRuntimeEvent } from "../../../shared/session/session-runtime-events.ts";
import type { recordSlashCommandMetric } from "../../../shared/workflow/command-metrics.ts";
import type { OwnerConnectionRegistry } from "../server/owner-connections.ts";

type SessionService = WorkspaceSessionContinuationService;
type SessionPage = Awaited<ReturnType<SessionService["listSessions"]>>;
type OwnerSessionSummary = SessionPage["sessions"][number];
type TimelineResult = Awaited<ReturnType<SessionService["timeline"]>>;
type WorkspaceSessionEvent = NonNullable<TimelineResult["events"]>[number] | SessionRuntimeEvent;
type OperationSnapshot = ReturnType<SessionService["getOperation"]>;
type SessionPageOptions = SessionListOptions & Required<Pick<SessionListOptions, "page" | "pageSize">>;

interface SessionParams extends ProjectParams {
    runwieldSessionId: string;
}

interface OperationParams {
    operationId: string;
}

interface ProjectOperationParams extends ProjectParams, OperationParams {}

interface InteractionParams extends ProjectOperationParams {
    interactionId: string;
}

interface SessionServiceState {
    sessionContinuation: SessionService;
}

interface SessionStreamState extends SessionServiceState {
    ownerDevice: NonNullable<OwnerSessionState["ownerDevice"]>;
    ownerConnections: OwnerConnectionRegistry;
}

type SessionListContext = OwnerParamsContext<OwnerSessionState, ProjectParams> & OwnerUrlContext<OwnerSessionState>;
type SessionTimelineContext = OwnerParamsContext<OwnerSessionState, SessionParams> & OwnerUrlContext<OwnerSessionState>;

type EventMetadata = Pick<RuntimeToolStartEvent, "args" | "_meta">;

interface TimelineSegments {
    segments?: readonly unknown[];
}

interface WorkflowHandoffError {
    error?: string | null;
}

type WorkflowHandoffResult = Awaited<ReturnType<SessionService["startPlanWorkflowHandoff"]>> & WorkflowHandoffError;

type CommandMetric = Parameters<typeof recordSlashCommandMetric>[0];
type CommandObservation = Pick<CommandMetric, "kind" | "command" | "alias" | "invocationId" | "sessionId"> &
    (CommandProgressObservation | CommandFinishObservation);

interface CommandProgressObservation {
    phase: Exclude<CommandMetric["phase"], "finish">;
    outcome?: never;
    durationMs?: never;
    dispatched?: never;
}

interface CommandFinishObservation {
    phase: "finish";
    outcome: NonNullable<CommandMetric["outcome"]>;
    durationMs: number;
    dispatched?: boolean;
}

interface SessionRequestBody {
    action?: JsonValue;
    agentName?: JsonValue;
    confirmed?: JsonValue;
    expectedCurrentSegmentId?: JsonValue;
    expectedGeneration?: JsonValue;
    images?: JsonValue;
    model?: JsonValue;
    planId?: JsonValue;
    provider?: JsonValue;
    requestId?: JsonValue;
    response?: JsonValue;
    runwieldSessionId?: JsonValue;
    text?: JsonValue;
    thinkingLevel?: JsonValue;
}

interface SubmittedImage {
    base64?: JsonValue;
    mimeType?: JsonValue;
}

const MAX_JSON_BYTES = 12 * 1024 * 1024;

async function readJson(request: Request): Promise<SessionRequestBody> {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) throw new Error("Request body is too large.");
    // Route-specific checks below still receive the original wire payload.
    return (text ? JSON.parse(text) : {}) as SessionRequestBody;
}

function requireBoundedString(value: JsonValue | undefined, field: string, max: number) {
    if (typeof value !== "string" || value.length < 1 || value.length > max) {
        throw new Error(`${field} is invalid.`);
    }
    return value;
}

function requireExpectedGeneration(value: JsonValue | undefined) {
    const generation = Number(value);
    if (!Number.isInteger(generation) || generation < 0) throw new Error("expectedGeneration is invalid.");
    return generation;
}

function readPageValue(value: string | null, field: string, fallback: number, max: number) {
    if (value === null || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) throw new Error(`${field} is invalid.`);
    return parsed;
}

function readSubmittedImages(value: JsonValue | undefined) {
    if (!Array.isArray(value)) return [];
    return value.map((image: JsonValue) => {
        const source = image && typeof image === "object" ? (image as SubmittedImage) : {};
        const base64 = requireBoundedString(source.base64, "image.base64", 10 * 1024 * 1024);
        const mimeType = requireBoundedString(source.mimeType, "image.mimeType", 80);
        if (!mimeType.startsWith("image/")) throw new Error("Only image attachments are supported.");
        return { base64, mimeType };
    });
}

function safeEvent(value: WorkspaceSessionEvent) {
    if (!value || typeof value !== "object") return value;
    const source = value;
    const safe: typeof source & EventMetadata = { ...source };
    delete safe._meta;
    delete safe.args;
    return safe;
}

function safeDiagnostic(value: CatalogDiagnostic) {
    if (!value || typeof value !== "object") return { code: "catalog_diagnostic", message: String(value || "") };
    const source = value;
    return {
        code: typeof source.code === "string" ? source.code : "catalog_diagnostic",
        message:
            typeof source.message === "string"
                ? source.message.replaceAll(/(?:[A-Za-z]:)?[/\\][^\s,)]+/g, "[local path]")
                : "Catalog diagnostic recorded.",
    };
}

function safeTimelineResult(result: TimelineResult) {
    const safe: TimelineResult & TimelineSegments = { ...result };
    delete safe.segments;
    return safe;
}

function readOptionalBoundedString(body: SessionRequestBody, field: keyof SessionRequestBody, maxLength: number) {
    return typeof body[field] === "string" && body[field]
        ? requireBoundedString(body[field], field, maxLength)
        : undefined;
}

export async function ownerSessionOptionsApi(ctx: OwnerParamsContext<OwnerSessionState, ProjectParams>) {
    try {
        requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        const result = await ctx.state.sessionContinuation.listSessionOptions(ctx.params.projectId);
        return ownerJson(result);
    } catch (error) {
        return ownerErrorJson(error, 400);
    }
}

function committedPlanIdsForSession(session: OwnerSessionSummary, store: OwnerStoreState["store"], projectId: string) {
    const associations = store.listSessionPlanAssociations?.(session.runwieldSessionId, projectId) || [];
    return associations
        .filter((association) => association.committedGeneration !== null)
        .map((association) => String(association.planId || ""))
        .filter(Boolean);
}

async function listAllSessionsForFilter(
    sessionContinuation: SessionService,
    projectId: string,
    options: SessionPageOptions,
) {
    const sessions: OwnerSessionSummary[] = [];
    const diagnostics: CatalogDiagnostic[] = [];
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

export async function ownerProjectSessionsApi(ctx: SessionListContext) {
    try {
        requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        const page = readPageValue(ctx.url.searchParams.get("page"), "page", 0, 10_000);
        const pageSize = readPageValue(ctx.url.searchParams.get("pageSize"), "pageSize", 30, 100);
        const archiveState = ctx.url.searchParams.get("archiveState") || "active";
        if (!["active", "archived", "all"].includes(archiveState)) throw new Error("archiveState is invalid.");
        // The includes check validates the wire value without narrowing it in TypeScript.
        const listOptions: SessionPageOptions = {
            archiveState: ctx.url.searchParams.get("plan")
                ? "all"
                : (archiveState as SessionListOptions["archiveState"]),
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
        const result =
            planId || excludeAssociated
                ? await listAllSessionsForFilter(ctx.state.sessionContinuation, ctx.params.projectId, listOptions)
                : await ctx.state.sessionContinuation.listSessions(ctx.params.projectId, listOptions);
        let sessions = result.sessions || [];
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

export async function ownerSessionArchiveApi(ctx: OwnerRouteContext<OwnerSessionState, SessionParams>) {
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

export async function ownerSessionUnarchiveApi(ctx: OwnerRouteContext<OwnerSessionState, SessionParams>) {
    try {
        requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        return ownerJson(await ctx.state.sessionContinuation.unarchiveSession(ctx.params));
    } catch (error) {
        return ownerErrorJson(error, 409);
    }
}

export async function ownerSessionTimelineApi(ctx: SessionTimelineContext) {
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

export async function ownerSessionLiveApi(ctx: OwnerParamsContext<OwnerSessionState, SessionParams>) {
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

export async function ownerSessionBootstrapApi(ctx: OwnerRouteContext<OwnerSessionState, SessionParams>) {
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

export async function ownerSessionCreateApi(ctx: OwnerRouteContext<OwnerSessionState, ProjectParams>) {
    try {
        const body = await readJson(ctx.req);
        requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        const result = await ctx.state.sessionContinuation.createSession({
            deviceId: ctx.state.ownerDevice?.deviceId || null,
            projectId: ctx.params.projectId,
            requestId: requireBoundedString(body.requestId, "requestId", 128),
            text: body.text ? requireBoundedString(body.text, "text", 32_000) : "",
            images: readSubmittedImages(body.images),
            agentName:
                typeof body.agentName === "string" ? requireBoundedString(body.agentName, "agentName", 128) : undefined,
            model:
                typeof body.model === "string" && body.model
                    ? requireBoundedString(body.model, "model", 300)
                    : undefined,
            provider:
                typeof body.provider === "string" && body.provider
                    ? requireBoundedString(body.provider, "provider", 128)
                    : undefined,
            thinkingLevel:
                typeof body.thinkingLevel === "string" && body.thinkingLevel
                    ? requireBoundedString(body.thinkingLevel, "thinkingLevel", 32)
                    : undefined,
        });
        return ownerJson(result, 202);
    } catch (error) {
        const message = sanitizeOwnerError(error);
        const status =
            error instanceof ImageSubmissionValidationError
                ? 422
                : /not enabled|epoch|uncertain|reconcile/.test(message)
                  ? 503
                  : 409;
        return ownerJson({ error: message }, status);
    }
}

export async function ownerSessionContinuationStartApi(ctx: OwnerRouteContext<OwnerSessionState, SessionParams>) {
    try {
        const body = await readJson(ctx.req);
        requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        const result = await ctx.state.sessionContinuation.startContinuation({
            deviceId: ctx.state.ownerDevice?.deviceId || null,
            projectId: ctx.params.projectId,
            runwieldSessionId: ctx.params.runwieldSessionId,
            requestId: requireBoundedString(body.requestId, "requestId", 128),
            expectedGeneration: requireExpectedGeneration(body.expectedGeneration),
            text:
                typeof body.text === "string" && body.text.length === 0
                    ? " "
                    : requireBoundedString(body.text, "text", 32_000),
            images: readSubmittedImages(body.images),
        });
        return ownerJson(result, 202);
    } catch (error) {
        const message = sanitizeOwnerError(error);
        const status =
            error instanceof ImageSubmissionValidationError
                ? 422
                : /not enabled|epoch|uncertain|reconcile/.test(message)
                  ? 503
                  : 409;
        return ownerJson({ error: message }, status);
    }
}

export async function ownerSessionPlanReviewApi(ctx: OwnerRouteContext<OwnerSessionState, SessionParams>) {
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

export async function ownerSessionPlanWorkflowApi(ctx: OwnerRouteContext<OwnerSessionState, SessionParams>) {
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
        const retained =
            body.action === "retry_work_record"
                ? await readControllerRecord(projectRoot, { planId, planName: "" })
                : null;
        const recording = retained?.planId === planId && retained.state.recordingSource ? retained : null;
        const primary = recording
            ? { planId, planName: recording.planName }
            : await findPlanEvidenceById(projectRoot, planId);
        const plan = recording
            ? { attrs: { planId }, markdown: "", body: "" }
            : (await resolveWorkflowPlanLocation(projectRoot, primary.planName, { readOnly: true })).plan;
        if (!plan || plan.attrs.planId !== primary.planId) {
            throw new Error("Plan evidence is unavailable. Refresh and try again.");
        }
        const result: WorkflowHandoffResult = await ctx.state.sessionContinuation.startPlanWorkflowHandoff({
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

export async function ownerSessionConfigureApi(ctx: OwnerRouteContext<OwnerSessionState, SessionParams>) {
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

export async function ownerSessionForceRecoverApi(ctx: OwnerRouteContext<OwnerSessionState, SessionParams>) {
    try {
        const body = await readJson(ctx.req);
        requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        const result = await ctx.state.sessionContinuation.forceRecoverSessionControl({
            projectId: ctx.params.projectId,
            runwieldSessionId: ctx.params.runwieldSessionId,
            expectedGeneration: requireExpectedGeneration(body.expectedGeneration),
            expectedCurrentSegmentId:
                typeof body.expectedCurrentSegmentId === "string"
                    ? requireBoundedString(body.expectedCurrentSegmentId, "expectedCurrentSegmentId", 128)
                    : null,
        });
        return ownerJson({ status: "recovered", generation: result.generation?.generation ?? null });
    } catch (error) {
        const message = sanitizeOwnerError(error);
        return ownerJson({ error: message }, /still renewing|not available/.test(message) ? 409 : 503);
    }
}

export async function ownerSessionInteractionAnswerApi(ctx: OwnerRouteContext<OwnerSessionState, InteractionParams>) {
    try {
        const body = await readJson(ctx.req);
        requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        const result = await ctx.state.sessionContinuation.answerInteraction({
            deviceId: ctx.state.ownerDevice?.deviceId || null,
            projectId: ctx.params.projectId,
            operationId: ctx.params.operationId,
            interactionId: ctx.params.interactionId,
            runwieldSessionId:
                typeof body.runwieldSessionId === "string"
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

export async function ownerSessionSteerApi(ctx: OwnerRouteContext<OwnerSessionState, ProjectOperationParams>) {
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

export async function ownerSessionOperationCancelApi(ctx: OwnerParamsContext<SessionServiceState, OperationParams>) {
    try {
        const result = await ctx.state.sessionContinuation.cancelOperation({ operationId: ctx.params.operationId });
        return ownerJson(result, 202);
    } catch (error) {
        return ownerErrorJson(error, 409);
    }
}

export async function ownerSessionOperationStatusApi(ctx: OwnerParamsContext<SessionServiceState, OperationParams>) {
    const result = await ctx.state.sessionContinuation.refreshOperation(ctx.params.operationId);
    return ownerJson({ ...result, events: (result.events || []).map(safeEvent) });
}

export function ownerSessionOperationStreamApi(ctx: OwnerRouteContext<SessionStreamState, OperationParams>) {
    const encoder = new TextEncoder();
    const service = ctx.state.sessionContinuation;
    const operationId = ctx.params.operationId;
    let unsubscribe = () => {};
    let unregister = () => {};
    let closed = false;
    let dirty = true;
    let terminal = false;
    let finalResult: OperationSnapshot | null = null;
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
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
        } catch {
            /* canceled or already closed */
        }
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
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            streamController = controller;
            if (ctx.req.signal.aborted) {
                close();
                return;
            }
            ctx.req.signal.addEventListener("abort", close, { once: true });
            unregister = ctx.state.ownerConnections.register(ctx.state.ownerDevice.deviceId, { close });
            // A synchronous initial callback may finish before subscribeOperation returns.
            const stop = service.subscribeOperationChanges(operationId, (status) => {
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

/** Live alerts belong to the Workspace, independent of the displayed page. */
export function ownerNotificationsStreamApi(ctx: OwnerStateContext<SessionStreamState>) {
    const encoder = new TextEncoder();
    let unsubscribe = () => {};
    let unregister = () => {};
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode(": connected\n\n"));
            unregister = ctx.state.ownerConnections.register(ctx.state.ownerDevice.deviceId, {
                close() {
                    unsubscribe();
                    unregister();
                    controller.close();
                },
            });
            unsubscribe = ctx.state.sessionContinuation.subscribeNotifications((notification) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(notification)}\n\n`));
            });
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
 * Record slash command metric from Workspace client.
 */
export async function ownerProjectCommandMetricsApi(ctx: OwnerRouteContext<OwnerStoreState, ProjectParams>) {
    try {
        const root = requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        const raw = await ctx.req.text();
        if (raw.length > 2048) throw new Error("Command observation is too large.");
        // Keep the existing checks as the validation boundary for the wire payload.
        const payload = JSON.parse(raw) as CommandObservation;
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
                !Number.isSafeInteger(payload.durationMs) ||
                payload.durationMs < 0 ||
                payload.durationMs > 86_400_000)
        ) {
            throw new Error("Invalid command outcome or duration.");
        }
        const submittedName = requireBoundedString(payload.command, "command", 128);
        const definition = getSlashCommandDefinition(submittedName, "workspace");
        const command = definition?.name || "unknown";
        if (
            !definition &&
            !(
                ["start", "finish"].includes(payload.phase) &&
                (payload.phase !== "finish" || payload.outcome === "rejected")
            )
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
        const submittedAlias =
            typeof payload.alias === "string" &&
            getSlashCommandDefinition(payload.alias, "workspace")?.name === command &&
            payload.alias !== command
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
