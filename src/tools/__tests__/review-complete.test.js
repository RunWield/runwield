import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { HostedSession } from "../../shared/session/hosted-session.js";
import { RuntimeEventTypes } from "../../shared/session/session-runtime-events.js";
import { createReviewCompletedTool } from "../review-complete.ts";
import { makeToolProjectFixture, withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";

const REVIEW_PROJECT_ROOT = makeToolProjectFixture("runwield-review-complete-");

for (const approved of [true, false]) {
    test(`review_complete emits one semantic result when approved=${approved}`, async () => {
        await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
            const events = /** @type {any[]} */ ([]);
            const hostedSession = new HostedSession({ id: `review-${approved}`, cwd: projectRoot });
            hostedSession.setEventSink({ emit: (/** @type {any} */ event) => events.push(event) });
            const tool = createReviewCompletedTool({ hostedSession, agentName: "reviewer" });

            const result = await /** @type {any} */ (tool.execute)("call", {
                approved,
                feedback: approved ? "ship it" : "fix the boundary",
            });

            assertEquals(result.terminate, true);
            assertEquals(result.details.approved, approved);
            assertEquals(events.length, 1);
            assertEquals(events[0].type, RuntimeEventTypes.ASSISTANT_TEXT_DELTA);
            assertEquals(events[0].agentName, "reviewer");
            assertEquals(events[0].messageKind, "review_result");
            assertEquals(events[0].approved, approved);
            const metrics = await readMetrics();
            assertEquals(metrics.length, 1);
            assertEquals(metrics[0].event, "review_complete");
            assertEquals(metrics[0].details?.outcome, approved ? "approved" : "feedback");
        });
    });
}

/** @param {string} id */
function makeReviewTool(id) {
    const events = /** @type {any[]} */ ([]);
    const hostedSession = new HostedSession({ id, cwd: REVIEW_PROJECT_ROOT });
    hostedSession.setEventSink({ emit: (/** @type {any} */ event) => events.push(event) });
    const tool = createReviewCompletedTool({ hostedSession, agentName: "reviewer" });
    return { tool, events };
}

test("review_complete does not report resolved findings as outstanding issues", async () => {
    const { tool, events } = makeReviewTool("review-resolved-projection");

    // Observed live: the Reviewer narrated a resolved item alongside a new one in
    // free-text feedback, and it rendered under "issues found" — reporting finished
    // work as still broken, which makes a converging loop look stuck.
    const result = await /** @type {any} */ (tool.execute)("call", {
        approved: false,
        feedback: "- The model-availability facade is cold-empty.\n- R1-1 is fixed: the mutation queue now serializes.",
        findings: [
            { id: "R1-1", resolved: true, title: "Credential store does not serialize mutations" },
            { title: "Model-availability facade is cold-empty for runtime models" },
        ],
    });

    const message = events[0].delta;
    assertEquals(message.includes("R1-1 is fixed"), false, "a resolved item must not appear as an open issue");
    assertEquals(message.includes("1 issue open, 1 resolved this round"), true);
    assertEquals(message.includes("Model-availability facade is cold-empty"), true);
    assertEquals(result.details.findings.length, 2);
});

test("review_complete falls back to prose only when no findings are supplied", async () => {
    const { tool, events } = makeReviewTool("review-prose-fallback");

    await /** @type {any} */ (tool.execute)("call", {
        approved: false,
        feedback: "fix the boundary",
    });

    assertEquals(events[0].delta.includes("issues found"), true);
    assertEquals(events[0].delta.includes("fix the boundary"), true);
});

test("review_complete refuses to approve while a finding is unresolved", async () => {
    const { tool } = makeReviewTool("review-approve-with-open");

    const result = await /** @type {any} */ (tool.execute)("call", {
        approved: true,
        findings: [{ title: "Still missing the guard" }],
    });

    assertEquals(result.terminate, false, "an inconsistent result must not end the review");
    assertEquals(result.details.outcome, "rejected");
    assertEquals(result.details.reason, "approved_with_open_findings");
});
