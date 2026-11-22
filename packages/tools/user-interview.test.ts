import { deepStrictEqual, equal } from "node:assert/strict";
import { test } from "node:test";
import { toolRegistry, type InterviewParameters } from "@runwield/tools";

test("a caller can prepare an interview and decide whether to open an interaction", () => {
    const interview = toolRegistry.get("user_interview");
    const question = { type: "text", id: "scope", prompt: "Which repository?" } as const;
    const input: InterviewParameters = { question };
    const prepared = interview.prepare(input);
    equal(prepared.ok, true);
    deepStrictEqual(
        prepared.questions.map(({ id, prompt }) => ({ id, prompt })),
        [{ id: "scope", prompt: "Which repository?" }],
    );

    const malformed = interview.prepare({ ...input, questions: [question] });
    equal(malformed.ok, false);
    equal(malformed.details.totalQuestions, 0);
    equal(malformed.details.errors[0].code, "INVALID_BATCH");

    const duplicate = interview.prepare({ questions: [question, question] });
    equal(duplicate.ok, false);
    equal(duplicate.details.totalQuestions, 2);
    deepStrictEqual(
        duplicate.details.errors.map(({ code, questionIndex }) => ({ code, questionIndex })),
        [{ code: "DUPLICATE_ID", questionIndex: 2 }],
    );
});
