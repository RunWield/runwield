import { Type } from "typebox";

export const WORK_RECORD_SEARCH_TOOL_NAME = "work_record_search";

const PARAMETERS = Type.Object(
    {
        query: Type.String({ minLength: 1, description: "Work Record search query." }),
    },
    { additionalProperties: false },
);

export const workRecordSearchDefinition = {
    name: WORK_RECORD_SEARCH_TOOL_NAME,
    label: "Work Record Search",
    description: "Search canonical Work Records through the derived index and return hydrated Markdown metadata.",
    promptSnippet: "Search current usable Work Records for planning context by query.",
    parameters: PARAMETERS,
} as const;
