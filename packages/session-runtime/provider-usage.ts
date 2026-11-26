import type { JsonValue } from "@runwield/parsing/jsonc";
import type { RuntimeUsage } from "./events.ts";

interface ProviderUsageCost {
    total?: JsonValue;
}

/** Reported values from model providers or persisted transcript usage records. */
export interface ProviderUsage {
    input?: JsonValue;
    inputTokens?: JsonValue;
    output?: JsonValue;
    outputTokens?: JsonValue;
    cacheRead?: JsonValue;
    cacheReadTokens?: JsonValue;
    cacheWrite?: JsonValue;
    cacheWriteTokens?: JsonValue;
    cost?: JsonValue | ProviderUsageCost;
    costUsd?: JsonValue;
    contextWindow?: JsonValue;
    context_window?: JsonValue;
}

function reportedUsageNumber(value: JsonValue | undefined): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Normalize provider-specific usage once at the Runtime boundary. Absence is not zero.
 */
export function normalizeRuntimeUsage(value: ProviderUsage | JsonValue | undefined): RuntimeUsage {
    const usage = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const cost = usage.cost;
    const total = cost && typeof cost === "object" ? (Array.isArray(cost) ? undefined : cost.total) : cost;
    const contextWindow = reportedUsageNumber(usage.contextWindow ?? usage.context_window);
    const normalized = {
        inputTokens: reportedUsageNumber(usage.input ?? usage.inputTokens),
        outputTokens: reportedUsageNumber(usage.output ?? usage.outputTokens),
        cacheReadTokens: reportedUsageNumber(usage.cacheRead ?? usage.cacheReadTokens),
        cacheWriteTokens: reportedUsageNumber(usage.cacheWrite ?? usage.cacheWriteTokens),
        costUsd: reportedUsageNumber(total ?? usage.costUsd),
    };
    return contextWindow !== null && contextWindow > 0 ? { ...normalized, contextWindow } : normalized;
}
