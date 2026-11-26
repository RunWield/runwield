import type { TurnImage, TurnInput } from "@runwield/pi-ai/turn";
import { getNativeModelRegistry, getModelRuntime } from "@runwield/pi-ai/models";
import type { ImageGenerationSettings } from "../image-generation-settings.ts";

interface OpenCodeImageRequest {
    model: string;
    settings: ImageGenerationSettings;
    input: TurnInput;
    signal?: AbortSignal;
}
interface ResponseImage {
    type: string;
    status?: string;
    result?: string;
    output_format?: string;
}
interface ImageResponse {
    status?: string;
    output?: ResponseImage[];
    error?: { message?: string };
}

/** Hosted image tool over OpenCode's documented Responses endpoint, using existing Pi auth. */
export async function generateOpenCodeImage(request: OpenCodeImageRequest): Promise<TurnImage> {
    request.signal?.throwIfAborted();
    const runtime = await getModelRuntime();
    const model = runtime.getModel("opencode", request.model);
    if (!model || model.api !== "openai-responses") {
        throw new Error(
            `opencode/${request.model} is not a Responses model. This adapter requires OpenCode to support its hosted image_generation tool; vision input alone is not sufficient.`,
        );
    }
    if (request.input.images?.length && !model.input.includes("image")) {
        throw new Error(`opencode/${request.model} does not accept reference images.`);
    }
    const level = request.settings.thinkingLevel;
    let effort: string | undefined;
    if (level !== undefined) {
        if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(level) || !model.reasoning) {
            throw new Error(`Unsupported OpenCode thinkingLevel ${level} for ${request.model}.`);
        }
        // Use Pi's exact mapping; never silently clamp the user's choice.
        const mapped = model.thinkingLevelMap?.[level as keyof typeof model.thinkingLevelMap];
        if (mapped === null) throw new Error(`Unsupported OpenCode thinkingLevel ${level} for ${request.model}.`);
        effort = mapped ?? (level === "off" ? "none" : level);
    }
    if (request.settings.temperature !== undefined && model.reasoning) {
        throw new Error("OpenCode temperature is not enabled for reasoning models in this image adapter. Remove it.");
    }
    const auth = await getNativeModelRegistry().getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) throw new Error("Configure the existing opencode provider login/key in RunWield.");
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error("OpenCode image generation timed out.")), 300_000);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout.signal]) : timeout.signal;
    try {
        const response = await fetch(`${model.baseUrl.replace(/\/$/, "")}/responses`, {
            method: "POST",
            signal,
            redirect: "error",
            headers: {
                ...model.headers,
                ...auth.headers,
                Authorization: `Bearer ${auth.apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: model.id,
                store: false,
                stream: false,
                input: [
                    {
                        role: "user",
                        content: [
                            { type: "input_text", text: request.input.text },
                            ...(request.input.images ?? []).map((image) => ({
                                type: "input_image",
                                image_url: `data:${image.mimeType};base64,${image.data}`,
                                detail: "auto",
                            })),
                        ],
                    },
                ],
                tools: [{ type: "image_generation", output_format: "png" }],
                tool_choice: { type: "image_generation" },
                ...(effort ? { reasoning: { effort } } : {}),
                ...(request.settings.temperature !== undefined ? { temperature: request.settings.temperature } : {}),
            }),
        });
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (response.body) {
            for await (const chunk of response.body) {
                size += chunk.length;
                if (size > 48 * 1024 * 1024) throw new Error("OpenCode image response exceeds the size limit.");
                chunks.push(chunk);
            }
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
        }
        let result: ImageResponse;
        try {
            result = JSON.parse(new TextDecoder().decode(bytes)) as ImageResponse;
        } catch {
            throw new Error(`OpenCode returned a non-JSON image response (HTTP ${response.status}).`);
        }
        if (!response.ok || result.error) {
            const message = String(result.error?.message || response.statusText)
                .replaceAll(auth.apiKey, "[redacted]")
                .slice(0, 500);
            throw new Error(
                `OpenCode image generation rejected (HTTP ${response.status}): ${message}. Check model access and hosted image-tool support; no fallback or retry was made.`,
            );
        }
        const images = result.output?.filter((item) => item.type === "image_generation_call") || [];
        const image = images[0];
        if (result.status !== "completed" || images.length !== 1 || image.status !== "completed" || !image.result) {
            throw new Error(
                "OpenCode did not return exactly one completed image_generation_call. This account/model may not support hosted image output. No file was saved.",
            );
        }
        if (image.output_format && image.output_format !== "png") {
            throw new Error("OpenCode did not honor the requested PNG image format.");
        }
        return { type: "image", data: image.result, mimeType: "image/png" };
    } finally {
        clearTimeout(timer);
    }
}
