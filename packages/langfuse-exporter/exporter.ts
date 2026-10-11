/** Standalone contract 1 exporter. No SDK, instrumentation, storage access, or retries. */
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
    fields: Record<
        string,
        string | number | boolean | null | MetricsAvailability
    >;
}
export interface MetricsExportContext {
    endpoint: string;
    externalProject: string;
    credentials: Record<string, string>;
    deadline: number;
}
export type MetricsExportDeliveryResult =
    | { outcome: "accepted"; code?: string }
    | {
        outcome: "not_accepted";
        retry: "retryable" | "needs_correction" | "permanent";
        code?: string;
    }
    | { outcome: "uncertain"; code?: string };
export interface MetricsExportConfirmResult {
    status: "present" | "not_found_yet" | "mismatch";
}
type Scalar = string | number | boolean;
type Json = null | Scalar | Json[] | JsonRecord;
interface JsonRecord {
    [key: string]: Json;
}
interface Attribute {
    key: string;
    value: AttributeValue;
}
interface AttributeValue {
    stringValue?: string;
    boolValue?: boolean;
    doubleValue?: number;
}
interface Span {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
    kind: number;
    startTimeUnixNano: string;
    endTimeUnixNano: string;
    attributes: Attribute[];
}
interface Mapped {
    span: Span;
    metadata: Record<string, Scalar>;
    usage?: Record<string, number>;
    cost?: Record<string, number>;
    model?: string;
    type: string;
    start: string;
    end: string;
}
const NAMES: Record<MetricsExportKind, string> = {
    model_usage: "RunWield model request",
    execution_finished: "RunWield execution",
    tool_call_finished: "RunWield tool",
    validation_attempt: "RunWield validation",
    repair_round_finished: "RunWield repair",
    publication_confirmed: "RunWield publication",
    workflow_abandoned: "RunWield abandonment",
};
const FIELDS: Record<MetricsExportKind, string[]> = {
    model_usage: [
        "usageKind",
        "provider",
        "model",
        "backend",
        "inputTokens",
        "outputTokens",
        "reasoningTokens",
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
    execution_finished: [
        "backend",
        "outcome",
        "reason",
        "elapsedMs",
        "callCount",
    ],
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
const ENUMS: Record<string, string[]> = {
    usageKind: ["turn", "request", "compaction", "summary", "standalone"],
    costCurrency: ["USD"],
    costSource: ["reported", "calculated", "unavailable"],
    measurementAvailability: ["complete", "partial", "unavailable"],
    aggregationBasis: ["turn", "request", "alternative"],
    inputCacheBasis: ["excludes_cache", "includes_cache", "unknown"],
    outcome: [
        "succeeded",
        "failed",
        "canceled",
        "rejected",
        "interrupted",
        "success",
        "error",
        "incomplete",
        "ongoing",
        "approved",
        "feedback",
    ],
    reason: [
        "completed",
        "returned_error",
        "execution_error",
        "execution_canceled",
        "execution_settled",
        "canceled",
        "failed",
        "aborted",
        "rejected",
        "unknown",
        "manual",
        "threshold",
        "overflow",
        "auth_failed",
        "non_zero_exit",
        "malformed_stream",
        "bridge_startup_failed",
        "empty_result",
        "invalid_arguments",
        "gate_closed",
        "unavailable",
        "not_found",
    ],
    planKind: ["PLANNED_CHANGE", "PROJECT", "QUICK_FIX", "OPERATION"],
};
const NUMBER_FIELDS = new Set([
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "costAmount",
    "elapsedMs",
    "callCount",
    "durationMs",
    "resultBytes",
    "resultTokens",
    "imageCount",
    "attempt",
    "findingCount",
    "advisoryCount",
    "initialFindingCount",
    "missedOriginalCount",
    "repairRegressionCount",
    "unclassifiedNewCount",
    "existingStillOpenCount",
    "fixConfirmedCount",
]);
const NAME_FIELDS = new Set(["provider", "model", "backend", "toolName"]);
ENUMS.unavailableReason = ["not_reported", "source_unavailable"];
ENUMS.phase = [
    "start",
    "finish",
    "opened",
    "dispatched",
    "rejected",
    "mechanical",
    "semantic",
    "delivery",
    "planning",
];
const REFS = [
    "ownerRef",
    "projectRef",
    "sessionRef",
    "planRef",
    "executionRef",
    "parentExecutionRef",
    "attemptRef",
] as const;
function reference(value: string | undefined): value is string {
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function safeName(value: string): boolean {
    return /^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/.test(value) &&
        !value.includes("..") && !value.includes(":/");
}
function iso(
    value: string | number | boolean | null | MetricsAvailability | undefined,
): string | undefined {
    if (
        typeof value !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(
            value,
        )
    ) return;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return;
    // Reject calendar rollover as well as invalid offsets.
    const local = value.replace(/(?:Z|[+-]\d\d:\d\d)$/, "Z");
    if (
        new Date(Date.parse(local)).toISOString().slice(0, 19) !==
            local.slice(0, 19)
    ) return;
    return new Date(time).toISOString();
}
function count(
    value: string | number | boolean | null | MetricsAvailability | undefined,
): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
async function id(
    domain: string,
    value: string,
    length: number,
): Promise<string> {
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`runwield:${domain}:${value}`),
    );
    return Array.from(
        new Uint8Array(digest),
        (b) => b.toString(16).padStart(2, "0"),
    ).join("").slice(0, length);
}
function attribute(key: string, value: Scalar): Attribute {
    return {
        key,
        value: typeof value === "string"
            ? { stringValue: value }
            : typeof value === "boolean"
            ? { boolValue: value }
            : { doubleValue: value },
    };
}
async function map(o: MetricsExportObservation): Promise<Mapped> {
    if (
        o.contract !== 1 || !Object.hasOwn(NAMES, o.kind) ||
        !reference(o.observationId) || !reference(o.ownerRef) ||
        !reference(o.projectRef)
    ) throw new Error("invalid_observation");
    const occurred = iso(o.occurredAt);
    if (!occurred) throw new Error("invalid_observation");
    const metadata: Record<string, Scalar> = {
        observationId: o.observationId,
        kind: o.kind,
        occurredAt: occurred,
        contract: 1,
    };
    for (const key of REFS) {
        if (Object.hasOwn(o, key) && reference(o[key])) metadata[key] = o[key]!;
    }
    for (const key of FIELDS[o.kind]) {
        if (!Object.hasOwn(o.fields, key)) continue;
        const value = o.fields[key];
        if (
            NUMBER_FIELDS.has(key) && typeof value === "number" &&
            Number.isFinite(value) && value >= 0 &&
            (["costAmount", "elapsedMs", "durationMs"].includes(key) ||
                Number.isSafeInteger(value))
        ) metadata[key] = value;
        else if (
            typeof value === "boolean" && ["truncated", "isError"].includes(key)
        ) metadata[key] = value;
        else if (
            typeof value === "string" &&
            (ENUMS[key] ? ENUMS[key].includes(value) : NAME_FIELDS.has(key) && safeName(value))
        ) metadata[key] = value;
    }
    if (o.kind === "execution_finished" && Object.hasOwn(o.fields, "coverage")) {
        const coverage = o.fields.coverage;
        if (coverage && typeof coverage === "object") {
            for (const part of ["tools", "usage", "context"] as const) {
                const value = Object.hasOwn(coverage, part) ? coverage[part] : undefined;
                if (
                    typeof value === "string" &&
                    ["complete", "partial", "unavailable"].includes(value)
                ) {
                    metadata[`coverage_${part}`] = value;
                }
            }
        }
    }
    const observedStart = iso(
        Object.hasOwn(o.fields, "startedAt") ? o.fields.startedAt : null,
    );
    const observedEnd = iso(
        Object.hasOwn(o.fields, "endedAt") ? o.fields.endedAt : null,
    );
    const measured = o.kind === "model_usage" && !!observedStart &&
        !!observedEnd && observedStart <= observedEnd;
    const start = measured ? observedStart! : occurred;
    const end = measured ? observedEnd! : occurred;
    metadata.timing_measured = measured;
    let usage: Record<string, number> | undefined;
    let cost: Record<string, number> | undefined;
    let model: string | undefined;
    const aggregate = o.kind === "model_usage" &&
        ["claude-cli", "agy-cli"].includes(String(metadata.backend)) &&
        metadata.aggregationBasis === "turn";
    if (o.kind === "model_usage") {
        const input = count(metadata.inputTokens),
            output = count(metadata.outputTokens);
        const read = count(metadata.cacheReadTokens),
            write = count(metadata.cacheWriteTokens),
            reasoning = count(metadata.reasoningTokens);
        for (
            const [key, value] of [["input", input], ["output", output], [
                "input_cache_read",
                read,
            ], ["input_cache_creation", write]] as const
        ) metadata[`missing_${key}`] = value === undefined;
        metadata.reasoning_available = reasoning !== undefined;
        metadata.backend_turn_aggregate = aggregate;
        const basis = metadata.inputCacheBasis;
        if (basis === "excludes_cache" || basis === "includes_cache") {
            usage = {};
            if (basis === "excludes_cache" && input !== undefined) {
                usage.input = input;
            }
            if (
                basis === "includes_cache" && input !== undefined &&
                read !== undefined && write !== undefined && input >= read + write
            ) usage.input = input - read - write;
            if (read !== undefined) usage.input_cache_read = read;
            // Langfuse's price catalog calls cache writes input_cache_creation.
            if (write !== undefined) usage.input_cache_creation = write;
            if (
                output !== undefined && (reasoning === undefined || reasoning <= output)
            ) usage.output = output - (reasoning ?? 0);
            if (
                reasoning !== undefined && (output === undefined || reasoning <= output)
            ) usage.output_reasoning = reasoning;
            if (!Object.keys(usage).length) usage = undefined;
        }
        metadata.native_usage_available = usage !== undefined;
        metadata.usage_complete = metadata.measurementAvailability === "complete" &&
            !!usage &&
            ["input", "output", "input_cache_read", "input_cache_creation"].every((
                k,
            ) => Object.hasOwn(usage!, k));
        const amount = metadata.costAmount;
        if (
            ["reported", "calculated"].includes(String(metadata.costSource)) &&
            metadata.costCurrency === "USD" && typeof amount === "number" &&
            Number.isFinite(amount) && amount >= 0
        ) {
            cost = { total: amount };
            if (typeof metadata.model === "string") model = metadata.model;
        }
        metadata.cost_available = cost !== undefined;
        metadata.missing_cost = cost === undefined;
    }
    const type = o.kind === "model_usage" ? "GENERATION" : "SPAN";
    const attributes = [
        attribute("langfuse.observation.type", type.toLowerCase()),
        ...Object.entries(metadata).map(([k, v]) => attribute(`langfuse.observation.metadata.${k}`, v)),
    ];
    if (usage) {
        attributes.push(
            attribute("langfuse.observation.usage_details", JSON.stringify(usage)),
        );
    }
    if (cost) {
        attributes.push(
            attribute("langfuse.observation.cost_details", JSON.stringify(cost)),
        );
    }
    if (model) {
        attributes.push(attribute("langfuse.observation.model.name", model));
    }
    const group = metadata.planRef ?? metadata.sessionRef ??
        metadata.parentExecutionRef ?? metadata.executionRef ?? o.observationId;
    const parent = o.kind === "execution_finished" ? metadata.parentExecutionRef : metadata.executionRef;
    const span: Span = {
        traceId: await id("trace", `${o.projectRef}:${group}`, 32),
        spanId: o.kind === "execution_finished" &&
                typeof metadata.executionRef === "string"
            ? await id("execution", metadata.executionRef, 16)
            : await id("span", o.observationId, 16),
        ...(typeof parent === "string" ? { parentSpanId: await id("execution", parent, 16) } : {}),
        name: aggregate ? "RunWield backend-turn aggregate" : NAMES[o.kind],
        kind: 1,
        startTimeUnixNano: String(BigInt(Date.parse(start)) * 1000000n),
        endTimeUnixNano: String(BigInt(Date.parse(end)) * 1000000n),
        attributes,
    };
    return { span, metadata, usage, cost, model, type, start, end };
}
function headers(c: MetricsExportContext): Headers {
    const publicKey = c.credentials.publicKey,
        secretKey = c.credentials.secretKey;
    if (
        !publicKey || !secretKey || /[:\r\n]/.test(publicKey) ||
        /[\r\n]/.test(secretKey)
    ) throw new Error("invalid_credentials");
    return new Headers({
        authorization: `Basic ${btoa(`${publicKey}:${secretKey}`)}`,
        "content-type": "application/json",
        "x-langfuse-ingestion-version": "4",
    });
}
function endpoint(c: MetricsExportContext, path: string): URL {
    const url = new URL(c.endpoint);
    if (
        url.username || url.password || url.search || url.hash ||
        (url.protocol !== "https:" &&
            !(url.protocol === "http:" &&
                ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
    ) throw new Error("invalid_endpoint");
    return new URL(path, url.origin);
}
function record(value: Json | undefined): value is JsonRecord {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Bound the body as well as headers; never use remote text in a diagnostic. */
async function request(
    url: URL,
    c: MetricsExportContext,
    body?: string,
): Promise<ResponseData> {
    const remaining = c.deadline - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
        throw new Error("deadline");
    }
    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(),
        Math.min(remaining, 2147483647),
    );
    try {
        const response = await fetch(url, {
            method: body === undefined ? "GET" : "POST",
            headers: headers(c),
            body,
            signal: controller.signal,
            redirect: "error",
        });
        if (response.status !== 200) {
            await response.body?.cancel();
            return { status: response.status, data: null };
        }
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) {
            try {
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    size += chunk.value.length;
                    if (size > 1048576 || Date.now() >= c.deadline) {
                        controller.abort();
                        throw new Error("response_limit");
                    }
                    chunks.push(chunk.value);
                }
            } finally {
                reader.releaseLock();
            }
        }
        if (Date.now() >= c.deadline) throw new Error("deadline");
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
        }
        const data: Json = JSON.parse(new TextDecoder().decode(bytes));
        return { status: response.status, data };
    } finally {
        clearTimeout(timer);
    }
}
interface ResponseData {
    status: number;
    data: Json;
}
/** Langfuse 4.56.0 returns the queued OTEL job instead of the standard empty OTLP response. */
function queuedAcknowledgement(
    body: JsonRecord,
    c: MetricsExportContext,
): boolean {
    const keys = [
        "name",
        "data",
        "opts",
        "id",
        "progress",
        "returnvalue",
        "stacktrace",
        "priority",
        "attemptsStarted",
        "attemptsMade",
        "stalledCounter",
        "timestamp",
        "queueQualifiedName",
    ];
    if (
        Object.keys(body).length !== keys.length ||
        !Object.keys(body).every((k) => keys.includes(k)) ||
        body.name !== "otel-ingestion-job" ||
        body.queueQualifiedName !== "bull:otel-ingestion-queue" ||
        typeof body.id !== "string" || !/^[0-9]+$/.test(body.id) ||
        body.progress !== 0 || body.returnvalue !== null ||
        body.stacktrace !== null || body.priority !== 0 ||
        body.attemptsStarted !== 0 || body.attemptsMade !== 0 ||
        body.stalledCounter !== 0 ||
        typeof body.timestamp !== "number" ||
        !Number.isSafeInteger(body.timestamp) || body.timestamp <= 0 ||
        !record(body.opts) || !record(body.data)
    ) return false;
    const data = body.data;
    if (
        data.name !== body.name || typeof data.id !== "string" ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(data.id) ||
        typeof data.timestamp !== "string" || !iso(data.timestamp) || !record(data.payload)
    ) return false;
    const payload = data.payload;
    if (
        payload.ingestionVersion !== "4" || !record(payload.authCheck) ||
        payload.authCheck.validKey !== true || !record(payload.authCheck.scope) ||
        payload.authCheck.scope.projectId !== c.externalProject ||
        payload.authCheck.scope.accessLevel !== "project" ||
        !record(payload.data) ||
        payload.data.publicKey !== c.credentials.publicKey ||
        typeof payload.data.fileKey !== "string" ||
        !payload.data.fileKey.endsWith(".json")
    ) return false;
    // Bind the acknowledgement to this destination's uploaded OTEL batch, never arbitrary 200 JSON.
    return `/${payload.data.fileKey}`.includes(`/otel/${c.externalProject}/`);
}
/** Send exactly one immutable observation, with no automatic retry. */
export async function deliver(
    o: MetricsExportObservation,
    c: MetricsExportContext,
): Promise<MetricsExportDeliveryResult> {
    let mapped: Mapped;
    let url: URL;
    try {
        url = endpoint(c, "/api/public/otel/v1/traces");
        headers(c);
    } catch {
        return {
            outcome: "not_accepted",
            retry: "needs_correction",
            code: "invalid_configuration",
        };
    }
    try {
        mapped = await map(o);
    } catch {
        return {
            outcome: "not_accepted",
            retry: "permanent",
            code: "invalid_observation",
        };
    }
    if (!Number.isFinite(c.deadline) || Date.now() >= c.deadline) {
        return {
            outcome: "not_accepted",
            retry: "retryable",
            code: "deadline_before_send",
        };
    }
    try {
        const response = await request(
            url,
            c,
            JSON.stringify({
                resourceSpans: [{ scopeSpans: [{ spans: [mapped.span] }] }],
            }),
        );
        if ([401, 403, 404].includes(response.status)) {
            return {
                outcome: "not_accepted",
                retry: "needs_correction",
                code: `http_${response.status}`,
            };
        }
        if (response.status === 400) {
            return { outcome: "not_accepted", retry: "permanent", code: "http_400" };
        }
        if (response.status !== 200 || !record(response.data)) {
            return { outcome: "uncertain", code: "ambiguous_response" };
        }
        if (queuedAcknowledgement(response.data, c)) {
            return { outcome: "accepted", code: "langfuse_queued" };
        }
        const partial = response.data.partialSuccess;
        if (partial === undefined && Object.keys(response.data).length === 0) {
            return { outcome: "accepted", code: "otlp_success" };
        }
        if (
            record(partial) && Object.keys(response.data).every((k) => k === "partialSuccess") &&
            Object.keys(partial).every((k) => ["rejectedSpans", "errorMessage"].includes(k)) &&
            (partial.errorMessage === undefined ||
                typeof partial.errorMessage === "string")
        ) {
            const rejected = partial.rejectedSpans === undefined ? 0 : partial.rejectedSpans; // Proto3 omits default zero.
            if (rejected === 0 || rejected === "0") {
                return { outcome: "accepted", code: "otlp_warning" };
            }
            if (rejected === 1 || rejected === "1") {
                return {
                    outcome: "not_accepted",
                    retry: "permanent",
                    code: "otlp_rejected",
                };
            }
        }
        return { outcome: "uncertain", code: "ambiguous_response" };
    } catch {
        return { outcome: "uncertain", code: "transport_or_response_failure" };
    }
}
/** Two machine-epsilon relative error only; zero, absence and meaningful cost changes stay distinct. */
function sameCost(actual: Json | undefined, expected: number | null): boolean {
    if (expected === null) return actual === null;
    if (typeof actual !== "number" || !Number.isFinite(actual) || actual < 0) {
        return false;
    }
    if (actual === expected) return true;
    if (actual === 0 || expected === 0) return false;
    return Math.abs(actual - expected) <=
        2 * Number.EPSILON * Math.max(actual, expected);
}
function sameNumbers(
    actual: Json | undefined,
    expected: Record<string, number> | undefined,
    allowDerivedTotal = false,
    costs = false,
): boolean {
    if (!expected) {
        return actual === null ||
            (record(actual) && Object.keys(actual).length === 0);
    }
    if (!record(actual)) return false;
    const derivedTotal = allowDerivedTotal && Object.hasOwn(actual, "total");
    if (
        derivedTotal &&
        actual.total !== Object.values(expected).reduce((a, b) => a + b, 0)
    ) return false;
    const keys = Object.keys(actual).filter((key) => !(derivedTotal && key === "total"));
    return keys.length === Object.keys(expected).length &&
        Object.entries(expected).every(([k, v]) => costs ? sameCost(actual[k], v) : actual[k] === v);
}
function matches(row: JsonRecord, m: Mapped, externalProject: string): boolean {
    if (row.projectId !== externalProject) return false;
    if (
        row.id !== m.span.spanId || row.traceId !== m.span.traceId ||
        row.type !== m.type || row.name !== m.span.name
    ) return false;
    if (
        !Object.hasOwn(row, "parentObservationId") ||
        (row.parentObservationId ?? null) !== (m.span.parentSpanId ?? null) ||
        typeof row.startTime !== "string" || typeof row.endTime !== "string" ||
        iso(row.startTime) !== m.start || iso(row.endTime) !== m.end
    ) return false;
    if (
        !record(row.metadata) ||
        !Object.entries(m.metadata).every(([k, v]) => row.metadata && record(row.metadata) && row.metadata[k] === v)
    ) return false;
    if (
        !sameNumbers(row.usageDetails, m.usage, true) ||
        !sameNumbers(row.costDetails, m.cost, false, true)
    ) return false;
    const totalUsage = m.usage ? Object.values(m.usage).reduce((a, b) => a + b, 0) : null;
    if (
        (row.totalUsage !== totalUsage &&
            !(m.usage === undefined && row.totalUsage === 0)) ||
        !sameCost(row.totalCost, m.cost?.total ?? null)
    ) return false;
    return m.model ? row.model === m.model : row.model === null || row.model === "";
}
/** Unmerged storage versions may repeat a span. Conflicting returned facts must never be hidden. */
function sameReadback(a: Json, b: Json): boolean {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length &&
            a.every((value, i) => sameReadback(value, b[i]));
    }
    if (!record(a) || !record(b)) return false;
    return Object.keys(a).length === Object.keys(b).length &&
        Object.entries(a).every(([key, value]) => Object.hasOwn(b, key) && sameReadback(value, b[key]));
}
/** Read back a bounded ID lookup. Absence or a failed lookup never proves rejection. */
export async function confirm(
    o: MetricsExportObservation,
    c: MetricsExportContext,
): Promise<MetricsExportConfirmResult> {
    try {
        const m = await map(o);
        const url = endpoint(c, "/api/public/v2/observations");
        url.searchParams.set("fields", "core,basic,usage,model,metadata");
        url.searchParams.set(
            "fromStartTime",
            new Date(Date.parse(m.start) - 1000).toISOString(),
        );
        url.searchParams.set(
            "toStartTime",
            new Date(Date.parse(m.start) + 1000).toISOString(),
        );
        url.searchParams.set(
            "filter",
            JSON.stringify([{
                type: "string",
                column: "id",
                operator: "=",
                value: m.span.spanId,
            }]),
        );
        url.searchParams.set("limit", "100");
        const seen = new Set<string>();
        const rows: JsonRecord[] = [];
        for (let page = 0; page < 3; page++) {
            const response = await request(url, c);
            if (
                response.status !== 200 || !record(response.data) ||
                !Array.isArray(response.data.data) || !record(response.data.meta) ||
                response.data.data.length > 100
            ) return { status: "not_found_yet" };
            for (const row of response.data.data) {
                if (!record(row)) return { status: "mismatch" };
                if (
                    row.id === m.span.spanId ||
                    (record(row.metadata) &&
                        row.metadata.observationId === o.observationId)
                ) rows.push(row);
            }
            const cursor = response.data.meta.cursor;
            if (cursor === undefined || cursor === null) {
                if (rows.length === 0) return { status: "not_found_yet" };
                return {
                    status: rows.every((row) => matches(row, m, c.externalProject) && sameReadback(row, rows[0]))
                        ? "present"
                        : "mismatch",
                };
            }
            if (
                typeof cursor !== "string" || !cursor || cursor.length > 4096 ||
                seen.has(cursor)
            ) return { status: "not_found_yet" };
            seen.add(cursor);
            url.searchParams.set("cursor", cursor);
        }
    } catch { /* No arbitrary remote diagnostics. Core owns recovery. */ }
    return { status: "not_found_yet" };
}
