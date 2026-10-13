import { assertEquals } from "../../testing/assertions.ts";
import { mkdtemp as fsMkdtemp, rm as fsRm } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { strictEqual as assertStrictEquals } from "node:assert/strict";
import { HostedSession } from "./hosted-session.js";
import { requestHostedSessionInteraction, RuntimeInteractionTypes } from "./session-runtime-interactions.js";
import { emitHostedSessionRuntimeEvent, RuntimeEventTypes } from "./session-runtime-events.js";

test("Plan review captures only the selected Architect and keeps the same conversation through dehydration", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    const session = new HostedSession({ id: crypto.randomUUID(), cwd });
    const other = new HostedSession({ id: crypto.randomUUID(), cwd });
    try {
        const conversation = session.planReviewConversations.select("epic-a", "architect");
        const events = conversation.events;
        for (const [agentName, delta] of [["Architect", "First reply"], ["Planner", "Other reply"]]) {
            emitHostedSessionRuntimeEvent(session, {
                type: RuntimeEventTypes.ASSISTANT_TEXT_DELTA,
                agentName,
                delta,
                messageId: crypto.randomUUID(),
                messageKind: "assistant",
            });
        }
        assertEquals(conversation.events.map((event) => event.delta), ["First reply"]);
        session.dehydrateManagedSession();
        assertStrictEquals(session.planReviewConversations.select("epic-a", "architect"), conversation);
        assertStrictEquals(conversation.events, events);
        const unrelated = session.planReviewConversations.select("epic-b", "architect");
        assertEquals(unrelated.events, []);
        assertEquals(other.planReviewConversations.select("epic-a", "architect").events, []);
        session.planReviewConversations.stopCapture("epic-b");
        emitHostedSessionRuntimeEvent(session, {
            type: RuntimeEventTypes.ASSISTANT_TEXT_DELTA,
            agentName: "Architect",
            delta: "After final decision",
            messageId: crypto.randomUUID(),
            messageKind: "assistant",
        });
        assertEquals(unrelated.events, []);
        assertEquals(conversation.events.map((event) => event.delta), ["First reply"]);
    } finally {
        await session.dispose();
        await other.dispose();
        await fsRm(cwd, { recursive: true });
    }
});

test("Plan review keeps the planning reply after final feedback and grouped Sequence chat", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    const session = new HostedSession({ id: crypto.randomUUID(), cwd });
    try {
        const answers: Array<import("./session-runtime-interactions.js").RuntimeInteractionResponse> = [
            { outcome: "selected", _meta: { approved: false, feedback: "Revise the Epic." } },
            { outcome: "accepted", _meta: { approved: false, sequenceDecision: {}, feedback: "Revise the group." } },
            { outcome: "accepted", _meta: { sequenceDecision: {}, conversationTurn: true } },
            { outcome: "accepted", _meta: { approved: true } },
        ];
        session.setInteractionAdapter({ requestInteraction: () => answers.shift() ?? { outcome: "canceled" } });
        const reply = (delta: string) =>
            emitHostedSessionRuntimeEvent(session, {
                type: RuntimeEventTypes.ASSISTANT_TEXT_DELTA,
                agentName: "Planner",
                delta,
                messageId: crypto.randomUUID(),
                messageKind: "assistant",
            });
        await requestHostedSessionInteraction(session, {
            type: RuntimeInteractionTypes.PLAN_REVIEW,
            prompt: "Review Plan",
            _meta: { planId: "review-id", planName: "plan", planningAgentName: "planner" },
        });
        reply("Reply to final feedback");
        await requestHostedSessionInteraction(session, {
            type: RuntimeInteractionTypes.PLAN_REVIEW,
            prompt: "Review Sequence",
            _meta: { planId: "review-id", planName: "plan", planningAgentName: "planner", sequenceDocuments: [] },
        });
        reply("Reply to Sequence feedback");
        await requestHostedSessionInteraction(session, {
            type: RuntimeInteractionTypes.PLAN_REVIEW,
            prompt: "Review Sequence",
            _meta: { planId: "review-id", planName: "plan", planningAgentName: "planner", sequenceDocuments: [] },
        });
        reply("Reply to Sequence chat");
        const conversation = session.getPlanReviewConversation({ planId: "review-id", planningAgentName: "planner" });
        assertEquals(conversation.events.map((event) => event.delta), [
            "Reply to final feedback",
            "Reply to Sequence feedback",
            "Reply to Sequence chat",
        ]);
        await requestHostedSessionInteraction(session, {
            type: RuntimeInteractionTypes.PLAN_REVIEW,
            prompt: "Review Plan",
            _meta: { planId: "review-id", planName: "plan", planningAgentName: "planner" },
        });
        reply("Not part of review");
        assertEquals(conversation.events.length, 3);
    } finally {
        await session.dispose();
        await fsRm(cwd, { recursive: true });
    }
});
