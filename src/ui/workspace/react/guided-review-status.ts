export type GuidedReviewUsageState = "pending" | "available" | "unavailable";

export interface GuidedReviewTokenUsage {
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
    costUsd?: number | null;
}

export interface GuidedReviewCostUsage {
    usd?: number | null;
    costUsd?: number | null;
    total?: number | null;
}

export interface GuidedReviewJobStatus {
    usageState?: GuidedReviewUsageState;
    tokens?: GuidedReviewTokenUsage | null;
    cost?: GuidedReviewCostUsage | null;
}

export interface GuidedReviewUsageStatusText {
    tokens: string;
    cost: string;
}

function formatCompactTokens(count: number): string {
    if (count < 1000) return String(count);
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000) return `${Math.round(count / 1000)}k`;
    if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
    return `${Math.round(count / 1000000)}M`;
}

function readNumber(value: number | null | undefined): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function readCostUsd(job: GuidedReviewJobStatus): number | null {
    return readNumber(job.cost?.usd ?? job.cost?.costUsd ?? job.cost?.total ?? job.tokens?.costUsd);
}

export function formatGuidedReviewUsageStatus(job: GuidedReviewJobStatus): GuidedReviewUsageStatusText {
    const state = job.usageState || (job.tokens ? "available" : "unavailable");
    if (state === "pending") return { tokens: "tokens pending", cost: "cost pending" };
    const costUsd = readCostUsd(job);
    const values = [
        job.tokens?.inputTokens,
        job.tokens?.outputTokens,
        job.tokens?.cacheReadTokens,
        job.tokens?.cacheWriteTokens,
    ].map(readNumber);
    const labels = ["in", "out", "read", "write"];
    const tokens = state === "available" && values.some((value) => value !== null)
        ? `tokens ${
            values.map((value, index) => `${value === null ? "—" : formatCompactTokens(value)} ${labels[index]}`).join(
                " / ",
            )
        }`
        : "tokens unavailable";
    return { tokens, cost: costUsd === null ? "cost unavailable" : `cost $${costUsd.toFixed(3)}` };
}

export interface GuidedReviewGenerator {
    providerName?: string;
    model?: string;
    thinkingLevel?: string;
}

export function formatGuidedReviewGenerator(job?: GuidedReviewGenerator | null): string | undefined {
    if (!job?.providerName || job.providerName === "wld") return undefined;
    const model = job.model && job.model !== "unknown" ? `/${job.model}` : "";
    const thinking = job.thinkingLevel ? ` (${job.thinkingLevel})` : "";
    return `${job.providerName}${model}${thinking}`;
}
