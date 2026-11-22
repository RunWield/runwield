import { Type } from "typebox";

const PARAMETERS = Type.Object(
    {
        prompt: Type.String({
            minLength: 1,
            maxLength: 16000,
            description: "Describe the image to generate or the requested reference-image edit.",
        }),
        outputPath: Type.String({
            minLength: 1,
            description:
                "New image file inside the project (.png, .jpg, .jpeg or .webp). Existing files are never overwritten.",
        }),
        imageRefs: Type.Optional(
            Type.Array(Type.String({ minLength: 1 }), {
                maxItems: 14,
                description: "Optional project-relative images or Session attachment references to edit.",
            }),
        ),
    },
    { additionalProperties: false },
);

export const createImageDefinition = {
    name: "create_image",
    label: "create_image",
    description:
        "Generate or edit one image using the user's imageGeneration.model (Pi image model, codex-cli/openai-codex, or an OpenCode Responses model with hosted image-tool access). Save real image bytes to the required outputPath. Model and generation settings are user-controlled, not tool arguments.",
    parameters: PARAMETERS,
} as const;
