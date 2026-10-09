/**
 * @module shared/workflow/validation-progress
 * The Workflow Validation progress record and the status line that carries it.
 *
 * Progress is attached to every status message rather than emitted separately, so
 * the UI never has to correlate two streams to know which cycle a line belongs to.
 */

import { emitSystemStatus } from "../session/session-runtime-events.js";
import type { HostedSession } from "../session/hosted-session.js";
import type {
    RuntimeValidationCheckResult,
    RuntimeValidationCheckResults,
    RuntimeValidationProgress,
} from "../session/session-runtime-events.js";
import type { TransitionResult } from "./state-transition.ts";

/** Fields accepted when building a progress record from scratch. */
export type ValidationProgressInput =
    & Omit<Partial<RuntimeValidationProgress>, "checks">
    & { checks?: Partial<RuntimeValidationCheckResults> };

/**
 * Fields accepted when amending a record. `null` clears a counter, which is how a
 * terminal update drops cycle numbers that no longer mean anything.
 */
export type ValidationProgressPatch =
    & Omit<
        Partial<RuntimeValidationProgress>,
        "checks" | "cycle" | "maxCycles" | "totalCycle" | "repairAttempt" | "maxRepairAttempts" | "message"
    >
    & {
        checks?: Partial<RuntimeValidationCheckResults>;
        cycle?: number | null;
        maxCycles?: number | null;
        totalCycle?: number | null;
        repairAttempt?: number | null;
        maxRepairAttempts?: number | null;
        message?: string | null;
    };

const CLEARABLE_COUNTERS = ["cycle", "maxCycles", "totalCycle", "repairAttempt", "maxRepairAttempts"] as const;
const CHECK_KEYS = ["ci", "semanticReview", "humanReview", "merge"] as const;

/**
 * The last progress seen for a session, so a plain status line still carries it.
 *
 * Keyed weakly on the session object: progress is per-run UI state and must not
 * keep a finished session alive.
 */
const CURRENT_VALIDATION_PROGRESS = new WeakMap<object, RuntimeValidationProgress>();

/**
 * Attach an unrecorded-outcome note to a halt reason.
 *
 * A halt reason is what the user reads and what the Plan's failure reason keeps.
 * If RunWield also failed to write that outcome down, saying only why the work
 * stopped would imply the Plan reflects it.
 */
export function appendUnsettledNote(reason: string, unsettledNote: string): string {
    return unsettledNote ? `${reason} ${unsettledNote}` : reason;
}

/**
 * Explain a transition that could not be recorded, in terms of what it means for
 * the Plan the user is looking at.
 *
 * The distinction that matters: the repository change already happened — the merge
 * really did fail — but the Plan may still read `implemented` with no reason
 * attached. That gap is RunWield's own bookkeeping, so it must be stated plainly
 * with the commands that resolve it, never left as a one-line warning the user is
 * expected to decode.
 */
export function describeUnsettledTransition(transition: TransitionResult, intent: string): string {
    const commands = (transition.recoveryActions || [])
        .map((action) => action.command)
        .filter((command, index, all) => command && all.indexOf(command) === index);
    return [
        `RunWield could not record ${intent}: ${transition.message}`,
        "The repository change already happened; only RunWield's record of it is behind, so the Plan may still show " +
        "its previous status until this is resolved.",
        ...(commands.length > 0 ? [`Resolve it with: ${commands.join("  or  ")}`] : []),
    ].join(" ");
}

/**
 * The progress this session is currently showing, if any.
 *
 * This is the loop's memory of where it is. Plan status only has three values and
 * a phase re-derives from it on a cold start, but while a run is in flight the
 * stage, the round and the per-check verdicts live here — a status of
 * `implemented` cannot say whether CI is running, failed, or waiting on a repair.
 */
export function getCurrentValidationProgress(
    hostedSession: HostedSession | undefined,
): RuntimeValidationProgress | undefined {
    return hostedSession ? CURRENT_VALIDATION_PROGRESS.get(hostedSession) : undefined;
}

/**
 * Remember a progress record for a session without emitting a status line.
 *
 * Used by the validation session adapter to implement the port's
 * `setCurrentProgress`; records written this way came from the engine's own
 * update chain and were validated at the emit boundary on their way in.
 */
export function setCurrentValidationProgress(
    hostedSession: HostedSession | undefined,
    progress: RuntimeValidationProgress | undefined,
): void {
    if (hostedSession && progress) CURRENT_VALIDATION_PROGRESS.set(hostedSession, progress);
}

export function emitRunWieldSystemStatus(
    hostedSession: HostedSession | undefined,
    text: string,
    level: "info" | "success" | "warning" | "error" | boolean = "info",
    validationProgress?: RuntimeValidationProgress,
): void {
    const resolvedLevel = level === true ? "error" : level === false ? "info" : level;
    const currentProgress = validationProgress ||
        (hostedSession ? CURRENT_VALIDATION_PROGRESS.get(hostedSession) : undefined);
    const snapshot = currentProgress ? structuredClone(currentProgress) : undefined;
    // A saved report is emitted once with explicit completion, not on unrelated later status lines.
    if (snapshot && !validationProgress) delete snapshot.deliveryReport;
    emitSystemStatus(hostedSession, text, {
        level: resolvedLevel,
        header: "RunWield",
        ...(snapshot ? { validationProgress: snapshot } : {}),
    });
    // The runtime event boundary validates the semantic consistency of the
    // snapshot. Commit it to session memory only after that boundary accepts it;
    // caching first leaves a rejected stage/check combination behind, so every
    // later plain status line or retry re-emits the same invalid snapshot.
    if (hostedSession && validationProgress) CURRENT_VALIDATION_PROGRESS.set(hostedSession, validationProgress);
}

export function createValidationProgress(values: ValidationProgressInput): RuntimeValidationProgress {
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

export function updateValidationProgress(
    progress: RuntimeValidationProgress,
    patch: ValidationProgressPatch,
): RuntimeValidationProgress {
    const next = createValidationProgress({
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
export function completeValidationProgress(
    progress: RuntimeValidationProgress,
    passed: boolean,
    message: string,
): RuntimeValidationProgress {
    const terminalChecks: Record<string, RuntimeValidationCheckResult> = { ...progress.checks };
    for (const key of CHECK_KEYS) {
        if (terminalChecks[key] === "pending") terminalChecks[key] = "skipped";
        else if (terminalChecks[key] === "running") terminalChecks[key] = passed ? "skipped" : "failed";
    }
    return updateValidationProgress(progress, {
        outcome: passed ? "verified" : "failed",
        stage: "terminal",
        checks: terminalChecks,
        message,
        repairAttempt: progress.repairAttempt || null,
        maxRepairAttempts: progress.maxRepairAttempts || null,
    });
}

export interface CodeReviewAnnotation {
    file?: string;
    path?: string;
    filePath?: string;
    line?: number;
    text?: string;
    comment?: string;
}

export function formatCodeReviewAnnotations(annotations: CodeReviewAnnotation[]): string {
    return annotations.map((annotation, index) => {
        const file = annotation.file || annotation.path || annotation.filePath || "unknown file";
        const line = typeof annotation.line === "number" ? `:${annotation.line}` : "";
        const text = annotation.text || annotation.comment || "";
        return `${index + 1}. ${file}${line}${text ? `\n${text}` : ""}`;
    }).join("\n\n");
}
