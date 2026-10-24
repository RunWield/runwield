import type { AttachedCarrierResult } from "./coordinator.ts";
import type { AttachedNextAction, AttachedWorkflowView } from "./operations.ts";

export function actionId(action: AttachedNextAction, workflow: AttachedWorkflowView): string | null {
    return "actionId" in action ? action.actionId : (workflow.review?.actionId ?? null);
}

function compactAction(action: AttachedNextAction, workflow: AttachedWorkflowView) {
    const identity = actionId(action, workflow);
    const summary = {
        kind: action.kind,
        actionId: identity,
        round: workflow.review?.round ?? null,
        chatPending: "chat" in action && action.chat !== undefined,
    };
    if (action.kind === "triage" || action.kind === "plan") {
        return {
            ...summary,
            role: action.role,
            contractVersion: action.contractVersion,
            contextAvailable: true,
            instructionsAvailable: true,
        };
    }
    if (action.kind === "implementation") {
        return {
            ...summary,
            planName: action.planName,
            planPath: action.planPath,
            executionCwd: action.executionCwd,
            executionMode: action.executionMode,
            worktreeBranch: action.worktreeBranch,
            disclosure: action.disclosure,
            role: action.role,
            contractVersion: action.contractVersion,
            contextAvailable: true,
            instructionsAvailable: true,
        };
    }
    if (action.kind === "consent") {
        return { ...summary, consentKind: action.consentKind, disclosure: action.disclosure };
    }
    if (action.kind === "review") return { ...summary, planName: action.planName };
    if (action.kind === "plan_ready" || action.kind === "plan_saved" || action.kind === "implemented") {
        return { ...summary, planName: action.planName, guidance: action.guidance };
    }
    if (action.kind === "delivered") {
        return {
            ...summary,
            planName: action.planName,
            guidance: action.guidance,
            completionMode: action.completionMode,
            workRecord: action.workRecord,
        };
    }
    if (action.kind === "return_to_host") return { ...summary, reason: action.reason, message: action.message };
    if (action.kind === "validation_recovery") {
        return { ...summary, guidance: action.guidance, resultKind: action.resultKind, recovery: action.recovery };
    }
    if (action.kind === "code_review") return { ...summary, requestAvailable: true };
    if (action.kind !== "validation" && action.kind !== "recorder") return summary;

    const planPath = workflow.plan ? `docs/plans/${workflow.plan.planName}.md` : null;
    const request = action.request;
    if (request.kind === "decision") return { ...summary, requestAvailable: true };
    return {
        ...summary,
        request: {
            kind: request.kind,
            identity: request.identity,
            ...(request.kind === "reviewer" && {
                cwd: request.cwd,
                reviewMode: request.reviewMode,
                requiredScope: request.requiredScope,
                artifacts: {
                    planPath,
                    diffTool: "review_diff",
                    readTool: "get_artifact",
                    names: ["prompt", "execution_report", "repair_report"],
                },
            }),
            ...(request.kind === "repair" && {
                cwd: request.cwd,
                role: request.role,
                repairGeneration: request.repairGeneration,
                artifacts: {
                    planPath,
                    readTool: "get_artifact",
                    names: ["prompt", "execution_report", "repair_report"],
                },
            }),
            ...(request.kind === "recorder" && {
                cwd: request.cwd,
                artifacts: {
                    planPath,
                    executionDirectory: request.cwd,
                    readTool: "get_artifact",
                    names: ["prompt", "execution_report", "repair_report"],
                },
            }),
        },
        instructionsAvailable: true,
    };
}

function compactWorkflow(workflow: AttachedWorkflowView) {
    return {
        workflowId: workflow.workflowId,
        revision: workflow.revision,
        state: workflow.state,
        plan: workflow.plan,
        ...(workflow.recovery && { recovery: workflow.recovery }),
        nextAction: compactAction(workflow.nextAction, workflow),
        review: workflow.review
            ? {
                  round: workflow.review.round,
                  actionId: workflow.review.actionId,
                  status: workflow.review.status,
                  outcome: workflow.review.outcome?.kind ?? null,
              }
            : null,
    };
}

export function compactStatus(result: AttachedCarrierResult, review: { url: string } | null) {
    if (!result.workflow) return result;
    return {
        ok: result.ok,
        operation: "status" as const,
        ...(!result.ok && { rejection: result.rejection }),
        workflow: compactWorkflow(result.workflow),
        ...(review && { review }),
    };
}

export function compactResult(result: AttachedCarrierResult) {
    if (!result.workflow) return result;
    return {
        ...result,
        workflow: compactWorkflow(result.workflow),
        ...((result.workflow.nextAction.kind === "validation" || result.workflow.nextAction.kind === "recorder") && {
            instructions: undefined,
        }),
    };
}
