/** Engine-owned persistence and identity for host waits. No alternate validation loop. */
import { buildValidationRepairPrompt } from "./validation-repair-prompt.ts";
import { buildDiffInspectionSection } from "./review-diff.ts";
import { readSemanticRound, recordLifecycleEvent } from "./validation-context.ts";
import { loadPlan, updatePlanFrontMatter } from "../../plan-store.js";
import { semanticReviewMode } from "./validation-types.ts";
import type { PhaseContext, ValidationLoopArgs } from "./validation-types.ts";
import { readValidationReviewState, type ValidationCheckpoint } from "./validation-checkpoint.ts";
import { ValidationHostRejected, ValidationHostWait } from "./validation-host-contract.ts";
import type { ValidationHostResume } from "./validation-host-contract.ts";
import type { TriageMeta } from "./validation-types.ts";
import type { ValidationHostRequest } from "./validation-host-contract.ts";

export async function saveHostCheckpoint(
    args: ValidationLoopArgs,
    patch: Partial<ValidationCheckpoint>,
): Promise<void> {
    const cwd = args.session.getActiveWorkflow()?.executionCwd || args.session.cwd;
    const plan = await loadPlan(cwd, args.planName);
    if (!plan?.attrs.validationCheckpoint) throw new Error("Validation checkpoint is missing.");
    const checkpoint = { ...plan.attrs.validationCheckpoint, ...patch };
    await updatePlanFrontMatter(cwd, args.planName, { validationCheckpoint: checkpoint }, plan.attrs, {
        expectedRevision: plan.revision,
        expectedControllerRevision: plan.controllerRevision,
    });
    args.validationCheckpoint = checkpoint;
}

export function rejectHostResume(): never {
    throw new ValidationHostRejected();
}

export async function requestHostRepair(
    args: ValidationLoopArgs,
    context: PhaseContext,
    prompt: string,
    repairKind: string,
    failureReason?: string,
): Promise<never> {
    const checkpoint = args.validationCheckpoint || args.triageMeta.validationCheckpoint;
    if (!checkpoint) throw new Error("Validation checkpoint is missing.");
    const repairGeneration = repairKind === "semantic" ? checkpoint.repairGeneration! : crypto.randomUUID();
    const request: Extract<ValidationHostRequest, { kind: "repair" }> = {
        kind: "repair",
        identity: { attemptId: checkpoint.attemptId, generation: checkpoint.generation, repairGeneration },
        repairGeneration,
        prompt,
        cwd: context.executionCwd,
        role: "reviewer-feedback-engineer",
    };
    const repairCheckpoint: ValidationCheckpoint = {
        ...checkpoint,
        state: "awaiting_repair",
        nextPhase: "mechanical",
        expectedStatus: "implemented",
        repairGeneration,
        repairKind,
        repairCompletedOperationId: undefined,
        pendingRepair: request,
        pendingCiDecision: undefined,
        pendingHostDecision: undefined,
        hostDecisionChoices: undefined,
    };
    if (failureReason !== undefined) {
        await recordLifecycleEvent(
            args,
            context.projectRoot,
            "validation_failed",
            args.triageMeta.status === "implemented" ? "implemented" : "validated_ci",
            failureReason,
            { validationCheckpoint: repairCheckpoint },
        );
        args.validationCheckpoint = repairCheckpoint;
    } else await saveHostCheckpoint(args, repairCheckpoint);
    throw new ValidationHostWait(request);
}

/** Check caller claims before context recovery can publish diagnostics or lifecycle effects. */
export async function validateHostReviewerResume(args: ValidationLoopArgs): Promise<void> {
    const resume = args.hostTurn?.resume;
    if (resume?.kind !== "reviewer" || args.hostTurn?.consumed) return;
    const workflow = args.session.getActiveWorkflow();
    const checkpoint = args.validationCheckpoint;
    if (!workflow?.executionCwd || !workflow.worktreeBaseBranch || !checkpoint) rejectHostResume();
    await assertHostReviewerCandidate({
        cwd: workflow.executionCwd,
        baseBranch: workflow.worktreeBaseBranch,
        checkpoint,
        triageMeta: args.triageMeta,
        resume,
    });
}

export interface HostReviewerCandidateArgs {
    cwd: string;
    baseBranch: string;
    checkpoint: ValidationCheckpoint;
    triageMeta: TriageMeta;
    resume: Extract<ValidationHostResume, { kind: "reviewer" }>;
}

/** Read-only shared preflight, before a carrier persists a stale reviewer claim. */
export async function assertHostReviewerCandidate(args: HostReviewerCandidateArgs): Promise<void> {
    const { getWorktreeReviewDiff, getWorkflowDiff } = await import("./git-snapshot.ts");
    const { parseDiffFiles } = await import("./review-diff.ts");
    const { ReviewInspection } = await import("./review-inspection.ts");
    const { sameHostIdentity } = await import("./validation-host-contract.ts");
    const fullDiff = await getWorktreeReviewDiff(args.cwd, args.baseBranch);
    const checkpoint = args.checkpoint;
    const resume = args.resume;
    const durableReview = readValidationReviewState(checkpoint);
    const baseline = durableReview?.repairBaselineTree || "";
    const repairDiff = baseline ? await getWorkflowDiff(args.cwd, baseline) : "";
    const round = (durableReview?.semanticRound || readSemanticRound(args.triageMeta)) + 1;
    const mode = semanticReviewMode(round);
    const count = checkpoint.hostReview?.semanticRound === round ? checkpoint.hostReview.correctionCount : 0;
    const identity = await hostReviewerIdentity(checkpoint, round, mode, count, fullDiff, repairDiff);
    if (!sameHostIdentity(identity, resume.identity)) rejectHostResume();
    const scope = mode === "discovery" ? "full" : "repair";
    try {
        ReviewInspection.fromRecorded(
            parseDiffFiles(scope === "full" ? fullDiff : repairDiff).map((file) => ({
                scope,
                path: file.path,
                byteLength: file.byteLength,
            })),
            scope,
            resume.coverage,
        );
    } catch (error) {
        throw new ValidationHostRejected(
            `Review is incomplete. ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

export async function hostReviewerIdentity(
    checkpoint: ValidationCheckpoint,
    semanticRound: number,
    reviewMode: "discovery" | "verify",
    correctionCount: number,
    fullDiff: string,
    repairDiff: string,
) {
    const bytes = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify([fullDiff, repairDiff])),
    );
    const diffHash = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return {
        attemptId: checkpoint.attemptId,
        generation: checkpoint.generation,
        semanticRound,
        reviewMode,
        correctionCount,
        diffHash,
    };
}

/** The existing semantic handoff's repair prompt, for both a new and a reclaimed wait. */
export function hostSemanticRepairPrompt(context: PhaseContext, diffText: string, findingsSection: string): string {
    return buildValidationRepairPrompt({
        executionCwd: context.executionCwd,
        repairCwd: context.executionCwd,
        worktreeId: context.worktreeId,
        worktreeBranch: context.worktreeBranch,
        worktreeBaseBranch: context.worktreeBaseBranch,
        authorityNote: "A code reviewer found these issues. Fix every finding.",
        repairsNeeded: ["### Findings", "", findingsSection, "", buildDiffInspectionSection(diffText)].join("\n"),
        completionInstruction:
            "Report a disposition for every finding, then call task_completed. If a finding is still open because something blocked you, stop in plain text instead and name it.",
    });
}
