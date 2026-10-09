import { recordDeliveryEvidence } from "./delivery-evidence.ts";
/**
 * @module shared/workflow/validation-mechanical
 * Repository CI and the repair loop that returns failures to the execution Agent.
 */

import { AGENTS } from "../../constants.js";
import { loadPlan } from "../../plan-store.js";
import type { AgentTurnOutcome, ValidationLocalCIResult } from "./validation-ports.ts";
import type { PhaseContext, UserActionPause, ValidationLoopArgs, ValidationPhaseResult } from "./validation-types.ts";
import {
    getProjectRoot,
    preserveValidationContinuationState,
    readCiAttempts,
    readSemanticRound,
    recordLifecycleEvent,
    recordMetric,
    resolvePhaseContext,
} from "./validation-context.ts";
import { CI_REPAIR_CYCLES, type UserActionOption } from "./validation-types.ts";
import { clampCycle, emitProgress, emitStatus, repairBlockedReason } from "./validation-emit.ts";
import { pauseForUserAction, requestInteraction } from "./validation-interactions.ts";
import { ValidationInteractionTypes } from "./validation-ports.ts";
import { buildValidationRepairPrompt } from "./validation-repair-prompt.ts";
import { buildValidationUserMessage } from "./validation-user-messages.ts";
import {
    decideValidationRecovery,
    readValidationRetryPolicy,
    recordOperationalRecoveryMetric,
    waitForValidationRetryWithSessionCancellation,
} from "./validation-recovery.ts";

const ENGINEER_FOLLOW_UP_OPTIONS: UserActionOption[] = [
    { value: "engineer_follow_up", label: "Engineer follow-up" },
    { value: "retry", label: "Retry" },
    { value: "stop", label: "Stop" },
];

function adoptRecordedPlanState(
    args: ValidationLoopArgs,
    context: PhaseContext,
    attrs: Awaited<ReturnType<typeof recordLifecycleEvent>>,
): void {
    args.triageMeta = attrs as ValidationLoopArgs["triageMeta"];
    context.workflowBase.triageMeta = args.triageMeta;
    const activeWorkflow = args.session.getActiveWorkflow();
    if (activeWorkflow?.planName === args.planName) {
        args.session.setActiveWorkflow({ ...activeWorkflow, triageMeta: args.triageMeta });
    }
}

function pausedResult(args: ValidationLoopArgs, context: PhaseContext, reason: string): ValidationPhaseResult {
    return { kind: "paused", planName: args.planName, projectRoot: context.projectRoot, reason };
}

async function handleMechanicalOperationalFailure(
    args: ValidationLoopArgs,
    context: PhaseContext,
    ciResult: Extract<ValidationLocalCIResult, { kind: "operational_failure" }>,
    operationalAttempt: number,
): Promise<{ kind: "retry" } | { kind: "done"; result: ValidationPhaseResult }> {
    const decision = decideValidationRecovery({
        failure: ciResult.failure,
        attempt: operationalAttempt,
        policy: readValidationRetryPolicy(context.projectRoot),
        nextPhase: "mechanical",
    });
    await recordOperationalRecoveryMetric(args, context.projectRoot, decision.result);
    emitStatus(args, decision.result.message, decision.action === "halt" ? "error" : "warning");
    if (decision.action === "retry") {
        const wait = await waitForValidationRetryWithSessionCancellation(args, decision.delayMs, "mechanical");
        if (wait === "completed") return { kind: "retry" };
        return {
            kind: "done",
            result: pausedResult(
                args,
                context,
                "Validation retry was canceled. Run this Plan again when you are ready.",
            ),
        };
    }
    return {
        kind: "done",
        result: {
            kind: decision.action === "halt" ? "failed" : "paused",
            planName: args.planName,
            projectRoot: context.projectRoot,
            reason: decision.result.message,
            recovery: decision.result,
        },
    };
}

async function requestEngineerFollowUpFeedback(
    args: ValidationLoopArgs,
    prompt: string,
    defaultValue: string,
): Promise<string | null> {
    const response = await requestInteraction(args, { type: ValidationInteractionTypes.TEXT, prompt, defaultValue });
    if (response.outcome !== "text") return null;
    return typeof response.value === "string" && response.value.trim() ? response.value.trim() : defaultValue;
}

async function continueLastRepairSession(args: ValidationLoopArgs, prompt: string, defaultValue: string) {
    const feedback = await requestEngineerFollowUpFeedback(args, prompt, defaultValue);
    if (feedback === null) return null;
    return await args.session.continueLastRepairTurn(feedback);
}

async function reloadValidationPlanSnapshot(args: ValidationLoopArgs): Promise<ValidationPhaseResult | null> {
    const projectRoot = getProjectRoot(args);
    const activeWorkflow = args.session.getActiveWorkflow();
    const planCwd = activeWorkflow?.executionMode === "worktree" && activeWorkflow.executionCwd
        ? activeWorkflow.executionCwd
        : args.executionContext?.executionMode === "worktree" && args.executionContext.executionCwd
        ? args.executionContext.executionCwd
        : projectRoot;
    const plan = await loadPlan(planCwd, args.planName);
    if (!plan) {
        const message = buildValidationUserMessage({
            kind: "user_action",
            whatHappened: `The Plan "${args.planName}" is missing.`,
            doThis: "Restore it before retrying validation.",
        });
        emitStatus(args, message, "error");
        return { kind: "failed", planName: args.planName, projectRoot, reason: message };
    }
    args.triageMeta = plan.attrs as ValidationLoopArgs["triageMeta"];
    args.validationCheckpoint = plan.attrs.validationCheckpoint || undefined;
    args.planContent = plan.markdown;
    return null;
}

export async function runMechanicalValidationPhase(args: ValidationLoopArgs): Promise<ValidationPhaseResult> {
    let ciAttempts = readCiAttempts(args.triageMeta);
    let operationalAttempts = 0;
    for (;;) {
        const reloadFailure = await reloadValidationPlanSnapshot(args);
        if (reloadFailure) return reloadFailure;
        const phase = await resolvePhaseContext(args);
        if (phase.kind === "blocked") return phase.result;
        ciAttempts = readCiAttempts(args.triageMeta);

        emitProgress(
            args,
            buildValidationUserMessage({ kind: "ci_running", cwd: phase.context.executionCwd }),
            "info",
            {
                outcome: "running",
                stage: "ci",
                repairAttempt: ciAttempts > 0 ? clampCycle(ciAttempts, CI_REPAIR_CYCLES) : null,
                maxRepairAttempts: ciAttempts > 0 ? CI_REPAIR_CYCLES : null,
                checks: { ci: "running" },
            },
        );
        const ciResult = await args.localCI.run({ cwd: phase.context.executionCwd });
        await recordDeliveryEvidence(
            phase.context.projectRoot,
            args.planName,
            phase.context.worktreeId || "in-place",
            "ci",
            ciResult.kind === "completed" ? `Exit ${ciResult.exitCode}` : ciResult.kind,
            ciResult.output ? "````text\n" + ciResult.output + "\n````" : "No command output recorded.",
        );
        if (ciResult.kind === "operational_failure") {
            operationalAttempts += 1;
            const recovery = await handleMechanicalOperationalFailure(
                args,
                phase.context,
                ciResult,
                operationalAttempts,
            );
            if (recovery.kind === "retry") continue;
            return recovery.result;
        }
        operationalAttempts = 0;
        await recordMetric(args, phase.context.projectRoot, {
            category: "validation",
            event: "ci_attempt",
            planName: args.planName,
            details: {
                semanticRound: readSemanticRound(args.triageMeta) + 1,
                mechanicalAttempt: ciAttempts + 1,
                exitCode: ciResult.kind === "completed" ? ciResult.exitCode : 130,
                passed: ciResult.kind === "completed" && ciResult.exitCode === 0,
                canceled: ciResult.kind === "canceled",
            },
        });

        if (ciResult.kind === "canceled") {
            const pause: UserActionPause = {
                whatHappened:
                    `The tests for "${args.planName}" were stopped before they finished, so RunWield cannot tell yet whether the work is good.`,
                doThis: `Pick Engineer follow-up to return to the ${
                    args.session.getAgentDisplayName(phase.context.executionAgent, phase.context.projectRoot)
                } session, Retry to run them again now, or Stop to come back to this later.`,
                options: ENGINEER_FOLLOW_UP_OPTIONS,
            };
            const action = await pauseForUserAction(args, pause);
            if (action === "retry") continue;
            if (action === "engineer_follow_up") {
                return pauseForEngineerFollowUp(args, phase.context, pause.whatHappened);
            }
            return pausedResult(args, phase.context, `${pause.whatHappened} Run this Plan again when you are ready.`);
        }

        if (ciResult.exitCode === 0) {
            await recordLifecycleEvent(args, phase.context.projectRoot, "mechanical_validation_passed", "implemented");
            preserveValidationContinuationState(args, phase.context);
            emitProgress(args, buildValidationUserMessage({ kind: "checks_passed" }), "success", {
                stage: "cycle",
                checks: { ci: "passed" },
            });
            return {
                kind: "paused",
                planName: args.planName,
                projectRoot: phase.context.projectRoot,
                reason: "Mechanical Validation passed.",
                continueValidation: true,
            };
        }

        const failureReason = getCiFailureReason(ciResult);
        if (ciAttempts >= CI_REPAIR_CYCLES) {
            const pause: UserActionPause = {
                whatHappened: `The tests for "${args.planName}" are still failing. ${
                    args.session.getAgentDisplayName(AGENTS.REVIEWER_FEEDBACK_ENGINEER, phase.context.projectRoot)
                } tried ${CI_REPAIR_CYCLES} times and could not get them passing.`,
                doThis:
                    "Pick Engineer follow-up to reopen the last repair session, Retry only after you fixed the tests outside RunWield, or Stop to come back to this later.",
                details: [failureReason],
                options: ENGINEER_FOLLOW_UP_OPTIONS,
            };
            const action = await pauseForUserAction(args, pause);
            if (action === "retry") {
                continue;
            }
            if (action === "engineer_follow_up") {
                const followUp = await continueLastRepairSession(
                    args,
                    "Tell the Validation Repair Engineer what to try next.",
                    failureReason,
                );
                if (followUp?.completed) continue;
                return pausedResult(
                    args,
                    phase.context,
                    repairBlockedReason(args, phase.context.projectRoot, followUp?.blockerText),
                );
            }
            return {
                kind: "paused",
                planName: args.planName,
                projectRoot: phase.context.projectRoot,
                reason: `${pause.whatHappened} ${pause.doThis}`,
            };
        }
        const attrs = await recordLifecycleEvent(
            args,
            phase.context.projectRoot,
            "mechanical_validation_failed",
            "implemented",
            failureReason,
            { mechanicalFailureKind: "ci", validationCheckpoint: args.validationCheckpoint },
        );
        adoptRecordedPlanState(args, phase.context, attrs);
        const repair = await dispatchCiRepair(args, phase.context, ciResult);
        if (!repair.completed) {
            const reason = repairBlockedReason(args, phase.context.projectRoot, repair.blockerText);
            emitStatus(
                args,
                buildValidationUserMessage({
                    kind: "user_action",
                    whatHappened: reason,
                    doThis: "Clear the blocker, then continue the repair. Validation resumes when it reports complete.",
                }),
                "warning",
            );
            return {
                kind: "paused",
                planName: args.planName,
                projectRoot: phase.context.projectRoot,
                reason,
                awaitingTaskCompletion: true,
            };
        }
    }
}

function pauseForEngineerFollowUp(
    args: ValidationLoopArgs,
    context: PhaseContext,
    reason: string,
): ValidationPhaseResult {
    args.session.setActiveWorkflow({ ...context.workflowBase });
    emitStatus(
        args,
        buildValidationUserMessage({
            kind: "engineer_follow_up",
            agent: args.session.getAgentDisplayName(AGENTS.REVIEWER_FEEDBACK_ENGINEER, context.projectRoot),
        }),
        "warning",
    );
    return {
        kind: "paused",
        planName: args.planName,
        projectRoot: context.projectRoot,
        reason: `Mechanical Validation paused for ${
            args.session.getAgentDisplayName(context.executionAgent, context.projectRoot)
        } follow-up. ${reason}`,
        awaitingTaskCompletion: true,
    };
}

export async function dispatchCiRepair(
    args: ValidationLoopArgs,
    context: PhaseContext,
    ciResult: ValidationLocalCIResult,
): Promise<AgentTurnOutcome> {
    args.session.setActiveWorkflow({ ...context.workflowBase });
    emitProgress(
        args,
        buildValidationUserMessage({
            kind: "ci_repair",
            agent: args.session.getAgentDisplayName(AGENTS.REVIEWER_FEEDBACK_ENGINEER, context.projectRoot),
        }),
        "warning",
        { outcome: "running", stage: "engineer_repair", checks: { ci: "failed" } },
    );
    await recordDeliveryEvidence(
        context.projectRoot,
        args.planName,
        context.worktreeId || "in-place",
        "ci-repair",
        "Started",
    );
    const outcome = await args.session.runIndependentRepairTurn({
        kind: "validation",
        agentName: AGENTS.REVIEWER_FEEDBACK_ENGINEER,
        userRequest: buildValidationRepairPrompt({
            executionCwd: context.executionCwd,
            repairCwd: context.executionCwd,
            worktreeId: context.worktreeId,
            worktreeBranch: context.worktreeBranch,
            worktreeBaseBranch: context.worktreeBaseBranch,
            repairsNeeded:
                "The project failed CI validation. The failing command is configured in this repair checkout's `.wld/settings.json` as `verification_command`. " +
                "On a new project, that command can be the thing that is broken. Inspect `.wld/settings.json`; correct the command or implementation as needed. " +
                "Run focused checks for the reported failure before you call `task_completed`. Run the full configured command only when needed to diagnose the failure or explicitly requested by the user. " +
                "RunWield will independently reload `.wld/settings.json` and run the complete command after Task Completion; report that full validation as pending. " +
                "If the repair involves tests, follow the write-tests skill for sound testing behavior.\n\n" +
                getCiFailureReason(ciResult),
        }),
        cwd: context.executionCwd,
    });
    return outcome;
}

export function getCiFailureReason(ciResult: ValidationLocalCIResult): string {
    if (ciResult.kind === "completed") return ciResult.output || "Mechanical Validation failed.";
    if (ciResult.kind === "canceled") return "Mechanical Validation was canceled.";
    return ciResult.failure.message;
}
