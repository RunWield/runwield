/** The only owner of export payload contents. Never copy a journal row. */
import type { MetricsExportHostIdentity } from "./metrics-export-grants.ts";

export interface MetricsJournalRow {
    v: number;
    event: string;
    eventId: string;
    ts: string;
    historyEpoch: string;
    executionId?: string;
    sessionId?: string;
    planId?: string;
    parentExecutionId?: string;
    attemptId?: string;
    [key: string]: string | number | boolean | null | undefined | MetricsAvailability;
}
export interface MetricsAvailability {
    tools?: string;
    usage?: string;
    context?: string;
}
export type MetricsExportKind =
    | "model_usage"
    | "execution_finished"
    | "tool_call_finished"
    | "validation_attempt"
    | "repair_round_finished"
    | "publication_confirmed"
    | "workflow_abandoned";
export interface MetricsExportObservation {
    contract: 1;
    kind: MetricsExportKind;
    observationId: string;
    occurredAt: string;
    ownerRef: string;
    projectRef: string;
    sessionRef?: string;
    planRef?: string;
    executionRef?: string;
    parentExecutionRef?: string;
    attemptRef?: string;
    fields: Record<string, string | number | boolean | null | MetricsAvailability>;
}
const FIELDS: Record<MetricsExportKind, string[]> = {
    model_usage: [
        "usageKind",
        "provider",
        "model",
        "backend",
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheWriteTokens",
        "costAmount",
        "costCurrency",
        "costSource",
        "measurementAvailability",
        "unavailableReason",
        "aggregationBasis",
        "inputCacheBasis",
    ],
    execution_finished: ["backend", "outcome", "reason", "elapsedMs", "callCount", "coverage"],
    tool_call_finished: [
        "toolName",
        "outcome",
        "reason",
        "durationMs",
        "resultBytes",
        "resultTokens",
        "imageCount",
        "truncated",
        "isError",
    ],
    validation_attempt: [
        "attempt",
        "outcome",
        "phase",
        "findingCount",
        "advisoryCount",
        "initialFindingCount",
        "missedOriginalCount",
        "repairRegressionCount",
        "unclassifiedNewCount",
        "existingStillOpenCount",
        "fixConfirmedCount",
    ],
    repair_round_finished: ["outcome", "phase"],
    publication_confirmed: ["outcome", "planKind"],
    workflow_abandoned: ["outcome"],
};
export function isExportableMetric(row: MetricsJournalRow): boolean {
    return row.v === 2 && Object.hasOwn(FIELDS, row.event);
}
export async function metricsExportReference(
    identity: MetricsExportHostIdentity,
    kind: string,
    id: string,
): Promise<string> {
    const bytes = Uint8Array.from(identity.referenceKey.match(/../g) ?? [], (pair) => parseInt(pair, 16));
    const key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${kind}:${id}`));
    return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function buildMetricsExportObservation(
    row: MetricsJournalRow,
    projectRoot: string,
    identity: MetricsExportHostIdentity,
): Promise<Readonly<MetricsExportObservation> | null> {
    if (!isExportableMetric(row)) return null;
    const kind = row.event as MetricsExportKind;
    const observation: MetricsExportObservation = {
        contract: 1,
        kind,
        observationId: await metricsExportReference(
            identity,
            "observation",
            `${projectRoot}:${row.historyEpoch}:${row.eventId}`,
        ),
        occurredAt: row.ts,
        ownerRef: await metricsExportReference(identity, "owner", identity.ownerRef),
        projectRef: await metricsExportReference(identity, "project", projectRoot),
        fields: {},
    };
    for (
        const [local, reference] of [
            ["sessionId", "sessionRef"],
            ["planId", "planRef"],
            ["executionId", "executionRef"],
            ["parentExecutionId", "parentExecutionRef"],
            ["attemptId", "attemptRef"],
        ] as const
    ) {
        const value = row[local];
        if (typeof value === "string") observation[reference] = await metricsExportReference(identity, local, value);
    }
    for (const field of FIELDS[kind]) {
        const value = row[field];
        if (value === undefined) continue;
        if (field === "coverage" && value && typeof value === "object") {
            const coverage: MetricsAvailability = {};
            for (const part of ["tools", "usage", "context"] as const) {
                if (["complete", "partial", "unavailable"].includes(value[part] ?? "")) coverage[part] = value[part];
            }
            observation.fields.coverage = Object.freeze(coverage);
        } else if (typeof value === "string") {
            // Rows are sanitized on append; also refuse paths and text in manually altered journals.
            const pattern = ["provider", "model", "backend", "toolName"].includes(field)
                ? /^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/
                : /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
            if (pattern.test(value)) observation.fields[field] = value;
        } else if (
            value === null || typeof value === "boolean" ||
            (typeof value === "number" && Number.isFinite(value) && value >= 0)
        ) {
            observation.fields[field] = value;
        }
    }
    Object.freeze(observation.fields);
    return Object.freeze(observation);
}
