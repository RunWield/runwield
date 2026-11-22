import { Type, type Static } from "typebox";

const PARAMETERS = Type.Object(
    {
        supersededRequirement: Type.String({
            minLength: 1,
            description: "Exact effective Plan requirement the user's instruction replaces.",
        }),
        replacementRequirement: Type.String({
            minLength: 1,
            description: "Exact replacement requirement the user is being asked to confirm.",
        }),
        reason: Type.Optional(Type.String({ minLength: 1, description: "Optional concise reason for the deviation." })),
    },
    { additionalProperties: false },
);

export const planDeviationDefinition = {
    name: "record_plan_deviation",
    exposure: "model-only",
    label: "Record Plan Deviation",
    description:
        "Ask the user to confirm an execution instruction that replaces an effective Plan requirement, then persist the confirmed replacement in the authoritative execution Plan.",
    parameters: PARAMETERS,
} as const;

export type PlanDeviationParameters = Static<typeof planDeviationDefinition.parameters>;
