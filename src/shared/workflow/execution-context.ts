import { effectiveDeliveryBranch } from "./plan-branch.ts";
/**
 * Fail-closed resolver for Workflow Validation execution context.
 */

import { isPlannedChangeClassification } from "../../constants.js";
import { loadPlan, normalizeExecutionMode, updatePlanFrontMatter } from "../../plan-store.js";
import {
    describeRegistryAmbiguity,
    findActiveByPlanName as findWorktreeRegistryEntryByPlanName,
    findById as findWorktreeRegistryEntryById,
    findByPlanId as findWorktreeRegistryEntryByPlanId,
    reconcileEntryGitLocation,
    restoreEntryFromPlanEvidence,
    updateEntry as updateWorktreeRegistryEntry,
} from "../worktree-registry.js";
import { prepareExecutionPlanFile } from "./execution-plan-file.js";
import { withProjectRuntimeReadScope } from "../project-runtime-layout.ts";
import { resolveTargetBranchName } from "../worktree.js";
import { getWorkflowDiff } from "./git-snapshot.ts";
import { recordWorkflowMetric } from "./metrics.js";
import { isInValidation } from "./plan-lifecycle.js";
import { hasImplementationDiff, requiresImplementationDiff } from "./validation-scope.ts";
import type { ValidationRecoveryNotice } from "./validation-user-messages.ts";

const VALIDATION_ELIGIBLE_WORKTREE_STATUSES = new Set([
    "active",
    "completed",
    "validation_failed",
    "validated",
]);

type PlanFrontMatter = import("../../plan-store.js").PlanFrontMatter;
type ResolutionSource = "explicit" | "active_session" | "durable_recovery";
type ScalarValue = string | number | boolean | null | undefined;
export interface ExecutionContextCandidate {
    planName?: string;
    projectRoot?: string;
    triageMeta?: Pick<PlanFrontMatter, "planId">;
    executionMode?: "worktree" | "non_git_in_place" | null;
    executionCwd?: string | null;
    baselineTree?: string | null;
    worktreeId?: string | null;
    worktreeBranch?: string | null;
    worktreeBaseBranch?: string | null;
    worktreeBaseRef?: string | null;
    worktreeBaseCommit?: string | null;
    nonGitInPlace?: boolean;
    baseCommit?: string;
    baseRef?: string;
}

export interface ResolvedWorktreeValidationContext {
    executionMode: "worktree";
    planName: string;
    projectRoot: string;
    executionCwd: string;
    baselineTree?: string;
    worktreeId?: string;
    worktreeBranch?: string;
    worktreeBaseBranch?: string;
    worktreeBaseRef?: string;
    worktreeBaseCommit?: string;
    worktreeBaseTree?: string;
    source: ResolutionSource;
}

export interface ResolvedNonGitValidationContext {
    executionMode: "non_git_in_place";
    planName: string;
    projectRoot: string;
    executionCwd: string;
    source: ResolutionSource;
}

export type ResolvedValidationContext = ResolvedWorktreeValidationContext | ResolvedNonGitValidationContext;

export interface BlockedValidationContext {
    kind: "blocked";
    reason: string;
    message: string;
}

export interface ValidationContextResolutionOk {
    kind: "ok";
    context: ResolvedValidationContext;
    persistedLegacyExecutionMode?: boolean;
    restoredPlanFile?: { relativePath: string };
    selfHealNotices?: ValidationRecoveryNotice[];
}

export type ValidationContextResolution = ValidationContextResolutionOk | BlockedValidationContext;

interface CandidateSelection {
    source: ResolutionSource;
    context: ExecutionContextCandidate | null;
}

interface ResolutionMetricOptions {
    cwd: string;
    planName: string;
    reason: string;
    recovered?: boolean;
    planFileRestored?: boolean;
}

export interface ResolveValidationExecutionContextOptions {
    projectRoot: string;
    planName: string;
    triageMeta?: Partial<PlanFrontMatter>;
    explicitContext?: ExecutionContextCandidate;
    activeWorkflow?: ExecutionContextCandidate | null;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
    const command = new Deno.Command("git", { cwd, args, stdout: "piped", stderr: "piped" });
    const output = await command.output();
    const stdout = new TextDecoder().decode(output.stdout).trim();
    const stderr = new TextDecoder().decode(output.stderr).trim();
    if (output.code !== 0) throw new Error(stderr || stdout || `git ${args.join(" ")} failed`);
    return stdout;
}

type AttachedWorktree = { path: string; head?: string; branch?: string };

async function listAttachedWorktrees(projectRoot: string): Promise<AttachedWorktree[]> {
    const output = await runGit(projectRoot, ["worktree", "list", "--porcelain"]);
    return output.trim().split(/\n\n+/).filter(Boolean).map((block) => {
        const fields = new Map(
            block.split("\n").map((line) => {
                const split = line.indexOf(" ");
                return split < 0 ? [line, ""] : [line.slice(0, split), line.slice(split + 1)];
            }),
        );
        const branchRef = fields.get("branch");
        return {
            path: fields.get("worktree") || "",
            ...(fields.get("HEAD") ? { head: fields.get("HEAD") } : {}),
            ...(branchRef?.startsWith("refs/heads/") ? { branch: branchRef.slice("refs/heads/".length) } : {}),
        };
    }).filter((entry) => entry.path.length > 0);
}

function isNonEmptyString(value: ScalarValue): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function asString(value: ScalarValue): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizePlanIdentity(value: ScalarValue): string {
    return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function planIdentityMatches(left: ScalarValue, right: ScalarValue): boolean {
    const normalizedLeft = normalizePlanIdentity(left);
    const normalizedRight = normalizePlanIdentity(right);
    return normalizedLeft.length > 0 && normalizedLeft === normalizedRight;
}

function blocked(reason: string, message: string): BlockedValidationContext {
    return { kind: "blocked", reason, message };
}

async function realPath(value: string | undefined): Promise<string | undefined> {
    if (!isNonEmptyString(value)) return undefined;
    try {
        return await Deno.realPath(String(value));
    } catch {
        return undefined;
    }
}

function selectCandidateContext(
    { explicitContext, activeWorkflow }: Pick<
        ResolveValidationExecutionContextOptions,
        "explicitContext" | "activeWorkflow"
    >,
): CandidateSelection {
    if (explicitContext?.planName) return { source: "explicit", context: explicitContext };
    if (activeWorkflow?.planName) return { source: "active_session", context: activeWorkflow };
    return { source: "durable_recovery", context: null };
}

async function recordResolutionMetric({
    cwd,
    planName,
    reason,
    recovered = false,
    planFileRestored = false,
}: ResolutionMetricOptions): Promise<void> {
    await recordWorkflowMetric({
        category: "validation",
        event: "execution_context_resolution",
        planName,
        details: { reason, recovered, planFileRestored },
    }, cwd).catch(() => {});
}

/** One validation context resolution verifies each checkout's runtime layout once. */
export async function resolveValidationExecutionContext(
    options: ResolveValidationExecutionContextOptions,
): Promise<ValidationContextResolution> {
    return await withProjectRuntimeReadScope(() => resolveValidationExecutionContextInScope(options));
}

async function resolveValidationExecutionContextInScope({
    projectRoot,
    planName,
    triageMeta = {},
    explicitContext,
    activeWorkflow,
}: ResolveValidationExecutionContextOptions): Promise<ValidationContextResolution> {
    const selected = selectCandidateContext({ explicitContext, activeWorkflow });
    const selectedExecutionCwd = selected.context?.executionMode === "worktree"
        ? asString(selected.context.executionCwd)
        : undefined;
    const executionPlan = selectedExecutionCwd
        ? await loadPlan(selectedExecutionCwd, planName).catch(() => null)
        : null;
    let plan;
    try {
        // Resolve the controller's directory before opening any primary Plan.
        // The identity/Git recovery below owns validation's legacy-ID repair.
        const recorded = await findWorktreeRegistryEntryByPlanName(projectRoot, planName);
        plan = (recorded ? await loadPlan(recorded.path, planName) : null) || executionPlan ||
            await loadPlan(projectRoot, planName);
    } catch (error) {
        const described = describeRegistryAmbiguity(error);
        if (!described) throw error;
        return blocked("worktree_registry_ambiguous", described);
    }
    let attrs = plan?.attrs || triageMeta || {};
    if (!plan && isPlannedChangeClassification(attrs.classification)) {
        await recordResolutionMetric({
            cwd: projectRoot,
            planName,
            reason: "missing_plan",
        });
        return blocked(
            "missing_plan",
            `Plan ${planName} could not be loaded; Workflow Validation requires a canonical implemented planned-change Plan.`,
        );
    }
    if (!isPlannedChangeClassification(attrs.classification)) {
        const directContext = explicitContext || activeWorkflow;
        const executionMode = directContext?.nonGitInPlace === true ||
                directContext?.executionMode === "non_git_in_place"
            ? "non_git_in_place"
            : "worktree";
        return {
            kind: "ok",
            context: {
                executionMode,
                planName,
                projectRoot,
                executionCwd: executionMode === "non_git_in_place"
                    ? projectRoot
                    : directContext?.executionCwd || projectRoot,
                baselineTree: executionMode === "worktree" ? asString(directContext?.baselineTree) : undefined,
                worktreeId: executionMode === "worktree" ? asString(directContext?.worktreeId) : undefined,
                worktreeBranch: executionMode === "worktree" ? asString(directContext?.worktreeBranch) : undefined,
                worktreeBaseBranch: executionMode === "worktree"
                    ? asString(directContext?.worktreeBaseBranch)
                    : undefined,
                worktreeBaseRef: executionMode === "worktree" ? asString(directContext?.worktreeBaseRef) : undefined,
                worktreeBaseCommit: executionMode === "worktree"
                    ? asString(directContext?.worktreeBaseCommit)
                    : undefined,
                source: explicitContext ? "explicit" : activeWorkflow?.planName ? "active_session" : "durable_recovery",
            },
        };
    }
    // Session and caller data fill only facts the durable records do not have.
    // Registry and Git facts below always override them, so stale process state
    // cannot veto a proven attempt.
    const candidate = selected.context || {};
    const candidateMode = candidate.nonGitInPlace === true ? "non_git_in_place" : candidate.executionMode;
    const normalizedCandidateMode = normalizeExecutionMode(candidateMode);
    const durableMode = normalizeExecutionMode(attrs.executionMode);
    const candidateWorktreeId = asString(attrs.worktreeId) || asString(candidate.worktreeId);
    const canonicalPlanId = asString(attrs.planId);
    let recoveredRegistryEntry: Awaited<ReturnType<typeof findWorktreeRegistryEntryById>>;
    try {
        recoveredRegistryEntry = candidateWorktreeId
            ? await findWorktreeRegistryEntryById(projectRoot, candidateWorktreeId)
            : null;
        if (!recoveredRegistryEntry && canonicalPlanId) {
            recoveredRegistryEntry = await findWorktreeRegistryEntryByPlanId(projectRoot, canonicalPlanId);
        }
        if (!recoveredRegistryEntry) {
            recoveredRegistryEntry = await findWorktreeRegistryEntryByPlanName(projectRoot, planName);
        }
    } catch (error) {
        // A damaged registry is RunWield's bookkeeping, not the user's mistake. Let it
        // block the operation, but as a blocked result carrying the commands that fix
        // it — an escaping exception here reached the user as a bare stack trace.
        const described = describeRegistryAmbiguity(error);
        if (!described) throw error;
        return blocked("worktree_registry_ambiguous", described);
    }
    const executionMode = durableMode || (recoveredRegistryEntry ? "worktree" : undefined) || normalizedCandidateMode;
    if (!executionMode) {
        const hasCompleteLegacyWorktree = attrs.worktreeId && attrs.worktreePath && attrs.worktreeBranch;
        if (!hasCompleteLegacyWorktree) {
            await recordResolutionMetric({
                cwd: projectRoot,
                planName,
                reason: "unknown_execution_mode",
            });
            return blocked(
                "unknown_execution_mode",
                `RunWield cannot tell where "${planName}" was implemented because the Plan has no execution mode and no recoverable worktree record. It will not validate the current checkout automatically, because that could mark unrelated changes as this Plan. Use /load-plan ${planName}, inspect the recovery report, then choose "Delete/recreate worktree and start over", "Reset tree and start over", or "Re-open for review".`,
            );
        }
    }

    if (executionMode === "non_git_in_place") {
        if (plan && !isInValidation(typeof attrs.status === "string" ? attrs.status : undefined)) {
            return blocked(
                "plan_not_implemented",
                `Plan ${planName} is ${
                    attrs.status || "unknown"
                }; Workflow Validation requires a validation lifecycle status.`,
            );
        }
        if (plan && attrs.executionMode !== "non_git_in_place" && selected.source !== "durable_recovery") {
            await updatePlanFrontMatter(
                projectRoot,
                planName,
                {
                    executionMode: "non_git_in_place",
                    deliveryEvidence: null,
                    validatedCommit: null,
                },
                attrs,
                { expectedRevision: plan.revision },
            );
        }
        await recordResolutionMetric({
            cwd: projectRoot,
            planName,
            reason: selected.source,
            recovered: selected.source === "durable_recovery",
        });
        return {
            kind: "ok",
            context: {
                executionMode: "non_git_in_place",
                planName,
                projectRoot,
                executionCwd: projectRoot,
                source: selected.source,
            },
            persistedLegacyExecutionMode: attrs.executionMode !== "non_git_in_place",
        };
    }

    const candidateWorktreePath = asString(candidate.executionCwd) && candidate.executionCwd !== projectRoot
        ? asString(candidate.executionCwd)
        : undefined;
    const recordedWorktreePath = asString(attrs.worktreePath);
    const worktreeId = asString(recoveredRegistryEntry?.id) || candidateWorktreeId;
    const worktreePath = asString(recoveredRegistryEntry?.path) || candidateWorktreePath || recordedWorktreePath;
    const worktreeBranch = asString(recoveredRegistryEntry?.branch) || asString(candidate.worktreeBranch) ||
        asString(attrs.worktreeBranch);
    let worktreeBaseBranch = asString(recoveredRegistryEntry?.baseBranch) ||
        asString(candidate.worktreeBaseBranch) || asString(attrs.worktreeBaseBranch);
    let baselineTree = asString(recoveredRegistryEntry?.executionBaselineTree) ||
        asString(recoveredRegistryEntry?.baseTree) ||
        asString(candidate.baselineTree) || asString(attrs.executionBaselineTree);
    if (!worktreeId || !worktreePath || !worktreeBranch || !worktreeBaseBranch) {
        await recordResolutionMetric({
            cwd: projectRoot,
            planName,
            reason: "incomplete_worktree_identity",
        });
        return blocked(
            "incomplete_worktree_identity",
            `RunWield found that "${planName}" should validate from a worktree, but the recorded worktree identity is incomplete. Use /load-plan ${planName}, inspect the recovery report, then choose "Delete/recreate worktree and start over" or "Re-open for review".`,
        );
    }
    let attachedWorktrees: AttachedWorktree[];
    try {
        attachedWorktrees = await listAttachedWorktrees(projectRoot);
    } catch {
        return blocked(
            "worktree_inspection_failed",
            "Git could not verify the recorded execution worktree. Recovery was left unchanged.",
        );
    }
    const primaryPath = await realPath(attachedWorktrees[0]?.path);
    const recordedPath = await realPath(worktreePath);
    const branchCheckout = attachedWorktrees.find((entry) => entry.branch === worktreeBranch);
    if (primaryPath && (recordedPath === primaryPath || await realPath(branchCheckout?.path) === primaryPath)) {
        return blocked(
            "primary_checkout_is_not_execution_worktree",
            "Recovery cannot use the primary checkout as an execution worktree. Its branch and files were left unchanged.",
        );
    }
    const authoritativePlan = await loadPlan(worktreePath, planName).catch(() => null);
    if (authoritativePlan) {
        plan = authoritativePlan;
        attrs = authoritativePlan.attrs;
    }
    if (plan && !isInValidation(typeof attrs.status === "string" ? attrs.status : undefined)) {
        return blocked(
            "plan_not_implemented",
            `Plan ${planName} is ${
                attrs.status || "unknown"
            }; Workflow Validation requires a validation lifecycle status.`,
        );
    }
    if (candidate.planName && !planIdentityMatches(candidate.planName, planName)) {
        return blocked("plan_name_mismatch", `Execution context belongs to ${candidate.planName}, not ${planName}.`);
    }
    const selfHealNotices: ValidationRecoveryNotice[] = [];
    if (attrs.planId && candidate.triageMeta?.planId && attrs.planId !== candidate.triageMeta.planId) {
        // The Plan name already matched above, which binds this context to this Plan.
        // A differing id therefore means the id was minted twice, not that two
        // different Plans met, so the canonical Plan's id wins and validation
        // continues. `attrs` is what flows downstream, and the session-scoped triage
        // copy is not durable state, so nothing is written and nothing is lost.
        // Blocking here stranded Plans at "implemented" over metadata RunWield owns.
        selfHealNotices.push({ kind: "session_plan_fixed", planName });
    }
    let registryEntry = recoveredRegistryEntry || await findWorktreeRegistryEntryById(projectRoot, worktreeId);
    if (!registryEntry) {
        const restored = await restoreEntryFromPlanEvidence(projectRoot, {
            id: worktreeId,
            planName,
            planId: canonicalPlanId || "",
            baseBranch: worktreeBaseBranch,
            baseRef: asString(candidate.worktreeBaseRef),
            baseCommit: asString(candidate.worktreeBaseCommit),
            executionBaselineTree: baselineTree,
            branch: worktreeBranch,
            path: worktreePath,
            status: "completed",
        });
        if (restored.restored && restored.entry) {
            registryEntry = restored.entry;
            selfHealNotices.push({ kind: "worktree_record_rebuilt", planName });
        } else {
            return blocked(
                "missing_registry_entry",
                `RunWield has worktree metadata for "${planName}", but registry entry ${worktreeId} is missing. Use /load-plan ${planName}, inspect the recovery report, then choose "Restore worktree record and continue", "Delete/recreate worktree and start over", or "Re-open for review". Restore was not automatic: ${
                    restored.reason || "evidence did not agree"
                }.`,
            );
        }
    }
    if (!planIdentityMatches(registryEntry.planName, planName)) {
        return blocked(
            "registry_plan_mismatch",
            `Worktree registry entry ${worktreeId} belongs to ${registryEntry.planName}.`,
        );
    }
    if (!VALIDATION_ELIGIBLE_WORKTREE_STATUSES.has(registryEntry.status)) {
        return blocked(
            "registry_status_not_validation_eligible",
            `Worktree registry entry ${worktreeId} is ${registryEntry.status}, not validation-eligible.`,
        );
    }
    if (!baselineTree) baselineTree = asString(registryEntry.executionBaselineTree) || asString(registryEntry.baseTree);
    const candidateBaseCommit = asString(registryEntry.baseCommit) || asString(candidate.worktreeBaseCommit) ||
        asString(candidate.baseCommit);
    const candidateBaseRef = asString(registryEntry.baseRef) || asString(candidate.worktreeBaseRef) ||
        asString(candidate.baseRef);
    if (!baselineTree) {
        const baselineRef = candidateBaseCommit || asString(registryEntry.baseCommit) || candidateBaseRef ||
            asString(registryEntry.baseRef);
        if (baselineRef) {
            baselineTree = await runGit(projectRoot, ["rev-parse", `${baselineRef}^{tree}`]);
        }
    }
    if (!baselineTree) {
        await recordResolutionMetric({
            cwd: projectRoot,
            planName,
            reason: "incomplete_worktree_identity",
        });
        return blocked(
            "incomplete_worktree_identity",
            `RunWield found the worktree for "${planName}", but it cannot recover the execution baseline needed for validation. Use /load-plan ${planName}, inspect the recovery report, then choose "Delete/recreate worktree and start over" or "Re-open for review".`,
        );
    }
    const attachedForBranch = attachedWorktrees.filter((entry) => entry.branch === worktreeBranch);
    let canonicalRegistryPath = await realPath(registryEntry.path);
    let canonicalWorktreePath = await realPath(worktreePath);
    if (attachedForBranch.length === 1) {
        const gitPath = await realPath(attachedForBranch[0].path);
        if (gitPath && (!canonicalRegistryPath || canonicalRegistryPath !== gitPath)) {
            registryEntry = await reconcileEntryGitLocation(projectRoot, worktreeId, {
                path: attachedForBranch[0].path,
                branch: worktreeBranch,
            });
            canonicalRegistryPath = gitPath;
            canonicalWorktreePath = gitPath;
            selfHealNotices.push({ kind: "worktree_path_fixed", planName });
        }
    }
    if (!canonicalRegistryPath && !canonicalWorktreePath) {
        let branchExists = await runGit(projectRoot, ["rev-parse", "--verify", `refs/heads/${worktreeBranch}`])
            .then(() => true)
            .catch(() => false);
        if (!branchExists) {
            const staleRecord = attachedWorktrees.find((entry) =>
                entry.path === registryEntry.path || entry.branch === worktreeBranch
            );
            if (staleRecord?.head) {
                await runGit(projectRoot, ["rev-parse", "--verify", `${staleRecord.head}^{commit}`]);
                await runGit(projectRoot, ["worktree", "prune"]);
                await runGit(projectRoot, ["branch", worktreeBranch, staleRecord.head]);
                branchExists = true;
                selfHealNotices.push({ kind: "branch_restored", branch: worktreeBranch });
            }
        }
        if (branchExists) {
            // The folder is derived from the branch. Pruning an absent worktree's
            // Git admin record removes no files and lets Git attach it again.
            await runGit(projectRoot, ["worktree", "prune"]);
            await runGit(projectRoot, ["worktree", "add", registryEntry.path, worktreeBranch]);
            canonicalRegistryPath = await realPath(registryEntry.path);
            canonicalWorktreePath = canonicalRegistryPath;
            selfHealNotices.push({ kind: "worktree_restored", planName, branch: worktreeBranch });
        }
    }
    if (!canonicalRegistryPath || !canonicalWorktreePath || canonicalRegistryPath !== canonicalWorktreePath) {
        return blocked(
            "worktree_path_mismatch",
            `The saved worktree path is not ready. RunWield kept all files.`,
        );
    }
    const projectCommonDir = await runGit(projectRoot, ["rev-parse", "--git-common-dir"]);
    const worktreeCommonDir = await runGit(canonicalWorktreePath, ["rev-parse", "--git-common-dir"]);
    const projectCommonReal = await realPath(
        projectCommonDir.startsWith("/") ? projectCommonDir : `${projectRoot}/${projectCommonDir}`,
    );
    const worktreeCommonReal = await realPath(
        worktreeCommonDir.startsWith("/") ? worktreeCommonDir : `${canonicalWorktreePath}/${worktreeCommonDir}`,
    );
    if (!projectCommonReal || !worktreeCommonReal || projectCommonReal !== worktreeCommonReal) {
        return blocked(
            "git_common_dir_mismatch",
            `Execution worktree ${worktreeId} is not attached to the Project repository.`,
        );
    }
    let checkedOutBranch = await runGit(canonicalWorktreePath, ["branch", "--show-current"]);
    const recordedBranchExists = await runGit(projectRoot, ["rev-parse", "--verify", `refs/heads/${worktreeBranch}`])
        .then(() => true)
        .catch(() => false);
    if (!recordedBranchExists) {
        await runGit(canonicalWorktreePath, ["switch", "-c", worktreeBranch]);
        checkedOutBranch = worktreeBranch;
        selfHealNotices.push({ kind: "branch_restored", branch: worktreeBranch });
    }
    if (checkedOutBranch !== worktreeBranch) {
        return blocked(
            "worktree_branch_mismatch",
            `Execution worktree is on ${checkedOutBranch || "detached HEAD"}, not ${worktreeBranch}.`,
        );
    }
    // The registry describes where execution started. The freshly loaded Plan
    // owns where it will be delivered; session snapshots cannot override an edit.
    const requestedTarget = effectiveDeliveryBranch(attrs);
    if (requestedTarget) {
        try {
            worktreeBaseBranch = await resolveTargetBranchName(projectRoot, requestedTarget);
        } catch (error) {
            return blocked("invalid_target_branch", error instanceof Error ? error.message : String(error));
        }
    }
    const targetBranchExists = await runGit(projectRoot, ["rev-parse", `refs/heads/${worktreeBaseBranch}`])
        .then(() => true)
        .catch(() => false);
    if (!targetBranchExists) {
        return blocked(
            "missing_target_branch",
            `Target branch ${worktreeBaseBranch} is missing. Restore or create that branch, then run validation again.`,
        );
    }
    const actualBaselineTree = await runGit(canonicalWorktreePath, ["rev-parse", `${baselineTree}^{tree}`]);
    if (!actualBaselineTree) {
        return blocked(
            "baseline_tree_mismatch",
            `Execution baseline tree for ${planName} is not valid in this repository.`,
        );
    }
    baselineTree = actualBaselineTree;

    const worktreeBaseTree = asString(registryEntry.baseTree);
    if (
        worktreeBaseTree && worktreeBaseTree !== baselineTree && requiresImplementationDiff(attrs) &&
        !hasImplementationDiff(await getWorkflowDiff(canonicalWorktreePath, baselineTree), planName) &&
        hasImplementationDiff(await getWorkflowDiff(canonicalWorktreePath, worktreeBaseTree), planName)
    ) {
        // The attempt's creation tree is durable Git evidence. If the newer saved
        // baseline hides all implementation work but the creation tree proves it,
        // a resume accidentally replaced the review range. Repair that owned state
        // instead of asking the user to reconstruct internal metadata.
        baselineTree = worktreeBaseTree;
        await updateWorktreeRegistryEntry(projectRoot, worktreeId, {
            executionBaselineTree: worktreeBaseTree,
        });
        selfHealNotices.push({ kind: "review_range_fixed", planName });
    }

    const planFile = await prepareExecutionPlanFile({
        projectRoot,
        executionCwd: canonicalWorktreePath,
        planName,
        executionAuthoritative: true,
    });
    if (planFile.kind !== "present" && planFile.kind !== "restored" && planFile.kind !== "reconciled") {
        return blocked(
            `execution_plan_${planFile.kind}`,
            `Execution worktree Plan file ${planFile.relativePath} is not usable: ${planFile.reason || planFile.kind}`,
        );
    }
    const restoredPlanFile = planFile.kind === "restored" ? { relativePath: planFile.relativePath } : undefined;
    if (planFile.healedPlanId) {
        selfHealNotices.push({ kind: "execution_plan_fixed", planName });
    }

    let persistedLegacyExecutionMode = false;
    const currentExecutionPlan = await loadPlan(canonicalWorktreePath, planName);
    if (currentExecutionPlan) {
        const ownedRepairs: Partial<PlanFrontMatter> = {};
        if (registryEntry.planId && currentExecutionPlan.attrs.planId !== registryEntry.planId) {
            ownedRepairs.planId = registryEntry.planId;
            selfHealNotices.push({ kind: "execution_plan_fixed", planName });
        }
        if (currentExecutionPlan.attrs.status !== "validated" && !currentExecutionPlan.attrs.worktreeId) {
            ownedRepairs.worktreeId = worktreeId;
        }
        if (Object.keys(ownedRepairs).length > 0) {
            await updatePlanFrontMatter(canonicalWorktreePath, planName, ownedRepairs, currentExecutionPlan.attrs, {
                expectedRevision: currentExecutionPlan.revision,
            });
        }
        persistedLegacyExecutionMode = currentExecutionPlan.attrs.executionMode !== "worktree";
    }
    await recordResolutionMetric({
        cwd: projectRoot,
        planName,
        reason: selected.source,
        recovered: selected.source === "durable_recovery",
        planFileRestored: Boolean(restoredPlanFile),
    });
    return {
        kind: "ok",
        context: {
            executionMode: "worktree",
            planName,
            projectRoot,
            executionCwd: canonicalWorktreePath,
            baselineTree,
            worktreeId,
            worktreeBranch,
            worktreeBaseBranch,
            worktreeBaseRef: candidateBaseRef,
            worktreeBaseCommit: candidateBaseCommit,
            worktreeBaseTree,
            source: selected.source,
        },
        persistedLegacyExecutionMode,
        restoredPlanFile,
        ...(selfHealNotices.length > 0 ? { selfHealNotices } : {}),
    };
}
