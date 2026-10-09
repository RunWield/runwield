import type { RuntimeValidationProgressPresentationInput } from "./validation-progress-presentation.ts";

export interface LiveValidationProgress extends RuntimeValidationProgressPresentationInput {
    message?: string;
}

export type WorkflowPresentationStepState =
    | "completed"
    | "current"
    | "upcoming"
    | "blocked"
    | "paused"
    | "skipped"
    | "unavailable";

export type WorkflowPresentationActionKind =
    | "open_plan"
    | "open_session"
    | "review_plan"
    | "review_code"
    | "answer_agent"
    | "run"
    | "resume"
    | "resume_from_hold"
    | "recover";

export interface WorkflowProgressFact {
    kind: "validation_checkpoint" | "publication" | "registry" | "session";
    phase?: string | null;
    state?: string | null;
    status?: string | null;
    repairKind?: string | null;
    updatedAt?: string | null;
    failure?: boolean | null;
    message?: string | null;
}

export interface WorkflowPresentationInput {
    planName?: string | null;
    epicName?: string | null;
    intent?: string | null;
    classification?: string | null;
    projectPlanType?: string | null;
    status?: string | null;
    validationPhase?: "mechanical" | "semantic" | "delivery";
    progressFacts?: WorkflowProgressFact[];
    liveValidationProgress?: LiveValidationProgress | null;
    degradedMessage?: string | null;
    sessionState?: string | null;
    hasWorkingSession?: boolean;
    hasLiveQuestion?: boolean;
    hasPlanReview?: boolean;
    hasCodeReview?: boolean;
    canRun?: boolean;
    canResume?: boolean;
    canRecover?: boolean;
}

export interface WorkflowPresentationStage {
    id: string;
    label: string;
    state: WorkflowPresentationStepState;
    detail: string;
    current: boolean;
}

export interface WorkflowPresentationAction {
    kind: WorkflowPresentationActionKind;
    label: string;
    detail: string;
}

export interface WorkflowPresentationConnection {
    from: string;
    to: string;
    kind: "forward" | "repair_return";
}

export interface WorkflowPresentation {
    active: boolean;
    epic: string | null;
    plan: string;
    intent: string;
    stages: WorkflowPresentationStage[];
    connections: WorkflowPresentationConnection[];
    currentStage: WorkflowPresentationStage | null;
    blocker: string | null;
    action: WorkflowPresentationAction | null;
}

type StageDefinition = { id: string; label: string };

const EXECUTABLE_STAGES: StageDefinition[] = [
    { id: "planning", label: "Planning" },
    { id: "execution", label: "Execution" },
    { id: "mechanical", label: "Tests and CI" },
    { id: "semantic", label: "AI review" },
    { id: "repair", label: "Repair" },
    { id: "code_review", label: "Code Review" },
    { id: "delivery", label: "Publication" },
    { id: "completion", label: "Completion" },
];

const QUICK_FIX_STAGES: StageDefinition[] = [
    { id: "execution", label: "Implementation" },
    { id: "mechanical", label: "Tests and CI" },
    { id: "repair", label: "Repair" },
    { id: "manual_qa", label: "Manual QA" },
    { id: "completion", label: "Completion" },
];

const CONTAINER_STAGES: StageDefinition[] = [
    { id: "review", label: "Review" },
    { id: "decomposition", label: "Decomposition" },
    { id: "child_work", label: "Child work" },
    { id: "completion", label: "Completion" },
];

const ACTIVE_STATES = new Set(["running"]);
const BLOCKED_STATES = new Set(["needs_attention", "failed"]);
const PAUSED_STATES = new Set(["paused"]);
const DONE_STATES = new Set(["passed", "completed"]);
const SKIPPED_STATES = new Set(["not_required", "skipped"]);

function clean(value?: string | null): string {
    return typeof value === "string" ? value.trim() : "";
}

function isProject(input: WorkflowPresentationInput): boolean {
    return clean(input.classification) === "PROJECT";
}

function stageDefinitions(input: WorkflowPresentationInput): StageDefinition[] {
    return clean(input.intent) === "QUICK_FIX"
        ? QUICK_FIX_STAGES
        : isProject(input)
        ? CONTAINER_STAGES
        : EXECUTABLE_STAGES;
}

function connectionDefinitions(stages: StageDefinition[], repairTarget: string): WorkflowPresentationConnection[] {
    const forward = stages.slice(0, -1).map((stage, index) => ({
        from: stage.id,
        to: stages[index + 1].id,
        kind: "forward" as const,
    }));
    return stages.some((stage) => stage.id === "repair") && repairTarget
        ? [...forward, { from: "repair", to: repairTarget, kind: "repair_return" as const }]
        : forward;
}

function stateFromRaw(raw: string, isCurrent: boolean): WorkflowPresentationStepState {
    if (BLOCKED_STATES.has(raw)) return "blocked";
    if (PAUSED_STATES.has(raw)) return "paused";
    if (ACTIVE_STATES.has(raw)) return "current";
    if (DONE_STATES.has(raw)) return "completed";
    if (SKIPPED_STATES.has(raw)) return "skipped";
    if (raw === "unknown") return "unavailable";
    return isCurrent ? "current" : "upcoming";
}

function baseStates(input: WorkflowPresentationInput, stages: StageDefinition[]): Map<string, string> {
    const status = clean(input.status).toLowerCase();
    const states = new Map(stages.map((stage) => [stage.id, "pending"]));
    if (states.has("repair")) states.set("repair", "not_required");
    if (clean(input.intent) === "QUICK_FIX") {
        states.set("execution", "running");
        return states;
    }
    if (isProject(input)) {
        if (status === "feedback" || status === "failed") states.set("review", "needs_attention");
        else if (status === "ready_for_decomposition") states.set("decomposition", "running");
        else if (status === "ready_for_work" || status === "in_progress") {
            states.set("review", "completed");
            states.set("decomposition", "completed");
            states.set("child_work", "running");
        } else if (["validated", "verified", "user_verified", "closed_without_verification"].includes(status)) {
            for (const stage of stages) states.set(stage.id, "completed");
        } else states.set("review", "running");
        return states;
    }

    if (
        ["ready_for_work", "in_progress", "implemented", "validated_ci", "reviewed", "validated"].includes(
            status,
        )
    ) {
        states.set("planning", "completed");
    }
    if (status === "feedback" || status === "failed") states.set("planning", "needs_attention");
    else if (status === "ready_for_work") states.set("execution", "pending");
    else if (status === "in_progress") states.set("execution", "running");
    else if (status === "implemented" && input.validationPhase !== "semantic") {
        states.set("execution", "completed");
        states.set("mechanical", "running");
    } else if (status === "validated_ci" || (status === "implemented" && input.validationPhase === "semantic")) {
        states.set("execution", "completed");
        states.set("mechanical", "completed");
        states.set("semantic", "running");
    } else if (status === "reviewed") {
        states.set("execution", "completed");
        states.set("mechanical", "completed");
        states.set("semantic", "completed");
        states.set("code_review", "running");
    } else if (status === "validated") {
        states.set("code_review", "completed");
        states.set("execution", "completed");
        states.set("mechanical", "completed");
        states.set("semantic", "completed");
        states.set("delivery", "running");
    } else if (["verified", "user_verified", "closed_without_verification"].includes(status)) {
        for (const stage of stages) states.set(stage.id, stage.id === "repair" ? "not_required" : "completed");
    } else states.set("planning", "running");
    return states;
}

function stageForValidationPhase(phase: string): string {
    if (phase === "mechanical") return "mechanical";
    if (phase === "semantic") return "semantic";
    if (phase === "delivery") return "code_review";
    return "";
}

function stageStateFromCheckpoint(state: string): string {
    if (state === "awaiting_repair") return "needs_attention";
    if (state === "paused") return "paused";
    if (state === "ready" || state === "running") return "running";
    return "pending";
}

function mergedRawStates(input: WorkflowPresentationInput, stages: StageDefinition[]): Map<string, string> {
    const states = baseStates(input, stages);
    for (const fact of input.progressFacts || []) {
        const kind = clean(fact.kind);
        const phase = clean(fact.phase);
        if (kind === "validation_checkpoint") {
            if (phase === "semantic" || phase === "delivery") states.set("mechanical", "completed");
            if (phase === "delivery") states.set("semantic", "completed");
            const stageId = stageForValidationPhase(phase);
            if (stageId && states.has(stageId)) states.set(stageId, stageStateFromCheckpoint(clean(fact.state)));
            if ((clean(fact.state) === "awaiting_repair" || clean(fact.repairKind)) && states.has("repair")) {
                states.set("repair", clean(fact.state) === "paused" ? "paused" : "running");
            }
        } else if (kind === "publication") {
            if (states.has("code_review")) states.set("code_review", "completed");
            if (states.has("delivery")) states.set("delivery", "running");
            if (fact.failure && states.has("delivery")) states.set("delivery", "needs_attention");
            else if (["publication_verified", "cleanup_complete"].includes(phase) && states.has("delivery")) {
                states.set("delivery", "completed");
            }
        } else if (kind === "registry") {
            const status = clean(fact.status);
            if (status === "execution_failed" && states.has("execution")) states.set("execution", "needs_attention");
            if (status === "validation_failed") {
                const planStatus = clean(input.status).toLowerCase();
                states.set(
                    planStatus === "implemented" && input.validationPhase !== "semantic"
                        ? "mechanical"
                        : planStatus === "validated_ci" || input.validationPhase === "semantic"
                        ? "semantic"
                        : "repair",
                    "needs_attention",
                );
            }
            if (status === "active" && states.has("execution") && clean(input.status).toLowerCase() === "in_progress") {
                states.set("execution", "running");
            }
        } else if (kind === "session" && clean(fact.state) === "active" && states.has("execution")) {
            states.set("execution", "running");
        }
    }
    if (input.hasPlanReview && states.has("planning")) states.set("planning", "running");
    if (input.hasCodeReview && states.has("code_review")) states.set("code_review", "running");
    const live = input.liveValidationProgress;
    if (live?.kind === "mechanical" && clean(input.intent) === "QUICK_FIX") {
        states.set("execution", "completed");
        states.set(
            "mechanical",
            live.checks.ci === "passed"
                ? "completed"
                : live.stage === "engineer_repair"
                ? "pending"
                : live.outcome === "paused"
                ? "paused"
                : live.outcome === "failed"
                ? "needs_attention"
                : "running",
        );
        states.set("repair", live.stage === "engineer_repair" ? "running" : "not_required");
        if (live.stage === "manual_qa") states.set("manual_qa", "running");
        if (live.outcome === "verified") {
            states.set("manual_qa", "completed");
            states.set("completion", "completed");
        }
    } else if (live?.outcome === "running" && states.has("mechanical")) {
        // Live work supersedes a saved checkpoint from before Resume was pressed.
        states.set("planning", "completed");
        states.set("execution", "completed");
        states.set("repair", live.stage === "engineer_repair" ? "running" : "not_required");
        for (
            const [check, stage] of Object.entries({
                ci: "mechanical",
                semanticReview: "semantic",
                humanReview: "code_review",
                merge: "delivery",
            })
        ) {
            const state = live.checks[check as keyof typeof live.checks];
            states.set(stage, state === "canceled" ? "paused" : state === "failed" ? "pending" : state);
        }
    }
    return states;
}

function repairReturnTarget(input: WorkflowPresentationInput): string {
    for (const fact of input.progressFacts || []) {
        if (clean(fact.kind) === "validation_checkpoint") {
            const target = stageForValidationPhase(clean(fact.phase));
            if (target) return target;
        }
        if (clean(fact.kind) === "registry" && clean(fact.status) === "validation_failed") {
            const status = clean(input.status).toLowerCase();
            return status === "implemented" ? "mechanical" : status === "validated_ci" ? "semantic" : "code_review";
        }
    }
    const status = clean(input.status).toLowerCase();
    return status === "implemented" ? "mechanical" : status === "validated_ci" ? "semantic" : "";
}

function currentStageIndex(stages: StageDefinition[], rawStates: Map<string, string>): number {
    const urgent = stages.findIndex((stage) => {
        const raw = rawStates.get(stage.id) || "pending";
        return BLOCKED_STATES.has(raw) || PAUSED_STATES.has(raw);
    });
    if (urgent >= 0) return urgent;
    const running = stages.findIndex((stage) => ACTIVE_STATES.has(rawStates.get(stage.id) || "pending"));
    if (running >= 0) return running;
    const pending = stages.findIndex((stage) => {
        const raw = rawStates.get(stage.id) || "pending";
        return !DONE_STATES.has(raw) && !SKIPPED_STATES.has(raw);
    });
    if (pending >= 0) return pending;
    return stages.length - 1;
}

function detailFor(stage: WorkflowPresentationStage, input: WorkflowPresentationInput): string {
    if (stage.current && input.liveValidationProgress?.outcome === "running" && input.liveValidationProgress.message) {
        return input.liveValidationProgress.message;
    }
    const fact = (input.progressFacts || []).find((item) =>
        item.kind === "publication"
            ? stage.id === "delivery"
            : item.kind === "validation_checkpoint"
            ? stage.id === stageForValidationPhase(clean(item.phase))
            : item.kind === "registry" && stage.id === "execution"
    );
    if (fact?.failure && clean(fact.message)) return clean(fact.message);
    if (
        stage.current && input.hasLiveQuestion &&
        !(clean(input.intent) === "QUICK_FIX" && input.liveValidationProgress?.stage === "ci" &&
            input.liveValidationProgress.outcome === "running")
    ) return "The agent needs your answer in the Session before continuing.";
    if (stage.current && clean(input.degradedMessage)) return clean(input.degradedMessage);
    if (stage.id === "planning" && input.hasPlanReview) {
        return "Review the proposed Plan, then approve it or send feedback.";
    }
    if (stage.id === "code_review" && input.hasCodeReview) {
        return "Inspect the changes and approve them or request a repair.";
    }
    if (stage.state === "paused") return "Work is paused. Open the Session to review the latest result and continue.";
    if (stage.state === "unavailable") return "Progress could not be read. Open the Session for the latest result.";
    if (stage.state === "blocked") {
        if (stage.id === "mechanical") return "A check failed. The agent must repair it and rerun validation.";
        if (stage.id === "semantic") return "The AI review found issues that must be repaired and reviewed again.";
        if (stage.id === "delivery") {
            return "Publishing needs attention. Open the Session to inspect the failure and retry.";
        }
        if (stage.id === "planning") {
            return "The Plan needs revisions before work can begin. Open the Session to continue.";
        }
        return "Work stopped before this step finished. Open the Session to inspect the result and continue.";
    }
    if (stage.id === "delivery" && fact?.phase) {
        const phases: Record<string, string> = {
            candidate_sealed: "Validated changes are recorded; preparing the publication commit.",
            artifacts_committed: "Changes and delivery records are committed; integrating the target branch next.",
            target_integrated: "Changes are integrated into the target branch; publishing next.",
            target_published: "Changes reached the target; verifying publication.",
            publication_verified: "Publication is confirmed; cleaning up the execution worktree.",
            cleanup_complete: "Publication is confirmed and the execution worktree is cleaned up.",
        };
        if (phases[fact.phase]) return phases[fact.phase];
    }
    if (stage.state === "completed") {
        const results: Record<string, string> = {
            planning: "The Plan is ready for implementation.",
            execution: "Implementation is recorded; validation checks the resulting changes.",
            mechanical: "The required tests and CI checks passed.",
            semantic: "The AI review checks passed.",
            code_review: "The code review and delivery checks are satisfied.",
            delivery: "The changes reached their publication target.",
            completion: "The workflow is finished.",
        };
        return results[stage.id] || "";
    }
    if (clean(input.intent) === "QUICK_FIX") {
        if (stage.id === "execution") return "Implement the quick fix in this Session.";
        if (stage.id === "completion") return "The quick fix checks finished.";
    }
    if (stage.id === "execution" && clean(input.status) === "ready_for_work") {
        return "Ready to implement. Continue from the Session to start work.";
    }
    const descriptions: Record<string, string> = {
        planning: "Define the scope, approach, and verification steps before implementation.",
        execution: "Implement the Plan and record the changes for validation.",
        mechanical: "Run the required tests, lint, type checks, and CI validation.",
        semantic: "Review the implementation against the Plan and check for correctness issues.",
        repair: "Fix the reported issues, then rerun the failed check.",
        manual_qa: "Prepare the manual QA checklist for the quick fix.",
        code_review: "Inspect the diff and address review feedback before publication.",
        delivery: "Publish the validated changes to the target branch and confirm they arrived.",
        completion: "Record delivery evidence and finish any remaining cleanup.",
        review: "Review the scope and approve the parent Plan before splitting work.",
        decomposition: "Split the approved Plan into executable child Plans.",
        child_work: "Implement and validate the child Plans in dependency order.",
    };
    return descriptions[stage.id] || "";
}

function actionFor(
    _stage: WorkflowPresentationStage,
    input: WorkflowPresentationInput,
): WorkflowPresentationAction | null {
    if (
        input.hasLiveQuestion &&
        !(clean(input.intent) === "QUICK_FIX" && input.liveValidationProgress?.stage === "ci" &&
            input.liveValidationProgress.outcome === "running")
    ) {
        return {
            kind: "answer_agent",
            label: "Answer agent",
            detail: "Focus the waiting prompt in the working Session.",
        };
    }
    if (input.hasPlanReview) {
        return { kind: "review_plan", label: "Review Plan", detail: "Open the current Plan review." };
    }
    if (input.hasCodeReview) {
        return { kind: "review_code", label: "Review code", detail: "Open the current code review." };
    }
    const status = clean(input.status);
    if (clean(input.intent) === "QUICK_FIX") {
        return { kind: "open_session", label: "Open Session", detail: "Open the working Session." };
    }
    const completed = ["verified", "user_verified", "closed_without_verification"].includes(status) ||
        (isProject(input) && status === "validated");
    if (status === "on_hold" && input.canResume && clean(input.sessionState) !== "active") {
        return {
            kind: "resume_from_hold",
            label: "Resume from hold",
            detail: "Check the saved work and restore this Plan to its previous stage.",
        };
    }
    if (clean(input.sessionState) === "active" || completed || status === "on_hold") {
        return input.hasWorkingSession || clean(input.sessionState) === "active"
            ? { kind: "open_session", label: "Open Session", detail: "Open the working Session." }
            : { kind: "open_plan", label: "Open Plan", detail: "Open the Plan home." };
    }
    if (
        ["approved", "ready_for_work"].includes(clean(input.status)) &&
        clean(input.sessionState) !== "active" && (input.canResume || input.canRun)
    ) {
        return {
            kind: "review_plan",
            label: "Review Plan",
            detail: "Review this Plan and choose whether to run it or save it for later.",
        };
    }
    if (input.canRecover) {
        return { kind: "recover", label: "Recover", detail: "Open the Session to inspect the failure and continue." };
    }
    if (input.canResume) {
        return { kind: "resume", label: "Resume", detail: "Continue this Plan from its saved progress." };
    }
    if (input.canRun) {
        return { kind: "run", label: "Run", detail: "Start implementation of this Plan." };
    }
    if (clean(input.sessionState) === "active" || input.hasWorkingSession) {
        return { kind: "open_session", label: "Open Session", detail: "Open the working Session." };
    }
    return { kind: "open_plan", label: "Open Plan", detail: "Open the Plan home." };
}

export function buildWorkflowPresentation(input: WorkflowPresentationInput): WorkflowPresentation {
    const plan = clean(input.planName);
    const epic = clean(input.epicName);
    const intent = clean(input.intent || input.projectPlanType).replaceAll("_", " ");
    const active = Boolean(plan || epic || intent || clean(input.status));
    if (!active) {
        return {
            active: false,
            epic: null,
            plan: "No active Plan",
            intent: "No active workflow",
            stages: [],
            connections: [],
            currentStage: null,
            blocker: null,
            action: null,
        };
    }

    const definitions = stageDefinitions(input);
    const rawStates = mergedRawStates(input, definitions);
    const currentIndex = currentStageIndex(definitions, rawStates);
    const stages = definitions.map((definition, index) => {
        const state = stateFromRaw(rawStates.get(definition.id) || "pending", index === currentIndex);
        const stage: WorkflowPresentationStage = {
            id: definition.id,
            label: definition.label,
            state,
            detail: "",
            current: index === currentIndex,
        };
        return { ...stage, detail: detailFor(stage, input) };
    }).filter((stage) => stage.state !== "skipped");
    const currentStage = stages.find((stage) => stage.current) || stages.at(-1) || null;
    const blocker = clean(input.degradedMessage) ||
        (currentStage && ["blocked", "paused", "unavailable"].includes(currentStage.state)
            ? currentStage.detail
            : null);
    return {
        active,
        epic: epic || null,
        plan: epic && plan.startsWith(`${epic}/`) ? plan.slice(epic.length + 1) : plan || "No active Plan",
        intent: intent || (isProject(input) ? "Container workflow" : "Plan workflow"),
        stages,
        connections: connectionDefinitions(definitions, repairReturnTarget(input)),
        currentStage,
        blocker,
        action: currentStage ? actionFor(currentStage, input) : null,
    };
}
