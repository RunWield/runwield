import { assertEquals } from "@std/assert";
import { decidePostExecution, decidePostPlanning } from "./decisions.ts";

/** @type {import('../../tools/plan-written.ts').TriageMeta} */
const fallbackTriageMeta = {
    classification: "FEATURE",
    complexity: "LOW",
    summary: "fallback",
    affectedPaths: ["src/a.js"],
};

Deno.test("decidePostPlanning returns execute_plan with normalized payload", () => {
    assertEquals(
        decidePostPlanning(
            {
                outcome: "approved_execute",
                planName: "plan-a",
                triageMeta: { classification: "PROJECT", complexity: "HIGH", summary: "project", affectedPaths: [] },
            },
            { planningAgentName: "architect", fallbackTriageMeta },
        ),
        {
            kind: "execute_plan",
            payload: {
                planName: "plan-a",
                triageMeta: { classification: "PROJECT", complexity: "HIGH", summary: "project", affectedPaths: [] },
            },
        },
    );
});

Deno.test("decidePostPlanning falls back to triage metadata for execute_plan", () => {
    assertEquals(
        decidePostPlanning(
            { outcome: "approved_execute", planName: "plan-b" },
            { planningAgentName: "planner", fallbackTriageMeta },
        ),
        {
            kind: "execute_plan",
            payload: {
                planName: "plan-b",
                triageMeta: fallbackTriageMeta,
            },
        },
    );
});

Deno.test("decidePostPlanning maps approved_decompose to a Slicer phase transition", () => {
    const triageMeta = { classification: /** @type {const} */ ("PROJECT") };
    assertEquals(
        decidePostPlanning(
            { outcome: "approved_decompose", planName: "epic-a", triageMeta },
            { planningAgentName: "architect", fallbackTriageMeta },
        ),
        {
            kind: "start_slicer",
            payload: { planName: "epic-a", triageMeta },
        },
    );
});

Deno.test("decidePostPlanning carries approval annotations and images into the next phase", () => {
    const reviewImages = [{ base64: "YXBwcm92ZWQ=", mimeType: "image/png" }];
    assertEquals(
        decidePostPlanning(
            {
                outcome: "approved_execute",
                planName: "plan-with-notes",
                feedback: "Keep the selected command.",
                images: reviewImages,
            },
            { planningAgentName: "planner", fallbackTriageMeta },
        ),
        {
            kind: "execute_plan",
            payload: {
                planName: "plan-with-notes",
                triageMeta: fallbackTriageMeta,
                reviewFeedback: "Keep the selected command.",
                reviewImages,
            },
        },
    );
});

Deno.test("decidePostPlanning maps saved to save_plan", () => {
    assertEquals(
        decidePostPlanning(
            { outcome: "saved", planName: "plan-c" },
            { planningAgentName: "planner", fallbackTriageMeta },
        ),
        { kind: "save_plan", payload: { planName: "plan-c" } },
    );
});

Deno.test("decidePostPlanning maps feedback to semantic stay_with_agent reason", () => {
    assertEquals(
        decidePostPlanning(
            { outcome: "feedback", planName: "plan-d" },
            { planningAgentName: "planner", fallbackTriageMeta },
        ),
        { kind: "stay_with_agent", payload: { agentName: "planner", reason: "plan_feedback" } },
    );
});

Deno.test("decidePostPlanning maps canceled to semantic stay_with_agent reason", () => {
    assertEquals(
        decidePostPlanning(
            { outcome: "canceled" },
            { planningAgentName: "architect", fallbackTriageMeta },
        ),
        { kind: "stay_with_agent", payload: { agentName: "architect", reason: "plan_review_canceled" } },
    );
});

Deno.test("decidePostPlanning maps no_call and missing planName to missing declaration", () => {
    assertEquals(
        decidePostPlanning(
            { outcome: "no_call" },
            { planningAgentName: "planner", fallbackTriageMeta },
        ),
        { kind: "stay_with_agent", payload: { agentName: "planner", reason: "missing_plan_declaration" } },
    );
    assertEquals(
        decidePostPlanning(
            { outcome: "approved_execute" },
            { planningAgentName: "planner", fallbackTriageMeta },
        ),
        { kind: "stay_with_agent", payload: { agentName: "planner", reason: "missing_plan_declaration" } },
    );
});

Deno.test("decidePostPlanning maps repair_required to plan feedback iteration", () => {
    assertEquals(
        decidePostPlanning(
            { outcome: "repair_required" },
            { planningAgentName: "architect", fallbackTriageMeta },
        ),
        { kind: "stay_with_agent", payload: { agentName: "architect", reason: "plan_feedback" } },
    );
});

Deno.test("decidePostPlanning halts on unknown planning outcomes", () => {
    assertEquals(
        decidePostPlanning(
            /** @type {any} */ ({ outcome: "something_else" }),
            { planningAgentName: "planner", fallbackTriageMeta },
        ),
        { kind: "halt", payload: { reason: "unknown_plan_outcome" } },
    );
});

Deno.test("decidePostExecution returns run_validation when execution completed", () => {
    assertEquals(
        decidePostExecution(
            { repairRequired: false, executionComplete: true },
            { planName: "plan-a", triageMeta: fallbackTriageMeta, executionAgentName: "engineer" },
        ),
        { kind: "run_validation", payload: { planName: "plan-a", triageMeta: fallbackTriageMeta } },
    );
});

Deno.test("decidePostExecution returns complete_session for intentional workflow completion", () => {
    assertEquals(
        decidePostExecution(
            {
                repairRequired: false,
                executionComplete: false,
                intentionalComplete: true,
                intentionalCompleteReason: "saved_for_later",
                message: "done",
            },
            { planName: "plan-b", triageMeta: fallbackTriageMeta, executionAgentName: "engineer" },
        ),
        {
            kind: "complete_session",
            payload: {
                planName: "plan-b",
                triageMeta: fallbackTriageMeta,
                reason: "saved_for_later",
                message: "done",
            },
        },
    );
});

Deno.test("decidePostExecution returns stay_with_agent when execution is incomplete", () => {
    assertEquals(
        decidePostExecution(
            { repairRequired: false, executionComplete: false },
            { planName: "plan-c", triageMeta: fallbackTriageMeta, executionAgentName: "architect" },
        ),
        {
            kind: "stay_with_agent",
            payload: {
                agentName: "architect",
                reason: "execution_incomplete",
                error: undefined,
            },
        },
    );
});

Deno.test("decidePostExecution halts when execution result is missing", () => {
    assertEquals(
        decidePostExecution(
            undefined,
            { planName: "plan-d", triageMeta: fallbackTriageMeta, executionAgentName: "planner" },
        ),
        { kind: "halt", payload: { reason: "missing_execution_result" } },
    );
});
