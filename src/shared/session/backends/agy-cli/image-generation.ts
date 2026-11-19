import type { ImageContent } from "@earendil-works/pi-ai";
import type { ImageGenerationSettings } from "../../../image-generation-settings.ts";

interface AgyImageRequest {
    model: string;
    settings: ImageGenerationSettings;
    prompt: string;
    referencePaths: string[];
    signal?: AbortSignal;
}

/** Keep saved Agy image settings readable without falling back to print mode or API credentials. */
export async function generateAgyImage(request: AgyImageRequest): Promise<ImageContent> {
    request.signal?.throwIfAborted();
    throw new Error(
        "agy-cli image generation is unavailable after the ACP migration. " +
            "Your saved imageGeneration settings are unchanged. " +
            "Explicitly select another supported image provider in imageGeneration.model, " +
            "or set imageGeneration.enabled to false. " +
            "RunWield will not use agy print mode or fall back to API credentials.",
    );
}
