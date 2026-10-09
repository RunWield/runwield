export type ValidationProgressStage =
    | "cycle"
    | "ci"
    | "engineer_repair"
    | "semantic_review"
    | "human_review"
    | "merge"
    | "manual_qa"
    | "terminal";
export type ValidationProgressOutcome = "running" | "paused" | "verified" | "failed";
export type ValidationProgressCheckName = "ci" | "semanticReview" | "humanReview" | "merge";
export type ValidationProgressCheckState = "pending" | "running" | "passed" | "failed" | "skipped" | "canceled";

export interface RuntimeValidationProgressPresentationInput {
    kind: "workflow" | "mechanical";
    outcome: ValidationProgressOutcome;
    stage: ValidationProgressStage;
    checks: Record<ValidationProgressCheckName, ValidationProgressCheckState>;
}

const STAGE_LABELS: Record<ValidationProgressStage, string> = {
    cycle: "Validation",
    ci: "Verification Command",
    engineer_repair: "Repair",
    semantic_review: "AI review",
    human_review: "Code review",
    merge: "Merge worktree",
    manual_qa: "Manual QA",
    terminal: "Validation result",
};

const CHECK_LABELS: Record<ValidationProgressCheckName, string> = {
    ci: "Verification Command",
    semanticReview: "AI review",
    humanReview: "Code review",
    merge: "Merge worktree",
};

const OUTCOME_LABELS: Record<ValidationProgressOutcome, string> = {
    running: "running",
    paused: "paused",
    verified: "passed",
    failed: "failed",
};

export function validationStageLabel(stage: ValidationProgressStage): string {
    return STAGE_LABELS[stage];
}

export function validationCheckLabel(check: ValidationProgressCheckName): string {
    return CHECK_LABELS[check];
}

export function validationOutcomeLabel(outcome: ValidationProgressOutcome): string {
    return OUTCOME_LABELS[outcome];
}

export function validationProgressHeading(progress: RuntimeValidationProgressPresentationInput): string {
    if (progress.kind === "mechanical") {
        const outcome = progress.outcome === "verified" ? "done" : validationOutcomeLabel(progress.outcome);
        return `${validationCheckLabel("ci")} ${outcome}`;
    }
    if (progress.outcome === "verified") return "Validation passed";
    if (progress.outcome === "failed") return "Validation failed";
    return `${validationStageLabel(progress.stage)} ${validationOutcomeLabel(progress.outcome)}`;
}

export function validationProgressCheckSummary(progress: RuntimeValidationProgressPresentationInput): string {
    const ci = `${validationCheckLabel("ci")} ${progress.checks.ci === "passed" ? "done" : progress.checks.ci}`;
    if (progress.kind === "mechanical") return ci;
    return [
        ci,
        `${validationCheckLabel("semanticReview")} ${progress.checks.semanticReview}`,
        `${validationCheckLabel("humanReview")} ${progress.checks.humanReview}`,
        `${validationCheckLabel("merge")} ${progress.checks.merge}`,
    ].join(", ");
}
