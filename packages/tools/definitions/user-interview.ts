import { Type, type Static } from "typebox";

const QUESTION_ID = Type.String({
    minLength: 1,
    maxLength: 64,
    description: "Optional stable question ID (letters, numbers, underscore, dash).",
});

const YES_NO_QUESTION = Type.Object(
    {
        id: Type.Optional(QUESTION_ID),
        type: Type.Enum(["yes_no"]),
        prompt: Type.String({ minLength: 1, maxLength: 400, description: "Question text shown to the user." }),
        default: Type.Optional(Type.Boolean({ description: "Optional recommended default answer." })),
        allowOther: Type.Optional(
            Type.Boolean({
                description: "Deprecated. 'Other' is always available for yes_no questions.",
            }),
        ),
    },
    { additionalProperties: false },
);

const TEXT_QUESTION = Type.Object(
    {
        id: Type.Optional(QUESTION_ID),
        type: Type.Enum(["text"]),
        prompt: Type.String({ minLength: 1, maxLength: 400, description: "Question text shown to the user." }),
        default: Type.Optional(Type.String({ maxLength: 400, description: "Optional default text answer." })),
        placeholder: Type.Optional(Type.String({ maxLength: 200, description: "Optional prompt hint." })),
        allowEmpty: Type.Optional(Type.Boolean({ description: "Whether empty text answers are allowed." })),
    },
    { additionalProperties: false },
);

const MULTIPLE_CHOICE_QUESTION = Type.Object(
    {
        id: Type.Optional(QUESTION_ID),
        type: Type.Enum(["multiple_choice"]),
        prompt: Type.String({ minLength: 1, maxLength: 400, description: "Question text shown to the user." }),
        choices: Type.Array(
            Type.Object(
                {
                    value: Type.String({ minLength: 1, maxLength: 120 }),
                    label: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
                },
                { additionalProperties: false },
            ),
            {
                minItems: 2,
                maxItems: 12,
                description: "Choice list. Values must be unique in the same question.",
            },
        ),
        default: Type.Optional(
            Type.String({ minLength: 1, maxLength: 120, description: "Optional default choice value." }),
        ),
        allowOther: Type.Optional(
            Type.Boolean({
                description: "Deprecated. 'Other' is always available for multiple_choice questions.",
            }),
        ),
    },
    { additionalProperties: false },
);

const INTERVIEW_QUESTION = Type.Union([YES_NO_QUESTION, TEXT_QUESTION, MULTIPLE_CHOICE_QUESTION]);

const PARAMETERS = Type.Object(
    {
        question: Type.Optional(INTERVIEW_QUESTION),
        questions: Type.Optional(
            Type.Array(INTERVIEW_QUESTION, {
                minItems: 1,
                maxItems: 3,
                description: "Batch of 1-3 questions asked sequentially.",
            }),
        ),
    },
    { additionalProperties: false },
);

export const userInterviewDefinition = {
    name: "user_interview",
    exposure: "model-only",
    label: "User Interview",
    description:
        "Ask the user 1-3 structured clarification questions (yes_no, text, multiple_choice) and receive ordered answers. Yes/no and multiple-choice always include an 'Other' option with free-text follow-up.",
    promptSnippet:
        "user_interview(question|questions): Ask one or a small 1-3 question batch before finalizing planning decisions. Yes/no and multiple_choice always include an Other option for open-ended input.",
    parameters: PARAMETERS,
} as const;

export type InterviewParameters = Static<typeof userInterviewDefinition.parameters>;
