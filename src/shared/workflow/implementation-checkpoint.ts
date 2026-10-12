// @ts-nocheck: extracted from checked JSDoc workflow.js; tightening types is out of scope for this structural split.
import { loadPlan } from "../../plan-store.js";
import { checkpointExecutionWorktree } from "../worktree.js";
import { acknowledgeTaskCompletion, claimPendingTaskCompletion } from "../session/task-completion-session.ts";
import { updateEntry as updateWorktreeRegistryEntry } from "../worktree-registry.js";
import { isInValidation, recordPlanEvent } from "./plan-lifecycle.js";
import { restoreExecutionPlanFromBaseline } from "./execution-plan-file.js";
import { recordWorkflowOutcome } from "./outcome-observations.ts";
import { runImplementationCheckpointTransition } from "./state-transition.ts";

interface FinalizePlanImplementationOptions {
    projectRoot: string;
    planName: string;
    triageMeta?: import("../session/hosted-session.js").ActiveExecutionWorkflow["triageMeta"];
    executionContext: import("../session/hosted-session.js").ActiveExecutionWorkflow | null | undefined;
    executionReport?: string;
    hostedSession?: import("../session/hosted-session.js").HostedSession;
}

/**
 * Commit all execution-worktree changes before Plan or registry state can say
 * implementation is complete. The returned context is authoritative; this
 * boundary must not depend on volatile Hosted Session state being retained.
 *
 * @param {FinalizePlanImplementationOptions} options
 * @returns {Promise<{ implementationCommit?: string }>}
 */
export async function finalizePlanImplementation({
    projectRoot,
    planName,
    triageMeta = {},
    executionContext,
    executionReport = undefined,
    hostedSession = undefined,
}: FinalizePlanImplementationOptions) {
    if (!executionContext) {
        throw new Error(`Cannot complete ${planName}: durable execution context is missing.`);
    }

    const planCwd = executionContext.executionMode === "worktree" && executionContext.executionCwd
        ? executionContext.executionCwd
        : projectRoot;
    let currentPlan = await (async () => {
        try {
            return await loadPlan(planCwd, planName);
        } catch {
            return null;
        }
    })();
    if (!currentPlan && executionContext.executionMode === "worktree") {
        if (!executionContext.executionCwd || !executionContext.baselineTree) {
            throw new Error(`Cannot complete ${planName}: the missing execution Plan has no recorded baseline source.`);
        }
        const restored = await restoreExecutionPlanFromBaseline({
            executionCwd: executionContext.executionCwd,
            planName,
            baselineTree: executionContext.baselineTree,
        });
        if (restored.kind !== "restored" && restored.kind !== "present") {
            throw new Error(
                `Cannot complete ${planName}: execution Plan ${restored.relativePath} could not be restored from the recorded baseline: ${
                    restored.reason || restored.kind
                }`,
            );
        }
        currentPlan = await loadPlan(executionContext.executionCwd, planName);
    }
    const expectedPlanId = typeof triageMeta.planId === "string" ? triageMeta.planId : undefined;
    if (!currentPlan) throw new Error(`Cannot complete ${planName}: execution Plan is missing.`);
    if (expectedPlanId && currentPlan.attrs.planId !== expectedPlanId) {
        throw new Error(
            `Cannot complete ${planName}: execution Plan identity is ${
                currentPlan.attrs.planId || "missing"
            }, expected ${expectedPlanId}.`,
        );
    }
    const planStatus = currentPlan?.attrs?.status;
    if (isInValidation(planStatus) || planStatus === "verified" || planStatus === "user_verified") {
        acknowledgeImplementationCompletion(hostedSession);
        return {};
    }
    if (planStatus && planStatus !== "in_progress" && planStatus !== "ready_for_work") {
        throw new Error(
            `Cannot complete ${planName}: Plan status is "${planStatus}", expected "in_progress" or "ready_for_work".`,
        );
    }
    const transition = await runImplementationCheckpointTransition({
        projectRoot: planCwd,
        planName,
        planId: typeof triageMeta.planId === "string" ? triageMeta.planId : undefined,
        worktreeId: executionContext.worktreeId,
        expectedRevision: currentPlan?.revision,
        checkpoint: async ({ markEffect }) => {
            /** @type {string | undefined} */
            let implementationCommit;
            if (
                executionContext.executionMode !== "worktree" &&
                executionContext.executionMode !== "non_git_in_place" &&
                executionContext.nonGitInPlace !== true
            ) {
                throw new Error(`Cannot complete ${planName}: execution mode is missing or unknown.`);
            }
            if (planStatus === "ready_for_work") {
                await recordPlanEvent({
                    cwd: planCwd,
                    planName,
                    event: "execution_started",
                    currentStatus: "ready_for_work",
                    details: {
                        triageMeta,
                        nonGitInPlace: executionContext.nonGitInPlace === true,
                        executionMode: executionContext.executionMode,
                        executionBaselineTree: executionContext.baselineTree,
                        worktreeId: executionContext.worktreeId,
                        worktreePath: executionContext.executionCwd,
                        worktreeBranch: executionContext.worktreeBranch,
                        worktreeBaseBranch: executionContext.worktreeBaseBranch,
                        worktreeStatus: executionContext.executionMode === "worktree" ? "active" : undefined,
                    },
                });
            }
            await recordPlanEvent({
                cwd: planCwd,
                planName,
                event: "implementation_finished",
                currentStatus: "in_progress",
                details: {
                    triageMeta,
                    nonGitInPlace: executionContext.nonGitInPlace === true,
                    executionMode: executionContext.executionMode,
                    executionBaselineTree: executionContext.baselineTree,
                    worktreeId: executionContext.worktreeId,
                    worktreePath: executionContext.executionCwd,
                    worktreeBranch: executionContext.worktreeBranch,
                    worktreeBaseBranch: executionContext.worktreeBaseBranch,
                    executionReport,
                },
            });
            if (executionContext.executionMode === "worktree") {
                if (!executionContext.executionCwd || !executionContext.worktreeBranch) {
                    throw new Error(
                        `Cannot complete ${planName}: worktree execution context is missing its path or branch.`,
                    );
                }
                const checkpoint = await checkpointExecutionWorktree({
                    worktreePath: executionContext.executionCwd,
                    branch: executionContext.worktreeBranch,
                    planName,
                    planDescription: typeof triageMeta.summary === "string" ? triageMeta.summary : undefined,
                });
                implementationCommit = checkpoint.executionCommit;
                await markEffect("implementation_checkpoint_settled", {
                    implementationCommit,
                    worktreeId: executionContext.worktreeId,
                    worktreeBranch: executionContext.worktreeBranch,
                });
            }
            await markActiveWorktreeStatus("completed", { hostedSession, workflow: executionContext });
            return implementationCommit ? { implementationCommit } : {};
        },
    });
    if (transition.status !== "committed") {
        throw new Error(transition.message || `Implementation checkpoint did not commit for ${planName}.`);
    }
    acknowledgeImplementationCompletion(hostedSession);
    const transitionValue = /** @type {{ value?: { implementationCommit?: string } }} */ (transition.value);
    const implementationCommit = transitionValue.value?.implementationCommit;
    await recordWorkflowOutcome(projectRoot, {
        category: "execution",
        event: "implementation_finished",
        operationId: transition.transitionId,
        transitionId: transition.transitionId,
        attemptId: executionContext.worktreeId,
        planName,
        outcome: "succeeded",
        session: hostedSession?.getManagedMetadata(),
    });
    return implementationCommit ? { implementationCommit } : {};
}

function acknowledgeImplementationCompletion(hostedSession) {
    if (!hostedSession) return;
    const completion = claimPendingTaskCompletion(hostedSession, hostedSession.getRootAgentSession());
    if (completion) acknowledgeTaskCompletion(hostedSession, completion);
}

export async function markActiveWorktreeStatus(status, opts = {}) {
    const workflow = opts.workflow || opts.hostedSession?.getActiveExecutionWorkflow();
    if (!workflow?.worktreeId || !status || status === "none") return;
    if (!workflow.projectRoot) throw new Error("markActiveWorktreeStatus: workflow projectRoot is required");
    await updateWorktreeRegistryEntry(workflow.projectRoot, workflow.worktreeId, { status });
}
