import { getModelRegistry } from "../models/model-registry.ts";
import { getSettingsManager } from "../settings.ts";

export interface ModelAvailability {
    available: boolean;
    error: string | null;
}

export interface ModelSummary {
    id: string;
    provider: string;
    executionBackend?: string;
}

export interface ModelAvailabilitySource {
    getAvailable(): readonly ModelSummary[];
    find?(provider: string, id: string): ModelSummary | undefined;
}

function isRegistryModelSummary(value: ModelSummary | undefined): value is ModelSummary {
    return Boolean(value && typeof value === "object");
}

/**
 * Pure value contract: classify a registry snapshot's available-model count.
 *
 * @param registry A registry value (never an injected authority).
 */
export function detectModelAvailability(registry: ModelAvailabilitySource): ModelAvailability {
    try {
        return { available: (registry.getAvailable?.() || []).length > 0, error: null };
    } catch (error) {
        return { available: false, error: error instanceof Error ? error.message : String(error) };
    }
}

/** @returns {ModelAvailability} */
export function getConfiguredModelAvailability(): ModelAvailability {
    try {
        return detectModelAvailability(getModelRegistry());
    } catch (error) {
        return { available: false, error: error instanceof Error ? error.message : String(error) };
    }
}

/** @returns {ModelAvailability} */
export function getConfiguredProviderAvailability(): ModelAvailability {
    try {
        return { available: (getModelRegistry().getRegisteredProviderIds?.() || []).length > 0, error: null };
    } catch (error) {
        return { available: false, error: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * Whether the persisted default model is runnable right now. Registry or
 * settings failures become `{ available: false, error }` — this never throws.
 *
 * @param projectRoot Project root that scopes the settings manager.
 * @returns {ModelAvailability}
 */
export function getSelectedDefaultModelAvailability(projectRoot: string): ModelAvailability {
    try {
        const settingsManager = getSettingsManager(projectRoot);
        const defaultModel = settingsManager.getDefaultModel?.()?.trim();
        const defaultProvider = settingsManager.getDefaultProvider?.()?.trim();
        if (!defaultModel) {
            return { available: false, error: "No default model is selected." };
        }

        const registry = getModelRegistry();
        if (!registry.find) return { available: true, error: null };
        const found = registry.find(defaultProvider || "", defaultModel);
        const foundModel = isRegistryModelSummary(found) ? found : null;
        if (foundModel && registry.isSelectable?.(foundModel)) return { available: true, error: null };
        const availableModels = registry.getAvailable?.() || [];
        const runnable = availableModels.some((model) =>
            model.provider === (defaultProvider || foundModel?.provider) &&
            model.id === (foundModel?.id || defaultModel)
        );
        if (foundModel && runnable) return { available: true, error: null };

        if (defaultProvider === "agy-cli") {
            return {
                available: false,
                error:
                    `Unsupported Antigravity CLI model: ${defaultProvider}/${defaultModel}. Select agy-cli/gemini-3.8-flash or agy-cli/gemini-3.1-pro.`,
            };
        }
        return {
            available: false,
            error: defaultProvider
                ? `Selected default model is unavailable: ${defaultProvider}/${defaultModel}`
                : `Selected default model is unavailable: ${defaultModel}`,
        };
    } catch (error) {
        return { available: false, error: error instanceof Error ? error.message : String(error) };
    }
}
