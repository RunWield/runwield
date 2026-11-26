import type { InterviewParameters } from "./definitions/user-interview.ts";
export const INTERVIEW_OTHER_VALUE = "other";

export interface InterviewError {
    code:
        | "DEFAULT_NOT_IN_CHOICES"
        | "DUPLICATE_CHOICE_VALUE"
        | "DUPLICATE_ID"
        | "EMPTY_ANSWER"
        | "EMPTY_CHOICE_VALUE"
        | "EMPTY_PROMPT"
        | "INTERACTION_BLOCKED"
        | "INTERACTION_UNSUPPORTED"
        | "INVALID_ANSWER"
        | "INVALID_BATCH"
        | "INVALID_CHOICES"
        | "INVALID_ID"
        | "SENTINEL_COLLISION"
        | "USER_CANCELED";
    message: string;
    questionIndex?: number;
    questionId?: string;
}

export interface InterviewChoice {
    value: string;
    label?: string;
}

export interface YesNoInterviewQuestion {
    id?: string;
    type: "yes_no";
    prompt: string;
    default?: boolean;
    allowOther?: boolean;
}

export interface TextInterviewQuestion {
    id?: string;
    type: "text";
    prompt: string;
    default?: string;
    placeholder?: string;
    allowEmpty?: boolean;
}

export interface MultipleChoiceInterviewQuestion {
    id?: string;
    type: "multiple_choice";
    prompt: string;
    choices: InterviewChoice[];
    default?: string;
    allowOther?: boolean;
}

export type InterviewQuestion = YesNoInterviewQuestion | TextInterviewQuestion | MultipleChoiceInterviewQuestion;
export type InterviewAnswerValue = boolean | string;

export interface InterviewResultAnswer {
    index: number;
    id?: string;
    type: InterviewQuestion["type"];
    prompt: string;
    value: InterviewAnswerValue;
    valueLabel?: string;
    otherText?: string;
}

interface InterviewResultBase {
    totalQuestions: number;
    answeredCount: number;
    remainingCount: number;
    answers: InterviewResultAnswer[];
    errors?: InterviewError[];
}

export interface CompletedInterviewResultDetails extends InterviewResultBase {
    status: "completed";
    canceled: false;
    completed: true;
    remainingCount: 0;
    canceledAt?: never;
}

export interface CanceledInterviewResultDetails extends InterviewResultBase {
    status: "canceled";
    canceled: true;
    completed: false;
    canceledAt: number;
    errors: InterviewError[];
}

export interface InvalidInterviewResultDetails extends InterviewResultBase {
    status: "invalid_request";
    canceled: false;
    completed: false;
    canceledAt?: never;
    errors: InterviewError[];
}

export interface ValidationErrorInterviewResultDetails extends InterviewResultBase {
    status: "validation_error";
    canceled: false;
    completed: false;
    canceledAt?: never;
    errors: InterviewError[];
}

export type InterviewResultDetails =
    | CompletedInterviewResultDetails
    | CanceledInterviewResultDetails
    | InvalidInterviewResultDetails
    | ValidationErrorInterviewResultDetails;

type NormalizeBatchResult =
    { ok: true; questions: InterviewQuestion[] } | { ok: false; questions: InterviewQuestion[]; error: string };

function toInterviewQuestion(
    question: NonNullable<InterviewParameters["questions"]>[number],
): InterviewQuestion | null {
    if (question.type === "multiple_choice") {
        if (!("choices" in question) || !Array.isArray(question.choices)) return null;
        return {
            id: question.id,
            type: "multiple_choice",
            prompt: question.prompt,
            choices: question.choices.map((choice) => ({ value: choice.value, label: choice.label })),
            default: typeof question.default === "string" ? question.default : undefined,
            allowOther: "allowOther" in question ? question.allowOther : undefined,
        };
    }
    if (question.type === "yes_no") {
        return {
            id: question.id,
            type: "yes_no",
            prompt: question.prompt,
            default: typeof question.default === "boolean" ? question.default : undefined,
            allowOther: "allowOther" in question ? question.allowOther : undefined,
        };
    }
    if (question.type !== "text") return null;
    return {
        id: question.id,
        type: "text",
        prompt: question.prompt,
        default: typeof question.default === "string" ? question.default : undefined,
        placeholder: "placeholder" in question ? question.placeholder : undefined,
        allowEmpty: "allowEmpty" in question ? question.allowEmpty : undefined,
    };
}

function normalizeBatch(params: InterviewParameters): NormalizeBatchResult {
    const hasQuestion = !!params.question;
    const hasQuestions = Array.isArray(params.questions);

    if (hasQuestion && hasQuestions) {
        return { ok: false, questions: [], error: "Provide either 'question' or 'questions', not both." };
    }

    if (!hasQuestion && !hasQuestions) {
        return {
            ok: false,
            questions: [],
            error: "Missing interview payload. Provide either 'question' or 'questions'.",
        };
    }

    const questionInputs = hasQuestion && params.question ? [params.question] : params.questions;
    if (!Array.isArray(questionInputs) || questionInputs.length < 1 || questionInputs.length > 3) {
        return { ok: false, questions: [], error: "Invalid batch size. Ask 1 to 3 questions per tool call." };
    }

    const questions: InterviewQuestion[] = [];
    for (const questionInput of questionInputs) {
        const question = toInterviewQuestion(questionInput);
        if (!question) {
            return { ok: false, questions: [], error: "Invalid interview question type." };
        }
        questions.push(question);
    }
    return { ok: true, questions };
}

function validateBatch(questions: InterviewQuestion[]): InterviewError[] {
    const errors: InterviewError[] = [];
    const ids = new Set<string>();

    for (let i = 0; i < questions.length; i++) {
        const question = questions[i];
        const idx = i + 1;

        if (question.id) {
            if (!/^[a-zA-Z0-9_-]+$/.test(question.id)) {
                errors.push({
                    code: "INVALID_ID",
                    message: "Question ID must use letters, numbers, underscore, or dash.",
                    questionIndex: idx,
                    questionId: question.id,
                });
            }
            if (ids.has(question.id)) {
                errors.push({
                    code: "DUPLICATE_ID",
                    message: `Duplicate question ID: ${question.id}`,
                    questionIndex: idx,
                    questionId: question.id,
                });
            }
            ids.add(question.id);
        }

        if (typeof question.prompt !== "string" || !question.prompt.trim()) {
            errors.push({
                code: "EMPTY_PROMPT",
                message: "Question prompt cannot be empty.",
                questionIndex: idx,
                questionId: question.id,
            });
        }

        if (question.type === "multiple_choice") {
            if (!Array.isArray(question.choices) || question.choices.length < 2) {
                errors.push({
                    code: "INVALID_CHOICES",
                    message: "Multiple-choice question requires at least 2 choices.",
                    questionIndex: idx,
                    questionId: question.id,
                });
                continue;
            }

            const values = new Set<string>();
            for (const choice of question.choices) {
                const value = String(choice.value || "").trim();
                if (!value) {
                    errors.push({
                        code: "EMPTY_CHOICE_VALUE",
                        message: "Choice value cannot be empty.",
                        questionIndex: idx,
                        questionId: question.id,
                    });
                }
                if (values.has(value)) {
                    errors.push({
                        code: "DUPLICATE_CHOICE_VALUE",
                        message: `Duplicate choice value in question ${idx}: ${value}`,
                        questionIndex: idx,
                        questionId: question.id,
                    });
                }
                values.add(value);
            }

            if (values.has(INTERVIEW_OTHER_VALUE)) {
                errors.push({
                    code: "SENTINEL_COLLISION",
                    message: `The value "${INTERVIEW_OTHER_VALUE}" is reserved and cannot be used as a choice value.`,
                    questionIndex: idx,
                    questionId: question.id,
                });
            }

            if (question.default && !values.has(String(question.default).trim())) {
                errors.push({
                    code: "DEFAULT_NOT_IN_CHOICES",
                    message: `Default value "${question.default}" is not present in choices.`,
                    questionIndex: idx,
                    questionId: question.id,
                });
            }
        }
    }

    return errors;
}

export type PreparedInterview =
    { ok: true; questions: InterviewQuestion[] } | { ok: false; details: InvalidInterviewResultDetails };

/** Validate the whole batch before the host opens its first interaction. */
export function prepareInterview(params: InterviewParameters): PreparedInterview {
    const normalized = normalizeBatch(params);
    if (!normalized.ok) {
        return {
            ok: false,
            details: {
                status: "invalid_request",
                canceled: false,
                completed: false,
                totalQuestions: 0,
                answeredCount: 0,
                remainingCount: 0,
                answers: [],
                errors: [{ code: "INVALID_BATCH", message: normalized.error || "Invalid interview batch." }],
            },
        };
    }

    const questions = normalized.questions;
    const validationErrors = validateBatch(questions);
    if (validationErrors.length > 0) {
        return {
            ok: false,
            details: {
                status: "invalid_request",
                canceled: false,
                completed: false,
                totalQuestions: questions.length,
                answeredCount: 0,
                remainingCount: questions.length,
                answers: [],
                errors: validationErrors,
            },
        };
    }

    return { ok: true, questions };
}

export interface InterviewChoiceOption {
    value: string;
    label: string;
}

type ChoiceInterviewQuestion = YesNoInterviewQuestion | MultipleChoiceInterviewQuestion;

export type PreparedInterviewAnswer =
    { error: InterviewError } | { value: InterviewAnswerValue; valueLabel?: string; otherText?: string };

const RECOMMENDED_SUFFIX_PATTERN = /\s*\(recommended\)\s*$/i;

function withRecommendedSuffix(label: string): string {
    return RECOMMENDED_SUFFIX_PATTERN.test(label) ? label.trim() : label + " (recommended)";
}

function formatInterviewChoiceLabel(choice: InterviewChoice, recommended: boolean): string {
    const label = choice.label || choice.value;
    return recommended ? withRecommendedSuffix(label) : label;
}

/** Build the choice list for a validated yes/no or multiple-choice question. */
export function interviewChoiceOptions(question: ChoiceInterviewQuestion): InterviewChoiceOption[] {
    const choices =
        question.type === "yes_no"
            ? [
                  { value: "yes", label: question.default === true ? "Yes (recommended)" : "Yes" },
                  { value: "no", label: question.default === false ? "No (recommended)" : "No" },
              ]
            : question.choices.map((choice) => ({
                  value: choice.value,
                  label: formatInterviewChoiceLabel(choice, choice.value === question.default),
              }));
    return [...choices, { value: INTERVIEW_OTHER_VALUE, label: "Other" }];
}

/** Convert a host’s selected choice into the corresponding typed answer. */
export function prepareInterviewChoiceAnswer(
    question: ChoiceInterviewQuestion,
    value: InterviewAnswerValue,
): PreparedInterviewAnswer {
    if (question.type === "yes_no") {
        if (value === "yes" || value === "no") return { value: value === "yes", valueLabel: value };
        return {
            error: {
                code: "INVALID_ANSWER",
                message: "Unexpected yes/no response: " + value,
                questionId: question.id,
            },
        };
    }
    const selected = question.choices.find((choice) => choice.value === value);
    if (!selected) {
        return {
            error: {
                code: "INVALID_ANSWER",
                message: "Selected option does not exist: " + value,
                questionId: question.id,
            },
        };
    }
    return {
        value: selected.value,
        valueLabel: formatInterviewChoiceLabel(selected, selected.value === question.default),
    };
}

/** Normalize a text answer according to the validated question’s empty-answer policy. */
export function prepareInterviewTextAnswer(question: TextInterviewQuestion, text: string): PreparedInterviewAnswer {
    const allowEmpty = question.allowEmpty === true;
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

/** Normalize the free text supplied for an Other selection. */
export function prepareInterviewOtherAnswer(question: InterviewQuestion, otherText: string): PreparedInterviewAnswer {
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
    return { value: INTERVIEW_OTHER_VALUE, valueLabel: "Other", otherText: normalized };
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

/** Render the interview result and its JSON payload without an interaction host. */
export function formatInterviewResult(details: InterviewResultDetails): string {
    const payload = { ...details, errors: details.errors || [] };
    return buildResultSummary(details) + "\n\ninterview_result_json:\n" + JSON.stringify(payload, null, 2);
}
