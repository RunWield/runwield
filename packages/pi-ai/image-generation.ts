import type { ImagesOptions, Usage } from "@earendil-works/pi-ai";
import { getModelRuntime } from "./models.ts";
import type { TurnImage, TurnInput } from "./turn.ts";

/** Image model identity and the provider options supported for image generation. */
export interface GenerateImageOptions {
    provider: string;
    modelId: string;
    modelRef: string;
    signal?: AbortSignal;
    temperature?: number;
    thinkingLevel?: string;
}

/** The single image returned by Pi and any provider usage measurements. */
export interface GeneratedImage {
    image: TurnImage;
    usage?: Usage;
}

interface OpenRouterImagePayload {
    temperature?: number;
    reasoning?: { effort: string };
    provider?: { require_parameters: boolean };
}

/** Verified mappings, not a claim that all image models accept chat options. */
function piOptions(provider: string, id: string, settings: GenerateImageOptions): ImagesOptions {
    const gemini =
        provider === "openrouter" && ["google/gemini-2.5-flash-image", "google/gemini-3.1-flash-image"].includes(id);
    if (settings.temperature !== undefined && !gemini) {
        throw new Error(`temperature is not supported by create_image for ${provider}/${id}. Remove it.`);
    }
    if (
        settings.thinkingLevel !== undefined &&
        !(gemini && id === "google/gemini-3.1-flash-image" && ["minimal", "high"].includes(settings.thinkingLevel))
    ) {
        throw new Error(
            `thinkingLevel is not supported for ${provider}/${id}. Gemini 3.1 Flash Image supports minimal or high.`,
        );
    }
    return {
        // An ambiguous retry may generate and charge for another image.
        maxRetries: 0,
        timeoutMs: 300_000,
        onPayload: (payload) => {
            const request = payload as OpenRouterImagePayload;
            if (settings.temperature !== undefined) request.temperature = settings.temperature;
            if (settings.thinkingLevel !== undefined) request.reasoning = { effort: settings.thinkingLevel };
            if (settings.temperature !== undefined || settings.thinkingLevel !== undefined) {
                request.provider = { require_parameters: true };
            }
            return request;
        },
    };
}

/** Generate one image through the model runtime with image-specific request options. */
export async function generateImage(
    { text, images }: TurnInput,
    settings: GenerateImageOptions,
): Promise<GeneratedImage> {
    const { provider, modelId, modelRef, signal } = settings;
    const options = piOptions(provider, modelId, settings);
    const runtime = await getModelRuntime();
    const model = runtime.getModelOfType("image", provider, modelId);
    if (!model) {
        throw new Error(
            `Not a configured Pi image-output model: ${modelRef}. A vision/chat model is not an image generator.`,
        );
    }
    if (images?.length && !model.input.includes("image")) {
        throw new Error(`${modelRef} does not accept reference images.`);
    }
    const input = [{ type: "text" as const, text }, ...(images ?? [])];
    const result = await runtime.generateImages(model, { input }, { ...options, signal });
    if (result.stopReason !== "stop") {
        throw new Error(result.errorMessage || `Image generation ${result.stopReason}.`);
    }
    const output = result.output.filter((block): block is TurnImage => block.type === "image");
    if (output.length !== 1) {
        throw new Error(`Expected one generated image; provider returned ${output.length}. No file was written.`);
    }
    return { image: output[0], usage: result.usage };
}
