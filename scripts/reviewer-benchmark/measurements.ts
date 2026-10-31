import { AGENTS } from "../../src/constants.js";

export type Measurement = number | "unavailable";
export interface ReviewMeasurements {
    model: string;
    provider: string;
    tokens: ReviewTokens;
    toolCallCount: Measurement;
}
interface ReviewTokens {
    input: Measurement;
    output: Measurement;
    cacheRead: Measurement;
    cacheWrite: Measurement;
}
interface JournalRecord {
    v: number;
    event: string;
    executionId: string;
    parentExecutionId?: string | null;
    agent?: string;
    model?: string;
    provider?: string;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
    aggregationBasis?: "turn" | "request" | "alternative";
    callCount?: number;
    coverage?: JournalCoverage;
}
interface JournalCoverage {
    tools?: string;
    usage?: string;
}
type TokenField = "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens";

/** Read actual usage for the Reviewer and its descendants. Alternative observations are not additive. */
export function readReviewMeasurements(text: string): ReviewMeasurements {
    let records: JournalRecord[] = [];
    try {
        records = text
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as JournalRecord);
        records = records.filter((record) => record?.v === 2 && typeof record.executionId === "string");
    } catch {
        // An incomplete or unreadable journal cannot establish measurements.
    }
    const roots = records.filter((record) => record.event === "execution_started" && record.agent === AGENTS.REVIEWER);
    const executions = new Set(roots.map((record) => record.executionId));
    for (let previousSize = -1; previousSize !== executions.size;) {
        previousSize = executions.size;
        for (const record of records) {
            if (record.parentExecutionId && executions.has(record.parentExecutionId))
                executions.add(record.executionId);
        }
    }
    const scoped = records.filter((record) => executions.has(record.executionId));
    const finished = scoped.filter((record) => record.event === "execution_finished");
    const settled =
        executions.size > 0 &&
        [...executions].every(
            (id) =>
                scoped.some((record) => record.event === "execution_started" && record.executionId === id) &&
                finished.filter((record) => record.executionId === id).length === 1,
        );
    const usage = [...executions].flatMap((id) => {
        const observations = scoped.filter((record) => record.executionId === id && record.event === "model_usage");
        const basis = observations.some((record) => record.aggregationBasis === "turn") ? "turn" : "request";
        return observations.filter((record) => record.aggregationBasis === basis);
    });
    function sum(field: TokenField): Measurement {
        if (
            !settled ||
            finished.some((record) => record.coverage?.usage !== "complete") ||
            [...executions].some((id) => !usage.some((record) => record.executionId === id)) ||
            usage.some(
                (record) => typeof record[field] !== "number" || !Number.isFinite(record[field]) || record[field]! < 0,
            )
        )
            return "unavailable";
        return usage.reduce((total, record) => total + record[field]!, 0);
    }
    function identity(field: "model" | "provider"): string {
        const values = new Set(roots.map((record) => record[field]));
        return values.size === 1 && roots[0]?.[field] ? roots[0][field] : "unavailable";
    }
    return {
        model: identity("model"),
        provider: identity("provider"),
        tokens: {
            input: sum("inputTokens"),
            output: sum("outputTokens"),
            cacheRead: sum("cacheReadTokens"),
            cacheWrite: sum("cacheWriteTokens"),
        },
        toolCallCount:
            settled &&
            finished.every(
                (record) =>
                    record.coverage?.tools === "complete" &&
                    typeof record.callCount === "number" &&
                    Number.isFinite(record.callCount) &&
                    record.callCount >= 0,
            )
                ? finished.reduce((total, record) => total + record.callCount!, 0)
                : "unavailable",
    };
}
