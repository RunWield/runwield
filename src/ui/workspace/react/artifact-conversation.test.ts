import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../../testing/assertions.ts";
import { buildArtifactConversationFeedback, collectArtifactConversationReply } from "./artifact-conversation.ts";

test("artifact conversation keeps the user message and optional review context distinct", () => {
    const feedback = buildArtifactConversationFeedback({
        message: "Tighten the verification section.",
        attachedFeedback: "Verification Plan: Add one browser annotation.",
        agentLabel: "Architect",
    });

    assertStringIncludes(feedback, "## Architect conversation");
    assertStringIncludes(feedback, "### User message\nTighten the verification section.");
    assertStringIncludes(feedback, "### Attached review annotations\nVerification Plan: Add one browser annotation.");
    assertStringIncludes(feedback, "Revise the Plan and call `plan_written`");
    assertStringIncludes(feedback, "A reply without a revision keeps the review open.");
    assertEquals(feedback.includes("even when"), false);
});

test("artifact conversation collects only new Planner text deltas", () => {
    const reply = collectArtifactConversationReply(
        [
            { type: "assistant_text_delta", messageId: "old", delta: "Old reply" },
            { type: "tool_start" },
            { type: "assistant_text_delta", messageId: "new", agentName: "Planner", delta: "I tightened " },
            { type: "assistant_text_delta", messageId: "new", agentName: "Planner", delta: "the checks." },
        ],
        1,
    );

    assertEquals(reply, { text: "I tightened the checks.", agentName: "Planner" });
});

for (const type of ["system_status", "terminal_error"]) {
    test(`review conversation shows ${type} errors instead of a successful unchanged reply`, () => {
        const reply = collectArtifactConversationReply(
            [
                { type: "system_status", level: "error", message: "An earlier failure." },
                { type: "assistant_text_delta", delta: "Let me explain.", messageId: "reply" },
                { type, level: "error", message: "The planning provider is unavailable.", messageId: "failure" },
                { type: "system_status", level: "info", message: "Review opened." },
            ],
            1,
        );
        assertEquals(reply.text, "Agent error: The planning provider is unavailable.");
    });
}

test("Plan and Code Review conversations accept annotations without a user message", () => {
    for (const artifactKind of ["plan", "code"] as const) {
        const feedback = buildArtifactConversationFeedback({
            message: "  ",
            attachedFeedback: "Fix the missing error handling.",
            artifactKind,
        });
        assertStringIncludes(feedback, "### Attached review annotations\nFix the missing error handling.");
        assertEquals(feedback.includes("### User message"), false);
        assertStringIncludes(feedback, "### Continue the review");
    }
});
