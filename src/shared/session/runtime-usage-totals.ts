import { normalizeRuntimeUsage } from "./session-runtime-events.js";
import type { RuntimeUsage } from "./session-runtime-events.js";

export type UsageCategory = "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "costUsd";
export type MeasurementAvailability = "complete" | "partial" | "unavailable";
export type UsageAvailability = Record<UsageCategory, MeasurementAvailability>;

const categories: UsageCategory[] = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"];

/** Sum measured values without converting missing measurements to zero. */
export class RuntimeUsageTotals {
    readonly usage: RuntimeUsage = {
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costUsd: null,
    };
    readonly availability: UsageAvailability = {
        inputTokens: "unavailable",
        outputTokens: "unavailable",
        cacheReadTokens: "unavailable",
        cacheWriteTokens: "unavailable",
        costUsd: "unavailable",
    };
    private observations = 0;

    add(reportedUsage: Partial<RuntimeUsage>): void {
        const usage = normalizeRuntimeUsage(reportedUsage);
        for (const category of categories) {
            const value = usage[category];
            const availability = value === null ? "unavailable" : "complete";
            this.availability[category] = this.observations === 0
                ? availability
                : this.availability[category] === availability
                ? availability
                : "partial";
            if (value !== null) this.usage[category] = (this.usage[category] ?? 0) + value;
        }
        if (usage.contextWindow !== undefined) this.usage.contextWindow = usage.contextWindow;
        this.observations++;
    }

    /** Token coverage; USD cost has separate provenance in model_usage records. */
    get measurementAvailability(): MeasurementAvailability {
        const tokens = categories.filter((category) => category !== "costUsd");
        if (tokens.every((category) => this.availability[category] === "complete")) return "complete";
        if (tokens.every((category) => this.availability[category] === "unavailable")) return "unavailable";
        return "partial";
    }
}
