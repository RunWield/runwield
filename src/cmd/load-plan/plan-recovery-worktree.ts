/**
 * @module cmd/load-plan/plan-recovery-worktree
 * Reading, reporting on, and detaching the worktree generation a Plan records.
 *
 * Recovery's job is Plans whose recorded execution metadata is partial or stale,
 * so everything here tolerates missing fields — and refuses, loudly, where a
 * missing field would make a destructive action unsafe.
 */

import { loadPlan, resolvePlanExecutionPolicy, updatePlanFrontMatter } from "../../plan-store.js";
import { buildPlanEventUpdates } from "../../shared/workflow/plan-lifecycle.js";
import { resolveValidationExecutionContext } from "../../shared/workflow/execution-context.ts";
import {
    buildPlanRecoveryUserMessage,
    buildValidationRecoveryNotice,
    planRecoveryMessage,
} from "../../shared/workflow/validation-user-messages.ts";
import { runPlanFrontMatterTransition, runReviewReopenTransition } from "../../shared/workflow/state-transition.ts";
import { getWorkflowDiff } from "../../shared/workflow/git-snapshot.ts";
import { getWorktreeStatus } from "../../shared/worktree.js";
import {
    findActiveByPlanName as findWorktreeByPlanName,
    findById as findWorktreeById,
} from "../../shared/worktree-registry.js";
import { buildPlanSummary } from "../../shared/plan-presentation.ts";
import { transitionFailureError } from "./transition-failure.ts";
import { resolveWorkflowPlanLocation } from "../../shared/workflow/plan-location.ts";

import { recordPlanEvent } from "../../shared/workflow/plan-lifecycle.js";
import type { PlanFrontMatter } from "../../plan-store.js";
import type { PlanStatus } from "../../shared/workflow/plan-lifecycle.js";
import type { UiAPI } from "../../ui/tui/types.js";
import type { PlanSessionSurface, RecoveryWorktreeContext } from "./plan-session-types.ts";

/**
 * The minimum a Plan has to carry for recovery to reason about its worktree.
 *
 * Deliberately not the whole Plan: the lookups below run against Plans loaded
 * for their Front Matter alone, with no body read.
 */
export interface RecoveryPlanRef {
    planName: string;
    attrs: PlanFrontMatter;
    revision?: string;
}

/** A Plan with enough loaded to render a recovery report. */
export interface RecoverablePlan extends RecoveryPlanRef {
    path?: string;
    body: string;
    markdown?: string;
}

/**
 * The execution context recovery reads, whether it was reconstructed from the
 * Plan's own metadata or resolved fresh. Both shapes are read the same way here.
 */
export interface RecoveryExecutionContext {
    executionMode?: "worktree" | "non_git_in_place" | null;
    executionCwd?: string | null;
    baselineTree?: string | null;
    worktreeId?: string | null;
    worktreeBranch?: string | null;
    worktreeBaseBranch?: string | null;
}

interface AttachedWorktreeRecord {
    path: string;
    branch: string;
}

interface ResolveRecoveryWorktreeOptions {
    migrateRegistry?: boolean;
}

async function canonicalPath(path: string): Promise<string | null> {
    try {
        return await Deno.realPath(path);
    } catch {
        return null;
    }
}

async function listAttachedWorktrees(projectRoot: string): Promise<AttachedWorktreeRecord[]> {
    const command = new Deno.Command("git", {
        args: ["worktree", "list", "--porcelain"],
        cwd: projectRoot,
        stdout: "piped",
        stderr: "null",
    });
    const output = await command.output();
    if (output.code !== 0) return [];
    return new TextDecoder().decode(output.stdout).trim().split("\n\n").filter(Boolean).map((block) => {
        const lines = block.split("\n");
        return {
            path: lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length).trim() || "",
            branch: lines.find((line) => line.startsWith("branch "))?.slice("branch ".length).trim() || "",
        };
    }).filter((record) => Boolean(record.path && record.branch));
}

async function discoverAttachedPlanWorktree(
    projectRoot: string,
    plan: RecoveryPlanRef,
): Promise<RecoveryWorktreeContext | null> {
    const projectPath = await canonicalPath(projectRoot);
    const matches: RecoveryWorktreeContext[] = [];
    for (const record of await listAttachedWorktrees(projectRoot)) {
        const recordPath = await canonicalPath(record.path);
        if (!recordPath || recordPath === projectPath) continue;
        const executionPlan = await loadPlan(record.path, plan.planName).catch(() => null);
        if (!executionPlan || executionPlan.attrs.executionMode !== "worktree") continue;
        const attrs = executionPlan.attrs;
        if (
            !attrs.planId || !attrs.worktreeId || !attrs.worktreePath || !attrs.worktreeBranch ||
            !attrs.worktreeBaseBranch
        ) continue;
        if (plan.attrs.planId && plan.attrs.planId !== attrs.planId) continue;
        if (await canonicalPath(attrs.worktreePath) !== recordPath) continue;
        if (record.branch !== `refs/heads/${attrs.worktreeBranch}`) continue;
        if (
            !["in_progress", "failed", "implemented", "validated_ci", "reviewed", "validated"].includes(
                attrs.status,
            )
        ) continue;
        matches.push({
            id: attrs.worktreeId,
            path: record.path,
            branch: attrs.worktreeBranch,
            baseBranch: attrs.worktreeBaseBranch,
            executionBaselineTree: attrs.executionBaselineTree || undefined,
            status: attrs.worktreeStatus || undefined,
        });
    }
    return matches.length === 1 ? matches[0] : null;
}

/** The execution workflow recovery re-attaches to the session. */
export interface RecoveryWorkflowState {
    planName: string;
    triageMeta: PlanFrontMatter;
    executionAgent: "engineer" | "frontend-engineer";
    projectRoot: string;
    executionMode?: "worktree" | "non_git_in_place";
    executionCwd?: string;
    baselineTree?: string;
    worktreeId?: string;
    worktreeBranch?: string;
    worktreeBaseBranch?: string;
    nonGitInPlace?: boolean;
}

/** Everything `reopenPlanForReview` needs to detach a Plan from its generation. */
export interface ReopenPlanForReviewOptions {
    projectRoot: string;
    plan: RecoveryPlanRef;
    currentStatus: PlanStatus;
    worktreeContext?: RecoveryWorktreeContext | null;
    session: PlanSessionSurface;
}

/**
 * @param {string} projectRoot
 * @param {{ planName: string, attrs: import('../../plan-store.js').PlanFrontMatter }} plan
 * @param {{ migrateRegistry?: boolean }} [options]
 * @returns {Promise<RecoveryWorktreeContext | null>}
 */
export async function resolveRecoveryWorktree(
    projectRoot: string,
    plan: RecoveryPlanRef,
    options: ResolveRecoveryWorktreeOptions = {},
): Promise<RecoveryWorktreeContext | null> {
    const registryReadOptions = options.migrateRegistry === false ? { migrate: false } : undefined;
    let entry = null;
    if (plan.attrs.worktreeId) entry = await findWorktreeById(projectRoot, plan.attrs.worktreeId, registryReadOptions);
    if (!entry) entry = await findWorktreeByPlanName(projectRoot, plan.planName, registryReadOptions);
    if (
        !entry && !plan.attrs.worktreePath && !plan.attrs.worktreeBranch && !plan.attrs.worktreeId
    ) {
        const discovered = await discoverAttachedPlanWorktree(projectRoot, plan);
        if (discovered) return discovered;
    }
    const path = entry?.path || plan.attrs.worktreePath || undefined;
    const branch = entry?.branch || plan.attrs.worktreeBranch || undefined;
    const id = entry?.id || plan.attrs.worktreeId || undefined;
    const recordedBaseBranch = entry?.baseBranch || plan.attrs.worktreeBaseBranch || undefined;
    const baseBranch = recordedBaseBranch === "HEAD" ? undefined : recordedBaseBranch;
    if (!path && !branch && !id) return null;
    return {
        id,
        path,
        branch,
        baseBranch,
        // Once execution starts, the registry records operational attempt state.
        // The primary-checkout Plan is intentionally immutable during publication,
        // so its older worktreeStatus must not hide a failed push or conflict.
        status: entry?.status || plan.attrs.worktreeStatus || undefined,
        baseRef: entry?.baseRef || plan.attrs.worktreeBaseCommit || undefined,
        baseCommit: entry?.baseCommit || plan.attrs.worktreeBaseCommit || undefined,
        baseTree: entry?.baseTree,
        executionBaselineTree: entry?.executionBaselineTree || plan.attrs.executionBaselineTree || undefined,
        publication: entry?.publication,
    };
}

/**
 * @param {string} projectRoot
 * @param {{ planName: string, attrs: import('../../plan-store.js').PlanFrontMatter, revision?: string }} plan
 * @param {RecoveryWorktreeContext | null} context
 * @returns {Promise<import('../../plan-store.js').PlanFrontMatter>}
 */
export async function persistRecoveredWorktreeMetadata(
    projectRoot: string,
    plan: RecoveryPlanRef,
    context: RecoveryWorktreeContext | null,
): Promise<PlanFrontMatter> {
    if (!context) return plan.attrs;
    // A validated Plan deliberately drops attempt pointers. The registry remains
    // publication authority until upstream verification and cleanup complete.
    if (plan.attrs.status === "validated") return plan.attrs;
    const updates: Partial<PlanFrontMatter> = {};
    if (context.id && !plan.attrs.worktreeId) updates.worktreeId = context.id;
    if (!Object.keys(updates).length) return plan.attrs;
    const transition = await runPlanFrontMatterTransition({
        projectRoot,
        planName: plan.planName,
        operation: "recovery_metadata_refresh",
        updates,
        recoveryAttrs: {},
        expectedRevision: plan.revision,
    });
    if (transition.status !== "committed") {
        throw transitionFailureError(transition, `Recovery metadata transition failed for ${plan.planName}.`);
    }
    return transition.value as PlanFrontMatter;
}

/**
 * Refuse to detach a generation RunWield does not manage.
 *
 * Worktree metadata with a path or branch but no registry id is a worktree
 * nothing can abandon: there is no entry to mark. Detaching the Plan from it
 * anyway would strand a real working tree with no record pointing at it.
 *
 * @param {string} planName
 * @param {RecoveryWorktreeContext | null | undefined} priorWorktree
 */
export function assertRecoveryWorktreeIsManaged(
    planName: string,
    priorWorktree: RecoveryWorktreeContext | null | undefined,
): void {
    if (priorWorktree?.id) return;
    if (!priorWorktree?.path && !priorWorktree?.branch) return;
    throw new Error(
        `Cannot reopen ${planName} for review while recovery worktree metadata lacks a registry id. Resolve or abandon the recorded worktree (${
            priorWorktree.path || "unknown path"
        }, ${priorWorktree.branch || "unknown branch"}) before reopening review.`,
    );
}

/**
 * Reopen review without retiring the implementation. Reapproval continues in
 * the same worktree, including its committed and uncommitted changes.
 *
 * @param {Object} opts
 * @param {string} opts.projectRoot
 * @param {{ planName: string, path: string, body: string, attrs: import('../../plan-store.js').PlanFrontMatter, revision?: string }} opts.plan
 * @param {import('../../shared/workflow/plan-lifecycle.js').PlanStatus} opts.currentStatus
 * @param {RecoveryWorktreeContext | null | undefined} [opts.worktreeContext]
 * @param {PlanSessionSurface} opts.session
 */
export async function reopenPlanForReview({
    projectRoot,
    plan,
    currentStatus,
    worktreeContext,
    session,
}: ReopenPlanForReviewOptions): Promise<void> {
    const priorWorktree = worktreeContext === undefined
        ? await resolveRecoveryWorktree(projectRoot, plan)
        : worktreeContext;
    if (!priorWorktree?.id) {
        assertRecoveryWorktreeIsManaged(plan.planName, priorWorktree);
        session.clearActiveExecutionWorkflow();
        const updatedAttrs = await recordPlanEvent({
            cwd: projectRoot,
            planName: plan.planName,
            event: "review_reopened",
            currentStatus,
            details: { triageMeta: plan.attrs },
        });
        plan.attrs = { ...plan.attrs, ...updatedAttrs };
        return;
    }
    const priorWorktreeId = priorWorktree.id;
    const { documentRoot } = await resolveWorkflowPlanLocation(projectRoot, plan.planName);
    const transition = await runReviewReopenTransition({
        projectRoot: documentRoot,
        planName: plan.planName,
        worktreeId: priorWorktreeId,
        expectedRevision: plan.revision,
        reopen: async ({ beforePlan, markEffect }) => {
            if (!beforePlan) throw new Error(`Plan not found: ${plan.planName}`);
            const updates = buildPlanEventUpdates("review_reopened", currentStatus, { triageMeta: beforePlan.attrs });
            const updatedAttrs = await updatePlanFrontMatter(documentRoot, plan.planName, updates, beforePlan.attrs, {
                expectedRevision: beforePlan.revision,
            });
            await markEffect("plan_event_recorded", { planName: plan.planName, event: "review_reopened" });
            return updatedAttrs;
        },
    });
    if (transition.status !== "committed") {
        throw transitionFailureError(transition, `Review reopen transition failed for ${plan.planName}.`);
    }
    session.clearActiveExecutionWorkflow();
    const refreshed = await loadPlan(documentRoot, plan.planName);
    if (refreshed) Object.assign(plan, refreshed);
}

/**
 * @param {RecoveryWorktreeContext | null} context
 * @returns {boolean}
 */
export function hasWorktreeContext(context: RecoveryWorktreeContext | null | undefined): boolean {
    return Boolean(context?.path || context?.branch || context?.id);
}

/**
 * Publication recovery is only safe after Workflow Validation has already
 * passed and publication either conflicted or could not update the upstream
 * branch.
 *
 * @param {RecoveryWorktreeContext | null} context
 * @returns {boolean}
 */
/**
 * @param {RecoveryWorktreeContext | null} context
 * @returns {string | null}
 */
export function getRecordedWorktreeRecreateBase(context: RecoveryWorktreeContext | null | undefined): string | null {
    return context?.baseCommit || context?.baseRef || null;
}

/** @param {string | undefined} path */
export async function pathExists(path: string | undefined): Promise<boolean> {
    if (!path) return false;
    try {
        const stat = await Deno.stat(path);
        return stat.isDirectory;
    } catch {
        return false;
    }
}

/**
 * @param {string} action
 * @param {string} planName
 * @param {string} error
 * @param {import('../../ui/tui/types.js').UiAPI} uiAPI
 */
export function reportInvalidRecoveryPolicy(
    action: string,
    planName: string,
    _error: string | undefined,
    uiAPI: UiAPI,
): void {
    uiAPI.appendSystemMessage(
        buildPlanRecoveryUserMessage({ kind: "invalid_policy", action, planName }),
        true,
        "RunWield",
    );
}

/**
 * @param {string} projectRoot
 * @param {{ planName: string, attrs: import('../../plan-store.js').PlanFrontMatter }} plan
 * @param {RecoveryWorktreeContext | null} context
 * @param {PlanSessionSurface} session
 * @param {import('../../ui/tui/types.js').UiAPI} [uiAPI]
 * @param {string} [action]
 * @returns {Promise<RecoveryWorkflowState | null>}
 */
export async function rehydrateActiveRecoveryWorkflow(
    projectRoot: string,
    plan: RecoveryPlanRef,
    context: RecoveryWorktreeContext | null,
    session: PlanSessionSurface,
    uiAPI?: UiAPI,
    action: string = "continue",
): Promise<RecoveryWorkflowState | null> {
    const policy = resolvePlanExecutionPolicy(plan.attrs);
    if (!policy.ok) {
        if (uiAPI) {
            reportInvalidRecoveryPolicy(action, plan.planName, policy.error, uiAPI);
            return null;
        }
        throw new Error(policy.error);
    }
    const explicitContext = {
        planName: plan.planName,
        triageMeta: plan.attrs,
        executionMode: plan.attrs.executionMode,
        baselineTree: plan.attrs.executionBaselineTree || context?.baseTree,
        worktreeId: context?.id || plan.attrs.worktreeId,
        worktreeBranch: context?.branch || plan.attrs.worktreeBranch,
        worktreeBaseBranch: context?.baseBranch || plan.attrs.worktreeBaseBranch,
        executionCwd: context?.path || plan.attrs.worktreePath,
        nonGitInPlace: plan.attrs.executionMode === "non_git_in_place",
    };
    let resolvedContext: RecoveryExecutionContext = explicitContext;
    if (action !== "continue") {
        const resolution = await resolveValidationExecutionContext({
            projectRoot,
            planName: plan.planName,
            triageMeta: plan.attrs,
            explicitContext,
        });
        if (resolution.kind === "blocked") {
            if (uiAPI) {
                console.error("[RunWield] Recovery action blocked", { action, reason: resolution.message });
                uiAPI.appendSystemMessage(planRecoveryMessage("action_blocked"), false, "RunWield");
                return null;
            }
            throw new Error(resolution.message);
        }
        if (resolution.restoredPlanFile && uiAPI) {
            uiAPI.appendSystemMessage(
                buildPlanRecoveryUserMessage({ kind: "plan_restored", path: resolution.restoredPlanFile.relativePath }),
                false,
                "RunWield",
            );
        }
        for (const notice of resolution.selfHealNotices || []) {
            if (uiAPI) uiAPI.appendSystemMessage(buildValidationRecoveryNotice(notice), false, "RunWield");
        }
        resolvedContext = resolution.context;
    }
    const workflow: RecoveryWorkflowState = {
        planName: plan.planName,
        triageMeta: plan.attrs,
        executionAgent: policy.policy.executionAgent,
        executionMode: resolvedContext.executionMode || undefined,
        projectRoot,
        executionCwd: resolvedContext.executionCwd || undefined,
    };
    if (resolvedContext.executionMode === "non_git_in_place") workflow.nonGitInPlace = true;
    if (resolvedContext.executionMode === "worktree") {
        workflow.baselineTree = resolvedContext.baselineTree || undefined;
        workflow.worktreeId = resolvedContext.worktreeId || undefined;
        workflow.worktreeBranch = resolvedContext.worktreeBranch || undefined;
        workflow.worktreeBaseBranch = resolvedContext.worktreeBaseBranch || undefined;
    }
    // Workflow publication is a managed Session mutation. Claim the Session name
    // after the non-mutating policy checks above and immediately before the
    // workflow state is published.
    await session.activateForPlan(plan.planName);
    await session.setActiveExecutionWorkflow(workflow);
    return workflow;
}

/**
 * Append recovery context for a partially executed Plan.
 *
 * @param {string} projectRoot
 * @param {{ planName: string, attrs: import('../../plan-store.js').PlanFrontMatter, body: string, markdown: string }} plan
 * @param {import('../../ui/tui/types.js').UiAPI} uiAPI
 * @param {RecoveryWorktreeContext | null} worktreeContext
 * @returns {Promise<void>}
 */
export async function appendRecoveryReport(
    projectRoot: string,
    plan: RecoverablePlan,
    uiAPI: UiAPI,
    worktreeContext: RecoveryWorktreeContext | null,
): Promise<void> {
    let gitStatus: string | undefined;
    let diff: string | undefined;
    let inspectionFailed = false;
    if (hasWorktreeContext(worktreeContext)) {
        if (worktreeContext?.path) {
            try {
                const status = await getWorktreeStatus({
                    projectRoot: projectRoot,
                    path: worktreeContext.path,
                    branch: worktreeContext.branch,
                    baseTree: plan.attrs.executionBaselineTree || worktreeContext.executionBaselineTree ||
                        worktreeContext.baseTree || worktreeContext.baseCommit || undefined,
                });
                gitStatus = status.exists ? status.statusText.trim() : "missing worktree path";
                diff = status.diff?.trim() || "";
            } catch (error) {
                console.error("[RunWield] recovery_report_worktree_check_failed", error);
                inspectionFailed = true;
            }
        }
    } else if (plan.attrs.executionBaselineTree) {
        try {
            diff = (await getWorkflowDiff(projectRoot, plan.attrs.executionBaselineTree)).trim();
        } catch (error) {
            console.error("[RunWield] recovery_report_diff_failed", error);
            inspectionFailed = true;
        }
    }
    uiAPI.appendSystemMessage(
        buildPlanRecoveryUserMessage({
            kind: "recovery_report",
            summary: buildPlanSummary(plan),
            lastRunStopped: Boolean(plan.attrs.failureReason),
            ...(hasWorktreeContext(worktreeContext)
                ? {
                    worktree: {
                        status: worktreeContext?.status,
                        path: worktreeContext?.path,
                        branch: worktreeContext?.branch,
                        target: worktreeContext?.baseBranch,
                    },
                }
                : {}),
            ...(gitStatus !== undefined ? { gitStatus } : {}),
            ...(diff !== undefined ? { diff } : {}),
            ...(inspectionFailed ? { inspectionFailed: true } : {}),
            ...(!hasWorktreeContext(worktreeContext) && !plan.attrs.executionBaselineTree ? { noBaseline: true } : {}),
        }),
        false,
        "Plan Recovery",
    );
}

/**
 * Ask for destructive baseline reset confirmation.
 *
 * @param {string} planName
 * @param {import('../../ui/tui/types.js').UiAPI} uiAPI
 * @returns {Promise<boolean>}
 */
export async function confirmBaselineReset(planName: string, uiAPI: UiAPI): Promise<boolean> {
    const answer = await uiAPI.promptSelect(
        `Reset "${planName}" to its execution-start snapshot? Changes made after that snapshot, including unrelated changes, will be lost.`,
        [
            { value: "reset", label: "Yes, reset and start over" },
            { value: "cancel", label: "Cancel" },
        ],
    );
    return answer === "reset";
}

/**
 * @param {string} planName
 * @param {import('../../ui/tui/types.js').UiAPI} uiAPI
 * @returns {Promise<boolean>}
 */
export async function confirmMetadataOnlyRecoveryCleanup(_planName: string, uiAPI: UiAPI): Promise<boolean> {
    uiAPI.appendSystemMessage(
        buildPlanRecoveryUserMessage({ kind: "git_blocked" }),
        true,
        "RunWield",
    );
    const answer = await uiAPI.promptSelect("Clear stale Git recovery metadata and mark the plan ready for work?", [
        { value: "clear", label: "Clear metadata only" },
        { value: "cancel", label: "Cancel" },
    ]);
    return answer === "clear";
}

/**
 * @param {string} planName
 * @param {import('../../ui/tui/types.js').UiAPI} uiAPI
 * @param {string} action
 * @returns {Promise<boolean>}
 */
export async function confirmWorktreeAction(planName: string, uiAPI: UiAPI, action: string): Promise<boolean> {
    const answer = await uiAPI.promptSelect(`${action} worktree for "${planName}"?`, [
        { value: "confirm", label: `Yes, ${action.toLowerCase()} worktree` },
        { value: "cancel", label: "Cancel" },
    ]);
    return answer === "confirm";
}

/**
 * @param {string} planName
 * @param {RecoveryWorktreeContext | null} worktreeContext
 * @param {import('../../ui/tui/types.js').UiAPI} uiAPI
 * @returns {Promise<boolean>}
 */
export async function confirmMissingWorktreeRecreate(
    planName: string,
    worktreeContext: RecoveryWorktreeContext | null,
    uiAPI: UiAPI,
): Promise<boolean> {
    const path = worktreeContext?.path;
    uiAPI.appendSystemMessage(
        buildPlanRecoveryUserMessage({ kind: "recreate_warning", planName, ...(path ? { path } : {}) }),
        true,
        "RunWield",
    );
    const answer = await uiAPI.promptSelect("Recreate the worktree and start over?", [
        { value: "confirm", label: "Yes, create a new worktree and start over" },
        { value: "cancel", label: "Cancel" },
    ]);
    return answer === "confirm";
}

/**
 * @param {string} planName
 * @param {RecoveryWorktreeContext | null} worktreeContext
 * @param {import('../../ui/tui/types.js').UiAPI} uiAPI
 * @returns {Promise<boolean>}
 */
/**
 * @param {string} projectRoot
 * @param {string} planName
 * @param {RecoveryWorktreeContext | null} worktreeContext
 * @param {import('../../ui/tui/types.js').UiAPI} uiAPI
 * @returns {Promise<boolean>}
 */
export async function confirmRecoveryWorktreeAvailable(
    projectRoot: string,
    planName: string,
    worktreeContext: RecoveryWorktreeContext | null,
    uiAPI: UiAPI,
): Promise<boolean> {
    if (!hasWorktreeContext(worktreeContext)) return true;
    if (worktreeContext?.status === "abandoned") {
        uiAPI.appendSystemMessage(
            buildPlanRecoveryUserMessage({ kind: "worktree_abandoned", planName }),
            true,
            "RunWield",
        );
        return false;
    }
    if (!worktreeContext?.path) {
        uiAPI.appendSystemMessage(
            buildPlanRecoveryUserMessage({ kind: "worktree_path_missing", planName }),
            true,
            "RunWield",
        );
        return false;
    }
    if (!(await pathExists(worktreeContext.path))) {
        uiAPI.appendSystemMessage(
            buildPlanRecoveryUserMessage({ kind: "worktree_missing", planName, path: worktreeContext.path }),
            true,
            "RunWield",
        );
        return false;
    }
    try {
        const status = await getWorktreeStatus({
            projectRoot: projectRoot,
            path: worktreeContext.path,
            branch: worktreeContext.branch,
            baseTree: worktreeContext.executionBaselineTree || worktreeContext.baseTree || worktreeContext.baseCommit,
        });
        if (!status.exists) {
            uiAPI.appendSystemMessage(
                buildPlanRecoveryUserMessage({ kind: "worktree_missing", planName, path: worktreeContext.path }),
                true,
                "RunWield",
            );
            return false;
        }
        if (worktreeContext.branch && status.branch && status.branch !== worktreeContext.branch) {
            uiAPI.appendSystemMessage(
                buildPlanRecoveryUserMessage({ kind: "worktree_branch_changed", planName }),
                true,
                "RunWield",
            );
            return false;
        }
    } catch (error) {
        console.error("[RunWield] recovery_worktree_inspection_failed", error);
        uiAPI.appendSystemMessage(
            buildPlanRecoveryUserMessage({ kind: "worktree_inspection_failed", planName }),
            true,
            "RunWield",
        );
        return false;
    }
    return true;
}
