import { assertEquals } from "@std/assert";
import { tuiSessionSidebarProjection, type TuiSessionSidebarSnapshot } from "./session-sidebar.ts";
import { buildWorkflowPresentation, type LiveValidationProgress } from "../../shared/workflow/workflow-presentation.ts";

function workflow(context: TuiSessionSidebarSnapshot["workflowContext"], progress?: LiveValidationProgress) {
    return tuiSessionSidebarProjection({
        workflowContext: { planName: "sample", ...context },
        validationProgress: progress,
    }).workflow;
}

Deno.test("TUI leaves questions in the prompt and does not offer Session navigation", () => {
    assertEquals(workflow({ liveQuestion: true }).action, null);
    assertEquals(workflow({ status: "in_progress" }).action, null);
    assertEquals(workflow({ status: "verified" }).action, null);
    assertEquals(workflow({ status: "on_hold", canResume: true }).action, null);
    // Workspace still has its navigation/answer operation.
    assertEquals(buildWorkflowPresentation({ planName: "sample", hasLiveQuestion: true }).action?.kind, "answer_agent");
});

Deno.test("TUI labels saved review and paused delivery with the supported continuation", () => {
    assertEquals(workflow({ status: "ready_for_work", canRun: true }).action?.label, "Reopen Plan review");
    assertEquals(
        workflow({
            status: "reviewed",
            canResume: true,
            progressFacts: [
                { kind: "validation_checkpoint", phase: "delivery", state: "paused" },
            ],
        }).action?.label,
        "Reopen Code Review",
    );
});

Deno.test("verified completion wins over old failed checkpoints", () => {
    const result = workflow({
        status: "verified",
        progressFacts: [
            { kind: "validation_checkpoint", phase: "mechanical", state: "paused" },
            { kind: "registry", status: "validation_failed" },
        ],
    });
    assertEquals(
        result.stages.filter((stage) => stage.id !== "repair").every((stage) => stage.state === "completed"),
        true,
    );
});

Deno.test("latest checkpoint clears earlier paused stages", () => {
    const result = workflow({
        status: "reviewed",
        progressFacts: [
            { kind: "validation_checkpoint", phase: "mechanical", state: "paused", updatedAt: "2026-10-09T00:00:00Z" },
            { kind: "validation_checkpoint", phase: "delivery", state: "paused", updatedAt: "2026-10-10T00:00:00Z" },
        ],
    });
    assertEquals(result.currentStage?.id, "code_review");
    assertEquals(result.currentStage?.state, "paused");
});

Deno.test("Code Review cancellation shows a paused review instead of running", () => {
    const result = workflow({ status: "reviewed", canResume: true }, {
        kind: "workflow",
        stage: "terminal",
        outcome: "paused",
        checks: { ci: "passed", semanticReview: "passed", humanReview: "pending", merge: "pending" },
    });
    assertEquals(result.currentStage?.id, "code_review");
    assertEquals(result.currentStage?.state, "paused");
});

Deno.test("live repair is current while its failed check remains visible", () => {
    const result = workflow({ status: "implemented" }, {
        kind: "workflow",
        stage: "engineer_repair",
        outcome: "running",
        checks: { ci: "failed", semanticReview: "pending", humanReview: "pending", merge: "pending" },
    });
    assertEquals(result.currentStage?.id, "repair");
    assertEquals(result.stages.find((stage) => stage.id === "mechanical")?.state, "blocked");
});

Deno.test("terminal verified progress completes Plan and Quick Fix", () => {
    for (const routingIntent of ["PLANNED_CHANGE", "QUICK_FIX"]) {
        const result = workflow({ routingIntent, status: "implemented" }, {
            kind: routingIntent === "QUICK_FIX" ? "mechanical" : "workflow",
            stage: "terminal",
            outcome: "verified",
            checks: { ci: "passed", semanticReview: "passed", humanReview: "passed", merge: "passed" },
        });
        assertEquals(
            result.stages.filter((stage) => stage.id !== "repair").every((stage) => stage.state === "completed"),
            true,
        );
        assertEquals(result.action, null);
        assertEquals(result.connections.some((edge) => edge.kind === "repair_return"), false);
    }
});

Deno.test("paused repair preserves the failed check and returns through the saved verification phase", () => {
    for (const routingIntent of ["PLANNED_CHANGE", "QUICK_FIX"]) {
        const result = workflow({
            routingIntent,
            status: "implemented",
            canRecover: true,
            progressFacts: [
                {
                    kind: "validation_checkpoint",
                    phase: "mechanical",
                    state: "awaiting_repair",
                    repairKind: "semantic",
                },
            ],
        }, {
            kind: routingIntent === "QUICK_FIX" ? "mechanical" : "workflow",
            stage: "engineer_repair",
            outcome: "paused",
            checks: { ci: "failed", semanticReview: "failed", humanReview: "pending", merge: "pending" },
        });
        assertEquals(result.currentStage?.id, "repair");
        assertEquals(result.currentStage?.state, "paused");
        assertEquals(result.stages.find((stage) => stage.id === "mechanical")?.state, "blocked");
        assertEquals(result.connections.find((edge) => edge.kind === "repair_return")?.to, "mechanical");
    }
});

Deno.test("an idle reopened Session cannot claim its saved repair is still running", () => {
    const result = tuiSessionSidebarProjection({
        busy: false,
        workflowContext: {
            planName: "sample",
            status: "implemented",
            canRecover: true,
            validationProgress: {
                kind: "workflow",
                stage: "engineer_repair",
                outcome: "running",
                checks: { ci: "passed", semanticReview: "failed", humanReview: "pending", merge: "pending" },
            },
        },
    }).workflow;
    assertEquals(result.currentStage?.id, "repair");
    assertEquals(result.currentStage?.state, "paused");
    assertEquals(result.action?.label, "Resume repair");
});
