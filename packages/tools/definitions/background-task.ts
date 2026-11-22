import { Type } from "typebox";

const PARAMETERS = Type.Object(
    {
        action: Type.Enum(["start", "status", "cancel"]),
        command: Type.Optional(Type.String()),
        task_id: Type.Optional(Type.String()),
        timeout: Type.Optional(Type.Number({ description: "Optional positive timeout in seconds." })),
    },
    { additionalProperties: false },
);

export const backgroundTaskDefinition = {
    name: "background_task",
    label: "Background Task",
    description:
        "Start an independent shell command, or check or cancel a Session background task. A start is not a passed test; inspect the final result. ",
    parameters: PARAMETERS,
} as const;
