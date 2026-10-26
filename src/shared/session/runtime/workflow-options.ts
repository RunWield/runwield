/**
 * @module shared/session/runtime/workflow-options
 * The option shapes Session runtime workflow operations accept.
 */

export interface RuntimeTriageFields {
    status?: string | null;
    classification?: string | null;
    planId?: string | null;
    planName?: string | null;
    revision?: string | null;
    executionAgent?: string | null;
    parentPlan?: string | null;
    routingIntent?: string | null;
    complexity?: string | null;
    validationCiAttempts?: number;
    validationSemanticRounds?: number;
    worktree?: import("../../workflow/plan-actions.ts").PlanWorktreeExpectation;
}
export type RuntimePersistedTriageInput = Omit<
    import("../../../plan-store.js").PlanFrontMatter,
    "status" | "executionAgent"
> & {
    status?: string;
    worktree?: import("../../workflow/plan-actions.ts").PlanWorktreeExpectation;
};
export type RuntimeTriageInput =
    | RuntimeTriageFields
    | RuntimePersistedTriageInput
    | import("../../../tools/plan-written.ts").TriageMeta
    | import("../../../plan-store.js").PlanFrontMatter;
export type RuntimeExecutePlanOptions = Partial<
    Omit<import("../../workflow/plan-executor.ts").ExecutePlanOptions, "hostedSession" | "triageMeta">
> & {
    triageMeta?: RuntimeTriageInput;
    expectedGeneration?: number;
    initialRequest?: string;
    planContent?: string;
};
export type RuntimePlanningOptions = Partial<
    Omit<
        import("../../workflow/planning-agent.ts").RunPlanningAgentOptions,
        "hostedSession" | "sessionManager" | "triageMeta"
    >
> & { triageMeta?: RuntimeTriageInput };
export type RuntimeSlicerOptions = Partial<
    Omit<import("../../workflow/workflow-slicer.ts").RunSlicerAgentOptions, "hostedSession" | "sessionManager">
>;
export type RuntimeValidationOptions = Partial<
    Omit<
        import("../../workflow/validation-supervisor.ts").ContinueWorkflowValidationArgs,
        | "triageMeta"
        | "hostedSession"
        | "sessionManager"
        | "git"
        | "semanticReviewPort"
        | "localCI"
        | "workRecordMnemotecaPort"
        | "supportsSemanticRepairHandoff"
    >
> & {
    triageMeta?: RuntimeTriageInput;
    expectedGeneration?: number;
    skipPendingSegmentResume?: boolean;
    /** The enclosing prompt owns Epic continuation after validation settles. */
    suppressEpicContinuation?: boolean;
};
export type RuntimeWorkflowOptions =
    | RuntimeExecutePlanOptions
    | RuntimePlanningOptions
    | RuntimeSlicerOptions
    | RuntimeValidationOptions
    | import("./epic-gate.ts").RuntimeEpicIntegrationGateOptions;

type WorkflowValidationResult = import("../../workflow/validation.ts").WorkflowValidationResult;
export interface SemanticRepairHandoffResult {
    kind: "semantic_repair_handoff";
    planName?: string;
    projectRoot?: string;
    semanticRepairHandoff: NonNullable<WorkflowValidationResult["semanticRepairHandoff"]>;
}
export type SemanticRepairContinuation = Omit<
    import("../../workflow/execution-segment-handoff.ts").SemanticRepairSegmentContinuation,
    "activeWorkflow"
> & { activeWorkflow: import("../hosted-session.js").ActiveExecutionWorkflow };
export interface RuntimeSemanticRepairOptions {
    suppressEpicContinuation?: boolean;
    planName: string;
    planContent?: string;
    triageMeta?: import("../../../tools/plan-written.ts").TriageMeta;
}

export interface RuntimeValidationResult {
    kind?: string;
    ok?: boolean;
    error?: string;
    planName?: string;
    projectRoot?: string;
    reason?: string;
    executionComplete?: boolean;
    executionContext?: import("../hosted-session.js").ActiveExecutionWorkflow;
    executionSegmentHandoff?: import("../../workflow/execution-segment-handoff.ts").ExecutionSegmentContinuation;
    epicContinuation?: NonNullable<WorkflowValidationResult["epicContinuation"]>;
    semanticRepairHandoff?: WorkflowValidationResult["semanticRepairHandoff"];
}

export function isValidationTriageMeta(
    value: RuntimeTriageInput,
): value is import("../../../tools/plan-written.ts").TriageMeta {
    const classifications = new Set(["QUICK_FIX", "PLANNED_CHANGE", "FEATURE", "PROJECT"]);
    const complexities = new Set(["LOW", "MEDIUM", "HIGH"]);
    const statuses = new Set([
        "approved",
        "draft",
        "ready_for_decomposition",
        "ready_for_work",
        "in_progress",
        "failed",
        "implemented",
        "validated_ci",
        "reviewed",
        "validated",
        "blocked",
        "canceled",
        "abandoned",
        "superseded",
    ]);
    const executionAgents = new Set(["engineer", "frontend-engineer"]);
    return (
        value.planId !== null &&
        value.parentPlan !== null &&
        (value.classification === undefined ||
            (value.classification !== null && classifications.has(value.classification))) &&
        (value.complexity === undefined || (value.complexity !== null && complexities.has(value.complexity))) &&
        (value.status === undefined || (value.status !== null && statuses.has(value.status))) &&
        (!("executionAgent" in value) ||
            value.executionAgent === undefined ||
            (typeof value.executionAgent === "string" && executionAgents.has(value.executionAgent)))
    );
}
