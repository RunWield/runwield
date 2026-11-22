import { Type } from "typebox";

const parameters = Type.Object({ checklistMarkdown: Type.String({ minLength: 1 }) }, { additionalProperties: false });

export const manualQaCompletedDefinition = {
    name: "manual_qa_completed",
    exposure: "model-only",
    label: "Manual QA Completed",
    description: "Submit the manual verification checklist. Call once when the checklist is complete.",
    parameters,
} as const;
