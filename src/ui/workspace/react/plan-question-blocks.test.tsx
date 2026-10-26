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

test("answers restore after reload and enter the queue without a manual attach action", async () => {
    await withReview(async ({ container, radio, reload, openChat }) => {
        await act(() => radio("All members").click());
        await act(async () => await new Promise((resolve) => setTimeout(resolve, 550)));
        await reload();
        assertEquals(radio("All members").checked, true);
        await openChat();
        assertStringIncludes(container.textContent, "1 answers");
    }, plan);
});

test("chat Send carries answers and excluding answers preserves them for a later send", async () => {
    await withReview(async ({ container, button, radio, openChat, submitted, fill }) => {
        await act(() => radio("All members").click());
        await openChat();
        await act(() => button("Exclude answers").click());
        await fill(container.querySelector('textarea[aria-label="Message Planner"]'), "Keep the Plan.");
        await act(() => button("Send to Planner").click());
        assertEquals(submitted[0].feedback.includes("### Question answers"), false);
        assertEquals(radio("All members").checked, true);
        assertStringIncludes(container.querySelector('[aria-label="Review Queue"]').textContent, "1 answers");
        await act(() => button("Send to Planner").click());
        assertStringIncludes(submitted[1].feedback, "### Question answers");
        assertStringIncludes(submitted[1].feedback, "All members");
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

test("Sequence approval counts open questions across tabs, cancel sends nothing, and confirm sends each tab's answers", async () => {
    const sequenceDocuments = [
        {
            planId: "sequence",
            planName: "sequence",
            plan:
                plan.replace("# Review links", "# Sequence") +
                '\n```wld-question\n{"type":"text","prompt":"Invalid question"}\n```\n',
            frontmatter: { classification: "PLANNED_CHANGE", type: "SEQUENCE" },
        },
        {
            planId: "child",
            planName: "child",
            plan,
            frontmatter: { classification: "PLANNED_CHANGE" },
        },
    ];
    await withReview(
        async ({ container, button, radio, submitted, confirmations, confirm }) => {
            await act(() => radio("All members").click());
            await act(() => button("1. Review links").focus());
            const child = container.querySelector('[role="tabpanel"]:not([hidden])');
            const no = [...child.querySelectorAll("label")]
                .find((element) => element.textContent === "No")
                .querySelector("input");
            await act(() => no.click());
            await act(() => button("Sequence overview").focus());
            await act(() => button("Approve & Execute").click());
            assertEquals(confirmations, ["2 questions are not answered. The recommended answers will be used."]);
            assertEquals(submitted, []);
            assertEquals(radio("All members").checked, true);
            assertEquals(no.checked, true);
            confirm(true);
            await act(() => button("1. Review links").focus());
            await act(() => button("Approve & Execute").click());
            assertEquals(confirmations.length, 2);
            assertEquals(confirmations[1], confirmations[0]);
            assertEquals(submitted.length, 1);
            assertEquals(submitted[0].approved, true);
            assertEquals(
                submitted[0].documents.map(({ planId, questionAnswers }) => ({ planId, questionAnswers })),
                [
                    { planId: "sequence", questionAnswers: [{ id: "scope", value: "all" }] },
                    { planId: "child", questionAnswers: [{ id: "keep", value: false }] },
                ],
            );
        },
        sequenceDocuments[0].plan,
        { sequenceDocuments },
    );
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
        assertStringIncludes(container.textContent, "1 answers");
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

test("question answers combine with automatically included notes and annotation-only Send stays available", async () => {
    await withReview(async ({ container, button, radio, submitted, addNote, openChat }) => {
        await addNote("Clarify the link rules.");
        await openChat();
        assertStringIncludes(container.textContent, "1 annotations");
        assertEquals(button("Send to Planner").disabled, false);
        await act(() => radio("All members").click());
        assertStringIncludes(container.textContent, "1 answers");
        await act(() => button("Send to Planner").click());
        assertStringIncludes(submitted[0].feedback, "Clarify the link rules.");
        assertStringIncludes(submitted[0].feedback, "### Question answers");
        assertEquals(container.querySelector('[aria-label="Review Queue"]'), null);
    }, plan);
});

test("Submit answer includes only one answer and does not repeat it in the next chat send", async () => {
    await withReview(async ({ container, button, radio, submitted, addNote, openChat, fill }) => {
        await addNote("Keep this note queued.");
        await openChat();
        await fill(container.querySelector('textarea[aria-label="Message Planner"]'), "Keep this message unsent.");
        await act(() => radio("All members").click());
        await act(() => radio("No").click());
        await act(() => container.querySelectorAll(".rw-question-card button")[0].click());
        assertStringIncludes(submitted[0].feedback, "### Question answers");
        assertStringIncludes(submitted[0].feedback, "All members");
        assertEquals(submitted[0].feedback.includes("Keep this"), false);
        assertEquals(submitted[0].feedback.includes("Keep old links?"), false);
        assertEquals(submitted[0].questionAnswers, [{ id: "scope", value: "all" }]);
        assertStringIncludes(container.querySelectorAll(".rw-question-card")[0].textContent, "Answer sent");
        assertEquals(
            container.querySelector('textarea[aria-label="Message Planner"]').value,
            "Keep this message unsent.",
        );
        await act(() => button("Send to Planner").click());
        assertStringIncludes(submitted[1].feedback, "Keep this note queued.");
        assertStringIncludes(submitted[1].feedback, "Keep old links?");
        assertEquals(submitted[1].feedback.includes("All members"), false);
        await act(() => radio("Admins only").click());
        assertEquals(Boolean(container.querySelectorAll(".rw-question-card")[0].querySelector("button")), true);
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

for (const exclude of [false, true]) {
    test(`Submit answer preserves ${exclude ? "excluded" : "included"} notes and their saved draft`, async () => {
        await withReview(async ({ container, button, radio, submitted, reload, addNote, openChat }) => {
            await addNote("Keep this review note.");
            await openChat();
            if (exclude) await act(() => button("Exclude annotations").click());
            await act(() => radio("All members").click());
            await act(() => container.querySelector(".rw-question-card button").click());
            assertEquals(submitted[0].feedback.includes("Keep this review note."), false);
            assertStringIncludes(submitted[0].feedback, "### Question answers");
            await act(() => container.querySelector('button[role="tab"][title="Annotations"]').click());
            assertStringIncludes(container.textContent, "Keep this review note.");
            await act(async () => await new Promise((resolve) => setTimeout(resolve, 550)));
            await reload();
            await act(() => button("Restore draft").click());
            await act(() => container.querySelector('button[role="tab"][title="Annotations"]').click());
            assertStringIncludes(container.textContent, "Keep this review note.");
        }, plan);
    });
}

test("Submit answer is disabled while the Agent works and the other answer stays queued", async () => {
    await withReview(async ({ container, button, radio, submitted, hold, release, openChat }) => {
        await act(() => radio("All members").click());
        await act(() => radio("No").click());
        await openChat();
        hold();
        await act(() => container.querySelector(".rw-question-card button").click());
        assertEquals(submitted.length, 1);
        assertEquals(container.querySelectorAll(".rw-question-card")[1].querySelector("button").disabled, true);
        assertEquals(button("Send to Planner").disabled, true);
        assertStringIncludes(container.querySelector('[aria-label="Review Queue"]').textContent, "1 answers");
        await release();
        assertEquals(container.querySelectorAll(".rw-question-card")[1].querySelector("button").disabled, false);
    }, plan);
});

test("a failed Submit answer keeps its answer queued and allows retry", async () => {
    await withReview(async ({ container, radio, submitted, failNext }) => {
        await act(() => radio("All members").click());
        failNext();
        await act(() => container.querySelector(".rw-question-card button").click());
        assertEquals(submitted.length, 0);
        assertEquals(radio("All members").checked, true);
        assertEquals(container.querySelector(".rw-question-card button").disabled, false);
        await act(() => container.querySelector(".rw-question-card button").click());
        assertEquals(submitted.length, 1);
        assertStringIncludes(container.querySelector(".rw-question-card").textContent, "Answer sent");
    }, plan);
});
