export interface ArtifactConversationEvent {
    type?: string;
    delta?: string;
    messageId?: string;
    agentName?: string;
}

export interface ArtifactConversationFeedbackInput {
    message: string;
    attachedFeedback?: string;
    agentLabel?: string;
    artifactKind?: "plan" | "code";
}

export function buildArtifactConversationFeedback(input: ArtifactConversationFeedbackInput): string {
    const message = input.message.trim();
    const attachedFeedback = input.attachedFeedback?.trim() || "";
    const codeReview = input.artifactKind === "code";
    return [
        `## ${input.agentLabel || "Planner"} conversation`,
        "",
        ...(message ? ["### User message", message] : []),
        ...(attachedFeedback ? ["", "### Attached review annotations", attachedFeedback] : []),
        "",
        "### Continue the review",
        codeReview
            ? "Reply briefly to the user, then update the working files when the request requires it. " +
                "Finish by reporting what changed so Code Review can reload the current diff."
            : "Reply briefly to the user before using tools. Update the Plan when the request requires it. " +
                "Then call `plan_written` again, even when the Plan does not need a change, so the review remains open.",
    ].join("\n");
}

export function collectArtifactConversationReply(
    events: ArtifactConversationEvent[],
    startIndex: number,
): { text: string; agentName: string } {
    const messages = new Map<string, { text: string; agentName: string }>();
    let anonymousIndex = 0;
    for (const event of events.slice(Math.max(0, startIndex))) {
        if (event.type !== "assistant_text_delta" || typeof event.delta !== "string") continue;
        const messageId = event.messageId || `anonymous-${anonymousIndex++}`;
        const current = messages.get(messageId) || { text: "", agentName: event.agentName || "Planner" };
        current.text += event.delta;
        if (event.agentName) current.agentName = event.agentName;
        messages.set(messageId, current);
    }
    const completed = [...messages.values()].filter((message) => message.text.trim());
    const latest = completed.at(-1);
    return {
        text: latest?.text.trim() || "",
        agentName: latest?.agentName || "Planner",
    };
}
