import { recordWorkflowOutcome } from "../../shared/workflow/outcome-observations.ts";
import { AGENTS } from "../../constants.js";
import { buildPlanEventUpdates } from "../../shared/workflow/plan-lifecycle.js";
import { closeTransitionRecordByAttestation, runRecoveryTransition } from "../../shared/workflow/state-transition.ts";
import { healSettledTransitionRecords } from "../../shared/workflow/transition-recovery.ts";
import {
    buildPlanRecoveryUserMessage,
    buildValidationUserMessage,
} from "../../shared/workflow/validation-user-messages.ts";
import { cleanupStoredPublication } from "../../shared/workflow/publication-machine.ts";
import {
    appendRecoveryReport,
    confirmRecoveryWorktreeAvailable,
    confirmWorktreeAction,
    hasWorktreeContext,
    rehydrateActiveRecoveryWorkflow,
    reopenPlanForReview,
} from "./plan-recovery-worktree.ts";
import {
    confirmAffectedPathChangesBeforeExecution,
    executeReadyPlanWithRepair,
    validateCompletedExecution,
} from "./plan-execution.ts";
import { recordPlanEvent } from "../../shared/workflow/plan-lifecycle.js";
import { discardWorktreeGitArtifacts, validateWorktreeDiscard } from "../../shared/worktree.js";
import {
    findById as findWorktreeRegistryEntry,
    restoreEntryFromPlanEvidence,
    updateEntry as updateWorktreeRegistryEntry,
} from "../../shared/worktree-registry.js";
import { markPlanUserVerified, putPlanOnHold } from "./plan-hold.ts";
import { settleDiscardedRecoveryAttempt } from "./plan-recovery-discard.ts";
import { transitionFailureError } from "./transition-failure.ts";
import { writeControllerState } from "../../shared/workflow/controller-registry.ts";
import { resolveWorkflowPlanLocation } from "../../shared/workflow/plan-location.ts";
import { ProjectRuntimeEntryRefusedError } from "../../shared/project-runtime-layout.ts";

import { updatePlanFrontMatter } from "../../plan-store.js";
import type { UiAPI } from "../../ui/tui/types.js";
import type { PlanSessionSurface, RecoveryWorktreeContext } from "./plan-session-types.ts";
import type { RecoveryFlowPlan, UnresolvedTransitionRecord } from "./plan-recovery-flow.ts";

export type RecoveryActionOutcome =
    | { kind: "menu" }
    | { kind: "handled"; verified?: boolean }
    | { kind: "review" }
    | { kind: "settled" };
export type RecoveryMetricDetailValue = string | number | boolean | null | undefined;
export type RecoveryMetricDetails = Record<string, RecoveryMetricDetailValue>;

export interface RecoveryActionContext {
    projectRoot: string;
    plan: RecoveryFlowPlan;
    agentName: string;
    uiAPI: UiAPI;
    session: PlanSessionSurface;
    loadedWorktreeId?: string | null;
    worktreeContext: RecoveryWorktreeContext | null;
    unresolvedRecords: UnresolvedTransitionRecord[];
    refreshRecoveryWorktree(): Promise<RecoveryWorktreeContext | null>;
    recordRecoveryResult(action: string, result: string, details?: RecoveryMetricDetails): Promise<void>;
}

export type RecoveryActionName =
    | "settle_records"
    | "hold"
    | "user_verify"
    | "inspect"
    | "validate"
    | "follow_up"
    | "continue"
    | "abandon"
    | "review"
    | "reset"
    | "restore_record"
    | "stop_lost";

export async function stopLostRecoveryPlan(context: RecoveryActionContext): Promise<RecoveryActionOutcome> {
    const { projectRoot, plan } = context;
    const resetUpdates = buildPlanEventUpdates("recovery_reset", plan.attrs.status, {
        triageMeta: plan.attrs,
    });
    const transition = await runRecoveryTransition({
        projectRoot,
        planName: plan.planName,
        action: "abandon",
        worktreeId: context.worktreeContext?.id,
        expectedRevision: plan.revision,
        recover: async ({ beforePlan, registerRollback }) => {
            const id = context.worktreeContext?.id;
            const entry = id ? await findWorktreeRegistryEntry(projectRoot, id) : null;
            if (entry) {
                registerRollback("restore abandoned attempt", async () => {
                    await updateWorktreeRegistryEntry(projectRoot, entry.id, entry);
                });
                await updateWorktreeRegistryEntry(projectRoot, entry.id, { status: "abandoned" });
            }
            return await updatePlanFrontMatter(
                projectRoot,
                plan.planName,
                {
                    ...resetUpdates,
                    status: "ready_for_work",
                    executionMode: null,
                    worktreeId: null,
                },
                {},
                { expectedRevision: beforePlan?.revision },
            );
        },
    });
    if (transition.status !== "committed") {
        throw transitionFailureError(transition, `Could not stop recovery for ${plan.planName}.`);
    }
    context.uiAPI.appendSystemMessage(buildPlanRecoveryUserMessage({ kind: "stopped" }), false, "RunWield");
    await context.recordRecoveryResult("stop_lost", "ready_for_work");
    return { kind: "handled" };
}

export async function restoreRecoveryWorktreeRecord(context: RecoveryActionContext): Promise<RecoveryActionOutcome> {
    const { projectRoot, plan, uiAPI, worktreeContext } = context;
    if (!worktreeContext?.id || !worktreeContext.path || !worktreeContext.branch || !worktreeContext.baseBranch) {
        uiAPI.appendSystemMessage(
            buildPlanRecoveryUserMessage({ kind: "record_incomplete" }),
            true,
            "RunWield",
        );
        await context.recordRecoveryResult("restore_record", "blocked", { reason: "incomplete_worktree_identity" });
        return { kind: "menu" };
    }
    const restored = await restoreEntryFromPlanEvidence(projectRoot, {
        id: worktreeContext.id,
        planName: plan.planName,
        planId: String(plan.attrs.planId || ""),
        baseBranch: worktreeContext.baseBranch,
        baseRef: worktreeContext.baseRef,
        baseCommit: worktreeContext.baseCommit,
        baseTree: worktreeContext.baseTree,
        executionBaselineTree: worktreeContext.executionBaselineTree,
        branch: worktreeContext.branch,
        path: worktreeContext.path,
        status: "completed",
    });
    if (!restored.restored || !restored.entry) {
        uiAPI.appendSystemMessage(
            buildPlanRecoveryUserMessage({ kind: "record_restore_failed" }),
            true,
            "RunWield",
        );
        await context.recordRecoveryResult("restore_record", "blocked", {
            reason: restored.reason || "restore_refused",
        });
        return { kind: "menu" };
    }
    uiAPI.appendSystemMessage(
        buildPlanRecoveryUserMessage({ kind: "record_restored", planName: plan.planName }),
        true,
        "RunWield",
    );
    await context.recordRecoveryResult("restore_record", "handled", { worktreeId: restored.entry.id });
    await context.refreshRecoveryWorktree();
    return { kind: "menu" };
}

export async function settleRecoveryRecords(context: RecoveryActionContext): Promise<RecoveryActionOutcome> {
    const { projectRoot, plan, uiAPI } = context;
    const authorityRoots = [
        ...new Set([
            projectRoot,
            ...context.unresolvedRecords.map((record) => record.authorityRoot).filter((root): root is string =>
                Boolean(root)
            ),
        ]),
    ];
    const rechecks = await Promise.all(authorityRoots.map(async (authorityRoot) => {
        const result = await healSettledTransitionRecords(authorityRoot, {
            planName: plan.planName,
            apply: true,
            evidenceProjectRoot: projectRoot,
        });
        return {
            closed: result.closed,
            remaining: result.remaining.map((record) => ({ ...record, authorityRoot })),
        };
    })).catch((error) => {
        if (error instanceof ProjectRuntimeEntryRefusedError) throw error;
        return null;
    });
    const closedCount = rechecks?.reduce((count, result) => count + result.closed.length, 0) ?? 0;
    context.unresolvedRecords = rechecks ? rechecks.flatMap((result) => result.remaining) : context.unresolvedRecords;
    if (closedCount > 0) {
        uiAPI.appendSystemMessage(
            buildPlanRecoveryUserMessage({ kind: "records_settled", count: closedCount }),
            false,
            "RunWield",
        );
    }
    if (context.unresolvedRecords.length === 0) {
        await context.recordRecoveryResult("settle_records", "handled", { byProof: true });
        return { kind: "menu" };
    }
    for (const _record of context.unresolvedRecords) {
        uiAPI.appendSystemMessage(
            buildPlanRecoveryUserMessage({ kind: "record_unfinished", planName: plan.planName }),
            false,
            "RunWield",
        );
    }
    const confirmed = await uiAPI.promptSelect(
        `Close ${context.unresolvedRecords.length === 1 ? "this record" : "these records"} on your confirmation?`,
        [
            { value: "no", label: "No, leave them (check the state first)" },
            { value: "yes", label: "Yes — I have checked the repository and nothing is unpublished" },
        ],
    );
    if (confirmed !== "yes") {
        await context.recordRecoveryResult("settle_records", "declined");
        return { kind: "menu" };
    }
    for (const record of context.unresolvedRecords) {
        if (record.transitionId) {
            await closeTransitionRecordByAttestation(record.authorityRoot || projectRoot, record.transitionId, {
                note: `Closed from Plan Recovery for ${plan.planName}.`,
            });
        }
    }
    context.unresolvedRecords = [];
    uiAPI.appendSystemMessage(
        buildPlanRecoveryUserMessage({ kind: "records_attested", planName: plan.planName }),
        false,
        "RunWield",
    );
    await context.recordRecoveryResult("settle_records", "handled", { byAttestation: true });
    return { kind: "menu" };
}

export async function holdRecoveryPlan(context: RecoveryActionContext): Promise<RecoveryActionOutcome> {
    await putPlanOnHold({
        projectRoot: context.projectRoot,
        plan: context.plan,
        uiAPI: context.uiAPI,
    });
    await context.recordRecoveryResult("hold", "handled");
    return { kind: "handled" };
}

export async function userVerifyRecoveryPlan(context: RecoveryActionContext): Promise<RecoveryActionOutcome> {
    await markPlanUserVerified({
        projectRoot: context.projectRoot,
        plan: context.plan,
        uiAPI: context.uiAPI,
        session: context.session,
    });
    await context.recordRecoveryResult("user_verify", "handled");
    return { kind: "handled" };
}

export async function inspectRecoveryPlan(context: RecoveryActionContext): Promise<RecoveryActionOutcome> {
    context.worktreeContext = await context.refreshRecoveryWorktree();
    await appendRecoveryReport(
        context.projectRoot,
        context.plan,
        context.uiAPI,
        context.worktreeContext,
    );
    await context.recordRecoveryResult("inspect", "reported", {
        hasWorktree: hasWorktreeContext(context.worktreeContext),
    });
    return { kind: "menu" };
}

export async function validateRecoveryPlan(context: RecoveryActionContext): Promise<RecoveryActionOutcome> {
    context.worktreeContext = await context.refreshRecoveryWorktree();
    const publication = context.worktreeContext?.publication;
    if (publication?.phase === "publication_verified" || publication?.phase === "cleanup_complete") {
        const cleanup = await cleanupStoredPublication(context.projectRoot, publication);
        if (cleanup.preservedFiles) {
            context.uiAPI.appendSystemMessage(
                buildValidationUserMessage({ kind: "publication_files_preserved", path: cleanup.preservedFiles }),
                false,
                "RunWield",
            );
        }
        if (!cleanup.complete) {
            context.uiAPI.appendSystemMessage(
                buildValidationUserMessage({
                    kind: "publication_cleanup_incomplete",
                    targetBranch: publication.targetBranch,
                    worktreePath: cleanup.worktreeKept ? publication.executionCwd : undefined,
                    worktreeBranch: cleanup.branchKept ? publication.executionBranch : undefined,
                    details: cleanup.details,
                }),
                true,
                "RunWield",
            );
            return { kind: "menu" };
        }
        context.uiAPI.appendSystemMessage(
            buildValidationUserMessage({
                kind: "verified",
                planName: context.plan.planName,
                targetBranch: publication.targetBranch,
            }),
            false,
            "RunWield",
        );
        await context.recordRecoveryResult("validate", "already_published", {
            targetBranch: publication.targetBranch,
        });
        return { kind: "settled" };
    }
    if (
        !(await confirmRecoveryWorktreeAvailable(
            context.projectRoot,
            context.plan.planName,
            context.worktreeContext,
            context.uiAPI,
        ))
    ) {
        return { kind: "menu" };
    }
    const validationStarted = await validateCompletedExecution(
        { executionComplete: true },
        context.plan.planName,
        context.plan.markdown || context.plan.body || "",
        context.plan.attrs,
        context.session.runValidation,
        context.worktreeContext,
        context.session,
        context.uiAPI,
    );
    if (!validationStarted) {
        await context.recordRecoveryResult("validate", "blocked", { reason: "invalid_execution_policy" });
        return { kind: "menu" };
    }
    await context.recordRecoveryResult("validate", "handled");
    return {
        kind: "handled",
        ...(validationStarted && typeof validationStarted === "object" && validationStarted.kind === "verified"
            ? { verified: true }
            : {}),
    };
}

export async function openFollowUpRecoveryPlan(context: RecoveryActionContext): Promise<RecoveryActionOutcome> {
    context.worktreeContext = await context.refreshRecoveryWorktree();
    const worktree = context.worktreeContext;
    if (!worktree?.id || !worktree.path || !worktree.branch || !worktree.baseBranch) {
        context.uiAPI.appendSystemMessage(
            buildPlanRecoveryUserMessage({ kind: "record_incomplete" }),
            true,
            "RunWield",
        );
        await context.recordRecoveryResult("follow_up", "blocked", { reason: "incomplete_worktree_identity" });
        return { kind: "menu" };
    }
    if (
        !(await confirmRecoveryWorktreeAvailable(
            context.projectRoot,
            context.plan.planName,
            worktree,
            context.uiAPI,
        ))
    ) {
        await context.recordRecoveryResult("follow_up", "blocked", { reason: "worktree_unavailable" });
        return { kind: "menu" };
    }
    const workflow = await rehydrateActiveRecoveryWorkflow(
        context.projectRoot,
        context.plan,
        worktree,
        context.session,
        context.uiAPI,
        "continue",
    );
    if (!workflow) {
        await context.recordRecoveryResult("follow_up", "blocked", { reason: "invalid_execution_policy" });
        return { kind: "menu" };
    }
    await context.session.replaceWithExecutionSession(workflow);
    await context.recordRecoveryResult("follow_up", "handled", {
        worktreeId: worktree.id,
    });
    return { kind: "handled" };
}

export async function continueRecoveryPlan(context: RecoveryActionContext): Promise<RecoveryActionOutcome> {
    context.worktreeContext = await context.refreshRecoveryWorktree();
    if (
        context.plan.attrs.executionMode !== "non_git_in_place" &&
        !(await confirmRecoveryWorktreeAvailable(
            context.projectRoot,
            context.plan.planName,
            context.worktreeContext,
            context.uiAPI,
        ))
    ) {
        return { kind: "menu" };
    }
    if (context.plan.attrs.executionMode === "worktree") {
        const worktree = context.worktreeContext;
        if (!worktree?.id || !worktree.path || !worktree.branch || !worktree.baseBranch) {
            context.uiAPI.appendSystemMessage(
                buildPlanRecoveryUserMessage({ kind: "record_incomplete" }),
                true,
                "RunWield",
            );
            return { kind: "menu" };
        }
        const restored = await restoreEntryFromPlanEvidence(context.projectRoot, {
            id: worktree.id,
            planName: context.plan.planName,
            planId: String(context.plan.attrs.planId || ""),
            baseBranch: worktree.baseBranch,
            baseRef: worktree.baseRef,
            baseCommit: worktree.baseCommit,
            baseTree: worktree.baseTree,
            executionBaselineTree: context.plan.attrs.executionBaselineTree || worktree.executionBaselineTree,
            branch: worktree.branch,
            path: worktree.path,
            status: context.plan.attrs.status === "failed" ? "execution_failed" : "active",
        });
        if (!restored.entry) {
            console.error("[RunWield] recovery_worktree_record_restore_failed", restored.reason);
            context.uiAPI.appendSystemMessage(
                buildPlanRecoveryUserMessage({ kind: "record_restore_failed" }),
                true,
                "RunWield",
            );
            return { kind: "menu" };
        }
        if (restored.restored) {
            context.uiAPI.appendSystemMessage(
                buildPlanRecoveryUserMessage({ kind: "record_restored", planName: context.plan.planName }),
                false,
                "RunWield",
            );
            context.worktreeContext = await context.refreshRecoveryWorktree();
        }
    }
    const confirmed = await confirmAffectedPathChangesBeforeExecution({
        projectRoot: context.projectRoot,
        planName: context.plan.planName,
        triageMeta: context.plan.attrs,
        uiAPI: context.uiAPI,
    });
    if (!confirmed) {
        await context.recordRecoveryResult("continue", "canceled");
        return { kind: "handled" };
    }
    if (
        !(await rehydrateActiveRecoveryWorkflow(
            context.projectRoot,
            context.plan,
            context.worktreeContext,
            context.session,
            context.uiAPI,
            "continue",
        ))
    ) {
        await context.recordRecoveryResult("continue", "blocked", { reason: "invalid_execution_policy" });
        return { kind: "menu" };
    }
    if (context.plan.attrs.status === "in_progress" || context.plan.attrs.status === "failed") {
        const authorityRoot = context.plan.attrs.executionMode === "worktree" && context.worktreeContext?.path
            ? context.worktreeContext.path
            : context.projectRoot;
        context.plan.attrs = await recordPlanEvent({
            cwd: authorityRoot,
            planName: context.plan.planName,
            event: "recovery_continue",
            currentStatus: context.plan.attrs.status,
            details: { triageMeta: context.plan.attrs },
        });
    }
    await executeReadyPlanWithRepair({
        projectRoot: context.projectRoot,
        plan: context.plan,
        agentName: context.agentName,
        uiAPI: context.uiAPI,
        executePlan: context.session.executePlan,
        continueWorkflowValidation: context.session.runValidation,
        session: context.session,
        affectedPathsAlreadyConfirmed: true,
    });
    await context.recordRecoveryResult("continue", "handled");
    return { kind: "handled" };
}

export async function abandonRecoveryPlan(context: RecoveryActionContext): Promise<RecoveryActionOutcome> {
    const { projectRoot, plan, uiAPI } = context;
    if (!(await confirmWorktreeAction(plan.planName, uiAPI, "Delete/abandon"))) {
        return { kind: "menu" };
    }
    uiAPI.appendSystemMessage(
        buildPlanRecoveryUserMessage({ kind: "deleting_worktree", planName: plan.planName }),
        false,
        "RunWield",
    );
    const abandonedAttemptId = context.worktreeContext?.id || context.loadedWorktreeId || undefined;
    let cleanupMessage = "The recorded attempt was abandoned.";
    try {
        if (hasWorktreeContext(context.worktreeContext)) {
            await validateWorktreeDiscard({ projectRoot, ...context.worktreeContext });
        }
    } catch (error) {
        uiAPI.appendSystemMessage(
            buildPlanRecoveryUserMessage({
                kind: "worktree_cleanup_result",
                failed: true,
                detail: error instanceof Error ? error.message : String(error),
            }),
            true,
            "RunWield",
        );
        await context.recordRecoveryResult("abandon", "blocked");
        return { kind: "menu" };
    }
    const transition = await runRecoveryTransition({
        projectRoot,
        planName: plan.planName,
        planId: plan.attrs.planId,
        worktreeId: context.worktreeContext?.id,
        action: "abandon",
        recover: async ({ beforePlan, markEffect }) => {
            let retained = false;
            if (hasWorktreeContext(context.worktreeContext)) {
                for await (const cleanup of discardWorktreeGitArtifacts({ projectRoot, ...context.worktreeContext })) {
                    if (cleanup.status === "blocked") throw new Error(cleanup.message);
                    await markEffect(`recovery_discard_${cleanup.status}`, { ...context.worktreeContext, ...cleanup });
                    cleanupMessage = cleanup.message;
                    retained = cleanup.status === "retained";
                }
            }
            await settleDiscardedRecoveryAttempt(
                projectRoot,
                plan.planName,
                plan.attrs.planId,
                context.worktreeContext,
                retained,
            );
            await markEffect("recovery_discard_registry_settled", {
                worktreeId: context.worktreeContext?.id,
                retained,
            });
            // Deleted attempts must not remain the selected document after reload.
            // Review reopening retains this reference because its directory survives.
            // Imported recovery hints must not revive this attempt either.
            // Keep this write inside the transition so rollback owns it too.
            await writeControllerState(
                projectRoot,
                { planName: plan.planName, planId: plan.attrs.planId },
                { executionMode: null, documentWorktreeId: null },
                { expectedRevision: beforePlan?.controllerRevision, recovery: null },
            );
            return {
                ...plan.attrs,
                executionMode: null,
                executionBaselineTree: null,
                worktreeId: null,
                worktreePath: null,
                worktreeBranch: null,
                worktreeBaseBranch: null,
                worktreeStatus: "abandoned",
            };
        },
    });
    if (transition.status !== "committed") {
        uiAPI.appendSystemMessage(
            buildPlanRecoveryUserMessage({
                kind: "worktree_cleanup_result",
                failed: true,
                detail: transition.message || "Recovery was kept active.",
            }),
            true,
            "RunWield",
        );
        await context.recordRecoveryResult("abandon", "blocked");
        return { kind: "menu" };
    }
    await recordWorkflowOutcome(projectRoot, {
        event: "workflow_abandoned",
        category: "recovery",
        operationId: transition.transitionId,
        attemptId: abandonedAttemptId,
        planId: plan.attrs.planId,
        outcome: "succeeded",
    });
    context.worktreeContext = null;
    context.loadedWorktreeId = null;
    await context.session.clearActiveExecutionWorkflow();
    uiAPI.appendSystemMessage(
        buildPlanRecoveryUserMessage({ kind: "worktree_cleanup_result", detail: cleanupMessage }),
        false,
        "RunWield",
    );
    const location = await resolveWorkflowPlanLocation(projectRoot, plan.planName);
    if (!location.plan) {
        uiAPI.appendSystemMessage(
            buildPlanRecoveryUserMessage({ kind: "abandon_definition_missing" }),
            true,
            "RunWield",
        );
        await context.recordRecoveryResult("abandon", "missing_plan");
        return { kind: "handled" };
    }
    Object.assign(plan, location.plan);
    await context.recordRecoveryResult("abandon", "abandoned");
    return plan.attrs.status === "validated" || plan.attrs.status === "verified" ||
            plan.attrs.status === "user_verified"
        ? { kind: "settled" }
        : { kind: "menu" };
}

export async function reviewRecoveryPlan(context: RecoveryActionContext): Promise<RecoveryActionOutcome> {
    // Reopening review hands the Plan back to the Planner in this Session; the
    // Session is claimed right before that workflow work begins.
    await context.session.activateForPlan(context.plan.planName);
    await reopenPlanForReview({
        projectRoot: context.projectRoot,
        plan: context.plan,
        currentStatus: context.plan.attrs.status,
        worktreeContext: context.worktreeContext,
        session: context.session,
    });
    await context.session.switchAgent(AGENTS.PLANNER, {});
    await context.recordRecoveryResult("review", "review");
    return { kind: "review" };
}
