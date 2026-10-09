import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildArtifactConversationFeedback, collectArtifactConversationReply } from "./artifact-conversation.ts";

Deno.test("artifact conversation keeps the user message and optional review context distinct", () => {
    const feedback = buildArtifactConversationFeedback({
        message: "Tighten the verification section.",
        attachedFeedback: "Verification Plan: Add one browser annotation.",
        agentLabel: "Architect",
    });

    assertStringIncludes(feedback, "## Architect conversation");
    assertStringIncludes(feedback, "### User message\nTighten the verification section.");
    assertStringIncludes(feedback, "### Attached review annotations\nVerification Plan: Add one browser annotation.");
    assertStringIncludes(feedback, "call `plan_written` again");
});

Deno.test("artifact conversation collects only new Planner text deltas", () => {
    const reply = collectArtifactConversationReply([
        { type: "assistant_text_delta", messageId: "old", delta: "Old reply" },
        { type: "tool_start" },
        { type: "assistant_text_delta", messageId: "new", agentName: "Planner", delta: "I tightened " },
        { type: "assistant_text_delta", messageId: "new", agentName: "Planner", delta: "the checks." },
    ], 1);

    assertEquals(reply, { text: "I tightened the checks.", agentName: "Planner" });
});

Deno.test("Plan and Code Review conversations accept annotations without a user message", () => {
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
