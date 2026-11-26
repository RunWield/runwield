/** The active model selection as stored by a session. */
export interface ActiveModelState {
    model: string;
    provider?: string;
}

/** A provider and model ID, or a rejected reference. */
export type ProviderModelParseResult = { ok: true; provider: string; id: string } | { ok: false };

/**
 * Parse a strict model reference in `provider/id` format.
 */
export function parseProviderModel(value: string): ProviderModelParseResult {
    const text = value.trim();
    const slashIndex = text.indexOf("/");

    if (slashIndex <= 0 || slashIndex === text.length - 1) return { ok: false };

    const provider = text.slice(0, slashIndex).trim();
    const id = text.slice(slashIndex + 1).trim();

    if (!provider || !id) return { ok: false };

    return { ok: true, provider, id };
}

/**
 * Format a session model state as the provider/model reference accepted
 * by invocation overrides without duplicating an already-qualified provider.
 */
export function formatProviderModelReference(activeModel: ActiveModelState): string {
    if (!activeModel.provider) return activeModel.model;
    return activeModel.model.startsWith(`${activeModel.provider}/`)
        ? activeModel.model
        : `${activeModel.provider}/${activeModel.model}`;
}
