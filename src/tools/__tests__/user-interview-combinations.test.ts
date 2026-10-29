import { assertEquals } from "../../testing/assertions.ts";
import { getCwd } from "../../constants.js";
import { test } from "node:test";
import {
    createUserInterviewTool,
    type InterviewParameters,
    type InterviewResultDetails,
} from "../../tools/user-interview.ts";
import { HostedSession } from "../../shared/session/hosted-session.js";
import type { AgentToolResult, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

type InterviewTool = ReturnType<typeof createUserInterviewTool>;

function createInterviewTool(responses: Array<string | null> = []) {
    const session = new HostedSession({ id: `interview-${crypto.randomUUID()}`, cwd: getCwd() });
    let callCount = 0;
    session.setInteractionAdapter({
        requestInteraction: (request) => {
            const value = responses[callCount++] ?? null;
            if (value === null) return Promise.resolve({ outcome: "canceled" });
            if (request.type === "text") return Promise.resolve({ outcome: "text", value });
            return Promise.resolve({ outcome: "selected", value });
        },
    });
    return createUserInterviewTool({ hostedSession: session });
}

async function executeTool(
    tool: InterviewTool,
    params: InterviewParameters,
): Promise<AgentToolResult<InterviewResultDetails>> {
    const execute = tool.execute;
    // The tool ignores the SDK context; preserve this JavaScript fixture's empty object.
    return await execute("tool-call-1", params, new AbortController().signal, () => {}, {} as ExtensionToolContext);
}

test("user_interview - Single Yes/No Question (Happy Path)", async () => {
    const tool = createInterviewTool(["yes"]);
    const result = await executeTool(tool, {
        question: {
            type: "yes_no",
            prompt: "Do you agree?",
        },
    });

    assertEquals(result.details.status, "completed");
    assertEquals(result.details.answers[0]?.value, true);
});

test("user_interview - Single Yes/No with Other (Happy Path)", async () => {
    const tool = createInterviewTool(["other", "I have a custom thought"]);
    const result = await executeTool(tool, {
        question: {
            type: "yes_no",
            prompt: "Do you agree?",
            allowOther: true,
        },
    });

    assertEquals(result.details.status, "completed");
    assertEquals(result.details.answers[0]?.value, "other");
    assertEquals(result.details.answers[0]?.otherText, "I have a custom thought");
});

test("user_interview - Multiple Choice (Happy Path)", async () => {
    const tool = createInterviewTool(["option_b"]);
    const result = await executeTool(tool, {
        question: {
            type: "multiple_choice",
            prompt: "Pick one",
            choices: [
                { value: "option_a", label: "A" },
                { value: "option_b", label: "B" },
            ],
        },
    });

    assertEquals(result.details.status, "completed");
    assertEquals(result.details.answers[0]?.value, "option_b");
});

test("user_interview - Text Question (Happy Path)", async () => {
    const tool = createInterviewTool(["Hello World"]);
    const result = await executeTool(tool, {
        question: {
            type: "text",
            prompt: "Your name?",
        },
    });

    assertEquals(result.details.status, "completed");
    assertEquals(result.details.answers[0]?.value, "Hello World");
});

test("user_interview - Batch of Questions (Happy Path)", async () => {
    const tool = createInterviewTool(["yes", "option_a", "My Text"]);
    const result = await executeTool(tool, {
        questions: [
            { type: "yes_no", prompt: "Q1" },
            { type: "multiple_choice", prompt: "Q2", choices: [{ value: "option_a" }, { value: "option_b" }] },
            { type: "text", prompt: "Q3" },
        ],
    });

    assertEquals(result.details.status, "completed");
    assertEquals(result.details.answers.length, 3);
    assertEquals(result.details.answers[0]?.value, true);
    assertEquals(result.details.answers[1]?.value, "option_a");
    assertEquals(result.details.answers[2]?.value, "My Text");
});

test("user_interview - Invalid Request (Both question and questions)", async () => {
    const tool = createInterviewTool();
    const result = await executeTool(tool, {
        question: { type: "text", prompt: "Q1" },
        questions: [{ type: "text", prompt: "Q2" }],
    });

    assertEquals(result.details.status, "invalid_request");
    assertEquals(result.details.errors?.[0]?.code, "INVALID_BATCH");
});

test("user_interview - Validation Error (Empty Prompt)", async () => {
    const tool = createInterviewTool();
    const result = await executeTool(tool, {
        question: { type: "text", prompt: "" },
    });

    assertEquals(result.details.status, "invalid_request");
    assertEquals(result.details.errors?.[0]?.code, "EMPTY_PROMPT");
});

test("user_interview - User Cancelled", async () => {
    const tool = createInterviewTool([null]);
    const result = await executeTool(tool, {
        question: { type: "text", prompt: "Q1" },
    });

    assertEquals(result.details.status, "canceled");
    assertEquals(result.details.canceled, true);
});

test("user_interview - Multiple Choice Validation (Too few choices)", async () => {
    const tool = createInterviewTool();
    const result = await executeTool(tool, {
        question: {
            type: "multiple_choice",
            prompt: "Q1",
            choices: [{ value: "only_one" }],
        },
    });

    assertEquals(result.details.status, "invalid_request");
    assertEquals(result.details.errors?.[0]?.code, "INVALID_CHOICES");
});
