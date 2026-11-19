export type AgyCliEffort = "low" | "medium" | "high" | "xhigh";

/** Keep supervising-model selection identical for chat, images, and replay. */
export function thinkingLevelToEffort(modelId: string, thinkingLevel: string | undefined): AgyCliEffort {
    switch (thinkingLevel ?? "off") {
        case "off":
        case "minimal":
        case "low":
            return "low";
        case "medium":
            return modelId === "gemini-3.1-pro" ? "high" : "medium";
        case "high":
            return "high";
        case "xhigh":
        case "max":
            return modelId === "gemini-4-hydrogen" ? "xhigh" : "high";
        default:
            throw new Error(`Unknown RunWield thinkingLevel "${thinkingLevel}".`);
    }
}

export function concreteAgyModel(modelId: string, effort: AgyCliEffort): string {
    return `${modelId}-${effort}`;
}
