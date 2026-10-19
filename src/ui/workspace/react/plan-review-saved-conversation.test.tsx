// @ts-nocheck: Browser tests install happy-dom globals around the real review surface.
import { test } from "node:test";
import { act } from "react";
import { assertEquals, assertStringIncludes } from "../../../testing/assertions.ts";
import { withReview } from "./plan-review-test-dom.tsx";

const plan = "# Saved Plan\n\nPlan round N.\n";
const nextPlan = "# Saved Plan\n\nPlan round N+1.\n";
const payload = { savedConversation: true, reviewRevisionUrl: "/revision", reviewRevision: 0, agentLabel: "Claude" };

function savedConversation() {
    return {
        reviewRevision: 0,
        revision: 0,
        pending: true,
        plan,
        rawPatch: "",
        events: [],
        turns: [{ turnId: "queued", message: "Question queued before MCP restart" }],
    };
}

const poll = () =>
    act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 800));
    });

test("Plan Review restores the queued user message on a new page and displays the polled answer", async () => {
    let snapshot = savedConversation();
    await withReview(
        async ({ container, openChat, reload }) => {
            await openChat();
            assertStringIncludes(container.textContent, "Question queued before MCP restart");
            snapshot = {
                ...snapshot,
                pending: false,
                revision: 1,
                turns: [{ ...snapshot.turns[0], reply: "Answer after MCP restart" }],
                events: [{ messageId: "queued", delta: "Answer after MCP restart" }],
            };
            await poll();
            assertStringIncludes(container.textContent, "Answer after MCP restart");
            await reload();
            await openChat();
            assertStringIncludes(container.textContent, "Question queued before MCP restart");
            assertStringIncludes(container.textContent, "Answer after MCP restart");
        },
        plan,
        { payload, conversation: () => snapshot },
    );
});

test("Plan Review can chat and approve on the same page after the artifact advances to N+1", async () => {
    let snapshot = savedConversation();
    await withReview(
        async ({ container, openChat, submitted, button }) => {
            snapshot = { ...snapshot, plan: nextPlan, reviewRevision: 1, revision: 1, pending: false, turns: [] };
            await poll();
            assertStringIncludes(container.textContent, "Plan round N+1.");
            await openChat();
            const composer = container.querySelector("textarea");
            await act(() => {
                const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
                setter.call(composer, "Question about N+1");
                composer.dispatchEvent(new window.Event("input", { bubbles: true }));
            });
            const send = container.querySelector(".rw-review-action-button");
            assertEquals(send.disabled, false);
            await act(() => send.click());
            assertEquals(submitted.at(-1).conversationTurn, true);
            assertEquals(submitted.at(-1).reviewRevision, 1);
            assertEquals(submitted.at(-1).feedback, "Question about N+1");
            await act(() => button("Approve & Ready").click());
            assertEquals(submitted.at(-1).approvalAction, "run");
            assertEquals(submitted.at(-1).reviewRevision, 1);
        },
        plan,
        { payload, conversation: () => snapshot },
    );
});
