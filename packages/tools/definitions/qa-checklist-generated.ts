import { Type } from "typebox";

const TOOL_PARAMS = Type.Object(
    {
        checklistMarkdown: Type.String({
            minLength: 1,
            description:
                "Markdown checklist starting with 'Manual verification steps for <child plan>' and 1 to 6 unchecked items.",
        }),
    },
    { additionalProperties: false },
);

export const qaChecklistGeneratedDefinition = {
    name: "qa_checklist_generated",
    exposure: "model-only",
    label: "QA Checklist Generated",
    description:
        "Record this Epic child's Manual QA checklist in the Epic artifact. This tool is advisory only: failure never changes verification status.",
    parameters: TOOL_PARAMS,
} as const;
