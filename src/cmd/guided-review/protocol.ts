export const GUIDED_REVIEW_USAGE_VERSION = 2;
export const GUIDED_REVIEW_EVENT_PREFIX = "RUNWIELD_GUIDED_REVIEW_EVENT ";

export interface GuidedReviewUsage {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    costUsd: number | null;
    contextWindow?: number;
}

export interface GuidedReviewUsageEvent {
    version: 2;
    type: "usage";
    usage: GuidedReviewUsage;
}

function requireNumber(value: number | null | undefined, name: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`Malformed Guided Review usage frame: ${name} must be a finite number.`);
    }
    return value;
}

function requireMeasurement(value: number | null | undefined, name: string): number | null {
    return value === null ? null : requireNumber(value, name);
}

export function encodeGuidedReviewUsageEvent(usage: GuidedReviewUsage): string {
    return `${GUIDED_REVIEW_EVENT_PREFIX}${
        JSON.stringify({ version: GUIDED_REVIEW_USAGE_VERSION, type: "usage", usage })
    }\n`;
}

export function parseGuidedReviewUsageEventLine(line: string): GuidedReviewUsageEvent | null {
    if (!line.startsWith(GUIDED_REVIEW_EVENT_PREFIX)) return null;
    const payload = line.slice(GUIDED_REVIEW_EVENT_PREFIX.length);
    let parsed: Partial<GuidedReviewUsageEvent> & { usage?: Partial<GuidedReviewUsage> };
    try {
        parsed = JSON.parse(payload) as Partial<GuidedReviewUsageEvent> & { usage?: Partial<GuidedReviewUsage> };
    } catch (error) {
        throw new Error(
            `Malformed Guided Review usage frame: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    if (parsed.version !== GUIDED_REVIEW_USAGE_VERSION || parsed.type !== "usage" || !parsed.usage) {
        throw new Error("Malformed Guided Review usage frame: expected version 2 usage event.");
    }
    const usage: GuidedReviewUsage = {
        inputTokens: requireMeasurement(parsed.usage.inputTokens, "inputTokens"),
        outputTokens: requireMeasurement(parsed.usage.outputTokens, "outputTokens"),
        cacheReadTokens: requireMeasurement(parsed.usage.cacheReadTokens, "cacheReadTokens"),
        cacheWriteTokens: requireMeasurement(parsed.usage.cacheWriteTokens, "cacheWriteTokens"),
        costUsd: requireMeasurement(parsed.usage.costUsd, "costUsd"),
    };
    if (parsed.usage.contextWindow !== undefined) {
        usage.contextWindow = requireNumber(parsed.usage.contextWindow, "contextWindow");
    }
    return { version: GUIDED_REVIEW_USAGE_VERSION, type: "usage", usage };
}

export const GUIDED_REVIEW_METADATA_PREFIX = "RUNWIELD_GUIDED_REVIEW_METADATA ";

export interface GuidedReviewMetadata {
    provider: string;
    model: string;
    thinkingLevel?: string;
}

export function encodeGuidedReviewMetadata(metadata: GuidedReviewMetadata): string {
    return `${GUIDED_REVIEW_METADATA_PREFIX}${JSON.stringify(metadata)}\n`;
}

export function parseGuidedReviewMetadataLine(line: string): GuidedReviewMetadata | null {
    if (!line.startsWith(GUIDED_REVIEW_METADATA_PREFIX)) return null;
    const metadata: Partial<GuidedReviewMetadata> = JSON.parse(line.slice(GUIDED_REVIEW_METADATA_PREFIX.length));
    if (
        !metadata || typeof metadata.provider !== "string" || !metadata.provider ||
        typeof metadata.model !== "string" || !metadata.model ||
        (metadata.thinkingLevel !== undefined && typeof metadata.thinkingLevel !== "string")
    ) {
        throw new Error("Malformed Guided Review metadata: expected provider, model, and optional thinkingLevel.");
    }
    return {
        provider: metadata.provider,
        model: metadata.model,
        ...(metadata.thinkingLevel ? { thinkingLevel: metadata.thinkingLevel } : {}),
    };
}
