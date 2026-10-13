import { assertEquals } from "../../testing/assertions.ts";
// @ts-nocheck: Deno test imports are checked by scripts/run-tests.js, not Astro check.
import { test } from "node:test";
import { deriveManagedSessionContinuationDecision } from "../../shared/session/session-runtime.ts";
import { reduceSessionEvents } from "./components/SessionTimeline.jsx";

test("Workspace creates one Router Session and resumes idle conversational Agents through one stable identity", () => {
    const guideDecision = deriveManagedSessionContinuationDecision({
        activation: { state: "idle" },
        generation: { generation: 3 },
        expectedGeneration: 3,
        projection: { ok: true, complete: true, snapshot: { activeAgent: "Guide" } },
    });
    assertEquals(guideDecision.ok, true);
    assertEquals(guideDecision.agentName, "Guide");

    const workflowDecision = deriveManagedSessionContinuationDecision({
        activation: { state: "idle" },
        generation: { generation: 3 },
        expectedGeneration: 3,
        projection: { ok: true, complete: true, snapshot: { activeAgent: "Planner", workflowContext: { plan: "x" } } },
    });
    assertEquals(workflowDecision.ok, true);
    assertEquals(workflowDecision.agentName, "Planner");

    const executionWorkflowDecision = deriveManagedSessionContinuationDecision({
        activation: { state: "idle" },
        generation: { generation: 3 },
        expectedGeneration: 3,
        projection: {
            ok: true,
            complete: true,
            snapshot: { activeAgent: "Engineer", activeExecutionWorkflow: { planName: "feature-a" } },
        },
    });
    assertEquals(executionWorkflowDecision.ok, true);
    assertEquals(executionWorkflowDecision.agentName, "Engineer");
    assertEquals(
        deriveManagedSessionContinuationDecision({
            activation: { state: "idle" },
            generation: { generation: 3 },
            expectedGeneration: 3,
            projection: { ok: true, complete: false, snapshot: { activeAgent: "Guide" } },
        }).ok,
        true,
    );

    const timeline = reduceSessionEvents([
        { type: "user_message", eventId: "u1", messageId: "u1", text: "Start" },
        { type: "assistant_text_delta", eventId: "a1", messageId: "a1", agentName: "Router", delta: "Routing." },
        { type: "tool_start", eventId: "t1", toolCallId: "tool-1", toolName: "read" },
        { type: "tool_end", eventId: "t2", toolCallId: "tool-1", toolName: "read", output: "done" },
    ]);
    assertEquals(timeline.map((item) => item.kind), ["message", "message", "tool"]);
    assertEquals(timeline[1].agentName, "Router");
});
