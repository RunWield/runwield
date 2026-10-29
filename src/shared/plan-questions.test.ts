import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../testing/assertions.ts";
import { parsePlanQuestions, resolvePlanQuestions, formatPlanQuestionAnswers } from "./plan-questions.ts";

const choice = {
    id: "scope",
    type: "multiple_choice",
    prompt: "Who can export?",
    choices: [
        { value: "admins", label: "Admins only" },
        { value: "all", label: "All members" },
    ],
    default: "admins",
};
const fence = (question: Record<string, string | boolean | typeof choice.choices>) =>
    "```wld-question\n" + JSON.stringify(question) + "\n```";

test("resolves owner choice labels and preserves surrounding bytes", () => {
    const markdown = "Before\r\n\r\n" + fence(choice) + "\r\nAfter  \n";
    assertEquals(
        resolvePlanQuestions(markdown, [{ id: "scope", value: "all" }]),
        "Before\r\n\r\n> **Question (scope):** Who can export?\n>\n> **Answer:** All members (answered in review)\r\nAfter  \n",
    );
});
test("uses the recommended answer when unanswered", () => {
    assertStringIncludes(resolvePlanQuestions(fence(choice)), "Admins only (recommended; not answered in review)");
});
test("records Engineer discretion when there is no recommendation", () => {
    assertStringIncludes(
        resolvePlanQuestions(fence({ id: "note", type: "text", prompt: "Which message?" })),
        "Not answered. Engineer decides.",
    );
});
test("records Other text and quotes multiline answers", () => {
    assertStringIncludes(
        resolvePlanQuestions(fence(choice), [{ id: "scope", value: "Guests\nwith links" }]),
        "Guests\n> with links (answered in review)",
    );
});
test("false is an owner answer, not a missing answer", () => {
    const markdown = fence({ id: "keep", type: "yes_no", prompt: "Keep it?", default: true });
    assertStringIncludes(resolvePlanQuestions(markdown, [{ id: "keep", value: false }]), "No (answered in review)");
});
test("invalid JSON, missing ids, unknown types, and empty choices stay unchanged", () => {
    for (const markdown of [
        "```wld-question\n{\n```",
        fence({ type: "text", prompt: "Hello?" }),
        fence({ id: "bad", type: "invalid", prompt: "Hello?" }),
        fence({ ...choice, choices: [] }),
    ]) {
        assertEquals(Boolean(parsePlanQuestions(markdown)[0].error), true);
        assertEquals(resolvePlanQuestions(markdown), markdown);
    }
});
test("all duplicate ids stay unchanged", () => {
    const markdown = fence(choice) + "\n\n" + fence(choice);
    assertEquals(
        parsePlanQuestions(markdown).map((block) => Boolean(block.error)),
        [true, true],
    );
    assertEquals(resolvePlanQuestions(markdown), markdown);
});
test("ignores question examples inside longer code fences", () => {
    const markdown = "````md\n" + fence(choice) + "\n````\n";
    assertEquals(parsePlanQuestions(markdown), []);
    assertEquals(resolvePlanQuestions(markdown), markdown);
});
test("formats only answered valid questions for Planner", () => {
    const questions = parsePlanQuestions(fence(choice));
    assertEquals(formatPlanQuestionAnswers(questions, []), "");
    assertEquals(
        formatPlanQuestionAnswers(questions, [{ id: "scope", value: "all" }]),
        "### Question answers\n\n- scope: Who can export? — All members",
    );
});
