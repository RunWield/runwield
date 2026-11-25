import { plans, type PlanStatus } from "@runwield/plans";
import type { HostTurnValidationResult, ValidationHostResume } from "./host-contract.ts";
import type { ResumeAttemptOptions, WorkflowAttempt } from "./attempt.ts";
import type { WorkflowProgress } from "./progress.ts";

export { readWorkflowActivity, type WorkflowActivity } from "./activity.ts";
export type { ActiveExecutionWorkflow } from "./state.ts";
export type { ImplementationCompletion, WorkflowAttempt, ResumeAttemptOptions } from "./attempt.ts";
export type { PlanImplementationResult } from "./implementation-checkpoint.ts";

export interface WorkflowLocation {
    cwd: string;
    planName: string;
    planId?: string;
}

export interface StartWorkflowOptions {
    hostedSession?: import("../../src/shared/session/hosted-session.ts").HostedSession;
    collaborationStyle?: "autonomous" | "pair";
    collaborationRecommendation?: "autonomous" | "pair";
}

type HostInteractionAnswer = Extract<ValidationHostResume, { kind: "decision" }>;
type HostValidationReport = Exclude<ValidationHostResume, HostInteractionAnswer>;

export type { WorkflowProgress, WorkflowValidationProgress } from "./progress.ts";

export interface WorkflowPreparation {
    status?: PlanStatus;
    admission: "ready" | "resume" | "unavailable";
}

export interface Workflow {
    reconcilePreparation(): Promise<WorkflowPreparation>;
    startOrResume(options?: StartWorkflowOptions): Promise<WorkflowAttempt>;
    resumeAttempt(options?: ResumeAttemptOptions): Promise<WorkflowAttempt>;
    readProgress(): Promise<WorkflowProgress | undefined>;
    advanceHostValidation(options?: { signal?: AbortSignal }): Promise<HostTurnValidationResult>;
    continueHostValidation(
        report: HostValidationReport,
        options?: { signal?: AbortSignal },
    ): Promise<HostTurnValidationResult>;
    answerInteraction(
        answer: HostInteractionAnswer,
        options?: { signal?: AbortSignal },
    ): Promise<HostTurnValidationResult>;
    checkHostReviewerCandidate(report: Extract<ValidationHostResume, { kind: "reviewer" }>): Promise<void>;
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
