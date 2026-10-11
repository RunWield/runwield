import { assertEquals } from "@std/assert";
import { buildWorkflowPresentation } from "./workflow-presentation.ts";

Deno.test("workflow presentation derives current stage and blocker from raw progress facts without fabricating recovery", () => {
    const presentation = buildWorkflowPresentation({
        planName: "workspace/diagram",
        epicName: "workspace",
        intent: "PLANNED_CHANGE",
        status: "implemented",
        progressFacts: [
            { kind: "validation_checkpoint", phase: "mechanical", state: "awaiting_repair" },
        ],
    });

    assertEquals(presentation.active, true);
    assertEquals(presentation.plan, "diagram");
    assertEquals(presentation.currentStage?.id, "repair");
    assertEquals(presentation.currentStage?.state, "paused");
    assertEquals(presentation.blocker, "Work is paused. Open the Session to review the latest result and continue.");
    assertEquals(presentation.action?.kind, "open_plan");
    assertEquals(presentation.connections.some((connection) => connection.kind === "repair_return"), true);
});

Deno.test("workflow presentation exposes recovery only when live capability is present", () => {
    const presentation = buildWorkflowPresentation({
        planName: "workspace/diagram",
        status: "implemented",
        canRecover: true,
        progressFacts: [{ kind: "validation_checkpoint", phase: "mechanical", state: "awaiting_repair" }],
    });

    assertEquals(presentation.action?.kind, "recover");
});

Deno.test("workflow presentation returns repairs to the failed check, not repair itself", () => {
    const presentation = buildWorkflowPresentation({
        planName: "workspace/diagram",
        status: "reviewed",
        progressFacts: [{ kind: "registry", status: "validation_failed" }],
    });

    assertEquals(
        presentation.connections.find((connection) => connection.kind === "repair_return"),
        { from: "repair", to: "code_review", kind: "repair_return" },
    );
});

Deno.test("workflow presentation does not fabricate review actions from missing live facts", () => {
    const presentation = buildWorkflowPresentation({
        planName: "ready-plan",
        intent: "PLANNED_CHANGE",
        hasWorkingSession: true,
    });

    assertEquals(presentation.currentStage?.id, "planning");
    assertEquals(presentation.currentStage?.state, "current");
    assertEquals(presentation.action?.kind, "open_session");
    assertEquals(presentation.stages.some((stage) => stage.id === "delivery"), true);
});

Deno.test("workflow presentation gives container Plans child-work stages", () => {
    const presentation = buildWorkflowPresentation({
        planName: "workspace",
        classification: "PROJECT",
        projectPlanType: "sequence",
        status: "ready_for_decomposition",
    });

    assertEquals(presentation.stages.map((stage) => stage.id), ["review", "decomposition", "child_work", "completion"]);
    assertEquals(presentation.currentStage?.id, "decomposition");
});

Deno.test("ready Plans begin at execution with useful step descriptions", () => {
    const result = buildWorkflowPresentation({ planName: "Ready", status: "ready_for_work" });
    assertEquals(result.currentStage?.id, "execution");
    assertEquals(result.stages[0].state, "completed");
    assertEquals(result.currentStage?.detail, "Ready to implement. Continue from the Session to start work.");
    assertEquals(result.stages.some((stage) => /is current|has not started/.test(stage.detail)), false);
    assertEquals(result.stages.map((stage) => stage.label), [
        "Planning",
        "Execution",
        "Verification Command",
        "AI review",
        "Code Review",
        "Publication",
        "Completion",
    ]);
});

Deno.test("workflow descriptions show live user actions and publication failures", () => {
    const review = buildWorkflowPresentation({ planName: "Review", status: "reviewed", hasCodeReview: true });
    assertEquals(review.currentStage?.id, "code_review");
    assertEquals(review.currentStage?.detail, "Inspect the changes and approve them or request a repair.");
    const question = buildWorkflowPresentation({ planName: "Question", status: "in_progress", hasLiveQuestion: true });
    assertEquals(question.currentStage?.detail, "The agent needs your answer in the Session before continuing.");
    const publication = buildWorkflowPresentation({
        planName: "Publish",
        status: "validated",
        progressFacts: [
            { kind: "publication", phase: "target_integrated", failure: true, message: "Push rejected by the remote." },
        ],
    });
    assertEquals(publication.currentStage?.id, "delivery");
    assertEquals(publication.blocker, "Push rejected by the remote.");
});

Deno.test("live validation replaces the pre-resume paused checkpoint", () => {
    const presentation = buildWorkflowPresentation({
        planName: "Resume repair",
        status: "implemented",
        sessionState: "active",
        progressFacts: [{
            kind: "validation_checkpoint",
            phase: "mechanical",
            state: "paused",
            repairKind: "semantic",
        }],
        liveValidationProgress: {
            kind: "workflow",
            outcome: "running",
            stage: "ci",
            message: "Running the tests in the execution worktree.",
            checks: { ci: "running", semanticReview: "pending", humanReview: "pending", merge: "pending" },
        },
    });
    assertEquals(presentation.currentStage?.id, "mechanical");
    assertEquals(presentation.currentStage?.state, "current");
    assertEquals(presentation.currentStage?.detail, "Running the tests in the execution worktree.");
    assertEquals(presentation.stages.some((stage) => stage.state === "paused"), false);
    assertEquals(presentation.stages.some((stage) => stage.id === "repair"), false);
    assertEquals(presentation.action?.kind, "open_session");
});

Deno.test("saved approval offers Review Plan while validation keeps Resume and live work keeps its action", () => {
    for (const status of ["approved", "ready_for_work"]) {
        const input = { planName: "Saved", status, sessionState: "idle", canResume: true };
        assertEquals(buildWorkflowPresentation(input).action?.kind, "review_plan");
        assertEquals(buildWorkflowPresentation({ ...input, hasLiveQuestion: true }).action?.kind, "answer_agent");
        assertEquals(buildWorkflowPresentation({ ...input, hasCodeReview: true }).action?.kind, "review_code");
    }
    assertEquals(
        buildWorkflowPresentation({ planName: "Paused", status: "implemented", canResume: true }).action?.kind,
        "resume",
    );
    assertEquals(
        buildWorkflowPresentation({ planName: "Running", status: "ready_for_work", sessionState: "active" }).action
            ?.kind,
        "open_session",
    );
});

Deno.test("active and finished workflows ignore obsolete continuation flags", () => {
    for (
        const input of [
            { status: "implemented", sessionState: "active" },
            { status: "verified", sessionState: "idle" },
            { status: "validated", classification: "PROJECT", sessionState: "idle" },
        ]
    ) {
        const presentation = buildWorkflowPresentation({
            planName: "Plan",
            hasWorkingSession: true,
            canRun: true,
            canResume: true,
            canRecover: true,
            ...input,
        });
        assertEquals(presentation.action?.kind, "open_session");
    }
});

Deno.test("held Plans offer Resume from hold only when the saved workflow is available", () => {
    const input = { planName: "Held", status: "on_hold", hasWorkingSession: true };
    assertEquals(buildWorkflowPresentation({ ...input, canResume: true }).action?.kind, "resume_from_hold");
    assertEquals(buildWorkflowPresentation({ ...input, canResume: false }).action?.kind, "open_session");
    assertEquals(
        buildWorkflowPresentation({ ...input, canResume: true, sessionState: "active" }).action?.kind,
        "open_session",
    );
});

Deno.test("implemented Plans retain passed CI while the saved semantic phase resumes", () => {
    const presentation = buildWorkflowPresentation({
        planName: "Resume review",
        status: "implemented",
        validationPhase: "semantic",
    });
    assertEquals(presentation.stages.find((stage) => stage.id === "mechanical")?.state, "completed");
    assertEquals(presentation.currentStage?.id, "semantic");
});
