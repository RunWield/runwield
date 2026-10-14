import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import { readLatestPlanOutcome, readLatestReviewOutcome, readLatestTaskCompletedReport } from "./workflow-results.js";

function toolResult(toolName: string, details: JsonValue | undefined): AgentMessage {
    return {
        role: "toolResult",
        toolCallId: `${toolName}-call`,
        toolName,
        content: [{ type: "text", text: `${toolName} result` }],
        details,
        isError: false,
        timestamp: Date.now(),
    };
}

test("workflow result extraction preserves task completion reports", () => {
    const messages: AgentMessage[] = [toolResult("task_completed", {
        outcome: "task_completed",
        message: "- Done.",
    })];

    assertEquals(readLatestTaskCompletedReport(messages), {
        completed: true,
        message: "- Done.",
    });
});

test("workflow result extraction ignores non-record JSON details and searches backward", () => {
    const invalidDetails: Array<JsonValue | undefined> = [undefined, null, true, 7, "text", [], {}];
    const reviewMessages: AgentMessage[] = [toolResult("review_complete", {
        outcome: "approved",
        approved: true,
        feedback: "approved",
        findings: [],
        advisories: [],
    })];
    const planMessages: AgentMessage[] = [toolResult("plan_written", {
        outcome: "saved",
        planName: "fixture-plan",
        triageMeta: { classification: "PLANNED_CHANGE" },
    })];
    const completionMessages: AgentMessage[] = [toolResult("task_completed", {
        outcome: "task_completed",
        message: "complete",
    })];

    for (const details of invalidDetails) {
        reviewMessages.push(toolResult("review_complete", details));
        planMessages.push(toolResult("plan_written", details));
        completionMessages.push(toolResult("task_completed", details));
    }

    assertEquals(readLatestReviewOutcome(reviewMessages), {
        outcome: "approved",
        approved: true,
        feedback: "approved",
        findings: [],
        advisories: [],
    });
    assertEquals(readLatestPlanOutcome(planMessages), {
        outcome: "saved",
        planName: "fixture-plan",
        triageMeta: { classification: "PLANNED_CHANGE" },
        feedback: undefined,
    });
    assertEquals(readLatestTaskCompletedReport(completionMessages), {
        completed: true,
        message: "complete",
    });

    assertEquals(readLatestReviewOutcome(reviewMessages, 1), null);
    assertEquals(readLatestPlanOutcome(planMessages, 1), null);
    assertEquals(readLatestTaskCompletedReport(completionMessages, 1), { completed: false, message: "" });
});

test("plan result extraction preserves legacy truthy outcomes", () => {
    const messages: AgentMessage[] = [toolResult("plan_written", {
        outcome: 1,
        planName: "legacy-plan",
    })];

    const outcome = readLatestPlanOutcome(messages);
    assertEquals(Number(outcome?.outcome), 1);
    assertEquals(outcome?.planName, "legacy-plan");
});
