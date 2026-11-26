import type { ActiveExecutionWorkflow } from "./state.ts";
import type { WorkflowTaskCompletionHost } from "./events.ts";
import { withPlanImplementationCompletion } from "../../src/plan-store/index.ts";
import { capturePlanAccess, capturePlanExecutionContext, hasCanonicalPlanAccess } from "../../src/plan-store/index.ts";
import { resumePlanAttempt } from "../../src/plan-store/index.ts";
import { getPlanRevisionForText } from "@runwield/plans/format";
import { planDocumentsForCheckout } from "../../src/plan-store/index.ts";
import { checkpointExecutionWorktree } from "../../src/shared/worktree.ts";
import {
    acknowledgeTaskCompletion,
    claimPendingTaskCompletion,
} from "../../src/shared/session/task-completion-session.ts";
import {
    findActiveByPlanName,
    updateEntry as updateWorktreeRegistryEntry,
} from "../../src/shared/worktree-registry.ts";
import { isInValidation } from "@runwield/plans/lifecycle";
import { recordPlanEvent } from "../../src/plan-store/index.ts";
import { restoreExecutionPlanFromBaseline } from "../../src/plan-store/index.ts";
import { recordWorkflowOutcome, type OutcomeSession } from "../../src/shared/workflow/outcome-observations.ts";
import { listTransitionRecoveryRecords, runImplementationCheckpointTransition } from "../../src/plan-store/index.ts";

/** Identify the managed session and acknowledge its reports when implementation settles. */
export interface ImplementationCompletionHost extends WorkflowTaskCompletionHost {
    getManagedMetadata(): OutcomeSession | null;
}

/** Supplies the captured execution context and revision checks used to checkpoint a completion report. */
export interface FinalizePlanImplementationOptions {
    projectRoot: string;
    planName: string;
    triageMeta?: ActiveExecutionWorkflow["triageMeta"];
    executionContext: ActiveExecutionWorkflow | null | undefined;
    executionReport?: string;
    expectedPlanId?: string;
    expectedPlanRevision?: string;
    expectedPlanBodyRevision?: string;
    hostedSession?: ImplementationCompletionHost;
}

/** Reports the implementation commit when the completed attempt has one on record. */
export interface PlanImplementationResult {
    implementationCommit?: string;
}

/**
 * Settle execution-worktree changes and registry state before accepting
 * implementation completion, including retry after its Plan Event. This
 * boundary must not depend on volatile Hosted Session state being retained.
 *
 * @param {FinalizePlanImplementationOptions} options
 * @returns {Promise<{ implementationCommit?: string }>}
 */
export async function finalizePlanImplementation(
    options: FinalizePlanImplementationOptions,
): Promise<PlanImplementationResult> {
    const { executionContext, projectRoot, planName, expectedPlanId } = options;
    if (
        executionContext &&
        (executionContext.planName !== planName ||
            (expectedPlanId &&
                executionContext.triageMeta.planId &&
                executionContext.triageMeta.planId !== expectedPlanId))
    )
        throw new Error("Completion report belongs to a different Plan.");
    if (executionContext?.packageSelection && !capturePlanAccess()) {
        const selection = executionContext.packageSelection;
        return await resumePlanAttempt(
            projectRoot,
            selection,
            executionContext.packageAttemptId || executionContext.worktreeId,
            () => finalizePlanImplementation(options),
        );
    }
    if (!executionContext) {
        throw new Error(`Cannot complete ${planName}: durable execution context is missing.`);
    }
    const planCwd =
        executionContext.executionMode === "worktree" && executionContext.executionCwd
            ? executionContext.executionCwd
            : projectRoot;
    return await withPlanImplementationCompletion(
        planCwd,
        planName,
        executionContext.worktreeId,
        executionContext.packageInput,
        () => finalizeLockedImplementation(options),
    );
}

async function finalizeLockedImplementation({
    projectRoot,
    planName,
    triageMeta = {},
    executionContext,
    executionReport = undefined,
    expectedPlanId,
    expectedPlanRevision,
    expectedPlanBodyRevision,
    hostedSession = undefined,
}: FinalizePlanImplementationOptions) {
    if (!executionContext) {
        throw new Error(`Cannot complete ${planName}: durable execution context is missing.`);
    }

    const boundPlanId = expectedPlanId || executionContext.triageMeta.planId;
    if (executionContext.packageAttemptId && hasCanonicalPlanAccess()) {
        const retained = await capturePlanExecutionContext(planName);
        if (retained?.packageAttemptId !== executionContext.packageAttemptId)
            throw new Error("The recorded execution attempt changed.");
    }
    const registry = executionContext.worktreeId
        ? await findActiveByPlanName(executionContext.projectRoot || projectRoot, planName)
        : null;
    if (
        executionContext.worktreeId &&
        (registry?.id !== executionContext.worktreeId ||
            registry.path !== executionContext.executionCwd ||
            registry.branch !== executionContext.worktreeBranch ||
            (boundPlanId && registry.planId !== boundPlanId))
    )
        throw new Error("The recorded execution attempt changed.");
    const planCwd =
        executionContext.executionMode === "worktree" && executionContext.executionCwd
            ? executionContext.executionCwd
            : projectRoot;
    let currentPlan = await (async () => {
        try {
            return await planDocumentsForCheckout(planCwd).load(planName);
        } catch {
            return null;
        }
    })();
    let restoredMissingPlan = false;
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
        currentPlan = await planDocumentsForCheckout(executionContext.executionCwd).load(planName);
        restoredMissingPlan = true;
    }
    const planId = boundPlanId || triageMeta.planId;
    if (!currentPlan) throw new Error(`Cannot complete ${planName}: execution Plan is missing.`);
    if (planId && currentPlan.attrs.planId !== planId) {
        throw new Error(
            `Cannot complete ${planName}: execution Plan identity is ${
                currentPlan.attrs.planId || "missing"
            }, expected ${planId}.`,
        );
    }
    const planStatus = currentPlan?.attrs?.status;
    // Attached binds completion to the issued document. Check under the same
    // ordered locks as restoration, lifecycle writes, checkpoint, and registry settlement.
    if (expectedPlanRevision && currentPlan.revision !== expectedPlanRevision) {
        const sameBody =
            expectedPlanBodyRevision && (await getPlanRevisionForText(currentPlan.body)) === expectedPlanBodyRevision;
        if (!(sameBody && (planStatus === "implemented" || restoredMissingPlan))) {
            throw new Error("The execution Plan changed since the implementation action was issued.");
        }
    }
    const completed =
        planStatus === "implemented" &&
        (registry?.status === "completed" ||
            executionContext.executionMode === "non_git_in_place" ||
            executionContext.nonGitInPlace);
    const savedReceipt = registry?.implementationCommit ? { implementationCommit: registry.implementationCommit } : {};
    // The registry/document already settled the report. Only continue a journal whose final write was interrupted.
    const journalPending =
        completed &&
        (await listTransitionRecoveryRecords(planCwd)).some(
            (record) => record.operation === "implementation_checkpoint" && record.planName === planName,
        );
    if (
        (completed && !journalPending) ||
        (planStatus !== "implemented" &&
            (isInValidation(planStatus) || planStatus === "verified" || planStatus === "user_verified"))
    ) {
        acknowledgeImplementationCompletion(hostedSession);
        return savedReceipt;
    }
    if (planStatus && !["in_progress", "ready_for_work", "implemented"].includes(planStatus)) {
        throw new Error(
            `Cannot complete ${planName}: Plan status is "${planStatus}", expected "in_progress" or "ready_for_work".`,
        );
    }
    const transition = await runImplementationCheckpointTransition({
        projectRoot: planCwd,
        planName,
        planId,
        worktreeId: executionContext.worktreeId,
        expectedRevision: currentPlan?.revision,
        resumeInterrupted: planStatus === "implemented",
        checkpoint: async ({ markEffect }) => {
            if (completed) return savedReceipt;
            let implementationCommit: string | undefined;
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
            if (planStatus !== "implemented") {
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
            }
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
            await markCompletedWorktree(executionContext, implementationCommit);
            return implementationCommit ? { implementationCommit } : {};
        },
    });
    if (transition.status !== "committed") {
        throw new Error(transition.message || `Implementation checkpoint did not commit for ${planName}.`);
    }
    acknowledgeImplementationCompletion(hostedSession);
    const transitionValue = transition.value as { value?: PlanImplementationResult };
    const implementationCommit = transitionValue?.value?.implementationCommit;
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

function acknowledgeImplementationCompletion(hostedSession: ImplementationCompletionHost | undefined) {
    if (!hostedSession) return;
    const completion = claimPendingTaskCompletion(hostedSession, hostedSession.getRootAgentSession());
    if (completion) acknowledgeTaskCompletion(hostedSession, completion);
}

async function markCompletedWorktree(
    workflow: ActiveExecutionWorkflow,
    implementationCommit: string | undefined,
): Promise<void> {
    if (!workflow.worktreeId) return;
    if (!workflow.projectRoot) throw new Error("markActiveWorktreeStatus: workflow projectRoot is required");
    await updateWorktreeRegistryEntry(workflow.projectRoot, workflow.worktreeId, {
        status: "completed",
        implementationCommit,
    });
}
