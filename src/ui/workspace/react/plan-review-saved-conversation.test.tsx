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

test("Plan Review stops waiting after 180 seconds and still displays a late saved revision", async () => {
    let snapshot = savedConversation();
    const now = Date.now;
    let elapsed = 0;
    Date.now = () => now() + elapsed;
    try {
        await withReview(
            async ({ container, openChat }) => {
                await openChat();
                assertStringIncludes(container.textContent, "Claude is reviewing the Plan");
                elapsed = 179_000;
                await poll();
                assertEquals(container.textContent.includes("Claude is still working"), false);
                elapsed = 180_000;
                await poll();
                assertStringIncludes(container.textContent, "Claude is still working");
                assertEquals(container.textContent.includes("Claude is reviewing the Plan"), false);
                await poll();
                assertEquals(container.textContent.includes("Claude is reviewing the Plan"), false);
                snapshot = { ...snapshot, pending: false, plan: nextPlan, reviewRevision: 1, revision: 1, turns: [] };
                await poll();
                assertStringIncludes(container.textContent, "Plan round N+1.");
                assertEquals(container.textContent.includes("Claude is still working"), false);
            },
            plan,
            { payload, conversation: () => snapshot },
        );
    } finally {
        Date.now = now;
    }
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
            const browser = composer.ownerDocument.defaultView;
            await act(() => {
                const setter = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set;
                setter.call(composer, "Question about N+1");
                composer.dispatchEvent(new browser.Event("input", { bubbles: true }));
            });
            const send = container.querySelector(".rw-review-action-button");
            assertEquals(send.disabled, false);
            await act(() => send.click());
            assertEquals(submitted.at(-1).conversationTurn, true);
            assertEquals(submitted.at(-1).reviewRevision, 1);
            assertEquals(submitted.at(-1).feedback, "Question about N+1");
            await act(() => button("Approve & Run").click());
            assertEquals(submitted.at(-1).approvalAction, "run");
            assertEquals(submitted.at(-1).reviewRevision, 1);
            assertStringIncludes(container.textContent, "Approved & Run");
            assertStringIncludes(container.textContent, "Claude starts implementation in a RunWield worktree.");
            assertEquals(container.textContent.includes("Approve & Ready"), false);
        },
        plan,
        { payload, conversation: () => snapshot },
    );
});

test("Attached Plan approval for later saves the Plan without claiming execution", async () => {
    await withReview(
        async ({ container, submitted, button }) => {
            await act(() => button("More approval options").click());
            await act(() =>
                [...container.querySelectorAll("button")]
                    .find((element) => element.textContent.includes("Approve for Later"))
                    .click(),
            );
            assertEquals(submitted.at(-1).approvalAction, "later");
            assertStringIncludes(container.textContent, "Approved for later");
            assertStringIncludes(container.textContent, "The Plan is Ready For Work. /runwield:implement starts it.");
            assertEquals(container.textContent.includes("Approve & Ready"), false);
        },
        plan,
        { payload, conversation: () => ({ ...savedConversation(), pending: false, turns: [] }) },
    );
});
