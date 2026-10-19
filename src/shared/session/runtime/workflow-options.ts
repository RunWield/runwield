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
        import("../../workflow/validation.ts").ContinueWorkflowValidationArgs,
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
};
export type RuntimeWorkflowOptions =
    | RuntimeExecutePlanOptions
    | RuntimePlanningOptions
    | RuntimeSlicerOptions
    | RuntimeValidationOptions
    | import("./epic-gate.ts").RuntimeEpicIntegrationGateOptions;
