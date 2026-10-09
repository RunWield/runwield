/**
 * @module cmd/load-plan/plan-recovery-flow
 * The Plan Recovery menu coordinator for in-progress, failed, and implemented Plans.
 */

import { resolvePlanExecutionPolicy } from "../../plan-store.js";
import { resolveWorkflowPlanLocation } from "../../shared/workflow/plan-location.ts";
import { probeGitRepository } from "../../shared/git.ts";
import { createGitPort } from "../../shared/git-port.ts";
import {
    buildPlanRecoveryUserMessage,
    buildValidationUserMessage,
    validationUserMessage,
} from "../../shared/workflow/validation-user-messages.ts";
import { isInValidation } from "../../shared/workflow/plan-lifecycle.js";
import { recordWorkflowMetric } from "../../shared/workflow/metrics.js";
import { healSettledTransitionRecords } from "../../shared/workflow/transition-recovery.ts";
import { verifyRecordedPublication } from "../../shared/workflow/validation-merge-verification.ts";
import { isUserVerifiableStatus } from "./plan-hold.ts";
import {
    hasWorktreeContext,
    persistRecoveredWorktreeMetadata,
    reportInvalidRecoveryPolicy,
    resolveRecoveryWorktree,
} from "./plan-recovery-worktree.ts";
import {
    abandonRecoveryPlan,
    continueRecoveryPlan,
    holdRecoveryPlan,
    inspectRecoveryPlan,
    openFollowUpRecoveryPlan,
    restoreRecoveryWorktreeRecord,
    reviewRecoveryPlan,
    settleRecoveryRecords,
    stopLostRecoveryPlan,
    userVerifyRecoveryPlan,
    validateRecoveryPlan,
} from "./plan-recovery-actions.ts";
import { resetRecoveryPlan } from "./plan-recovery-reset.ts";

import type { PlanSessionSurface, RecoveryWorktreeContext } from "./plan-session-types.ts";
import type { PlanFrontMatter } from "../../plan-store.js";
import type { UiAPI } from "../../ui/tui/types.js";
import type {
    RecoveryActionContext,
    RecoveryActionName,
    RecoveryActionOutcome,
    RecoveryMetricDetails,
} from "./plan-recovery-actions.ts";

export interface RecoveryFlowPlan {
    planName: string;
    revision?: string;
    path: string;
    markdown: string;
    body: string;
    attrs: PlanFrontMatter;
}

export interface UnresolvedTransitionRecord {
    transitionId?: string;
    operation?: string;
    reason?: string;
    authorityRoot?: string;
}

export interface HandlePlanRecoveryOptions {
    projectRoot: string;
    plan: RecoveryFlowPlan;
    agentName: string;
    uiAPI: UiAPI;
    unresolvedRecords?: UnresolvedTransitionRecord[];
    session: PlanSessionSurface;
    /**
     * The selected Plan's recorded worktree attempt, already resolved by the
     * caller. Recovery builds its first menu on this snapshot instead of
     * resolving again; legacy Plans would otherwise repeat attached-worktree
     * discovery before the first menu.
     */
    recordedAttempt?: RecoveryWorktreeContext | null;
    ports: RecoveryFlowPorts;
}

export interface RecoveryFlowPorts {
    recordWorkflowMetric: typeof recordWorkflowMetric;
    probeGitRepository: typeof probeGitRepository;
}

export const SYSTEM_RECOVERY_FLOW_PORTS: RecoveryFlowPorts = Object.freeze({
    recordWorkflowMetric,
    probeGitRepository,
});

type RecoveryMenuAnswer = RecoveryActionName | "cancel";

interface RecoveryMenuOption extends Record<string, string> {
    value: RecoveryMenuAnswer;
    label: string;
}

export async function handlePlanRecovery(
    opts: HandlePlanRecoveryOptions,
): Promise<"handled" | "review" | "settled" | "verified"> {
    const { projectRoot, plan, uiAPI } = opts;
    // Recovery preflight is scoped to the selected Plan. It refreshes the
    // authoritative Plan document and gathers only the evidence needed to build
    // the first menu. It deliberately does not run the repository-wide
    // `plans doctor`: that diagnosis is available through `wld plans doctor`, and
    // running it here made every recovery menu wait on unrelated Plans,
    // worktrees, journals, and branches.
    try {
        const { plan: refreshed } = await resolveWorkflowPlanLocation(projectRoot, plan.planName, {
            migrateRegistry: false,
        });
        if (refreshed) {
            plan.path = refreshed.path;
            plan.markdown = refreshed.markdown;
            plan.body = refreshed.body;
            plan.attrs = refreshed.attrs;
            plan.revision = refreshed.revision;
        }
    } catch (error) {
        console.error("[RunWield] recovery_safe_repair_failed", error);
        uiAPI.appendSystemMessage(
            buildValidationUserMessage({ kind: "recovery_repair_failed" }),
            true,
            "RunWield",
        );
        return "handled";
    }
    const initialPolicy = resolvePlanExecutionPolicy(plan.attrs);
    const loadedWorktreeId = plan.attrs.worktreeId;
    if (!initialPolicy.ok && initialPolicy.reason !== "project_epic") {
        reportInvalidRecoveryPolicy("recover", plan.planName, initialPolicy.error, uiAPI);
        return "handled";
    }

    const context: RecoveryActionContext = {
        projectRoot,
        plan,
        agentName: opts.agentName,
        uiAPI,
        session: opts.session,
        loadedWorktreeId,
        worktreeContext: null,
        unresolvedRecords: opts.unresolvedRecords ?? [],
        refreshRecoveryWorktree: () => Promise.resolve(null),
        recordRecoveryResult: async () => {},
    };
    context.refreshRecoveryWorktree = async () => {
        const resolved = await resolveRecoveryWorktree(projectRoot, plan);
        plan.attrs = await persistRecoveredWorktreeMetadata(resolved?.path || projectRoot, plan, resolved);
        context.worktreeContext = resolved;
        return resolved;
    };
    context.recordRecoveryResult = async (action: string, result: string, details: RecoveryMetricDetails = {}) => {
        const hasWorktree = hasWorktreeContext(context.worktreeContext);
        await opts.ports.recordWorkflowMetric({
            category: "recovery",
            event: "recovery_action_result",
            planName: plan.planName,
            details: { action, result, currentStatus: plan.attrs.status, hasWorktree, ...details },
        }, projectRoot);
    };
    // The first menu is built on one selected-Plan snapshot. When the caller
    // already resolved the recorded attempt, reuse it: re-resolving repeats the
    // registry reads and can restart attached-worktree discovery for legacy
    // Plans. Persisting discovered worktree metadata is a lifecycle mutation, so
    // it still waits for an action that actually needs it
    // (`refreshRecoveryWorktree`), keeping the first menu cheap.
    context.worktreeContext = opts.recordedAttempt !== undefined
        ? opts.recordedAttempt
        : await resolveRecoveryWorktree(projectRoot, plan, { migrateRegistry: false });
    if (context.worktreeContext?.path && context.worktreeContext.path !== projectRoot) {
        const executionRecovery = await healSettledTransitionRecords(context.worktreeContext.path, {
            planName: plan.planName,
            evidenceProjectRoot: projectRoot,
        });
        const settledIds = new Set(executionRecovery.closed.map((record) => record.transitionId));
        context.unresolvedRecords = context.unresolvedRecords
            .filter((record) => !record.transitionId || !settledIds.has(record.transitionId))
            .concat(executionRecovery.remaining.map((record) => ({
                ...record,
                authorityRoot: context.worktreeContext?.path,
            })));
        if (executionRecovery.closed.length > 0) {
            uiAPI.appendSystemMessage(
                buildPlanRecoveryUserMessage({ kind: "records_settled", count: executionRecovery.closed.length }),
                false,
                "RunWield",
            );
        }
    }
    if (!context.worktreeContext) {
        const publication = await verifyRecordedPublication(projectRoot, plan.attrs, plan);
        if (publication.published) {
            uiAPI.appendSystemMessage(
                buildValidationUserMessage({
                    kind: "verified",
                    planName: plan.planName,
                    targetBranch: publication.targetBranch,
                }),
                false,
                "RunWield",
            );
            await context.recordRecoveryResult("validate", "already_published", {
                targetBranch: publication.targetBranch,
            });
            return "settled";
        }
    }

    // Git capability and physical-loss facts change only when a mutating action
    // runs. Cache them across re-prompts so read-only browsing (Inspect, View)
    // does not repeat the repository probes, and invalidate after any other
    // action completes.
    let gitProbeCache: Awaited<ReturnType<RecoveryFlowPorts["probeGitRepository"]>> | null = null;
    let physicallyLostCache: boolean | null = null;
    const getGitProbe = async () => gitProbeCache ??= await opts.ports.probeGitRepository(projectRoot);
    const getPhysicallyLost = async () =>
        physicallyLostCache ??= await isAttemptPhysicallyLost(projectRoot, context.worktreeContext);
    const invalidateRecoveryFacts = () => {
        gitProbeCache = null;
        physicallyLostCache = null;
    };

    while (true) {
        const hasWorktree = hasWorktreeContext(context.worktreeContext);
        const gitProbe = await getGitProbe();
        const hasGitRecoveryMetadata = hasWorktree ||
            (plan.attrs.executionMode !== "non_git_in_place" && Boolean(plan.attrs.executionBaselineTree));
        const gitRecoveryBlocked = !gitProbe.ok && hasGitRecoveryMetadata;
        const physicallyLost = await getPhysicallyLost();
        const answer = await promptRecoveryAction(
            context,
            gitRecoveryBlocked,
            hasWorktree,
            physicallyLost,
        );
        await opts.ports.recordWorkflowMetric({
            category: "recovery",
            event: "recovery_action_selected",
            planName: plan.planName,
            details: { action: answer || "cancel", currentStatus: plan.attrs.status, hasWorktree },
        }, projectRoot);
        if (!answer || answer === "cancel") {
            await context.recordRecoveryResult("cancel", "handled");
            return "handled";
        }
        const outcome = await dispatchRecoveryAction(answer, context, gitRecoveryBlocked, gitProbe.state);
        // Inspect is read-only; every other action can change what the probes see.
        if (answer !== "inspect") invalidateRecoveryFacts();
        const terminal = translateRecoveryOutcome(outcome);
        if (terminal) {
            return terminal;
        }
    }
}

async function isAttemptPhysicallyLost(
    projectRoot: string,
    worktree: RecoveryWorktreeContext | null,
): Promise<boolean> {
    if (!worktree?.id || !worktree.path || !worktree.branch) return false;
    const pathExists = await Deno.stat(worktree.path).then((info) => info.isDirectory).catch(() => false);
    if (pathExists) return false;
    const branchExists = await createGitPort().branchHead(projectRoot, worktree.branch)
        .then(() => true)
        .catch(() => false);
    if (branchExists) return false;
    const command = new Deno.Command("git", {
        cwd: projectRoot,
        args: ["worktree", "list", "--porcelain"],
        stdout: "piped",
        stderr: "null",
    });
    const output = await command.output().catch(() => null);
    if (!output || !output.success) return true;
    const records = new TextDecoder().decode(output.stdout).trim().split(/\n\n+/);
    const record = records.find((value) => value.split("\n").includes(`worktree ${worktree.path}`));
    const head = record?.split("\n").find((line) => line.startsWith("HEAD "))?.slice(5);
    if (!head) return true;
    const proof = await new Deno.Command("git", {
        cwd: projectRoot,
        args: ["rev-parse", "--verify", `${head}^{commit}`],
        stdout: "null",
        stderr: "null",
    }).output().catch(() => null);
    return !proof?.success;
}

async function promptRecoveryAction(
    context: RecoveryActionContext,
    gitRecoveryBlocked: boolean,
    hasWorktree: boolean,
    physicallyLost: boolean,
): Promise<RecoveryMenuAnswer | null | undefined> {
    if (physicallyLost) {
        const userVerifyOptions: RecoveryMenuOption[] = isUserVerifiableStatus(context.plan.attrs.status)
            ? [{
                value: "user_verify",
                label: "Mark as User Verified (user attestation; no Workflow Validation claim)",
            }]
            : [];
        return await context.uiAPI.promptSelect(
            validationUserMessage("lost_attempt"),
            [
                { value: "reset", label: "Try the implementation again" },
                { value: "abandon", label: "Abandon the lost worktree" },
                ...userVerifyOptions,
                { value: "review", label: "Send the Plan back to Planner" },
                { value: "stop_lost", label: "Stop here" },
            ],
        ) as RecoveryMenuAnswer | null;
    }
    const userVerifyOptions: RecoveryMenuOption[] = isUserVerifiableStatus(context.plan.attrs.status)
        ? [{ value: "user_verify", label: "Mark as User Verified (user attestation; no Workflow Validation claim)" }]
        : [];
    const resetLabel = gitRecoveryBlocked
        ? "Clear stale Git recovery metadata"
        : hasWorktree
        ? "Delete/recreate worktree and start over"
        : "Reset tree and start over";
    const restoreRecordOptions: RecoveryMenuOption[] = context.plan.attrs.status !== "validated" &&
            context.worktreeContext?.id && !context.loadedWorktreeId
        ? [{ value: "restore_record", label: "Restore worktree record and continue" }]
        : [];
    const recordOptions: RecoveryMenuOption[] = context.unresolvedRecords.length > 0
        ? [{
            value: "settle_records",
            label: `Close ${
                context.unresolvedRecords.length === 1 ? "the unfinished Plan update" : "unfinished Plan updates"
            } (you confirm the state)`,
        }]
        : [];
    const common: RecoveryMenuOption[] = [
        { value: "inspect", label: "Inspect and report current state" },
        { value: "reset", label: resetLabel },
        ...(hasWorktree ? [{ value: "abandon" as const, label: "Delete/abandon worktree" }] : []),
        { value: "review", label: "Re-open for review" },
        ...userVerifyOptions,
        { value: "hold", label: "Put on hold" },
        { value: "cancel", label: "Cancel" },
    ];
    const policy = resolvePlanExecutionPolicy(context.plan.attrs);
    const followUpAgentLabel = policy.ok && policy.policy.executionAgent === "frontend-engineer"
        ? "Frontend Engineer"
        : "Plan Engineer";
    const followUpOptions: RecoveryMenuOption[] = context.plan.attrs.status === "implemented" && hasWorktree &&
            !gitRecoveryBlocked
        ? [{ value: "follow_up", label: `Open ${followUpAgentLabel} for follow-up` }]
        : [];
    const options = isInValidation(context.plan.attrs.status)
        ? [
            ...recordOptions,
            ...restoreRecordOptions,
            ...(gitRecoveryBlocked ? [] : [{
                value: "validate" as const,
                label: context.worktreeContext?.publication ? "Resume publication" : "Retry Workflow Validation",
            }]),
            ...followUpOptions,
            common[0],
            ...common.slice(1),
        ]
        : [
            ...recordOptions,
            ...restoreRecordOptions,
            common[0],
            ...(gitRecoveryBlocked
                ? []
                : [{ value: "continue" as const, label: "Continue execution from current worktree" }]),
            ...common.slice(1),
        ];
    const answer = await context.uiAPI.promptSelect(`Plan recovery (${context.plan.attrs.status}):`, options);
    return answer as RecoveryMenuAnswer | null;
}

async function dispatchRecoveryAction(
    action: RecoveryActionName,
    context: RecoveryActionContext,
    gitRecoveryBlocked: boolean,
    gitState: string,
): Promise<RecoveryActionOutcome> {
    if (gitRecoveryBlocked && ["continue", "validate", "follow_up", "merge"].includes(action)) {
        context.uiAPI.appendSystemMessage(
            buildPlanRecoveryUserMessage({ kind: "git_blocked" }),
            true,
            "RunWield",
        );
        await context.recordRecoveryResult(action, "blocked", { gitState });
        return { kind: "menu" };
    }
    // Session claiming lives in the action handlers, not here: each continuation
    // action calls `session.activateForPlan` right before its workflow work
    // begins, after every check that can still return to the menu. Bookkeeping
    // actions (settle, restore record, hold, verify, abandon, cancel) never call
    // it and leave the Session name untouched.
    switch (action) {
        case "settle_records":
            return await settleRecoveryRecords(context);
        case "restore_record":
            return await restoreRecoveryWorktreeRecord(context);
        case "stop_lost":
            return await stopLostRecoveryPlan(context);
        case "hold":
            return await holdRecoveryPlan(context);
        case "user_verify":
            return await userVerifyRecoveryPlan(context);
        case "inspect":
            return await inspectRecoveryPlan(context);
        case "validate":
            return await validateRecoveryPlan(context);
        case "follow_up":
            return await openFollowUpRecoveryPlan(context);
        case "continue":
            return await continueRecoveryPlan(context);
        case "abandon":
            return await abandonRecoveryPlan(context);
        case "review":
            return await reviewRecoveryPlan(context);
        case "reset":
            return await resetRecoveryPlan(context, gitRecoveryBlocked, gitState);
    }
}

function translateRecoveryOutcome(
    outcome: RecoveryActionOutcome,
): "handled" | "review" | "settled" | "verified" | null {
    switch (outcome.kind) {
        case "menu":
            return null;
        case "handled":
            return outcome.verified ? "verified" : "handled";
        case "review":
            return "review";
        case "settled":
            return "settled";
    }
}
