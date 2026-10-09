/**
 * @module shared/workflow/validation-emit
 * Status and progress-panel emission for the session-independent engine.
 *
 * The engine's only window onto the progress panel is the port: it reads the
 * current record, patches it, and hands it back through {@link emitStatus}. The
 * record type is engine-owned (`ValidationProgressRecord`), so the patch/complete
 * helpers live here rather than in the session-coupled `validation-progress.ts`,
 * which the adapter calls with the real session.
 */

import type { ValidationCheckResult, ValidationCheckResults, ValidationProgressRecord } from "./validation-ports.ts";
import type { ValidationLoopArgs } from "./validation-types.ts";
import { SEMANTIC_REVIEW_CYCLES } from "./validation-types.ts";
import { readCiAttempts, readSemanticRound } from "./validation-context.ts";
import { AGENTS } from "../../constants.js";
import { buildValidationUserMessage } from "./validation-user-messages.ts";

/**
 * The pause text for a repair turn that stopped on a blocker instead of
 * reporting completion. The repair Agent's own words are the account of what
 * stopped it, so they travel with the pause.
 */
export function repairBlockedReason(args: ValidationLoopArgs, projectRoot: string, blockerText?: string): string {
    return buildValidationUserMessage({
        kind: "repair_blocked",
        agent: args.session.getAgentDisplayName(AGENTS.REVIEWER_FEEDBACK_ENGINEER, projectRoot),
        blockerText,
    });
}

/** Fields accepted when building a progress record from scratch. */
export type ValidationProgressInput =
    & Omit<Partial<ValidationProgressRecord>, "checks">
    & { checks?: Partial<ValidationCheckResults> };

/**
 * Fields accepted when amending a record. `null` clears a counter, which is how a
 * terminal update drops cycle numbers that no longer mean anything.
 */
export type ValidationProgressPatch =
    & Omit<
        Partial<ValidationProgressRecord>,
        "checks" | "cycle" | "maxCycles" | "totalCycle" | "repairAttempt" | "maxRepairAttempts" | "message"
    >
    & {
        checks?: Partial<ValidationCheckResults>;
        cycle?: number | null;
        maxCycles?: number | null;
        totalCycle?: number | null;
        repairAttempt?: number | null;
        maxRepairAttempts?: number | null;
        message?: string | null;
    };

const CLEARABLE_COUNTERS = ["cycle", "maxCycles", "totalCycle", "repairAttempt", "maxRepairAttempts"] as const;
const CHECK_KEYS = ["ci", "semanticReview", "humanReview", "merge"] as const;

export function createProgressRecord(values: ValidationProgressInput): ValidationProgressRecord {
    return {
        kind: values.kind || "workflow",
        outcome: values.outcome || "running",
        stage: values.stage || "cycle",
        checks: {
            ci: values.checks?.ci || "pending",
            semanticReview: values.checks?.semanticReview || "pending",
            humanReview: values.checks?.humanReview || "pending",
            merge: values.checks?.merge || "pending",
        },
        ...(values.cycle ? { cycle: values.cycle } : {}),
        ...(values.maxCycles ? { maxCycles: values.maxCycles } : {}),
        ...(values.kind === "workflow"
            ? { totalCycle: values.totalCycle || values.cycle || 1 }
            : values.totalCycle
            ? { totalCycle: values.totalCycle }
            : {}),
        ...(values.repairAttempt ? { repairAttempt: values.repairAttempt } : {}),
        ...(values.maxRepairAttempts ? { maxRepairAttempts: values.maxRepairAttempts } : {}),
        ...(values.message ? { message: values.message } : {}),
        ...(values.deliveryReport ? { deliveryReport: values.deliveryReport } : {}),
        ...(values.workRecordPlanName ? { workRecordPlanName: values.workRecordPlanName } : {}),
        ...(values.workRecordFailed !== undefined ? { workRecordFailed: values.workRecordFailed } : {}),
    };
}

export function updateProgressRecord(
    progress: ValidationProgressRecord,
    patch: ValidationProgressPatch,
): ValidationProgressRecord {
    const next = createProgressRecord({
        ...progress,
        ...patch,
        checks: { ...progress.checks, ...(patch.checks || {}) },
    } as ValidationProgressInput);
    for (const field of CLEARABLE_COUNTERS) {
        if (patch[field] === null) delete next[field];
    }
    if (!Object.hasOwn(patch, "message") || patch.message === null) delete next.message;
    return next;
}

/**
 * Close a progress record out.
 *
 * Checks still `pending` were never reached, so they report `skipped`. A check
 * still `running` when validation ended is the interesting case: on success it was
 * abandoned harmlessly, but on failure it is what stopped, so it reports `failed`.
 */
export function completeProgressRecord(
    progress: ValidationProgressRecord,
    passed: boolean,
    message: string,
): ValidationProgressRecord {
    const terminalChecks: Record<string, ValidationCheckResult> = { ...progress.checks };
    for (const key of CHECK_KEYS) {
        if (terminalChecks[key] === "pending") terminalChecks[key] = "skipped";
        else if (terminalChecks[key] === "running") terminalChecks[key] = passed ? "skipped" : "failed";
    }
    return updateProgressRecord(progress, {
        outcome: passed ? "verified" : "failed",
        stage: "terminal",
        checks: terminalChecks as ValidationCheckResults,
        message,
        repairAttempt: progress.repairAttempt || null,
        maxRepairAttempts: progress.maxRepairAttempts || null,
    });
}

/**
 * Keep the displayed round inside the advertised limit.
 *
 * A Retry hands out a fresh set of rounds without resetting how many have run, so
 * the raw count legitimately passes the maximum; showing "round 4/3" would just
 * look broken. The total is what carries the real number.
 */
export function clampCycle(cycle: number, maximum = SEMANTIC_REVIEW_CYCLES): number {
    return Math.min(Math.max(1, cycle), maximum);
}

/**
 * Where a run picks up when nothing is held in memory.
 *
 * Status is the right answer for exactly this moment and no other: a fresh call
 * knows only what the Plan durably records, so the checks already behind the
 * current status are marked passed and the rest are left pending.
 */
export function seedProgressForStatus(args: ValidationLoopArgs): ValidationProgressRecord {
    const status = args.triageMeta.status;
    const semanticDone = status === "reviewed";
    const ciDone = semanticDone || status === "validated_ci" ||
        (status === "implemented" && args.triageMeta.validationPhase === "semantic");
    const rounds = readSemanticRound(args.triageMeta);
    return createProgressRecord({
        kind: "workflow",
        outcome: "running",
        // Deliberately neutral. A stage has to agree with its own check — naming
        // `semantic_review` before the reviewer has started is rejected outright —
        // so the seed only says which checks are already behind us, and the first
        // real emit of a phase names the stage as it begins.
        stage: "cycle",
        cycle: clampCycle(rounds + 1),
        maxCycles: SEMANTIC_REVIEW_CYCLES,
        // Rounds and repairs both count as passes through the loop, so a user Retry
        // that resets the round counter still reads as forward motion rather than
        // starting over at one.
        totalCycle: rounds + readCiAttempts(args.triageMeta) + 1,
        checks: {
            ci: ciDone ? "passed" : "pending",
            semanticReview: semanticDone ? "passed" : ciDone ? "running" : "pending",
            humanReview: semanticDone ? "running" : "pending",
            merge: "pending",
        },
    });
}

/**
 * Say something to the user, carrying the validation panel with it.
 *
 * Every line the loop emits goes through here, and every one of them re-sends the
 * progress the session is currently holding. That is what keeps the panel pinned
 * for the whole run rather than only on the lines that happen to change a stage.
 */
export function emitStatus(
    args: ValidationLoopArgs,
    message: string,
    level: "info" | "success" | "warning" | "error" = "info",
    progress?: ValidationProgressRecord,
): void {
    args.session.emitStatus(message, level, progress);
}

/**
 * Move the loop's position and announce it.
 *
 * The patch applies to wherever the session already is, so checks accumulate
 * across phases within a run. On a cold start there is nothing to patch and the
 * position is seeded from the Plan's status by {@link seedProgressForStatus}.
 */
export function emitProgress(
    args: ValidationLoopArgs,
    message: string,
    level: "info" | "success" | "warning" | "error",
    patch: ValidationProgressPatch,
): void {
    const current = args.session.getCurrentProgress() || seedProgressForStatus(args);
    const next = updateProgressRecord(current, patch);
    // The total counts passes through the loop, so it can never sit below the round
    // it is qualifying. Rounds advance within a run while the total was seeded once
    // from durable counters, which is how the panel came to read "round 2/3 (total 1)".
    const total = Math.max(next.totalCycle || 0, next.cycle || 0, current.totalCycle || 0);
    emitStatus(args, message, level, total > 0 ? { ...next, totalCycle: total } : next);
}

/**
 * Close the panel out on a run that stopped.
 *
 * Terminal outcomes have to be internally consistent — no check left pending, none
 * left running — which is what {@link completeProgressRecord} settles. Patching
 * `outcome: "failed"` directly leaves the record contradicting itself and the event
 * is rejected, taking the whole halt path down with it.
 */
export function emitHalted(args: ValidationLoopArgs, message: string, reason: string): void {
    args.session.clearPosition(args.planName);
    const current = args.session.getCurrentProgress() || seedProgressForStatus(args);
    // A failed run has to name what failed. Checks caught mid-flight settle to
    // `failed` on their own; a halt that lands before anything started has nothing
    // to settle, and CI is the gate it never got through.
    const settled = Object.values(current.checks).some((check) => check === "running" || check === "failed")
        ? current
        : updateProgressRecord(current, { checks: { ci: "failed" } });
    emitStatus(args, message, "error", completeProgressRecord(settled, false, reason));
}
