import { assertEquals } from "../../testing/assertions.ts";
import { getCwd } from "../../constants.ts";
import { test } from "node:test";
import {
    createUserInterviewTool,
    type InterviewParameters,
    type InterviewResultDetails,
} from "../../tools/user-interview.ts";
import { HostedSession } from "../../shared/session/hosted-session.ts";
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

test("user_interview - Validation Error (Empty Prompt)", async () => {
    const tool = createInterviewTool();
    const result = await executeTool(tool, {
        question: { type: "text", prompt: "" },
    });

    assertEquals(result.details.status, "invalid_request");
    assertEquals(result.details.errors?.[0]?.code, "EMPTY_PROMPT");
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
