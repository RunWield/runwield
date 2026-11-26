import { plans, type PlanStatus } from "@runwield/plans";
import type { HostTurnValidationResult, ValidationHostResume } from "./host-contract.ts";
import type { ResumeAttemptOptions, WorkflowAttempt } from "./attempt.ts";
import type { WorkflowProgress } from "./progress.ts";
import type { ExecutionStartOptions } from "../../src/shared/workflow/execution-start.ts";

export { readWorkflowActivity, type WorkflowActivity } from "./activity.ts";
export type { ActiveExecutionWorkflow } from "./state.ts";
export type { ImplementationCompletion, WorkflowAttempt, ResumeAttemptOptions } from "./attempt.ts";
export type { PlanImplementationResult } from "./implementation-checkpoint.ts";

/** Selects a Plan in its launch checkout. Supplying its stable ID guards against reopening a different Plan. */
export interface WorkflowLocation {
    cwd: string;
    planName: string;
    planId?: string;
}

/** Carries the host session and collaboration preferences into execution. */
export interface StartWorkflowOptions {
    hostedSession?: ExecutionStartOptions["hostedSession"];
    collaborationStyle?: "autonomous" | "pair";
    collaborationRecommendation?: "autonomous" | "pair";
}

type HostInteractionAnswer = Extract<ValidationHostResume, { kind: "decision" }>;
type HostValidationReport = Exclude<ValidationHostResume, HostInteractionAnswer>;

export type { WorkflowProgress, WorkflowValidationProgress } from "./progress.ts";

/** Reports the Plan status, when available, and whether execution can start or resume. */
export interface WorkflowPreparation {
    status?: PlanStatus;
    admission: "ready" | "resume" | "unavailable";
}

/** Controls execution and host-driven validation for one selected Plan. */
export interface Workflow {
    /** Check whether the Plan can start or resume without starting an attempt. */
    reconcilePreparation(): Promise<WorkflowPreparation>;
    /** Start execution or rejoin the active attempt and return a handle bound to it. */
    startOrResume(options?: StartWorkflowOptions): Promise<WorkflowAttempt>;
    /** Reopen a recorded attempt from storage. A supplied attempt ID must match. */
    resumeAttempt(options?: ResumeAttemptOptions): Promise<WorkflowAttempt>;
    /** Read the current attempt, pending host action, and publication status. Returns undefined if the Plan is missing. */
    readProgress(): Promise<WorkflowProgress | undefined>;
    /** Run validation from its checkpoint until it needs host input, finishes, pauses, or fails. */
    advanceHostValidation(options?: { signal?: AbortSignal }): Promise<HostTurnValidationResult>;
    /** Apply a reviewer, repair, or recorder report to its matching request and continue validation. */
    continueHostValidation(
        report: HostValidationReport,
        options?: { signal?: AbortSignal },
    ): Promise<HostTurnValidationResult>;
    /** Apply the user's answer to the matching pending decision and continue validation. */
    answerInteraction(
        answer: HostInteractionAnswer,
        options?: { signal?: AbortSignal },
    ): Promise<HostTurnValidationResult>;
    /** Throw if the reviewer report no longer matches the candidate under review. */
    checkHostReviewerCandidate(report: Extract<ValidationHostResume, { kind: "reviewer" }>): Promise<void>;
    /** After a restart, return the saved response to replay, or undefined if the checkpoint has moved past it. */
    reconcileHostResume(resume: ValidationHostResume): Promise<ValidationHostResume | undefined>;
}

/** Bind operations to one Plan in its launch checkout. Each call uses the current owner's durable evidence. */
export function openWorkflow({ cwd, planName, planId: requestedPlanId }: WorkflowLocation): Workflow {
    const planId = plans.identity.parse(requestedPlanId);
    if (requestedPlanId !== undefined && (!planId || planId !== requestedPlanId))
        throw new Error("Invalid workflow Plan ID.");
    const location = { cwd, planName, planId };

    async function advanceHostValidation(resume: ValidationHostResume | undefined, signal?: AbortSignal) {
        const { continueHostTurnValidation } = await import("./host-turn.ts");
        return await continueHostTurnValidation({ projectRoot: cwd, planName, expectedPlanId: planId, resume, signal });
    }
    return {
        async reconcilePreparation() {
            const { reconcileExecutionPreparationLocation } =
                await import("../../src/shared/workflow/execution-start.ts");
            const source = await reconcileExecutionPreparationLocation(cwd, planName, {
                readOnly: true,
                expectedPlanId: planId,
            });
            const attrs = source.plan?.attrs;
            if (planId && attrs && attrs.planId !== planId) throw new Error("Workflow belongs to a different Plan.");
            if (!attrs) return { admission: "unavailable" };
            const status = attrs.status;
            if (status === "approved" || status === "ready_for_work") return { status, admission: "ready" };
            if (status !== "in_progress") return { status, admission: "unavailable" };
            const { listEntries } = await import("../../src/shared/worktree-registry.ts");
            const canonical = "packageSelection" in source && source.packageSelection;
            const active = (await listEntries(cwd)).some(
                (entry) =>
                    entry.planId === attrs.planId &&
                    entry.status === "active" &&
                    (canonical ? entry.id === attrs.worktreeId : entry.path === source.documentRoot),
            );
            if (active) return { status, admission: "resume" };
            const { hasNonGitExecutionConsent } = await import("../../src/shared/non-git-execution-consent.ts");
            const inPlace = attrs.executionMode === "non_git_in_place" && hasNonGitExecutionConsent("featurePlan", cwd);
            return { status, admission: inPlace ? "resume" : "unavailable" };
        },
        async startOrResume(options = {}) {
            // A failed save can tear down the session while the import is pending.
            options.hostedSession?.getManagedOperationCapability()?.assertLive();
            const { createExecutionStartPorts, startActiveExecutionWorkflow } =
                await import("../../src/shared/workflow/execution-start.ts");
            const state = await startActiveExecutionWorkflow({
                ...options,
                cwd,
                planName,
                expectedPlanId: planId,
                ports: createExecutionStartPorts(),
            });
            const { bindAttempt } = await import("./attempt.ts");
            return bindAttempt(location, state, options.hostedSession);
        },
        async resumeAttempt(options = {}) {
            const { resumeAttempt } = await import("./attempt.ts");
            return await resumeAttempt(location, options);
        },
        async readProgress() {
            const { readWorkflowProgress } = await import("./progress.ts");
            return await readWorkflowProgress(location);
        },
        advanceHostValidation: (options) => advanceHostValidation(undefined, options?.signal),
        continueHostValidation: (report, options) => advanceHostValidation(report, options?.signal),
        answerInteraction: (answer, options) => advanceHostValidation(answer, options?.signal),
        async checkHostReviewerCandidate(report) {
            const { assertCurrentHostReviewerCandidate } = await import("./host-turn.ts");
            return await assertCurrentHostReviewerCandidate(cwd, planName, report, planId);
        },
        async reconcileHostResume(resume) {
            const { reconcileConsumedHostResume } = await import("./host-turn.ts");
            return await reconcileConsumedHostResume(cwd, planName, resume, planId);
        },
    };
}
