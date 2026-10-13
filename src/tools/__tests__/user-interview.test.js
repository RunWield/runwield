import { assertEquals } from "../../testing/assertions.ts";
import { getCwd } from "../../constants.js";
import { test } from "node:test";
import { ok as assert, match as assertMatch } from "node:assert/strict";
import { createUserInterviewTool } from "../user-interview.ts";
import { HostedSession } from "../../shared/session/hosted-session.js";

/** @param {{ promptSelect?: () => Promise<string | null>, promptText?: () => Promise<string | null> }} overrides */
function makeUi(overrides) {
    const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd: getCwd() });
    hostedSession.setInteractionAdapter({
        requestInteraction: async (request) => {
            if (request.type === "text") {
                const value = await (overrides.promptText?.() ?? Promise.resolve(null));
                return value === null ? { outcome: "canceled" } : { outcome: "text", value };
            }
            const value = await (overrides.promptSelect?.() ?? Promise.resolve(null));
            const option = request.options?.find((item) => item.value === value);
            return value === null ? { outcome: "canceled" } : { outcome: "selected", value, valueLabel: option?.label };
        },
    });
    return { hostedSession };
}

/**
 * @param {{ execute: unknown }} tool
 * @param {object} params
 */
async function executeTool(tool, params) {
    const execute =
        /** @type {(id: string, params: object, signal: AbortSignal, onUpdate: () => void, context: object) => Promise<{ content: Array<{ type: string, text?: string }>, details: import('../user-interview.ts').InterviewResultDetails }>} */ (tool
            .execute);
    return await execute("tool-call-1", params, new AbortController().signal, () => {}, {});
}

/**
 * @param {{ content: Array<{ type: string, text?: string }> }} result
 */
function firstText(result) {
    const first = result.content[0];
    assertEquals(first?.type, "text");
    if (!first || first.type !== "text") throw new Error("Expected text content.");
    return first.text ?? "";
}

test("userInterviewTool exposes expected metadata", () => {
    const tool = createUserInterviewTool(undefined);

    assertEquals(tool.name, "user_interview");
    assertEquals(tool.label, "User Interview");
    assertMatch(tool.description, /Ask the user 1-3 structured clarification questions/i);
    assertEquals(typeof tool.promptSnippet, "string");
    assertEquals(typeof tool.parameters, "object");
    assertEquals(typeof tool.execute, "function");
});

test("userInterviewTool completes a single yes/no question", async () => {
    const tool = createUserInterviewTool(makeUi({
        promptSelect: () => Promise.resolve("yes"),
    }));

    const result = await executeTool(tool, {
        question: {
            id: "confirm_scope",
            type: "yes_no",
            prompt: "Proceed with the scoped feature?",
            default: true,
        },
    });

    assertEquals(result.details.status, "completed");
    assertEquals(result.details.completed, true);
    assertEquals(result.details.answeredCount, 1);
    assertEquals(result.details.answers.length, 1);
    assertEquals(result.details.answers[0], {
        index: 1,
        id: "confirm_scope",
        type: "yes_no",
        prompt: "Proceed with the scoped feature?",
        value: true,
        valueLabel: "yes",
        otherText: undefined,
    });
    assertMatch(firstText(result), /Proceed with the scoped feature\?\n\n1\. Answer selected was yes/);
    assertMatch(firstText(result), /interview_result_json:/);
    assertMatch(firstText(result), /"answers"\s*:\s*\[/);
});

test("userInterviewTool result text shows the question and selected answer", async () => {
    const tool = createUserInterviewTool(makeUi({
        promptSelect: () => Promise.resolve("2"),
    }));

    const result = await executeTool(tool, {
        question: {
            id: "multi_line",
            type: "multiple_choice",
            prompt: "Question blah blah\nmultiline?",
            choices: [
                { value: "1", label: "1" },
                { value: "2", label: "2" },
            ],
        },
    });

    assertMatch(firstText(result), /Question blah blah\nmultiline\?\n\n2\. Answer selected was 2/);
});

test("userInterviewTool result text shows Other answers", async () => {
    const tool = createUserInterviewTool(makeUi({
        promptSelect: () => Promise.resolve("other"),
        promptText: () => Promise.resolve("text from user here"),
    }));

    const result = await executeTool(tool, {
        question: {
            id: "custom",
            type: "multiple_choice",
            prompt: "Question blah blah",
            choices: [
                { value: "1", label: "1" },
                { value: "2", label: "2" },
            ],
        },
    });

    assertMatch(firstText(result), /Question blah blah\n\n1\. Answer selected was Other: text from user here/);
});

test("userInterviewTool returns to choices when multiple-choice Other text is canceled", async () => {
    const selectedValues = ["other", "high"];
    const textValues = [null];

    const tool = createUserInterviewTool(makeUi({
        promptSelect: () => Promise.resolve(selectedValues.shift() ?? null),
        promptText: () => Promise.resolve(textValues.shift() ?? null),
    }));

    const result = await executeTool(tool, {
        question: {
            id: "priority",
            type: "multiple_choice",
            prompt: "What priority should we assign?",
            choices: [
                { value: "low", label: "Low" },
                { value: "high", label: "High" },
            ],
        },
    });

    assertEquals(result.details.status, "completed");
    assertEquals(result.details.answers[0]?.value, "high");
    assertEquals(selectedValues, []);
    assertEquals(textValues, []);
});

test("userInterviewTool returns to yes/no choices when Other text is canceled", async () => {
    const selectedValues = ["other", "no"];
    const textValues = [null];

    const tool = createUserInterviewTool(makeUi({
        promptSelect: () => Promise.resolve(selectedValues.shift() ?? null),
        promptText: () => Promise.resolve(textValues.shift() ?? null),
    }));

    const result = await executeTool(tool, {
        question: {
            id: "confirm_scope",
            type: "yes_no",
            prompt: "Proceed with the scoped feature?",
        },
    });

    assertEquals(result.details.status, "completed");
    assertEquals(result.details.answers[0]?.value, false);
    assertEquals(selectedValues, []);
    assertEquals(textValues, []);
});

test("userInterviewTool completes a mixed 3-question batch", async () => {
    const selectedValues = ["high", "frontend"];
    const textValues = ["Use design tokens."];

    const tool = createUserInterviewTool(makeUi({
        promptSelect: () => Promise.resolve(selectedValues.shift() ?? null),
        promptText: () => Promise.resolve(textValues.shift() ?? null),
    }));

    const result = await executeTool(tool, {
        questions: [
            {
                id: "priority",
                type: "multiple_choice",
                prompt: "What priority should we assign?",
                default: "high",
                choices: [
                    { value: "low", label: "Low" },
                    { value: "high", label: "High" },
                ],
            },
            {
                id: "notes",
                type: "text",
                prompt: "Any implementation notes?",
                allowEmpty: false,
            },
            {
                id: "layer",
                type: "multiple_choice",
                prompt: "Which layer first?",
                choices: [
                    { value: "frontend", label: "Frontend" },
                    { value: "backend", label: "Backend" },
                ],
            },
        ],
    });

    assertEquals(result.details.status, "completed");
    assertEquals(result.details.totalQuestions, 3);
    assertEquals(result.details.answeredCount, 3);
    assertEquals(result.details.remainingCount, 0);
    assertEquals(result.details.answers[0]?.valueLabel, "High (recommended)");
    assertEquals(result.details.answers[1]?.value, "Use design tokens.");
    assertEquals(result.details.answers[2]?.value, "frontend");
});

test("userInterviewTool does not duplicate recommended marker when default choice label already includes it", async () => {
    const hostedSession = new HostedSession({ id: "recommended-label", cwd: getCwd() });
    /** @type {Array<{ value: string, label: string }>} */
    let displayedOptions = [];
    hostedSession.setInteractionAdapter({
        requestInteraction: (request) => {
            displayedOptions = [...(request.options || [])];
            return { outcome: "selected", value: "parallel", valueLabel: displayedOptions[0]?.label };
        },
    });
    const tool = createUserInterviewTool({ hostedSession });

    const result = await executeTool(tool, {
        question: {
            id: "reader_delegation",
            type: "multiple_choice",
            prompt: "Should v1 keep reader delegation as foreground parallel batches?",
            default: "parallel",
            choices: [
                { value: "parallel", label: "Yes—parallel children, parent waits for the batch (recommended)" },
                { value: "background", label: "No—add background spawn/wait/cancel semantics" },
            ],
        },
    });

    assertEquals(
        displayedOptions[0]?.label,
        "Yes—parallel children, parent waits for the batch (recommended)",
    );
    assertEquals(result.details.status, "completed");
    assertEquals(
        result.details.answers[0]?.valueLabel,
        "Yes—parallel children, parent waits for the batch (recommended)",
    );
});

test("userInterviewTool returns invalid_request when both question and questions are provided", async () => {
    const tool = createUserInterviewTool(undefined);

    const result = await executeTool(tool, {
        question: {
            type: "yes_no",
            prompt: "Question A",
        },
        questions: [{
            type: "yes_no",
            prompt: "Question B",
        }],
    });

    assertEquals(result.details.status, "invalid_request");
    assertEquals(result.details.errors?.[0]?.code, "INVALID_BATCH");
    assertMatch(result.details.errors?.[0]?.message ?? "", /either 'question' or 'questions'/i);
});

test("userInterviewTool returns invalid_request for validation errors", async () => {
    const tool = createUserInterviewTool(undefined);

    const result = await executeTool(tool, {
        questions: [
            {
                id: "dup",
                type: "multiple_choice",
                prompt: "Pick one",
                default: "gamma",
                choices: [
                    { value: "alpha" },
                    { value: "alpha" },
                ],
            },
            {
                id: "dup",
                type: "yes_no",
                prompt: "Continue?",
            },
        ],
    });

    assertEquals(result.details.status, "invalid_request");
    const codes = new Set((result.details.errors ?? []).map((/** @type {{ code: string }} */ e) => e.code));
    assert(codes.has("DUPLICATE_CHOICE_VALUE"));
    assert(codes.has("DEFAULT_NOT_IN_CHOICES"));
    assert(codes.has("DUPLICATE_ID"));
});

test("userInterviewTool returns canceled when user cancels", async () => {
    const tool = createUserInterviewTool(makeUi({
        promptSelect: () => Promise.resolve(null),
    }));

    const result = await executeTool(tool, {
        question: {
            id: "confirm",
            type: "yes_no",
            prompt: "Proceed?",
        },
    });

    assertEquals(result.details.status, "canceled");
    assertEquals(result.details.canceled, true);
    assertEquals(result.details.canceledAt, 1);
    assertEquals(result.details.answeredCount, 0);
    assertEquals(result.details.errors?.[0]?.code, "USER_CANCELED");
});

test("userInterviewTool returns validation_error for empty text answer when allowEmpty=false", async () => {
    const tool = createUserInterviewTool(makeUi({
        promptText: () => Promise.resolve("   "),
    }));

    const result = await executeTool(tool, {
        question: {
            id: "details",
            type: "text",
            prompt: "Provide details",
            allowEmpty: false,
        },
    });

    assertEquals(result.details.status, "validation_error");
    assertEquals(result.details.errors?.[0]?.code, "EMPTY_ANSWER");
});

test("userInterviewTool returns validation_error for invalid multiple-choice selection", async () => {
    const tool = createUserInterviewTool(makeUi({
        promptSelect: () => Promise.resolve("not-a-real-option"),
    }));

    const result = await executeTool(tool, {
        question: {
            id: "stack",
            type: "multiple_choice",
            prompt: "Pick stack",
            choices: [
                { value: "react", label: "React" },
                { value: "vue", label: "Vue" },
            ],
        },
    });

    assertEquals(result.details.status, "validation_error");
    assertEquals(result.details.errors?.[0]?.code, "INVALID_ANSWER");
    assertMatch(result.details.errors?.[0]?.message ?? "", /does not exist/i);
});

test("userInterviewTool returns invalid_request when payload is missing", async () => {
    const tool = createUserInterviewTool(undefined);
    const result = await executeTool(tool, {});

    assertEquals(result.details.status, "invalid_request");
    assertEquals(result.details.errors?.[0]?.code, "INVALID_BATCH");
    assertMatch(result.details.errors?.[0]?.message ?? "", /Missing interview payload/i);
});

test("userInterviewTool returns invalid_request for invalid id and choices", async () => {
    const tool = createUserInterviewTool(undefined);
    const result = await executeTool(tool, {
        question: {
            id: "bad id",
            type: "multiple_choice",
            prompt: "Pick",
            choices: [
                { value: "" },
                { value: "a" },
            ],
        },
    });

    assertEquals(result.details.status, "invalid_request");
    const codes = new Set((result.details.errors ?? []).map((/** @type {{ code: string }} */ e) => e.code));
    assert(codes.has("INVALID_ID"));
    assert(codes.has("EMPTY_CHOICE_VALUE"));
});

test("userInterviewTool returns validation_error for invalid yes/no response", async () => {
    const tool = createUserInterviewTool(makeUi({
        promptSelect: () => Promise.resolve("maybe"),
    }));

    const result = await executeTool(tool, {
        question: {
            id: "confirm",
            type: "yes_no",
            prompt: "Proceed?",
        },
    });

    assertEquals(result.details.status, "validation_error");
    assertEquals(result.details.errors?.[0]?.code, "INVALID_ANSWER");
    assertMatch(result.details.errors?.[0]?.message ?? "", /Unexpected yes\/no response/i);
});

test("userInterviewTool uses HostedSession interaction broker when available", async () => {
    const hostedSession = new HostedSession({ id: "brokered-interview", cwd: getCwd() });
    /** @type {string[]} */
    const prompts = [];
    hostedSession.setInteractionAdapter({
        requestInteraction: (request) => {
            prompts.push(request.prompt);
            return { outcome: "selected", value: "yes", valueLabel: "Yes" };
        },
    });
    const tool = createUserInterviewTool({ hostedSession });

    const result = await executeTool(tool, {
        question: { type: "yes_no", prompt: "Proceed?" },
    });

    assertEquals(prompts, ["Proceed?"]);
    assertEquals(result.details.status, "completed");
    assertEquals(result.details.answers[0].value, true);
});
