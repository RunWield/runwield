import { Type } from "typebox";

const parameters = Type.Object(
    {
        title: Type.String({ minLength: 1 }),
        summary: Type.String({ minLength: 1 }),
        outOfScope: Type.Optional(Type.String()),
        futurePlanningNotes: Type.Optional(Type.String()),
        supersessionProposals: Type.Optional(
            Type.Array(
                Type.Object({
                    recordId: Type.String({
                        pattern:
                            "^\\s*[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\\s*$",
                    }),
                    reason: Type.String({ minLength: 1 }),
                }),
            ),
        ),
    },
    { additionalProperties: false },
);

export const workRecordCompletedDefinition = {
    name: "work_record_completed",
    exposure: "model-only",
    label: "Work Record Completed",
    description: "Submit the completed Work Record sections.",
    parameters,
} as const;
