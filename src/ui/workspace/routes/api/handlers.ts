import type { WorkRecordMnemotecaPort } from "../../../../shared/work-records/mnemoteca-port.ts";
import {
    applyWorkspaceLifecycleAction,
    loadBoard,
    loadPlanSummaries,
    loadWorkspaceDetail,
    saveWorkspacePlanBody,
    serializePlanError,
    StalePlanBodyError,
    workspaceMetadata,
} from "../../server/plan-adapter.js";

export interface WorkspaceApiState {
    cwd: string;
    mnemotecaPort?: WorkRecordMnemotecaPort;
}

export interface WorkspaceApiContext {
    state: WorkspaceApiState;
    req: Request;
    params: Record<string, string>;
}

export interface WorkspaceLifecycleApiContext extends WorkspaceApiContext {
    state: WorkspaceLifecycleApiState;
}

export interface WorkspaceLifecycleApiState extends WorkspaceApiState {
    mnemotecaPort: WorkRecordMnemotecaPort;
}

export interface WorkspacePlanBodyPayload {
    body?: string;
    expectedBodyHash?: string;
    expectedRevision?: string;
}

export interface WorkspaceLifecyclePayload {
    action?: string;
    expectedRevision?: string;
    targetStatus?: string;
    acceptResumeWarnings?: boolean;
    closedWithoutVerificationReason?: string;
    userVerificationNote?: string;
}

function json<Data>(data: Data, status = 200) {
    return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

export function workspaceApi(ctx: WorkspaceApiContext) {
    return json(workspaceMetadata(ctx.state.cwd));
}

export async function plansApi(ctx: WorkspaceApiContext) {
    try {
        return json({ plans: await loadPlanSummaries(ctx.state.cwd) });
    } catch (error) {
        return json(serializePlanError(error), 500);
    }
}

export async function boardApi(ctx: WorkspaceApiContext) {
    try {
        return json(await loadBoard(ctx.state.cwd));
    } catch (error) {
        return json(serializePlanError(error), 500);
    }
}

export async function planDetailApi(ctx: WorkspaceApiContext) {
    try {
        return json({ plan: await loadWorkspaceDetail(ctx.state.cwd, ctx.params.planId) });
    } catch (error) {
        const body = serializePlanError(error);
        const status = body.error.includes("not found") || body.error.includes("Plan not found") ? 404 : 409;
        return json(body, status);
    }
}

export async function lifecycleActionApi(ctx: WorkspaceLifecycleApiContext) {
    let payload: WorkspaceLifecyclePayload | null;
    try {
        payload = await ctx.req.json();
    } catch {
        return json({ error: "Request body must be valid JSON." }, 400);
    }

    try {
        const result = await applyWorkspaceLifecycleAction(ctx.state.cwd, ctx.params.planId, payload, {
            mnemotecaPort: ctx.state.mnemotecaPort,
        });
        if (result.blocked) return json(result.body, result.status || 409);
        return json(result.body);
    } catch (error) {
        const body = serializePlanError(error);
        const message = body.error;
        const status = message.includes("not found") || message.includes("Plan not found")
            ? 404
            : message.includes("Unknown") || message.includes("missing targetStatus")
            ? 400
            : 409;
        return json({ ...body, blockedReason: status === 409 ? message : undefined }, status);
    }
}

export async function planBodyApi(ctx: WorkspaceApiContext) {
    let payload: WorkspacePlanBodyPayload | null;
    try {
        payload = await ctx.req.json();
    } catch {
        return json({ error: "Request body must be valid JSON." }, 400);
    }

    if (
        !payload || typeof payload.body !== "string" || typeof payload.expectedBodyHash !== "string" ||
        typeof payload.expectedRevision !== "string"
    ) {
        return json({
            error: "Expected JSON payload { body: string, expectedBodyHash: string, expectedRevision: string }.",
        }, 400);
    }

    try {
        const plan = await saveWorkspacePlanBody(
            ctx.state.cwd,
            ctx.params.planId,
            payload.body,
            payload.expectedBodyHash,
            payload.expectedRevision,
        );
        return json({ plan, bodyHash: plan.bodyHash });
    } catch (error) {
        if (error instanceof StalePlanBodyError) {
            return json({ error: error.message, bodyHash: error.currentBodyHash }, 409);
        }
        const body = serializePlanError(error);
        const status = body.error.includes("not found") || body.error.includes("Plan not found") ? 404 : 409;
        return json(body, status);
    }
}
