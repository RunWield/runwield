/**
 * @module tools/see-image
 * Vision fallback Custom Tool for text-only primary models.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { getModelRegistry, SYSTEM_MODEL_DISCOVERY_NETWORK } from "../shared/models/model-registry.ts";
import { remotePersonalResourcesActive } from "../shared/remote/personal-resources.ts";
import { resolveImageRef, resolveVisionFallbackModel } from "../shared/session/image-attachments.ts";

export const DEFAULT_SEE_IMAGE_PROMPT =
    "Describe this image in detail for a text-only coding agent. Include all visible UI/content, readable text and error messages, relevant layout, controls, highlighted regions, and visual state. If text or details are unclear, say so explicitly.";

const PARAMETERS = Type.Object({
    imageRef: Type.String({
        minLength: 1,
        description:
            "Image reference to inspect. Use attachment:<uuid> for pasted session images, or a safe project-relative image path.",
    }),
    question: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 2000,
        description: "Optional focused question about the image. Defaults to a detailed general description request.",
    })),
}, { additionalProperties: false });

interface TextContentBlock {
    type?: string;
    text?: string;
    data?: string;
    mimeType?: string;
}

type AssistantContent = string | TextContentBlock[] | AssistantMessage["content"] | null | undefined;
type VisionModel = Model<Api>;

type CompleteSimpleFunction = (
    model: VisionModel,
    context: Context,
    options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

interface SeeImageToolOptions {
    cwd: string;
    sessionManager?: SessionManager;
    completeSimpleFn?: CompleteSimpleFunction;
    /** Selected by the bounded remote Session, never by this tool's caller. */
    remoteModel?: VisionModel;
}

interface SeeImageDetails {
    ok: boolean;
}

type SeeImageResult = AgentToolResult<SeeImageDetails> & { isError?: boolean };

export function extractAssistantText(content: AssistantContent): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((block) => block.type === "text" ? block.text || "" : "").filter(Boolean).join("\n").trim();
}

export function createSeeImageTool(opts: SeeImageToolOptions) {
    const remote = remotePersonalResourcesActive();
    if (remote !== Boolean(opts.remoteModel)) {
        throw new Error("Remote see_image requires a selected vision model; local callers cannot replace it");
    }
    if (!opts.completeSimpleFn) throw new Error("see_image requires a model completion function");
    const modelRegistry = remote ? undefined : getModelRegistry();

    return defineTool<typeof PARAMETERS, SeeImageDetails>({
        name: "see_image",
        label: "see_image",
        description:
            "Inspect an image only using the configured visionFallback.model. imageRef must be an attachment:<uuid> reference or a safe project-relative .png, .jpg, .jpeg, .gif, or .webp path. This tool cannot inspect documents, source files, or other non-image files; use the appropriate file-reading tool instead. Returns a textual description for text-only primary models.",
        parameters: PARAMETERS,
        async execute(_toolCallId, params, signal, _onUpdate, _ctx): Promise<SeeImageResult> {
            try {
                const resolved = await resolveImageRef(params.imageRef, {
                    cwd: opts.cwd,
                    sessionManager: opts.sessionManager,
                });
                const fallback = remote
                    ? { model: opts.remoteModel! }
                    : await resolveVisionFallbackModel(modelRegistry!, SYSTEM_MODEL_DISCOVERY_NETWORK, opts.cwd);
                if (!fallback) throw new Error("visionFallback.model is not configured.");
                // Remote sessions have no provider credentials. The projected native runtime
                // carries this request over the authenticated control connection instead.
                const auth = remote ? undefined : await modelRegistry!.getApiKeyAndHeaders(fallback.model);
                if (auth && !auth.ok) throw new Error(auth.error || "Unable to resolve auth for visionFallback.model.");
                if (!remote && (!auth || !auth.apiKey && !auth.headers)) {
                    throw new Error(
                        `No API key configured for visionFallback.model: ${fallback.model.provider}/${fallback.model.id}`,
                    );
                }

                const bytes = await Deno.readFile(resolved.path);
                let binary = "";
                for (const byte of bytes) binary += String.fromCharCode(byte);
                const base64 = btoa(binary);
                const question = params.question?.trim() || DEFAULT_SEE_IMAGE_PROMPT;

                const context: Context = {
                    messages: [{
                        role: "user",
                        content: [
                            { type: "text", text: question },
                            { type: "image", data: base64, mimeType: resolved.mimeType },
                        ],
                        timestamp: Date.now(),
                    }],
                };
                const response = await opts.completeSimpleFn!(fallback.model, context, {
                    signal,
                    apiKey: auth?.ok ? auth.apiKey : undefined,
                    headers: auth?.ok ? auth.headers : undefined,
                    env: auth?.ok ? auth.env : undefined,
                    maxTokens: 2048,
                });

                if (response.stopReason === "error") {
                    throw new Error(response.errorMessage || "visionFallback.model returned an error.");
                }

                const text = extractAssistantText(response.content) || "(visionFallback.model returned no text)";
                return { content: [{ type: "text" as const, text }], details: { ok: true } };
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
