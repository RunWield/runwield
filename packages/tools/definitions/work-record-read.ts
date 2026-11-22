import { Type } from "typebox";

export const WORK_RECORD_READ_TOOL_NAME = "work_record_read";

const PARAMETERS = Type.Object(
    {
        recordId: Type.String({ minLength: 1, description: "Stable Work Record recordId." }),
    },
    { additionalProperties: false },
);

export const workRecordReadDefinition = {
    name: WORK_RECORD_READ_TOOL_NAME,
    label: "Work Record Read",
    description: "Read canonical Work Record Markdown by stable recordId, subject to agent access mode.",
    promptSnippet: "Read a Work Record by recordId when search results identify relevant planning context.",
    parameters: PARAMETERS,
} as const;
