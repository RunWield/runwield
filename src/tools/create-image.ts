import { toolRegistry } from "@runwield/tools";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

const definition = toolRegistry.get("create_image").definition;

interface CreateImageToolOptions {
    cwd: string;
    sessionManager?: SessionManager;
    includeImage?: boolean;
}

export function createImageTool(options: CreateImageToolOptions) {
    return defineTool({
        ...definition,

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
