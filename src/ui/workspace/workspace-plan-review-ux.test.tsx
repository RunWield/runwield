// @ts-nocheck: This fixture runs through scripts/run-tests.ts outside Astro check.
// @ts-nocheck: This fixture runs through scripts/run-tests.ts outside Astro check.
import { test } from "node:test";
import { act } from "react";
import { withReview } from "./react/plan-review-test-dom.tsx";
import {
    createPlanReviewDraft,
    parsePlanReviewDraft,
    planReviewDraftKey,
    serializePlanReviewDraft,
} from "./react/plan-review-draft.ts";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";

test("Plan annotations use default chat and a per-type queue instead of sending or attaching from the pane", async () => {
    await withReview(async ({ container, button, addNote, openChat, fill, submitted }) => {
        const opener = container.querySelector('[aria-label="Open annotations sidebar"]');
        if (opener) await act(() => opener.click());
        assertEquals(container.querySelector('button[title="Planner"]').getAttribute("aria-selected"), "true");
        await addNote("Keep the existing URLs.");
        assertStringIncludes(container.querySelector('[aria-label="Review Queue"]').textContent, "1 annotations");
        await act(() => button("Exclude annotations").click());
        await fill(container.querySelector('textarea[aria-label="Message Planner"]'), "Why is this needed?");
        await act(() => button("Send to Planner").click());
        assertEquals(submitted[0].feedback.includes("Keep the existing URLs."), false);
        assertStringIncludes(container.querySelector('[aria-label="Review Queue"]').textContent, "1 annotations");
        await act(() => container.querySelector('button[title="Annotations"]').click());
        assertStringIncludes(container.textContent, "Keep the existing URLs.");
        assertEquals(button("Send Annotations"), undefined);
        assertEquals(button("Add to Planner chat"), undefined);
        await openChat();
        await act(() => button("Send to Planner").click());
        assertStringIncludes(submitted[1].feedback, "Keep the existing URLs.");
        assertEquals(container.querySelector('[aria-label="Review Queue"]'), null);
    }, "# Plan\n\nPreserve saved URLs.\n");
});

test("Plan reviews without a conversation retain the Send Annotations fallback", async () => {
    await withReview(
        async ({ container, button, addNote, submitted }) => {
            await addNote("Clarify offline use.");
            assertEquals(Boolean(button("Send Annotations")), true);
            await act(() => button("Send Annotations").click());
            assertStringIncludes(submitted[0].feedback, "Clarify offline use.");
            assertEquals(submitted[0].conversationTurn, undefined);
            assertEquals(container.querySelector('[aria-label="Planner conversation"]'), null);
        },
        "# Plan\n",
        { conversationStatusUrl: undefined },
    );
});

const questionPlan =
    '# Plan\n\n- [ ] Keep saved links\n\n```wld-question\n{"id":"scope","type":"yes_no","prompt":"Keep old links?","default":true}\n```\n';

test("excluded direct edits cannot be saved by a chat turn and approval still forwards them", async () => {
    await withReview(async ({ container, button, openChat, fill, submitted, confirm }) => {
        await act(() => container.querySelector('[role="checkbox"]').click());
        await openChat();
        assertStringIncludes(container.querySelector('[aria-label="Review Queue"]').textContent, "1 direct edits");
        await act(() => button("Exclude direct edits").click());
        await fill(container.querySelector('textarea[aria-label="Message Planner"]'), "Explain the current Plan.");
        await act(() => button("Send to Planner").click());
        assertEquals(submitted[0].plan, questionPlan);
        assertEquals(submitted[0].feedback.includes("### Direct"), false);
        assertStringIncludes(container.querySelector('[aria-label="Review Queue"]').textContent, "1 direct edits");
        await act(() => button("Exclude direct edits").click());
        await act(() => button("Approve & Run").click());
        assertEquals(submitted.length, 1);
        confirm(true);
        await act(() => button("Approve as is").click());
        assertStringIncludes(submitted[1].plan, "- [x] Keep saved links");
        assertStringIncludes(submitted[1].feedback, "Keep saved links");
    }, questionPlan);
});

for (const sentEdit of [false, true]) {
    test(`an Agent revision preserves direct edits made while waiting ${sentEdit ? "after sending an earlier edit" : "without a sent edit"}`, async () => {
        await withReview(
            async ({ browser, container, button, openChat, fill, submitted, hold, release, revise, confirm }) => {
                if (sentEdit) await act(() => container.querySelector('[role="checkbox"]').click());
                await openChat();
                await fill(container.querySelector('textarea[aria-label="Message Planner"]'), "Clarify the rollout.");
                hold();
                await act(() => button("Send to Planner").click());
                assertEquals(submitted.length, 1);
                const sentPlan = sentEdit ? questionPlan.replace("- [ ]", "- [x]") : questionPlan;
                assertEquals(submitted[0].plan, sentPlan);

                await act(() => container.querySelector('[role="checkbox"]').click());
                const ownerDraft = sentEdit ? questionPlan : questionPlan.replace("- [ ]", "- [x]");
                const revisedPlan = `${sentPlan}\nAgent rollout detail.\n`;
                revise(revisedPlan);
                await release();

                assertStringIncludes(
                    container.querySelector('[aria-label="Review Queue"]')?.textContent || "",
                    "1 direct edits",
                );
                browser.dispatchEvent(new browser.Event("pagehide"));
                const saved = parsePlanReviewDraft(
                    browser.localStorage.getItem(planReviewDraftKey("questions")),
                    revisedPlan,
                );
                assertEquals(saved?.editedPlan, ownerDraft);
                confirm(true);
                await act(() => button("Approve & Run").click());
                assertEquals(submitted.length, 2);
                assertEquals(submitted[1].plan, ownerDraft);
                assertStringIncludes(submitted[1].feedback, "Keep saved links");
            },
            questionPlan,
        );
    });
}

for (const revised of [false, true]) {
    test(`approval ${revised ? "does not warn after a revision" : "warns after a reply-only turn and Cancel keeps review open"}`, async () => {
        await withReview(async ({ container, button, openChat, fill, submitted, revise, reply }) => {
            await openChat();
            await fill(container.querySelector('textarea[aria-label="Message Planner"]'), "Explain the choice.");
            if (revised) revise("# Plan\n\nUpdated choice.\n");
            reply("Here is the reason.");
            await act(() => button("Send to Planner").click());
            assertStringIncludes(
                container.querySelector('[aria-label="Planner conversation"]').textContent,
                "Here is the reason.",
            );
            await act(() => button("Approve & Run").click());
            if (revised) {
                assertEquals(submitted.length, 2);
                assertEquals(container.querySelector("dialog"), null);
            } else {
                assertEquals(submitted.length, 1);
                assertStringIncludes(container.querySelector("dialog").textContent, "Ask Planner to update the Plan");
                await act(() => button("Cancel").click());
                assertEquals(container.querySelector("dialog"), null);
                assertEquals(submitted.length, 1);
                await act(() => button("Approve & Run").click());
                await act(() => button("Approve as is").click());
                assertEquals(submitted[1].approved, true);
            }
        }, "# Plan\n\nCurrent choice.\n");
    });
}

test("a saved owner revision permits approval when the Agent echoes the sent Plan unchanged", async () => {
    await withReview(async ({ container, button, openChat, fill, submitted, revise, reply, confirm }) => {
        await openChat();
        const composer = container.querySelector('textarea[aria-label="Message Planner"]');
        await fill(composer, "Explain the choice.");
        await act(() => button("Send to Planner").click());
        await act(() => container.querySelector('[role="checkbox"]').click());
        const editedPlan = questionPlan.replace("- [ ]", "- [x]");
        revise(editedPlan);
        reply("The saved task change is sufficient.");
        await fill(composer, "Keep my task change.");
        await act(() => button("Send to Planner").click());
        assertEquals(submitted[1].plan, editedPlan);
        assertEquals(container.querySelector('[aria-label="Review Queue"]'), null);
        confirm(true);
        await act(() => button("Approve & Run").click());
        assertEquals(container.querySelector("dialog"), null);
        assertEquals(submitted.length, 3);
        assertEquals(submitted[2].approved, true);
        assertEquals(submitted[2].plan, editedPlan);
    }, questionPlan);
});

test("Workspace reply-only recovery displays the Agent error and keeps review approvable", async () => {
    await withReview(
        async ({ container, button, openChat, fill, submitted, failAgent }) => {
            await openChat();
            await fill(container.querySelector('textarea[aria-label="Message Planner"]'), "Explain the scope.");
            failAgent("The planning provider is unavailable.");
            await act(() => button("Send to Planner").click());
            assertStringIncludes(
                container.querySelector('[aria-label="Planner conversation"]').textContent,
                "Agent error: The planning provider is unavailable.",
            );
            assertEquals(container.textContent.includes("I reviewed that request and left the Plan unchanged."), false);
            await act(() => button("Approve & Run").click());
            await act(() => button("Approve as is").click());
            assertEquals(submitted[1].approved, true);
        },
        "# Plan\n\nCurrent scope.\n",
        {
            conversationStatusUrl: undefined,
            operationStatusUrl: "/operation",
            planDetailUrl: "/detail",
            interactionAnswerBaseUrl: "/answers",
            interactionId: "initial",
        },
    );
});

test("Ask Architect to update sends a fixed chat turn, not approval, and retains the composer", async () => {
    await withReview(
        async ({ container, button, openChat, fill, submitted }) => {
            // The helper's openChat also opens the rail for other agent labels.
            await openChat();
            await fill(container.querySelector('textarea[aria-label="Message Architect"]'), "Explain the design.");
            await act(() => button("Send to Architect").click());
            await fill(container.querySelector('textarea[aria-label="Message Architect"]'), "Unsent owner text.");
            await act(() => button("Approve & Slice").click());
            await act(() => button("Ask Architect to update the Plan").click());
            assertEquals(submitted[1].conversationTurn, true);
            assertEquals(submitted[1].approved, undefined);
            assertStringIncludes(submitted[1].feedback, "Please update the Plan to reflect our review conversation.");
            assertEquals(submitted[1].feedback.includes("Unsent owner text."), false);
            assertEquals(
                container.querySelector('textarea[aria-label="Message Architect"]').value,
                "Unsent owner text.",
            );
        },
        "# Epic\n",
        { agentLabel: "Architect", classification: "PROJECT", executionPolicy: { classification: "PROJECT" } },
    );
});

test("failed chat keeps its message, excluded notes, and retry route", async () => {
    await withReview(async ({ container, button, addNote, openChat, fill, submitted, failNext }) => {
        await addNote("Keep this annotation.");
        await openChat();
        await act(() => button("Exclude annotations").click());
        const composer = container.querySelector('textarea[aria-label="Message Planner"]');
        await fill(composer, "Explain the behavior.");
        failNext();
        await act(() => button("Send to Planner").click());
        assertEquals(submitted.length, 0);
        assertEquals(composer.value, "Explain the behavior.");
        assertStringIncludes(container.querySelector('[aria-label="Review Queue"]').textContent, "excluded");
        assertStringIncludes(container.textContent, "Connection lost. Try again.");
        await act(() => button("Send to Planner").click());
        assertEquals(submitted.length, 1);
        assertEquals(submitted[0].feedback.includes("Keep this annotation."), false);
    }, "# Plan\n");
});

test("all queue types are included by default and only included types leave after Send", async () => {
    await withReview(async ({ browser, container, button, openChat, reload, submitted }) => {
        const draft = createPlanReviewDraft({
            basePlan: questionPlan,
            editedPlan: questionPlan.replace("[ ]", "[x]"),
            annotations: [{ id: "note", type: "GLOBAL_COMMENT", text: "Plan note.", createdA: 1 }],
            codeAnnotations: [
                {
                    id: "file",
                    type: "comment",
                    scope: "line",
                    filePath: "src/link.ts",
                    lineStart: 1,
                    lineEnd: 1,
                    side: "new",
                    text: "File note.",
                    createdAt: 1,
                },
            ],
            globalAttachments: [{ path: "/image.png", name: "Link image" }],
            questionAnswers: [{ id: "scope", value: false }],
        });
        browser.localStorage.setItem(planReviewDraftKey("questions"), serializePlanReviewDraft(draft));
        await reload();
        await act(() => button("Restore draft").click());
        await openChat();
        for (const type of ["annotations", "file annotations", "images", "direct edits", "answers"]) {
            assertEquals(Boolean(button(`Exclude ${type}`)), true);
        }
        await act(() => button("Exclude images").click());
        await act(() => button("Send to Planner").click());
        assertStringIncludes(submitted[0].feedback, "Plan note.");
        assertStringIncludes(submitted[0].feedback, "File note.");
        assertEquals(submitted[0].globalAttachments, []);
        const queue = container.querySelector('[aria-label="Review Queue"]');
        assertStringIncludes(queue.textContent, "1 images");
        assertEquals(queue.querySelectorAll(".rw-review-queue-item").length, 1);
        await act(() => button("Send to Planner").click());
        assertEquals(submitted[1].globalAttachments.length, 1);
    }, questionPlan);
});

const sequenceDocuments = [
    {
        planId: "sequence",
        planName: "sequence",
        plan: "# Sequence\n",
        frontmatter: { classification: "PLANNED_CHANGE", type: "SEQUENCE" },
    },
    { planId: "child", planName: "child", plan: questionPlan, frontmatter: { classification: "PLANNED_CHANGE" } },
];

test("a Sequence revision keeps a new child draft after an earlier direct edit was sent", async () => {
    await withReview(
        async ({ browser, container, button, openChat, fill, submitted, hold, release, reviseDocuments, confirm }) => {
            await act(() => button("1. Plan").focus());
            const child = container.querySelector('[role="tabpanel"]:not([hidden])');
            await act(() => child.querySelector('[role="checkbox"]').click());
            await openChat();
            await fill(child.querySelector('textarea[aria-label="Message Planner"]'), "Clarify this child.");
            hold();
            await act(() => button("Send to Planner").click());
            assertStringIncludes(submitted[0].documents[1].plan, "- [x] Keep saved links");
            await act(() => child.querySelector('[role="checkbox"]').click());
            const revisedPlan = `${questionPlan.replace("- [ ]", "- [x]")}\nAgent rollout detail.\n`;
            reviseDocuments([sequenceDocuments[0], { ...sequenceDocuments[1], plan: revisedPlan }]);
            await release();

            assertStringIncludes(child.querySelector('[aria-label="Review Queue"]').textContent, "1 direct edits");
            browser.dispatchEvent(new browser.Event("pagehide"));
            const saved = parsePlanReviewDraft(
                browser.localStorage.getItem(planReviewDraftKey("questions:child")),
                revisedPlan,
            );
            assertEquals(saved?.editedPlan, questionPlan);
            confirm(true);
            await act(() => button("Approve & Execute").click());
            assertEquals(submitted.length, 2);
            assertEquals(submitted[1].documents[1].plan, questionPlan);
            assertStringIncludes(submitted[1].documents[1].feedback, "Keep saved links");
        },
        sequenceDocuments[0].plan,
        { sequenceDocuments },
    );
});

test("a saved owner child revision clears the Sequence warning when the Agent echoes every sent Plan", async () => {
    await withReview(
        async ({ container, button, openChat, fill, submitted, reviseDocuments, reply, confirm, hold, release }) => {
            await act(() => button("1. Plan").focus());
            const child = container.querySelector('[role="tabpanel"]:not([hidden])');
            await act(() => child.querySelector('[role="checkbox"]').click());
            const editedPlan = questionPlan.replace("- [ ]", "- [x]");
            reviseDocuments([sequenceDocuments[0], { ...sequenceDocuments[1], plan: editedPlan }]);
            reply("The saved child task change is sufficient.");
            await openChat();
            await fill(child.querySelector('textarea[aria-label="Message Planner"]'), "Keep my child task change.");
            hold();
            await act(() => button("Send to Planner").click());
            assertEquals(
                submitted[0].documents.map((document) => document.plan),
                [sequenceDocuments[0].plan, editedPlan],
            );
            await release();
            await act(() => button("Sequence overview").focus());
            confirm(true);
            await act(() => button("Approve & Execute").click());
            assertEquals(container.querySelector("dialog"), null);
            assertEquals(submitted.length, 2);
            assertEquals(submitted[1].approved, true);
            assertEquals(submitted[1].documents[1].plan, editedPlan);
        },
        sequenceDocuments[0].plan,
        { sequenceDocuments },
    );
});

test("Sequence Submit answer isolates one child answer from group notes, messages, and direct edits", async () => {
    await withReview(
        async ({ container, button, openChat, addNote, fill, submitted }) => {
            await addNote("Sequence note must stay queued.");
            await openChat();
            await fill(
                container.querySelector('textarea[aria-label="Message Planner"]'),
                "Sequence message must stay unsent.",
            );
            await act(() => button("1. Plan").focus());
            const child = container.querySelector('[role="tabpanel"]:not([hidden])');
            await act(() => child.querySelector('[role="checkbox"]').click());
            const no = [...child.querySelectorAll("label")]
                .find((element) => element.textContent === "No")
                .querySelector("input");
            await act(() => no.click());
            await act(() => child.querySelector(".rw-question-card button").click());
            assertEquals(submitted[0].documents.length, 2);
            assertEquals(submitted[0].documents[0].feedback, "");
            assertEquals(submitted[0].documents[0].plan, sequenceDocuments[0].plan);
            assertEquals(submitted[0].documents[1].plan, questionPlan);
            assertStringIncludes(submitted[0].feedback, "### Question answers");
            assertEquals(submitted[0].feedback.includes("must stay"), false);
            assertEquals(submitted[0].feedback.includes("Direct"), false);
            assertStringIncludes(child.querySelector(".rw-question-card").textContent, "Answer sent");
            await act(() => button("Sequence overview").focus());
            assertEquals(
                container.querySelector('textarea[aria-label="Message Planner"]').value,
                "Sequence message must stay unsent.",
            );
            assertStringIncludes(container.querySelector('[aria-label="Review Queue"]').textContent, "1 annotations");
            assertStringIncludes(container.querySelector('[aria-label="Review Queue"]').textContent, "1 direct edits");
        },
        sequenceDocuments[0].plan,
        { sequenceDocuments },
    );
});

test("Sequence exclusions apply across tabs, preserve excluded notes, and approval forwards the entire queue", async () => {
    await withReview(
        async ({ container, button, openChat, addNote, fill, submitted, confirm }) => {
            await addNote("Sequence unsent note.");
            await openChat();
            await act(() => button("Exclude annotations").click());
            await act(() => button("1. Plan").focus());
            const child = container.querySelector('[role="tabpanel"]:not([hidden])');
            const opener = child.querySelector('[aria-label="Open annotations sidebar"]');
            if (opener) await act(() => opener.click());
            assertStringIncludes(child.querySelector('[aria-label="Review Queue"]').textContent, "excluded");
            const composer = child.querySelector('textarea[aria-label="Message Planner"]');
            await fill(composer, "Explain the Sequence.");
            await act(() =>
                [...child.querySelectorAll("button")]
                    .find((element) => element.textContent.trim() === "Send to Planner")
                    .click(),
            );
            assertEquals(submitted[0].feedback.includes("Sequence unsent note."), false);
            assertEquals(submitted[0].documents[0].annotations.length, 0);
            await act(() => child.querySelector('[aria-label="Exclude annotations"]').click());
            await act(() =>
                [...child.querySelectorAll("button")]
                    .find((element) => element.getAttribute("aria-label") === "Approve & Execute")
                    .click(),
            );
            confirm(true);
            await act(() => button("Approve as is").click());
            assertStringIncludes(submitted[1].documents[0].feedback, "Sequence unsent note.");
            assertEquals(submitted[1].documents[0].annotations.length, 1);
        },
        sequenceDocuments[0].plan,
        { sequenceDocuments },
    );
});

for (const workspace of [false, true]) {
    test(`${workspace ? "Workspace" : "standalone"} chat accepts the backend rearmed review after more than 180 seconds`, async () => {
        await withReview(
            async ({ container, button, openChat, fill, submitted, delayRearm }) => {
                await openChat();
                await fill(container.querySelector('textarea[aria-label="Message Planner"]'), "Explain this Plan.");
                const realNow = Date.now;
                let now = realNow();
                try {
                    Date.now = () => (now += 181_000);
                    if (workspace) delayRearm(1);
                    await act(() => button("Send to Planner").click());
                    if (workspace) await act(async () => await new Promise((resolve) => setTimeout(resolve, 800)));
                    assertEquals(button("Send to Planner").disabled, true); // No text or queue remains.
                    assertEquals(button("Approve & Run").disabled, false);
                    assertEquals(container.querySelector('[role="alert"]'), null);
                    await act(() => button("Approve & Run").click());
                    await act(() => button("Approve as is").click());
                    assertEquals(submitted.length, 2);
                    assertEquals(submitted[1].approved, true);
                } finally {
                    Date.now = realNow;
                }
            },
            "# Plan\n",
            workspace
                ? {
                      mode: "workspace",
                      conversationStatusUrl: undefined,
                      operationStatusUrl: "/operation",
                      planDetailUrl: "/detail",
                      interactionAnswerBaseUrl: "/answers",
                      interactionId: "review-0",
                  }
                : {},
        );
    });
}

test("a Sequence child revision clears the group approval warning and preserves excluded answers", async () => {
    await withReview(
        async ({ container, button, openChat, fill, submitted, reviseDocuments }) => {
            await act(() => button("1. Plan").focus());
            const child = container.querySelector('[role="tabpanel"]:not([hidden])');
            const no = [...child.querySelectorAll("label")]
                .find((element) => element.textContent === "No")
                .querySelector("input");
            await act(() => no.click());
            await openChat();
            const exclude = child.querySelector('[aria-label="Exclude answers"]');
            await act(() => exclude.click());
            await fill(child.querySelector('textarea[aria-label="Message Planner"]'), "Revise this child only.");
            reviseDocuments([
                sequenceDocuments[0],
                { ...sequenceDocuments[1], plan: `${questionPlan}\nUpdated verification.\n` },
            ]);
            await act(() =>
                [...child.querySelectorAll("button")]
                    .find((element) => element.textContent.trim() === "Send to Planner")
                    .click(),
            );
            assertEquals(submitted[0].documents[1].questionAnswers, []);
            assertEquals(no.checked, true);
            assertStringIncludes(child.querySelector('[aria-label="Review Queue"]').textContent, "1 answers");
            await act(() =>
                [...child.querySelectorAll("button")]
                    .find((element) => element.getAttribute("aria-label") === "Approve & Execute")
                    .click(),
            );
            assertEquals(container.querySelector("dialog"), null);
            assertEquals(submitted.length, 2);
            assertEquals(submitted[1].documents[1].questionAnswers, [{ id: "scope", value: false }]);
        },
        sequenceDocuments[0].plan,
        { sequenceDocuments },
    );
});

for (const workspace of [false, true]) {
    test(`${workspace ? "Workspace" : "standalone"} reports a failed review re-arm instead of waiting indefinitely`, async () => {
        await withReview(
            async ({ container, button, fill, failRearm }) => {
                const opener = container.querySelector('[aria-label="Open annotations sidebar"]');
                if (opener) await act(() => opener.click());
                await fill(container.querySelector('textarea[aria-label="Message Planner"]'), "Explain the scope.");
                failRearm("Plan target cannot be reviewed in its current status.");
                await act(() => button("Send to Planner").click());
                assertStringIncludes(container.textContent, "Plan target cannot be reviewed in its current status.");
                await fill(container.querySelector('textarea[aria-label="Message Planner"]'), "Try again.");
                assertEquals(button("Send to Planner").disabled, false);
                assertEquals(button("Approve & Run").disabled, false);
            },
            "# Plan\n",
            workspace
                ? {
                      conversationStatusUrl: undefined,
                      operationStatusUrl: "/operation",
                      planDetailUrl: "/detail",
                      interactionAnswerBaseUrl: "/answers",
                      interactionId: "initial",
                  }
                : {},
        );
    });
}
