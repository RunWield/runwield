// @ts-nocheck: Browser tests install happy-dom globals around the real review surface.
import { test } from "node:test";
import { act } from "react";
import { assertEquals, assertStringIncludes } from "../../../testing/assertions.ts";
import { withReview } from "./plan-review-test-dom.tsx";

const plan =
    '# Review links\n\n```wld-question\n{"id":"scope","type":"multiple_choice","prompt":"Who can use links?","choices":[{"value":"admins","label":"Admins only"},{"value":"all","label":"All members"}],"default":"admins"}\n```\n\n```wld-question\n{"id":"keep","type":"yes_no","prompt":"Keep old links?","default":true}\n```\n';
test("question forms mount through the real Viewer and update answers instead of exposing raw code", async () => {
    await withReview(async ({ container, radio }) => {
        assertEquals(container.querySelectorAll(".rw-question-card").length, 2);
        assertEquals(container.querySelector(".rw-plan-question-mounted pre").hidden, true);
        await act(() => radio("All members").click());
        assertEquals(radio("All members").checked, true);
        await act(() => radio("Other").click());
        assertEquals(Boolean(container.querySelector('textarea[aria-label="Other answer: Who can use links?"]')), true);
    }, plan);
});

test("answers restore after reload and attach to chat without a manual attach action", async () => {
    await withReview(async ({ container, radio, reload, openChat }) => {
        await act(() => radio("All members").click());
        await act(async () => await new Promise((resolve) => setTimeout(resolve, 550)));
        await reload();
        assertEquals(radio("All members").checked, true);
        await openChat();
        assertStringIncludes(container.textContent, "1 question answer attached");
    }, plan);
});

test("chat Send carries answers and removing the context chip excludes them", async () => {
    await withReview(async ({ browser, container, button, radio, openChat, submitted }) => {
        await act(() => radio("All members").click());
        await openChat();
        await act(() => button("Send to Planner").click());
        assertStringIncludes(submitted[0].feedback, "### Question answers");
        assertStringIncludes(submitted[0].feedback, "All members");
        await act(() => container.querySelector('[aria-label="Remove attached annotations"]').click());
        const composer = container.querySelector('textarea[placeholder="Message Planner…"]');
        await act(() => {
            Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(
                composer,
                "Keep the Plan.",
            );
            composer.dispatchEvent(new browser.Event("input", { bubbles: true }));
        });
        await act(() => button("Send to Planner").click());
        assertEquals(submitted[1].feedback.includes("### Question answers"), false);
    }, plan);
});

test("approval warns about open questions, cancel stays open, and confirm sends structured answers", async () => {
    await withReview(async ({ button, radio, submitted, confirmations, confirm }) => {
        await act(() => radio("All members").click());
        await act(() => button("Approve & Run").click());
        assertEquals(submitted.length, 0);
        assertStringIncludes(confirmations[0], "1 question is not answered. The recommended answers will be used.");
        confirm(true);
        await act(() => button("Approve & Run").click());
        assertEquals(submitted[0].questionAnswers, [{ id: "scope", value: "all" }]);
    }, plan);
});

test("invalid questions keep the real Viewer code block with a visible parse error", async () => {
    await withReview(({ container }) => {
        assertEquals(container.querySelectorAll(".rw-question-card").length, 0);
        assertEquals(container.querySelector("pre").hidden, false);
        assertStringIncludes(container.querySelector('[role="note"]').textContent, "Question needs an id.");
    }, '# Plan\n\n```wld-question\n{"type":"text","prompt":"Which message?"}\n```\n');
});

test("text questions accept free text and mark the recommendation without using it as an owner answer", async () => {
    await withReview(async ({ browser, container, openChat }) => {
        const field = container.querySelector('textarea[aria-label="Which message?"]');
        assertEquals(field.value, "");
        assertStringIncludes(container.textContent, "Recommended: Follow the link.");
        await act(() => {
            Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(
                field,
                "Opening the saved Plan.",
            );
            field.dispatchEvent(new browser.Event("input", { bubbles: true }));
        });
        await openChat();
        assertStringIncludes(container.textContent, "1 question answer attached");
    }, '# Plan\n\n```wld-question\n{"id":"message","type":"text","prompt":"Which message?","default":"Follow the link."}\n```\n');
});

test("a Planner revision drops answers for removed question ids", async () => {
    await withReview(async ({ container, button, radio, openChat, submitted, revise, confirm }) => {
        await act(() => radio("All members").click());
        await openChat();
        revise(plan.replace(/```wld-question[\s\S]*?```\n\n/, "Audience: All members.\n\n"));
        await act(() => button("Send to Planner").click());
        assertEquals(Boolean(container.querySelector(".rw-artifact-conversation-context")), false);
        await act(() => button("View").click());
        assertEquals(container.querySelectorAll(".rw-question-card").length, 1);
        confirm(true);
        await act(() => button("Approve & Run").click());
        assertEquals(submitted[1].questionAnswers, []);
    }, plan);
});

test("question answers combine with attached notes and annotation-only Send stays available", async () => {
    await withReview(async ({ browser, container, button, radio, submitted }) => {
        await act(() => button("Global comment").click());
        const note = browser.document.querySelector('textarea[placeholder="Add a global comment..."]');
        await act(() => {
            Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(
                note,
                "Clarify the link rules.",
            );
            note.dispatchEvent(new browser.Event("input", { bubbles: true }));
        });
        const add = [...browser.document.querySelectorAll("button")].find(
            (element) => element.textContent.trim() === "Add",
        );
        await act(() => add.click());
        await act(() => button("Add to Planner chat").click());
        assertStringIncludes(container.textContent, "1 review note attached");
        assertEquals(button("Send to Planner").disabled, false);
        await act(() => radio("All members").click());
        assertStringIncludes(container.textContent, "1 review note and 1 question answer attached");
        await act(() => button("Send to Planner").click());
        assertStringIncludes(submitted[0].feedback, "Clarify the link rules.");
        assertStringIncludes(submitted[0].feedback, "### Question answers");
    }, plan);
});

test("Send Annotations includes answered questions without a chat message", async () => {
    await withReview(async ({ container, button, radio, submitted }) => {
        await act(() => radio("All members").click());
        await act(() => container.querySelector('[aria-label="Open annotations sidebar"]').click());
        await act(() => button("Send Annotations").click());
        assertStringIncludes(submitted[0].feedback, "### Question answers");
        assertStringIncludes(submitted[0].feedback, "All members");
    }, plan);
});

test("question forms mount at their source location after an indented example", async () => {
    const example = '    ```wld-question\n    {"id":"scope","type":"text","prompt":"Example only"}\n    ```\n\n';
    await withReview(
        ({ container }) => {
            const codeBlocks = [...container.querySelectorAll("[data-block-id]")].filter((element) =>
                element.querySelector("pre"),
            );
            assertEquals(codeBlocks.length, 3);
            assertEquals(codeBlocks[0].querySelector("pre").hidden, false);
            assertEquals(codeBlocks[0].querySelector(".rw-question-card"), null);
            assertStringIncludes(codeBlocks[1].querySelector(".rw-question-card").textContent, "Who can use links?");
            assertStringIncludes(codeBlocks[2].querySelector(".rw-question-card").textContent, "Keep old links?");
        },
        "---\ntitle: Review\n---\n\n" + example + plan,
    );
});

for (const detach of [false, true]) {
    test(`answer-only chat preserves ${detach ? "detached" : "unattached"} notes and their saved draft`, async () => {
        await withReview(async ({ browser, container, button, radio, submitted, reload }) => {
            await act(() => button("Global comment").click());
            const note = browser.document.querySelector('textarea[placeholder="Add a global comment..."]');
            await act(() => {
                Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(
                    note,
                    "Keep this review note.",
                );
                note.dispatchEvent(new browser.Event("input", { bubbles: true }));
            });
            await act(() =>
                [...browser.document.querySelectorAll("button")]
                    .find((element) => element.textContent.trim() === "Add")
                    .click(),
            );
            if (detach) {
                await act(() => button("Add to Planner chat").click());
                await act(() => container.querySelector('[aria-label="Remove attached annotations"]').click());
            } else {
                await act(() => container.querySelector('button[role="tab"][title="Planner"]').click());
            }
            await act(() => radio("All members").click());
            await act(() => button("Send to Planner").click());
            assertEquals(submitted[0].feedback.includes("Keep this review note."), false);
            assertStringIncludes(submitted[0].feedback, "### Question answers");
            await act(() => container.querySelector('button[role="tab"][title="Annotations"]').click());
            assertStringIncludes(container.textContent, "Keep this review note.");
            await act(async () => await new Promise((resolve) => setTimeout(resolve, 550)));
            await reload();
            await act(() => button("Restore draft").click());
            assertStringIncludes(container.textContent, "Keep this review note.");
        }, plan);
    });
}
