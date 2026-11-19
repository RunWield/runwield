import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

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

interface CreateImageToolOptions {
    cwd: string;
    sessionManager?: SessionManager;
    includeImage?: boolean;
}

export function createImageTool(options: CreateImageToolOptions) {
    return defineTool({
        name: "create_image",
        label: "create_image",
        description:
            "Generate or edit one image using the user's imageGeneration.model (Pi image model, agy-cli, codex-cli/openai-codex, or an OpenCode Responses model with hosted image-tool access). Save real image bytes to the required outputPath. Model and generation settings are user-controlled, not tool arguments.",
        parameters: PARAMETERS,
        async execute(_callId, params, signal) {
            try {
                // Keep image codec/WASM initialization off normal Session startup.
                const { createImage } = await import("../shared/image-generation.ts");
                const result = await createImage({ ...options, ...params, signal });
                const { preview, ...details } = result;
                const content: (TextContent | ImageContent)[] = [
                    {
                        type: "text",
                        text: `Created ${result.path} (${result.mimeType}, ${result.width}×${result.height}) using ${result.model}. Use this path as an imageRef for subsequent edits or see_image.`,
                    },
                ];
                if (options.includeImage !== false && preview) content.push(preview);
                return { content, details: { ok: true, ...details } };
            } catch (error) {
                return {
                    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
                    details: { ok: false },
                    isError: true,
                };
            }
        },
    });
}
