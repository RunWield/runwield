import { formatProviderModelReference, type ActiveModelState } from "@runwield/pi-ai";
import { listUserModelOptions } from "../shared/session/user-selection.ts";
import type { SessionConfigOption } from "@agentclientprotocol/sdk/unstable";

/** The session's current model and reasoning choice. */
export interface AcpModelSelection {
    activeModel?: ActiveModelState;
    thinkingLevel?: string;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Expose the same selectable models, reasoning levels, and active choices as the other Session surfaces.
 */
export async function buildAcpModelOptions(
    selection: AcpModelSelection | null | undefined,
): Promise<SessionConfigOption[]> {
    const active = selection?.activeModel;
    if (!active?.model) return [];
    const models = await listUserModelOptions();
    const currentValue = formatProviderModelReference(active);
    const options = models.map((model) => ({
        value: `${model.provider}/${model.id}`,
        name: `${model.name} (${model.provider})`,
    }));
    // Saved Sessions can retain a model whose credentials are no longer available.
    // Keep the reported current value honest while offering usable alternatives.
    if (!options.some((option) => option.value === currentValue)) {
        options.unshift({ value: currentValue, name: currentValue });
    }
    const configOptions: SessionConfigOption[] = [
        { id: "model", name: "Model", category: "model", type: "select", currentValue, options },
    ];
    const activeModel = models.find((model) => `${model.provider}/${model.id}` === currentValue);
    if (activeModel?.reasoning) {
        configOptions.push({
            id: "thought_level",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: selection?.thinkingLevel || "off",
            options: THINKING_LEVELS.map((value) => ({
                value,
                name: value === "xhigh" ? "Extra High" : `${value[0].toUpperCase()}${value.slice(1)}`,
            })),
        });
    }
    return configOptions;
}
