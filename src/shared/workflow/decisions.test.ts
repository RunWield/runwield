import type { TriageMeta } from "@runwield/workflow/state";
import type { PlanOutcome } from "./workflow.ts";
import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { decidePostExecution, decidePostPlanning } from "@runwield/workflow/decisions";
import { routeAttachedTriage, routeInteractiveTriage } from "@runwield/workflow/routing";
import { toolRegistry } from "@runwield/tools";

const fallbackTriageMeta: TriageMeta = {
    classification: "PLANNED_CHANGE",
    complexity: "LOW",
    summary: "fallback",
    affectedPaths: ["src/a.js"],
};

test("decidePostPlanning returns execute_plan with normalized payload", () => {
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

test("decidePostPlanning falls back to triage metadata for execute_plan", () => {
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

test("decidePostPlanning maps approved_decompose to a Slicer phase transition", () => {
    const triageMeta: TriageMeta = { classification: "PROJECT" };
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

test("decidePostPlanning carries approval annotations and images into the next phase", () => {
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

test("decidePostPlanning maps saved to save_plan", () => {
    assertEquals(
        decidePostPlanning(
            { outcome: "saved", planName: "plan-c" },
            { planningAgentName: "planner", fallbackTriageMeta },
        ),
        { kind: "save_plan", payload: { planName: "plan-c" } },
    );
});

test("decidePostPlanning maps feedback to semantic stay_with_agent reason", () => {
    assertEquals(
        decidePostPlanning(
            { outcome: "feedback", planName: "plan-d" },
            { planningAgentName: "planner", fallbackTriageMeta },
        ),
        { kind: "stay_with_agent", payload: { agentName: "planner", reason: "plan_feedback" } },
    );
});

test("decidePostPlanning maps canceled to semantic stay_with_agent reason", () => {
    assertEquals(decidePostPlanning({ outcome: "canceled" }, { planningAgentName: "architect", fallbackTriageMeta }), {
        kind: "stay_with_agent",
        payload: { agentName: "architect", reason: "plan_review_canceled" },
    });
});

test("decidePostPlanning maps no_call and missing planName to missing declaration", () => {
    assertEquals(decidePostPlanning({ outcome: "no_call" }, { planningAgentName: "planner", fallbackTriageMeta }), {
        kind: "stay_with_agent",
        payload: { agentName: "planner", reason: "missing_plan_declaration" },
    });
    assertEquals(
        decidePostPlanning({ outcome: "approved_execute" }, { planningAgentName: "planner", fallbackTriageMeta }),
        { kind: "stay_with_agent", payload: { agentName: "planner", reason: "missing_plan_declaration" } },
    );
});

test("decidePostPlanning maps repair_required to plan feedback iteration", () => {
    assertEquals(
        decidePostPlanning({ outcome: "repair_required" }, { planningAgentName: "architect", fallbackTriageMeta }),
        { kind: "stay_with_agent", payload: { agentName: "architect", reason: "plan_feedback" } },
    );
});

test("decidePostPlanning halts on unknown planning outcomes", () => {
    assertEquals(
        // Deliberately violate the outcome contract to preserve the defensive fallback regression.
        decidePostPlanning(
            { outcome: "something_else" as PlanOutcome },
            {
                planningAgentName: "planner",
                fallbackTriageMeta,
            },
        ),
        { kind: "halt", payload: { reason: "unknown_plan_outcome" } },
    );
});

test("decidePostExecution returns run_validation when execution completed", () => {
    assertEquals(
        decidePostExecution(
            { repairRequired: false, executionComplete: true },
            { planName: "plan-a", triageMeta: fallbackTriageMeta, executionAgentName: "engineer" },
        ),
        { kind: "run_validation", payload: { planName: "plan-a", triageMeta: fallbackTriageMeta } },
    );
});

test("decidePostExecution returns complete_session for intentional workflow completion", () => {
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

test("decidePostExecution returns stay_with_agent when execution is incomplete", () => {
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

test("decidePostExecution halts when execution result is missing", () => {
    assertEquals(
        decidePostExecution(undefined, {
            planName: "plan-d",
            triageMeta: fallbackTriageMeta,
            executionAgentName: "planner",
        }),
        { kind: "halt", payload: { reason: "missing_execution_result" } },
    );
});

test("decidePostPlanning keeps a conversation separate from Plan feedback", () => {
    assertEquals(
        decidePostPlanning({ outcome: "conversation", planName: "target" }, { planningAgentName: "architect" }),
        {
            kind: "stay_with_agent",
            payload: { agentName: "architect", planName: "target", reason: "plan_conversation" },
        },
    );
});

test("routes the same JSON report for interactive sessions and Connect", () => {
    const routes = [
        ["INQUIRY", "conversation", "guide", "role_handoff"],
        ["IDEATION", "conversation", "ideator", "role_handoff"],
        ["OPERATION", "operation", "operator", "unsupported_in_preview"],
        ["QUICK_FIX", "quick_fix", "engineer", "unsupported_in_preview"],
        ["PLANNED_CHANGE", "planning", "planner", "planning"],
        ["PROJECT", "planning", "architect", "unsupported_in_preview"],
    ] as const;

    for (const [routingIntent, kind, agentName, attachedKind] of routes) {
        const report = toolRegistry.get("triage_report").report({
            routingIntent,
            complexity: "LOW",
            summary: "Route the request.",
            ...(routingIntent === "PLANNED_CHANGE" && { workKind: "FEATURE" }),
        });
        assertEquals(routeInteractiveTriage(report), { kind, agentName, report });
        const attached = routeAttachedTriage(report);
        assertEquals(attached?.kind, attachedKind);
        assertEquals(attached?.report, report);
        if (attached?.kind === "role_handoff" || attached?.kind === "planning") {
            assertEquals(attached.agentName, agentName);
        }
    }
});

test("rejects retired routing intents from both workflow entry points", () => {
    const report = { routingIntent: "QUICK_FIX", classification: "FEATURE", complexity: "LOW", summary: "Repair" };
    assertEquals(routeInteractiveTriage(report), null);
    assertEquals(routeAttachedTriage(report), null);
});
