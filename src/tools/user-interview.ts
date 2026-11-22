/**
 * @module user-interview
 * Structured user interview tool for planning agents.
 */

import {
    toolRegistry,
    type InterviewError,
    type InterviewQuestion,
    type InterviewAnswerValue,
    type InterviewResultDetails,
    type InterviewResultAnswer,
    type CompletedInterviewResultDetails,
} from "@runwield/tools";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { HostedSession } from "../shared/session/hosted-session.ts";
import type {
    RuntimeInteractionRequest,
    RuntimeInteractionResponse,
} from "../shared/session/session-runtime-interactions.ts";
import {
    requestHostedSessionInteraction,
    RuntimeInteractionOutcomes,
    RuntimeInteractionTypes,
} from "../shared/session/session-runtime-interactions.ts";

const userInterview = toolRegistry.get("user_interview");

interface SelectOption {
    value: string;
    label: string;
}

const RECOMMENDED_SUFFIX_PATTERN = /\s*\(recommended\)\s*$/i;

type InterviewAnswer =
    | { canceled: true }
    | { error: InterviewError }
    | { value: InterviewAnswerValue; valueLabel?: string; otherText?: string };

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

function withRecommendedSuffix(label: string): string {
    return RECOMMENDED_SUFFIX_PATTERN.test(label) ? label.trim() : `${label} (recommended)`;
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
    options: SelectOption[],
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
    const option = options.find((item) => item.value === selected);
    if (selected === userInterview.otherValue && brokerResponse.otherText !== undefined) {
        return otherAnswerFromText(question, brokerResponse.otherText);
    }
    return { value: String(selected), valueLabel: brokerResponse.valueLabel || option?.label };
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
    return otherAnswerFromText(question, String(otherResponse.value ?? ""));
}

function otherAnswerFromText(question: InterviewQuestion, otherText: string): InterviewAnswer {
    const normalized = otherText.trim();
    if (!normalized) {
        return {
            error: {
                code: "EMPTY_ANSWER",
                message: "The 'Other' answer cannot be empty.",
                questionId: question.id,
            },
        };
    }
    return { value: userInterview.otherValue, valueLabel: "Other", otherText: normalized };
}

async function askQuestion(
    question: InterviewQuestion,
    hostedSession: HostedSession | undefined,
): Promise<InterviewAnswer> {
    if (question.type === "yes_no") {
        const options: SelectOption[] = [
            { value: "yes", label: question.default === true ? "Yes (recommended)" : "Yes" },
            { value: "no", label: question.default === false ? "No (recommended)" : "No" },
            { value: userInterview.otherValue, label: "Other" },
        ];
        while (true) {
            const selected = await askSelect(
                question,
                options,
                hostedSession,
                typeof question.default === "boolean" ? (question.default ? "yes" : "no") : undefined,
            );
            if ("canceled" in selected || "error" in selected) return selected;
            if (selected.value === userInterview.otherValue) {
                if (selected.otherText !== undefined) return selected;
                const otherAnswer = await askOther(question, hostedSession);
                if ("canceled" in otherAnswer) continue;
                return otherAnswer;
            }
            if (selected.value !== "yes" && selected.value !== "no") {
                return {
                    error: {
                        code: "INVALID_ANSWER",
                        message: `Unexpected yes/no response: ${selected.value}`,
                        questionId: question.id,
                    },
                };
            }
            return { value: selected.value === "yes", valueLabel: String(selected.value) };
        }
    }

    if (question.type === "multiple_choice") {
        const options: SelectOption[] = question.choices.map((choice) => ({
            value: choice.value,
            label:
                choice.value === question.default
                    ? withRecommendedSuffix(choice.label || choice.value)
                    : choice.label || choice.value,
        }));
        options.push({ value: userInterview.otherValue, label: "Other" });
        while (true) {
            const selected = await askSelect(question, options, hostedSession, question.default);
            if ("canceled" in selected || "error" in selected) return selected;
            if (selected.value === userInterview.otherValue) {
                if (selected.otherText !== undefined) return selected;
                const otherAnswer = await askOther(question, hostedSession);
                if ("canceled" in otherAnswer) continue;
                return otherAnswer;
            }
            const selectedOption = options.find((opt) => opt.value === selected.value);
            if (!selectedOption) {
                return {
                    error: {
                        code: "INVALID_ANSWER",
                        message: `Selected option does not exist: ${selected.value}`,
                        questionId: question.id,
                    },
                };
            }
            return { value: String(selected.value), valueLabel: selectedOption.label };
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
    const text = String(brokerResponse.value ?? "");

    const normalized = allowEmpty ? text : text.trim();
    if (!allowEmpty && !normalized) {
        return {
            error: {
                code: "EMPTY_ANSWER",
                message: "Text answer cannot be empty.",
                questionId: question.id,
            },
        };
    }

    return { value: normalized };
}

function buildResult(details: InterviewResultDetails): UserInterviewResult {
    const payload = { ...details, errors: details.errors || [] };

    return {
        content: [
            {
                type: "text",
                text: `${buildResultSummary(details)}\n\ninterview_result_json:\n${JSON.stringify(payload, null, 2)}`,
            },
        ],
        details,
    };
}

function formatAnswerSelection(answer: InterviewResultAnswer): string {
    if (answer.otherText) return `Other: ${answer.otherText}`;
    if (answer.valueLabel) return answer.valueLabel;
    return String(answer.value);
}

function answerLineNumber(answer: InterviewResultAnswer): number {
    if (typeof answer.value === "string" && /^\d+$/.test(answer.value)) return Number(answer.value);
    return answer.index;
}

function buildCompletedResultSummary(details: CompletedInterviewResultDetails): string {
    const summaries = details.answers.map(
        (answer) =>
            `${answer.prompt}\n\n${answerLineNumber(answer)}. Answer selected was ${formatAnswerSelection(answer)}`,
    );
    return summaries.join("\n\n");
}

function buildResultSummary(details: InterviewResultDetails): string {
    if (details.status === "completed") {
        return buildCompletedResultSummary(details);
    }

    if (details.status === "canceled") {
        return `Interview canceled at question ${
            details.canceledAt || "?"
        }: captured ${details.answeredCount}/${details.totalQuestions} answer(s).`;
    }

    const reason = details.errors?.[0]?.message || "unknown error";
    return `Interview ${details.status.replaceAll("_", " ")}: ${reason}`;
}
