/** Instructions shared by tool reviews and direct saved-Plan reviews. */
export function buildPlanConversationRequest({ planName, feedback }: { planName: string; feedback?: string }): string {
    return [
        `## Plan review conversation: docs/plans/${planName}.md`,
        "",
        feedback || "(no message provided)",
        "",
        "Reply in chat to explain, clarify, or ask a question. Revise the Plan and call plan_written when the answer changes scope, behavior, a decision, or verification. When in doubt, revise. RunWield keeps the review open; do not call plan_written for an unchanged Plan.",
    ].join("\n");
}
