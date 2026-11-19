import { getCustomSetting, getMergedCustomSetting } from "./settings.ts";

export interface ImageGenerationSettings {
    model: string;
    thinkingLevel?: string;
    temperature?: number;
    enabled?: boolean;
}

interface ImageGenerationPreset {
    imageGeneration?: ImageGenerationSettings;
}

/** Model changes replace the old route's options instead of inheriting them. */
function mergeSettings(base: ImageGenerationSettings | undefined, next: ImageGenerationSettings | undefined) {
    if (next === undefined) return base;
    if (!next || typeof next !== "object" || Array.isArray(next)) {
        throw new Error("imageGeneration must be an object with a model.");
    }
    return next.model !== undefined && next.model !== base?.model ? next : { ...base, ...next };
}

/** The same global, project and active-preset scopes as visionFallback. */
export function resolveImageGenerationSettings(cwd: string): ImageGenerationSettings | undefined {
    const global = getCustomSetting("imageGeneration", "global", cwd) as ImageGenerationSettings | undefined;
    const project = getCustomSetting("imageGeneration", "project", cwd) as ImageGenerationSettings | undefined;
    let settings = mergeSettings(mergeSettings(undefined, global), project);
    const preset = getMergedCustomSetting("activeModelPreset", cwd);
    const presets = getMergedCustomSetting("modelPresets", cwd) as Record<string, ImageGenerationPreset> | undefined;
    if (typeof preset === "string") settings = mergeSettings(settings, presets?.[preset]?.imageGeneration);
    if (!settings || settings.enabled === false) return undefined;
    if (typeof settings.model !== "string" || !settings.model.trim()) {
        throw new Error("imageGeneration.model must be a provider/model reference.");
    }
    if (settings.enabled !== undefined && typeof settings.enabled !== "boolean") {
        throw new Error("imageGeneration.enabled must be a boolean.");
    }
    if (settings.thinkingLevel !== undefined && typeof settings.thinkingLevel !== "string") {
        throw new Error("imageGeneration.thinkingLevel must be a supported thinking level.");
    }
    if (
        settings.temperature !== undefined &&
        (typeof settings.temperature !== "number" || !Number.isFinite(settings.temperature) ||
            settings.temperature < 0 || settings.temperature > 2)
    ) {
        throw new Error("imageGeneration.temperature must be a finite number between 0 and 2.");
    }
    for (const key of Object.keys(settings)) {
        if (!["model", "thinkingLevel", "temperature", "enabled"].includes(key)) {
            throw new Error(`Unsupported imageGeneration setting: ${key}. Use model, thinkingLevel or temperature.`);
        }
    }
    return { ...settings, model: settings.model.trim() };
}
