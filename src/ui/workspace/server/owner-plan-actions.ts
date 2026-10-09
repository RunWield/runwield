/** Owner Workspace backend Plan action service. */

import { requireOwnerProjectRoot, sessionBelongsToOwnerProject } from "./owner-projects.ts";
import {
    executePlanAction,
    type PlanActionRequest,
    type PlanActionResult,
} from "../../../shared/workflow/plan-actions.ts";

export type OwnerPlanActionServiceRequest = {
    projectId: string;
    runwieldSessionId: string;
    deviceId: string | null;
    requestId: string;
    requestHash: string;
    expectedGeneration: number;
    action: PlanActionRequest;
};

export type OwnerPlanActionHttpResult = {
    status: number;
    body: {
        result: PlanActionResult;
    };
};

type OwnerCoordinationStore = import("../../../shared/owner-coordination/index.js").OwnerCoordinationStore;

function httpStatusForResult(result: PlanActionResult): number {
    if (result.kind === "success") return 200;
    if (result.kind === "refresh_required") return 409;
    if (result.kind === "recovery_required") return 409;
    if (result.kind === "activation_unavailable") return 423;
    return 400;
}

function activationUnavailable(message: string): PlanActionResult {
    return { kind: "activation_unavailable", message };
}

function receiptRecoveryRequired(message: string): PlanActionResult {
    return { kind: "recovery_required", message, entryIds: [] };
}

function completedResultFromReceipt(
    receipt: { resultHttpStatus?: number | null; resultBody?: { result?: PlanActionResult } | null },
): OwnerPlanActionHttpResult | null {
    if (!receipt.resultHttpStatus || !receipt.resultBody?.result) return null;
    return { status: receipt.resultHttpStatus, body: { result: receipt.resultBody.result } };
}

export async function runOwnerPlanAction(
    store: OwnerCoordinationStore,
    request: OwnerPlanActionServiceRequest,
): Promise<OwnerPlanActionHttpResult> {
    const session = store.getSessionById(request.runwieldSessionId);
    if (!session || !sessionBelongsToOwnerProject(store, session, request.projectId)) {
        return { status: 404, body: { result: { kind: "invalid_action", message: "Session not found for Project." } } };
    }
    const root = requireOwnerProjectRoot(store, request.projectId);
    let receipt: ReturnType<OwnerCoordinationStore["createOrGetOperationReceipt"]>;
    try {
        receipt = store.createOrGetOperationReceipt({
            deviceId: request.deviceId,
            requestId: request.requestId,
            requestHash: request.requestHash,
            runwieldSessionId: request.runwieldSessionId,
            projectId: request.projectId,
            expectedGeneration: request.expectedGeneration,
            kind: "plan_action",
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("request id was reused with different input")) {
            return {
                status: 409,
                body: {
                    result: {
                        kind: "invalid_action",
                        message: "Plan action request ID was reused with different input.",
                    },
                },
            };
        }
        throw error;
    }
    if (!receipt.operationId) throw new Error("Plan action receipt was not created.");
    if (receipt.status === "completed") {
        const stored = completedResultFromReceipt(receipt);
        if (stored) return stored;
        const result = receiptRecoveryRequired("Previous Plan action result is unavailable; recover before retrying.");
        return { status: 409, body: { result } };
    }
    if (!receipt.wasCreated || receipt.status !== "accepted") {
        const result = receiptRecoveryRequired("Plan action request has no completed result; recover before retrying.");
        return { status: 409, body: { result } };
    }
    store.updateOperationReceipt(receipt.operationId, { status: "running" });
    const state = store.inspectSessionActivation(request.runwieldSessionId);
    if ((state.generation?.generation ?? null) !== request.expectedGeneration) {
        const result: PlanActionResult = {
            kind: "refresh_required",
            message: "Session generation changed. Refresh and retry.",
            evidence: {
                planId: request.action.planId,
                planName: "",
                revision: request.action.expectedRevision,
                status: request.action.expectedStatus,
                worktree: request.action.expectedWorktree,
            },
        };
        store.updateOperationReceipt(receipt.operationId, {
            status: "completed",
            resultGeneration: state.generation?.generation ?? null,
            resultHttpStatus: 409,
            resultBody: { result },
        });
        return { status: 409, body: { result } };
    }
    let proof: ReturnType<OwnerCoordinationStore["acquireSessionActivation"]> | null = null;
    try {
        proof = store.acquireSessionActivation({
            runwieldSessionId: request.runwieldSessionId,
            projectId: request.projectId,
            ownerInstanceId: `owner-plan-action:${request.deviceId || "owner"}`,
            ownerProcessKind: "workspace",
            expectedGeneration: request.expectedGeneration,
            expectedCurrentSegmentId: state.generation?.currentSegmentId ?? state.activation?.currentSegmentId ?? null,
            phase: "preparing",
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const result = message.includes("current segment")
            ? {
                kind: "refresh_required" as const,
                message: "Session segment changed. Refresh and retry.",
                evidence: {
                    planId: request.action.planId,
                    planName: "",
                    revision: request.action.expectedRevision,
                    status: request.action.expectedStatus,
                    worktree: request.action.expectedWorktree,
                },
            }
            : activationUnavailable("Session activation is not available for this Plan action.");
        const status = httpStatusForResult(result);
        store.updateOperationReceipt(receipt.operationId, {
            status: "completed",
            resultGeneration: request.expectedGeneration,
            resultHttpStatus: status,
            resultBody: { result },
        });
        return { status, body: { result } };
    }
    try {
        const result = await executePlanAction(root, request.action);
        const status = httpStatusForResult(result);
        store.updateOperationReceipt(receipt.operationId, {
            status: "completed",
            resultGeneration: request.expectedGeneration,
            resultHttpStatus: status,
            resultBody: { result },
        });
        store.releaseUnchangedActivation(proof);
        return { status, body: { result } };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const result: PlanActionResult = { kind: "invalid_action", message: "Owner Workspace Plan action failed." };
        store.updateOperationReceipt(receipt.operationId, {
            status: "failed",
            resultGeneration: request.expectedGeneration,
            resultHttpStatus: 500,
            resultBody: { result },
            errorCode: "plan_action_failed",
            errorMessage: message,
        });
        try {
            store.markSessionUncertain(proof, { reason: message });
        } catch {
            // Preserve the original service result.
        }
        return { status: 500, body: { result } };
    }
}
