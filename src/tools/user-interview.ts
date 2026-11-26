/**
 * @module user-interview
 * Structured user interview tool for planning agents.
 */

import {
    toolRegistry,
    type InterviewQuestion,
    type InterviewChoiceOption,
    type InterviewResultDetails,
    type PreparedInterviewAnswer,
} from "@runwield/tools";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { requestHostedSessionInteraction, type HostedSession } from "@runwield/session-runtime/host";
import type { RuntimeInteractionRequest, RuntimeInteractionResponse } from "@runwield/session-runtime/interactions";
import { RuntimeInteractionOutcomes, RuntimeInteractionTypes } from "@runwield/session-runtime/interactions";

const userInterview = toolRegistry.get("user_interview");

type InterviewAnswer = { canceled: true } | PreparedInterviewAnswer;

type UserInterviewResult = AgentToolResult<InterviewResultDetails>;

interface UserInterviewToolOptions {
    hostedSession?: HostedSession;
}

export function createUserInterviewTool(
    opts: UserInterviewToolOptions = {},
): ToolDefinition<typeof userInterview.definition.parameters, InterviewResultDetails> {
    const hostedSession = opts.hostedSession;
    return defineTool<typeof userInterview.definition.parameters, InterviewResultDetails>({
        ...userInterview.definition,

        async execute(_toolCallId, params): Promise<UserInterviewResult> {
            const prepared = userInterview.prepare(params);
            if (!prepared.ok) return buildResult(prepared.details);
            const { questions } = prepared;
            const answers: InterviewResultDetails["answers"] = [];

            for (let i = 0; i < questions.length; i++) {
                const question = questions[i];
                const answer = await askQuestion(question, hostedSession);

                if ("canceled" in answer) {
                    return buildResult({
                        status: "canceled",
                        canceled: true,
                        completed: false,
                        totalQuestions: questions.length,
                        answeredCount: answers.length,
                        remainingCount: questions.length - answers.length,
                        canceledAt: i + 1,
                        answers,
                        errors: [
                            {
                                code: "USER_CANCELED",
                                message: "User canceled the interview prompt.",
                                questionIndex: i + 1,
                                questionId: question.id,
                            },
                        ],
                    });
                }

                if ("error" in answer) {
                    return buildResult({
                        status: "validation_error",
                        canceled: false,
                        completed: false,
                        totalQuestions: questions.length,
                        answeredCount: answers.length,
                        remainingCount: questions.length - answers.length,
                        answers,
                        errors: [answer.error],
                    });
                }

                answers.push({
                    index: i + 1,
                    id: question.id,
                    type: question.type,
                    prompt: question.prompt,
                    value: answer.value,
                    valueLabel: answer.valueLabel,
                    otherText: answer.otherText,
                });
            }

            return buildResult({
                status: "completed",
                canceled: false,
                completed: true,
                totalQuestions: questions.length,
                answeredCount: answers.length,
                remainingCount: 0,
                answers,
            });
        },
    });
}

async function askBrokered(
    hostedSession: HostedSession | undefined,
    request: RuntimeInteractionRequest,
): Promise<RuntimeInteractionResponse> {
    if (!hostedSession) {
        return {
            outcome: RuntimeInteractionOutcomes.UNSUPPORTED,
            message: "No hosted session is available for this interview prompt.",
        };
    }
    return await requestHostedSessionInteraction(
        hostedSession,
        request,
        undefined,
        hostedSession.getManagedOperationCapability?.() || null,
    );
}

function brokerFailureToAnswer(
    response: RuntimeInteractionResponse,
    question: InterviewQuestion,
): InterviewAnswer | null {
    if (response.outcome === RuntimeInteractionOutcomes.CANCELED) return { canceled: true };
    if (
        response.outcome === RuntimeInteractionOutcomes.UNSUPPORTED ||
        response.outcome === RuntimeInteractionOutcomes.BLOCKED
    ) {
        return {
            error: {
                code:
                    response.outcome === RuntimeInteractionOutcomes.BLOCKED
                        ? "INTERACTION_BLOCKED"
                        : "INTERACTION_UNSUPPORTED",
                message: response.message || "The current client cannot answer this structured interview prompt.",
                questionId: question.id,
            },
        };
    }
    return null;
}

async function askSelect(
    question: InterviewQuestion,
    options: InterviewChoiceOption[],
    hostedSession: HostedSession | undefined,
    defaultValue?: string,
): Promise<InterviewAnswer> {
    const brokerResponse = await askBrokered(hostedSession, {
        type: RuntimeInteractionTypes.SELECT,
        prompt: question.prompt,
        options,
        defaultValue,
        otherOptionValue: userInterview.otherValue,
        _meta: { source: "user_interview", questionType: question.type, questionId: question.id },
    });
    const brokerFailure = brokerFailureToAnswer(brokerResponse, question);
    if (brokerFailure) return brokerFailure;
    const selected = brokerResponse.value;
    if (selected === null || typeof selected === "undefined") return { canceled: true };
    if (selected === userInterview.otherValue && brokerResponse.otherText !== undefined) {
        return userInterview.prepareOtherAnswer(question, brokerResponse.otherText);
    }
    return { value: String(selected) };
}

async function askOther(
    question: InterviewQuestion,
    hostedSession: HostedSession | undefined,
): Promise<InterviewAnswer> {
    const followUpPrompt = `Please specify your answer for: "${question.prompt}"`;
    const otherResponse = await askBrokered(hostedSession, {
        type: RuntimeInteractionTypes.TEXT,
        prompt: followUpPrompt,
        placeholder: "Esc returns to the choice list",
        allowEmpty: false,
        _meta: { source: "user_interview", questionType: question.type, questionId: question.id, other: true },
    });
    const otherFailure = brokerFailureToAnswer(otherResponse, question);
    if (otherFailure) return otherFailure;
    return userInterview.prepareOtherAnswer(question, String(otherResponse.value ?? ""));
}

async function askQuestion(
    question: InterviewQuestion,
    hostedSession: HostedSession | undefined,
): Promise<InterviewAnswer> {
    if (question.type !== "text") {
        const options = userInterview.choiceOptions(question);
        const defaultValue =
            typeof question.default === "boolean" ? (question.default ? "yes" : "no") : question.default;
        while (true) {
            const selected = await askSelect(question, options, hostedSession, defaultValue);
            if ("canceled" in selected || "error" in selected) return selected;
            if (selected.value === userInterview.otherValue) {
                if (selected.otherText !== undefined) return selected;
                const otherAnswer = await askOther(question, hostedSession);
                if ("canceled" in otherAnswer) continue;
                return otherAnswer;
            }
            return userInterview.prepareChoiceAnswer(question, selected.value);
        }
    }

    const allowEmpty = question.allowEmpty === true;
    const brokerResponse = await askBrokered(hostedSession, {
        type: RuntimeInteractionTypes.TEXT,
        prompt: question.prompt,
        defaultValue: question.default,
        placeholder: question.placeholder,
        allowEmpty,
        _meta: { source: "user_interview", questionType: question.type, questionId: question.id },
    });
    const brokerFailure = brokerFailureToAnswer(brokerResponse, question);
    if (brokerFailure) return brokerFailure;
    return userInterview.prepareTextAnswer(question, String(brokerResponse.value ?? ""));
}

function buildResult(details: InterviewResultDetails): UserInterviewResult {
    return {
        content: [{ type: "text", text: userInterview.formatResult(details) }],
        details,
    };
}
