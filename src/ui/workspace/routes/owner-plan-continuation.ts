/** Plan-scoped continuation entry points, including Plans without a working Session. */
import { findPlanEvidenceById } from "../../../plan-store.js";
import {
    executePlanAction,
    loadPlanActionEvidence,
    type PlanActionRequest,
} from "../../../shared/workflow/plan-actions.ts";
import { runWorkspaceResumeCheck } from "../server/plan-adapter.js";
import { runOwnerPlanAction } from "../server/owner-plan-actions.ts";
import { requireOwnerProjectRoot } from "../server/owner-projects.ts";
import { associatedPlanSession, ownerErrorJson, ownerJson } from "./owner-api.js";

type PlanContinuationContext = {
    req: Request;
    params: { projectId: string; planId: string; runwieldSessionId?: string };
    state: {
        store: import("../../../shared/owner-coordination/index.js").OwnerCoordinationStore;
        sessionContinuation: import("../server/session-continuation.js").WorkspaceSessionContinuationService;
        ownerDevice?: { deviceId: string };
    };
};

type PlanContinuationRequest = {
    requestId: string;
    action: string;
    expectedRevision?: string;
    expectedGeneration?: number;
    acceptResumeWarnings?: boolean;
};

export async function ownerPlanContinuationApi(ctx: PlanContinuationContext) {
    try {
        const text = await ctx.req.text();
        if (text.length > 65536) throw new Error("Request body is too large.");
        const body = JSON.parse(text) as PlanContinuationRequest;
        if (typeof body.requestId !== "string" || !body.requestId || body.requestId.length > 128) {
            throw new Error("Plan action requestId is required.");
        }
        const root = requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        const plan = await findPlanEvidenceById(root, ctx.params.planId);
        if (body.action === "resume_from_hold") {
            const evidence = await loadPlanActionEvidence(root, plan.planId);
            if (evidence.kind !== "success") throw new Error(evidence.message);
            const check = await runWorkspaceResumeCheck(root, plan.attrs);
            if (check.failures.length) return ownerJson({ error: check.failures.join(" "), resumeCheck: check }, 409);
            if (check.warnings.length && body.acceptResumeWarnings !== true) {
                return ownerJson({ error: check.message, requiresConfirmation: true, resumeCheck: check }, 409);
            }
            if (!body.expectedRevision) throw new Error("Plan revision is required. Refresh and try again.");
            const action: PlanActionRequest = {
                planId: plan.planId,
                action: /** @type {const} */ ("resume_from_hold"),
                expectedRevision: body.expectedRevision,
                expectedStatus: evidence.evidence.status,
                expectedWorktree: evidence.evidence.worktree,
                acceptResumeWarnings: body.acceptResumeWarnings,
            };
            const sessionId = ctx.params.runwieldSessionId ||
                await associatedPlanSession(ctx.state.store, ctx.params.projectId, plan.planId);
            if (sessionId) {
                const state = ctx.state.store.inspectSessionActivation(sessionId);
                if (state.activation?.state !== "idle") throw new Error("This Session is busy.");
                const result = await runOwnerPlanAction(ctx.state.store, {
                    projectId: ctx.params.projectId,
                    runwieldSessionId: sessionId,
                    deviceId: ctx.state.ownerDevice?.deviceId || null,
                    requestId: body.requestId,
                    requestHash: JSON.stringify({ action, generation: body.expectedGeneration }),
                    expectedGeneration: body.expectedGeneration ?? state.generation?.generation ?? 0,
                    action,
                });
                return ownerJson(result.body, result.status);
            }
            const result = await executePlanAction(root, action);
            return ownerJson({ result }, result.kind === "success" ? 200 : 409);
        }
        if (body.action !== "review_plan") throw new Error("This Plan action is unavailable.");
        const result = await ctx.state.sessionContinuation.startSavedPlanReview({
            requestId: body.requestId,
            action: body.action,
            deviceId: ctx.state.ownerDevice?.deviceId || null,
            projectId: ctx.params.projectId,
            planName: plan.planName,
            planContent: plan.markdown,
            triageMeta: plan.attrs,
        });
        return ownerJson(result, 202);
    } catch (error) {
        return ownerErrorJson(error, 409);
    }
}
