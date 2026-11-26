import {
    capturePlanAccess,
    capturePlanExecutionContext,
    hasCanonicalPlanAccess,
    planDocumentsForCheckout,
    selectPlanAccess,
    withPlanAccess,
} from "../../src/plan-store/index.ts";
import type { HostedSession } from "../../src/shared/session/hosted-session.ts";
import { findActiveByPlanName, findById } from "../../src/shared/worktree-registry.ts";
import { projects } from "@runwield/projects";
import { resolveExecutionOwner } from "../../src/shared/workflow/execution-collaboration.ts";
import { finalizePlanImplementation, type PlanImplementationResult } from "./implementation-checkpoint.ts";
import type { ActiveExecutionWorkflow } from "./state.ts";
import type { WorkflowLocation } from "./index.ts";

/** Carries the implementation report and optional revision checks for the Plan and its body. */
export interface ImplementationCompletion {
    executionReport?: string;
    expectedPlanRevision?: string;
    expectedPlanBodyRevision?: string;
}

/** Identifies the attempt to reopen and the host session to acknowledge on completion. */
export interface ResumeAttemptOptions {
    attemptId?: string;
    hostedSession?: HostedSession;
}

/** Binds completion to the execution context captured when this attempt started or resumed. */
export interface WorkflowAttempt {
    /** Read a detached snapshot of the bound execution context. */
    readonly state: Readonly<ActiveExecutionWorkflow>;
    /** Checkpoint implementation for this attempt. Replaying a settled completion returns its recorded result. */
    acceptCompletion(report: ImplementationCompletion): Promise<PlanImplementationResult>;
}

export function bindAttempt(
    location: WorkflowLocation,
    state: ActiveExecutionWorkflow,
    hostedSession?: HostedSession,
): WorkflowAttempt {
    const executionContext = structuredClone(state);
    return {
        get state() {
            return structuredClone(executionContext);
        },
        acceptCompletion(report) {
            return finalizePlanImplementation({
                ...report,
                projectRoot: location.cwd,
                planName: location.planName,
                expectedPlanId: location.planId,
                triageMeta: executionContext.triageMeta,
                executionContext,
                hostedSession,
            });
        },
    };
}

export async function resumeAttempt(
    location: WorkflowLocation,
    { attemptId, hostedSession }: ResumeAttemptOptions,
): Promise<WorkflowAttempt> {
    const { cwd, planName, planId } = location;
    if (!capturePlanAccess()) {
        const selection = await selectPlanAccess(cwd, planName, planId);
        if (selection)
            return await withPlanAccess(
                cwd,
                selection,
                () => resumeAttempt(location, { attemptId, hostedSession }),
                planName,
            );
    }

    const projectRoot = projects.checkout.primaryRoot(cwd);
    const entry = attemptId
        ? await findById(projectRoot, attemptId)
        : await findActiveByPlanName(projectRoot, planName);
    if (
        entry &&
        (entry.planName !== planName ||
            (planId && entry.planId !== planId) ||
            entry.status === "planning" ||
            entry.status === "abandoned")
    ) {
        throw new Error("The recorded execution attempt changed.");
    }
    const executionCwd = entry?.path ?? projectRoot;
    const loadPlan = () => planDocumentsForCheckout(executionCwd).load(planName);
    const plan = entry ? await loadPlan().catch(() => null) : await loadPlan();
    if (planId && plan?.attrs.planId && plan.attrs.planId !== planId)
        throw new Error("Workflow belongs to a different Plan.");
    const retained = hasCanonicalPlanAccess() ? await capturePlanExecutionContext(planName) : undefined;
    if (attemptId && retained && retained.packageAttemptId !== attemptId)
        throw new Error("The recorded execution attempt changed.");
    if (entry && retained && entry.id !== retained.packageAttemptId)
        throw new Error("The recorded execution attempt changed.");
    if (!entry && (plan?.attrs.executionMode !== "non_git_in_place" || (attemptId && !retained))) {
        throw new Error(`Cannot complete ${planName}: durable execution context is missing.`);
    }

    const triageMeta = plan?.attrs ?? (entry?.planId ? { planId: entry.planId } : {});
    return bindAttempt(
        location,
        {
            planName,
            projectRoot,
            executionCwd,
            triageMeta,
            executionAgent: resolveExecutionOwner(triageMeta),
            ...retained,
            ...(entry
                ? {
                      executionMode: "worktree" as const,
                      baselineTree: entry.executionBaselineTree || entry.baseTree,
                      worktreeId: entry.id,
                      worktreeBranch: entry.branch,
                      worktreeBaseBranch: entry.baseBranch,
                      worktreeBaseRef: entry.baseRef,
                      worktreeBaseCommit: entry.baseCommit,
                  }
                : {
                      executionMode: "non_git_in_place" as const,
                      nonGitInPlace: true,
                  }),
        },
        hostedSession,
    );
}
