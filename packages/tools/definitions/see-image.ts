import { Type } from "typebox";

const PARAMETERS = Type.Object(
    {
        imageRef: Type.String({
            minLength: 1,
            description:
                "Image reference to inspect. Use attachment:<uuid> for pasted session images, or a safe project-relative image path.",
        }),
        question: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 2000,
                description:
                    "Optional focused question about the image. Defaults to a detailed general description request.",
            }),
        ),
    },
    { additionalProperties: false },
);

export const seeImageDefinition = {
    name: "see_image",
    label: "see_image",
    description:
        "Inspect an image only using the configured visionFallback.model. imageRef must be an attachment:<uuid> reference or a safe project-relative .png, .jpg, .jpeg, .gif, or .webp path. This tool cannot inspect documents, source files, or other non-image files; use the appropriate file-reading tool instead. Returns a textual description for text-only primary models.",
    parameters: PARAMETERS,
} as const;
