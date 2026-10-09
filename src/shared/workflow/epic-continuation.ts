import { projectPlanType } from "../project-plan.ts";
/**
 * @module shared/workflow/epic-continuation
 * Strict ordered continuation for child FEATURE plans inside PROJECT Epics.
 */

import {
    compareChildPlansByOrder,
    findPlansByParent,
    getDeclaredPlanStatus,
    listPlans,
    loadPlan,
    resolveSiblingChildPlanDependencyStates,
} from "../../plan-store.js";
import { AGENTS, isPlannedChangeClassification } from "../../constants.js";
import { recordPlanEvent } from "./plan-lifecycle.js";
import { executePlan, runPlanningAgent } from "./workflow.js";
import { decidePostExecution, decidePostPlanning } from "./decisions.ts";
import { buildTriageReport } from "./workflow-prompts.ts";
import { SYSTEM_SEMANTIC_REVIEW_PORT } from "./validation.ts";
import { continueWorkflowValidation } from "./validation-supervisor.ts";
import { emitSystemStatus } from "../session/session-runtime-events.js";
import { buildPlanSummary } from "../plan-presentation.ts";
import type { PlanFrontMatter } from "../../plan-store.js";
import type { HostedSession } from "../session/hosted-session.js";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { WorkflowValidationResult } from "./validation.ts";
import { createGitPort } from "../git-port.ts";
import { systemLocalCIPort } from "./validation-local-ci.ts";
import { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } from "../work-records/mnemoteca-port.ts";
import { isGitRepository } from "../git.ts";
import { findTargetBranchPlansByParent, preparePlanningWorktreeForPlan } from "./planning-worktree.ts";
import { ensureEpicBranch } from "./epic-branch.ts";
import { resolveWorkflowPlanLocation } from "./plan-location.ts";
import { resolvePrimaryCheckoutRoot } from "../primary-checkout.ts";

const TERMINAL_CHILD_STATUSES = new Set(["validated", "verified", "user_verified", "closed_without_verification"]);

/** A child Plan of the Epic being continued. */
export interface EpicContinuationChild {
    name: string;
    path: string;
    attrs: PlanFrontMatter;
}

/** What the Epic should do next, and why. */
export interface EpicContinuationResolution {
    kind: "none" | "blocked" | "plan" | "readiness_execute" | "execute";
    completedPlanName: string;
    parentPlanName?: string;
    childPlanName?: string;
    childStatus?: string;
    childSummary?: string;
    childAttrs?: PlanFrontMatter;
    reason?: string;
}

/** Whether these Front Matter attributes describe an Epic still doing work. */
function isActiveProjectEpic(attrs: PlanFrontMatter | undefined): boolean {
    if (attrs?.classification !== "PROJECT") return false;
    if (
        attrs.status === "on_hold" || attrs.status === "validated" || attrs.status === "verified" ||
        attrs.status === "user_verified" ||
        attrs.status === "closed_without_verification"
    ) {
        return false;
    }
    return attrs.epicCompletionMode !== "done_enough";
}

/** The continuation action a child Plan's status calls for, if any. */
function actionForStatus(status: string): EpicContinuationResolution["kind"] | null {
    if (status === "draft" || status === "feedback") return "plan";
    if (status === "approved") return "readiness_execute";
    if (status === "ready_for_work") return "execute";
    return null;
}

/** What `resolveEpicContinuation` needs to pick the next child. */
export interface ResolveEpicContinuationOptions {
    cwd: string;
    completedPlanName: string;
    completedStatus?: PlanFrontMatter["status"];
}

/** What `runEpicChildContinuation` needs to run the child it was given. */
export interface RunEpicChildContinuationOptions {
    hostedSession: HostedSession;
    resolution: EpicContinuationResolution;
    sessionManager?: SessionManager;
}

/**
 * Resolve the next child action after a verified child FEATURE completes.
 */
export async function resolveEpicContinuation(
    { cwd, completedPlanName, completedStatus: knownCompletedStatus }: ResolveEpicContinuationOptions,
): Promise<EpicContinuationResolution> {
    const completedLocation = await resolveWorkflowPlanLocation(cwd, completedPlanName);
    let completedAttrs = completedLocation.plan?.attrs;
    let completedDeclaredStatus = knownCompletedStatus ||
        (completedLocation.plan ? getDeclaredPlanStatus(completedLocation.plan.markdown) : undefined);
    if (!completedAttrs) {
        completedAttrs = (await listPlans(cwd)).find((plan) => plan.name === completedPlanName)?.attrs;
    }
    if (!completedAttrs) return { kind: "none", reason: "completed_plan_missing", completedPlanName };
    let parentPlanName = typeof completedAttrs.parentPlan === "string" ? completedAttrs.parentPlan.trim() : "";
    const completedTargetBranch = typeof completedAttrs.targetBranch === "string"
        ? completedAttrs.targetBranch.trim()
        : "";
    if (
        !TERMINAL_CHILD_STATUSES.has(completedDeclaredStatus || "") && parentPlanName && completedTargetBranch &&
        await isGitRepository(cwd)
    ) {
        const targetCompleted = (await findTargetBranchPlansByParent(cwd, completedTargetBranch, parentPlanName))
            .find((plan) =>
                plan.name === completedPlanName ||
                Boolean(completedAttrs?.planId && plan.attrs.planId === completedAttrs.planId)
            );
        if (targetCompleted) {
            completedAttrs = targetCompleted.attrs;
            completedDeclaredStatus = targetCompleted.attrs.status;
            parentPlanName = typeof completedAttrs.parentPlan === "string" ? completedAttrs.parentPlan.trim() : "";
        }
    }
    const completedStatus = (completedDeclaredStatus || completedAttrs.status) as PlanFrontMatter["status"];
    if (
        !isPlannedChangeClassification(completedAttrs.classification) ||
        !TERMINAL_CHILD_STATUSES.has(completedStatus)
    ) {
        return { kind: "none", reason: "completed_plan_not_completed_child_feature", completedPlanName };
    }
    if (!parentPlanName) return { kind: "none", reason: "completed_plan_has_no_parent_epic", completedPlanName };
    let parentLocation = await resolveWorkflowPlanLocation(cwd, parentPlanName);
    if (!parentLocation.plan && resolvePrimaryCheckoutRoot(cwd) !== cwd) {
        // A child's execution checkout is based on the Epic branch, which carries the children but not the Epic.
        parentLocation = await resolveWorkflowPlanLocation(resolvePrimaryCheckoutRoot(cwd), parentPlanName);
    }
    const parent = parentLocation.plan;
    if (!parent) return { kind: "none", reason: "parent_epic_missing", completedPlanName, parentPlanName };
    if (!isActiveProjectEpic(parent.attrs)) {
        return { kind: "none", reason: "parent_epic_not_active", completedPlanName, parentPlanName };
    }
    try {
        if (projectPlanType(parent.attrs) === "sequence" && parent.attrs.status !== "ready_for_work") {
            return { kind: "blocked", reason: "sequence_not_ready", completedPlanName, parentPlanName };
        }
    } catch {
        return { kind: "blocked", reason: "unsupported_project_type", completedPlanName, parentPlanName };
    }

    const targetBranch = typeof parent.attrs.targetBranch === "string" ? parent.attrs.targetBranch.trim() : "";
    const family = targetBranch && await isGitRepository(cwd)
        ? await findTargetBranchPlansByParent(cwd, targetBranch, parentPlanName)
        : await findPlansByParent(cwd, parentPlanName);
    const siblings = family.filter((plan) => isPlannedChangeClassification(plan.attrs.classification)).map((plan) =>
        plan.name === completedPlanName || Boolean(completedAttrs.planId && plan.attrs.planId === completedAttrs.planId)
            ? { ...plan, attrs: { ...plan.attrs, status: completedStatus } }
            : plan
    ).sort(compareChildPlansByOrder);
    const next = siblings.find((plan) => !TERMINAL_CHILD_STATUSES.has(plan.attrs.status));
    if (!next) return { kind: "none", reason: "no_remaining_children", completedPlanName, parentPlanName };

    const childPlanName = next.name;
    const childStatus = next.attrs.status;
    if (childStatus === "on_hold") {
        return {
            kind: "blocked",
            reason: "child_on_hold",
            completedPlanName,
            parentPlanName,
            childPlanName,
            childStatus,
        };
    }
    if (["in_progress", "failed", "implemented"].includes(childStatus)) {
        return {
            kind: "blocked",
            reason: "child_needs_recovery",
            completedPlanName,
            parentPlanName,
            childPlanName,
            childStatus,
        };
    }

    const dependencies = resolveSiblingChildPlanDependencyStates(
        parentPlanName,
        next.attrs.dependencies || [],
        siblings,
    );
    const unmet = dependencies.find((dependency) =>
        dependency.state !== "verified" && dependency.state !== "user_verified"
    );
    if (unmet) {
        return {
            kind: "blocked",
            reason: unmet.state === "missing" ? "dependency_missing" : "dependency_unverified",
            completedPlanName,
            parentPlanName,
            childPlanName,
            childStatus,
        };
    }

    const action = actionForStatus(childStatus);
    if (!action) {
        return {
            kind: "blocked",
            reason: "unsupported_child_status",
            completedPlanName,
            parentPlanName,
            childPlanName,
            childStatus,
        };
    }
    return {
        kind: action,
        completedPlanName,
        parentPlanName,
        childPlanName,
        childStatus,
        childSummary: next.attrs.summary || childPlanName,
        childAttrs: next.attrs,
    };
}

/** The prompt handed to the Planner when a child Plan is resumed. */
function buildResumeRequest(planName: string, attrs: PlanFrontMatter): string {
    return [
        `## Resuming Epic Child Plan: ${planName}`,
        "",
        `RunWield automatically selected docs/plans/${planName}.md from its parent Epic. Status: ${attrs.status}.`,
        "",
        buildTriageReport(attrs),
    ].join("\n");
}

/**
 * Show the next child Plan the same way the manual load flow does: a loading
 * notice followed by the Plan details summary. Returns the loaded Plan, or null
 * when the child Plan is missing.
 */
export async function presentEpicChildPlan(
    hostedSession: HostedSession,
    planName: string,
    cwd = hostedSession.cwd,
): Promise<Awaited<ReturnType<typeof loadPlan>> | null> {
    emitSystemStatus(hostedSession, `Loading Plan: ${planName}`, { header: "RunWield" });
    const plan = await loadPlan(cwd, planName);
    if (!plan) {
        emitSystemStatus(hostedSession, `Epic continuation stopped: child Plan not found: ${planName}`, {
            level: "warning",
            header: "RunWield",
        });
        return null;
    }
    emitSystemStatus(hostedSession, buildPlanSummary(plan), { header: "Plan" });
    return plan;
}

/**
 * Execute the resolved child workflow inside the supplied fresh HostedSession.
 */
export async function runEpicChildContinuation(
    { hostedSession, resolution, sessionManager }: RunEpicChildContinuationOptions,
): Promise<WorkflowValidationResult | null> {
    if (!["plan", "readiness_execute", "execute"].includes(resolution.kind) || !resolution.childPlanName) return null;
    const planName = resolution.childPlanName;
    let planRoot = hostedSession.cwd;
    if (
        resolution.childAttrs?.parentPlan && typeof resolution.childAttrs.targetBranch === "string" &&
        ["draft", "feedback", "approved", "ready_for_work"].includes(resolution.childAttrs.status) &&
        await isGitRepository(hostedSession.cwd)
    ) {
        await ensureEpicBranch(hostedSession.cwd, resolution.childAttrs.parentPlan);
        const planning = await preparePlanningWorktreeForPlan(hostedSession.cwd, planName, resolution.childAttrs);
        planRoot = planning.entry.path;
    }
    const plan = await presentEpicChildPlan(hostedSession, planName, planRoot);
    if (!plan) return null;

    if (resolution.kind === "plan") {
        const outcome = await runPlanningAgent({
            agentName: AGENTS.PLANNER,
            initialRequest: buildResumeRequest(planName, plan.attrs),
            triageMeta: plan.attrs,
            sessionManager,
            hostedSession,
            planName,
            cwd: planRoot,
        });
        const decision = decidePostPlanning(outcome, {
            planningAgentName: AGENTS.PLANNER,
            fallbackTriageMeta: plan.attrs,
        });
        if (decision.kind !== "execute_plan") return null;
    }

    if (resolution.kind === "readiness_execute") {
        await recordPlanEvent({
            cwd: planRoot,
            planName,
            event: "readiness_passed",
            currentStatus: "approved",
            details: { triageMeta: plan.attrs },
        });
        plan.attrs.status = "ready_for_work";
    }

    const executionResult = await executePlan({ planName, triageMeta: plan.attrs, sessionManager, hostedSession });
    const executionDecision = decidePostExecution(executionResult, {
        planName,
        triageMeta: plan.attrs,
        executionAgentName: hostedSession.getActiveExecutionWorkflow?.()?.executionAgent || AGENTS.ENGINEER,
    });
    if (executionDecision.kind !== "run_validation") return null;
    const latestPlan = await loadPlan(planRoot, planName);
    return /** @type {any} */ (await continueWorkflowValidation({
        hostedSession,
        planName,
        planContent: latestPlan?.markdown || plan.markdown || plan.body || "",
        triageMeta: latestPlan?.attrs || plan.attrs,
        sessionManager,
        finalAgentName: AGENTS.ROUTER,
        executionContext: executionResult.executionContext,
        git: createGitPort(),
        localCI: systemLocalCIPort,
        workRecordMnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
        semanticReviewPort: SYSTEM_SEMANTIC_REVIEW_PORT,
    }));
}
