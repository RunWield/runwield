/** Read-only reporting over collected Project measurements. No Session or Plan reads. */
import { createHash } from "node:crypto";
import { dirname, join } from "@std/path";
import { getWorkflowMetricsFilePath, readLegacyWorkflowMetric } from "./metrics.js";
import { resolvePrimaryCheckoutRoot } from "../primary-checkout.ts";
import { clearWorkflowMetricJournal } from "./metrics-journal.ts";

export interface UsagePeriod {
    /** Inclusive local calendar date, YYYY-MM-DD. */
    start: string;
    /** Exclusive local calendar date, YYYY-MM-DD. */
    end: string;
}

interface JournalRow {
    v: number;
    recorderId?: string;
    userInitiated?: boolean;
    event: string;
    ts: string;
    eventId?: string;
    historyEpoch?: string;
    collectionEpoch?: string;
    enabled?: boolean;
    executionId?: string;
    executionKind?: string;
    dispatchKind?: string;
    mode?: string;
    sourceId?: string;
    turnId?: string;
    requestId?: string;
    operationId?: string;
    attemptId?: string;
    roundId?: string;
    planId?: string;
    planKind?: string;
    managedSessionId?: string;
    segmentId?: string;
    backend?: string;
    provider?: string;
    model?: string;
    outcome?: string;
    aggregationBasis?: string;
    inputCacheBasis?: string;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
    costAmount?: number | null;
    costCurrency?: string;
    costSource?: string;
    measurementAvailability?: string;
    totalLatencyMs?: number | null;
    completedAt?: number | null;
    coverage?: JournalUsageCoverage;
}

interface JournalUsageCoverage {
    usage?: string;
}

interface JournalCache {
    epoch: string;
    offset: number;
    rows: Map<string, JournalRow>;
    corruptLines: number;
    incompleteTail: boolean;
    oversizedLine?: boolean;
}

export interface UsageMeasure {
    value: number;
    /** Number of observations excluded from a complete measure. */
    exclusions: number;
}

export interface UsageTotals {
    inputTokens: UsageMeasure;
    outputTokens: UsageMeasure;
    cacheReadTokens: UsageMeasure;
    cacheWriteTokens: UsageMeasure;
    tokens: UsageMeasure;
    reportedCostUsd: UsageMeasure;
    estimatedCostUsd: UsageMeasure;
    latencyMs: UsageMeasure;
    activeDays: number;
    activeDaysExclusions: number;
    publishedChanges: number;
    publishedChangesExclusions: number;
    validationAttempts: number;
    repairRounds: number;
    ongoing: number;
    abandoned: number;
}

export interface UsageLink {
    projectId: string;
    eventId?: string;
    sessionId?: string;
    segmentId?: string;
    planId?: string;
    attemptId?: string;
    executionId?: string;
    asOf: string;
}

export interface UsageDay {
    date: string;
    totals: UsageTotals;
    gaps: string[];
    /** Null breaks a trend; a covered zero is numeric zero. */
    tokens: number | null;
}

export interface UsageBreakdown {
    key: string;
    totals: UsageTotals;
}

export interface UsageProjectCoverage {
    corruptLines: number;
    incompleteTail: boolean;
    unavailable: boolean;
    overlappingUsage: number;
}

export interface UsageProjectReport {
    projectId: string;
    recordedThrough: string | null;
    totals: UsageTotals;
    daily: UsageDay[];
    backends: UsageBreakdown[];
    models: UsageBreakdown[];
    links: UsageLink[];
    incomplete: UsageLink[];
    ongoing: UsageLink[];
    legacy: NonNullable<ReturnType<typeof readLegacyWorkflowMetric>>[];
    coverage: UsageProjectCoverage;
}

function projectIdentity(path: string): string {
    return createHash("sha256").update(dirname(path).split(/[\\/]/).at(-1)!).digest("hex");
}

/** Resolve an authorized root to the opaque identity used by report rows and links. */
export function usageProjectIdentityForRoot(root: string): string {
    return projectIdentity(journalPaths([root])[0]);
}

/** Resolve caller-authorized aliases without creating or reading another Project. */
function journalPaths(roots: string[]): string[] {
    const paths = new Map<string, string>();
    for (const root of roots) {
        const primary = resolvePrimaryCheckoutRoot(root);
        let identity = primary;
        try {
            identity = Deno.realPathSync(primary);
        } catch { /* Unavailable roots remain explicit gaps. */ }
        const path = getWorkflowMetricsFilePath(primary);
        if (!paths.has(identity)) paths.set(identity, path);
        // Preserve existing history when an alias uses a different spelling of the same root.
        try {
            Deno.statSync(path);
            paths.set(identity, path);
        } catch { /* Reporting handles absent journals. */ }
    }
    return [...paths.values()];
}

function totals(): UsageTotals {
    const measure = (): UsageMeasure => ({ value: 0, exclusions: 0 });
    return {
        inputTokens: measure(),
        outputTokens: measure(),
        cacheReadTokens: measure(),
        cacheWriteTokens: measure(),
        tokens: measure(),
        reportedCostUsd: measure(),
        estimatedCostUsd: measure(),
        latencyMs: measure(),
        activeDays: 0,
        activeDaysExclusions: 0,
        publishedChanges: 0,
        publishedChangesExclusions: 0,
        validationAttempts: 0,
        repairRounds: 0,
        ongoing: 0,
        abandoned: 0,
    };
}

function sumTotals(target: UsageTotals, source: UsageTotals): void {
    for (
        const key of [
            "inputTokens",
            "outputTokens",
            "cacheReadTokens",
            "cacheWriteTokens",
            "tokens",
            "reportedCostUsd",
            "estimatedCostUsd",
            "latencyMs",
        ] as const
    ) {
        target[key].value += source[key].value;
        target[key].exclusions += source[key].exclusions;
    }
    for (
        const key of [
            "activeDaysExclusions",
            "publishedChanges",
            "publishedChangesExclusions",
            "validationAttempts",
            "repairRounds",
            "ongoing",
            "abandoned",
        ] as const
    ) {
        target[key] += source[key];
    }
}

function localDate(timestamp: number, formatter: Intl.DateTimeFormat): string {
    const parts = formatter.formatToParts(timestamp);
    return ["year", "month", "day"].map((name) => parts.find((part) => part.type === name)?.value).join("-");
}

function dateNumber(date: string): number {
    const time = Date.parse(`${date}T00:00:00Z`);
    if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(time) ||
        new Date(time).toISOString().slice(0, 10) !== date
    ) {
        throw new Error("invalid_usage_period");
    }
    return time;
}

/** First instant of a local calendar day, including 23/25-hour DST days. */
function dayBoundary(date: string, formatter: Intl.DateTimeFormat): number {
    const utc = dateNumber(date);
    let low = utc - 36 * 3600000;
    let high = utc + 36 * 3600000;
    while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (localDate(middle, formatter) < date) low = middle;
        else high = middle;
    }
    return high;
}

function finite(value: number | null | undefined): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function observationTime(row: JournalRow): number {
    return finite(row.completedAt) ? row.completedAt : Date.parse(row.ts);
}

function link(projectId: string, row: JournalRow): UsageLink {
    return {
        projectId,
        eventId: row.eventId,
        sessionId: row.managedSessionId,
        segmentId: row.segmentId,
        planId: row.planId,
        attemptId: row.attemptId,
        executionId: row.executionId,
        asOf: row.ts,
    };
}

function addUsage(target: UsageTotals, row: JournalRow): void {
    for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
        if (finite(row[key])) target[key].value += row[key];
        if (!finite(row[key]) || ["partial", "unavailable"].includes(row.measurementAvailability || "")) {
            target[key].exclusions++;
        }
    }
    // Input with included cache already counts those tokens. Unknown bases keep a known subtotal only.
    target.tokens.value += (finite(row.inputTokens) ? row.inputTokens : 0) +
        (finite(row.outputTokens) ? row.outputTokens : 0);
    if (row.inputCacheBasis === "excludes_cache") {
        target.tokens.value += (finite(row.cacheReadTokens) ? row.cacheReadTokens : 0) +
            (finite(row.cacheWriteTokens) ? row.cacheWriteTokens : 0);
    }
    if (
        ["partial", "unavailable"].includes(row.measurementAvailability || "") ||
        ![row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens].every(finite) ||
        !["includes_cache", "excludes_cache"].includes(row.inputCacheBasis || "")
    ) target.tokens.exclusions++;
    const cost = row.costSource === "reported" ? target.reportedCostUsd : target.estimatedCostUsd;
    if (
        finite(row.costAmount) && row.costCurrency === "USD" &&
        ["reported", "calculated"].includes(row.costSource || "")
    ) {
        cost.value += row.costAmount;
        if (row.measurementAvailability === "partial") cost.exclusions++;
    } else {
        target.reportedCostUsd.exclusions++;
        target.estimatedCostUsd.exclusions++;
    }
}

/** Disposable per-process cache; diagnostics expose actual refresh work, not a test seam. */
export class UsageReporter {
    private journals = new Map<string, JournalCache>();
    private bytesRead = 0;
    private linesParsed = 0;

    get diagnostics() {
        return { bytesRead: this.bytesRead, linesParsed: this.linesParsed };
    }

    private epoch(path: string): string {
        const directory = dirname(path);
        try {
            Deno.statSync(join(directory, "clear.json"));
            throw new Error("history_clear_pending");
        } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        try {
            return JSON.parse(Deno.readTextFileSync(join(directory, "state.json"))).historyEpoch || "initial";
        } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
            return "initial";
        }
    }

    private refresh(path: string): JournalCache {
        const epoch = this.epoch(path);
        const file = Deno.openSync(path, { read: true });
        try {
            const size = file.statSync().size;
            let cache = this.journals.get(path);
            if (!cache || cache.epoch !== epoch || cache.offset > size) {
                cache = { epoch, offset: 0, rows: new Map(), corruptLines: 0, incompleteTail: false };
                this.journals.set(path, cache);
            }
            file.seekSync(cache.offset, Deno.SeekMode.Start);
            let remaining = size - cache.offset;
            let pending = new Uint8Array();
            let oversizedLine = cache.oversizedLine === true;
            cache.incompleteTail = false;
            while (remaining > 0) {
                const buffer = new Uint8Array(Math.min(remaining, 64 * 1024));
                const count = file.readSync(buffer);
                if (count === null) break;
                this.bytesRead += count;
                remaining -= count;
                if (oversizedLine) {
                    const newline = buffer.subarray(0, count).indexOf(10);
                    if (newline === -1) {
                        cache.offset += count;
                        continue;
                    }
                    cache.offset += newline + 1;
                    oversizedLine = false;
                    pending = new Uint8Array();
                    file.seekSync(cache.offset, Deno.SeekMode.Start);
                    remaining = size - cache.offset;
                    continue;
                }
                const bytes = new Uint8Array(pending.length + count);
                bytes.set(pending);
                bytes.set(buffer.subarray(0, count), pending.length);
                let start = 0;
                for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
                    this.linesParsed++;
                    try {
                        const row: JournalRow = JSON.parse(new TextDecoder().decode(bytes.subarray(start, end)));
                        if (
                            typeof row.event !== "string" || typeof row.ts !== "string" ||
                            !Number.isFinite(Date.parse(row.ts))
                        ) {
                            cache.corruptLines++;
                        } else if (!row.historyEpoch || epoch === "initial" || row.historyEpoch === epoch) {
                            // V1 has no stable ID; its byte position is stable until clear.
                            cache.rows.set(row.eventId || `legacy:${cache.offset + start}`, row);
                        }
                    } catch {
                        cache.corruptLines++;
                    }
                    start = end + 1;
                }
                cache.offset += start;
                pending = bytes.slice(start);
                if (pending.length > 1024 * 1024) {
                    cache.corruptLines++;
                    cache.offset += pending.length;
                    pending = new Uint8Array();
                    oversizedLine = true;
                }
            }
            cache.oversizedLine = oversizedLine;
            cache.incompleteTail = pending.length > 0 || oversizedLine;
            if (this.epoch(path) !== epoch) {
                this.journals.delete(path);
                throw new Error("history_changed");
            }
            return cache;
        } finally {
            file.close();
        }
    }

    /** Caller supplies only authorized roots. Worktree aliases resolve to one journal. */
    query(projectRoots: string[], period: UsagePeriod, timeZone: string) {
        const start = dateNumber(period.start);
        const end = dateNumber(period.end);
        if (start >= end) throw new Error("invalid_usage_period");
        const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        });
        const dates: string[] = [];
        for (let date = start; date < end; date += 86400000) dates.push(new Date(date).toISOString().slice(0, 10));
        const paths = journalPaths(projectRoots);
        for (const path of this.journals.keys()) if (!paths.includes(path)) this.journals.delete(path);
        const projects: UsageProjectReport[] = paths.map((path) => {
            // The private journal directory already has a stable, host-local Project identity.
            const projectId = projectIdentity(path);
            let cache: JournalCache;
            let unavailable = false;
            try {
                cache = this.refresh(path);
            } catch (error) {
                unavailable = !(error instanceof Deno.errors.NotFound);
                this.journals.delete(path);
                cache = { epoch: "initial", offset: 0, rows: new Map(), corruptLines: 0, incompleteTail: false };
            }
            const rows = [...cache.rows.values()].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
            const through = rows.at(-1)?.ts || null;
            const selected = rows.filter((row) => {
                const day = localDate(observationTime(row), formatter);
                return day >= period.start && day < period.end;
            });
            const active = new Set<string>();
            const daily = dates.map((date): UsageDay => ({ date, totals: totals(), gaps: [], tokens: null }));
            const days = new Map(daily.map((day) => [day.date, day]));
            const backends = new Map<string, UsageTotals>();
            const models = new Map<string, UsageTotals>();
            const incomplete: UsageLink[] = [];
            const ongoing: UsageLink[] = [];
            const latestWorkflows = new Map<string, JournalRow>();
            const starts = new Map<string, JournalRow>();
            const finishes = new Map<string, JournalRow>();
            for (const row of rows) {
                if (row.executionId && row.event === "execution_started") starts.set(row.executionId, row);
                if (row.executionId && row.event === "execution_finished") finishes.set(row.executionId, row);
                if (
                    localDate(observationTime(row), formatter) < period.end && row.attemptId && row.planId &&
                    [
                        "publication_confirmed",
                        "workflow_abandoned",
                        "workflow_transition_committed",
                        "validation_attempt",
                        "repair_round",
                        "plan_execution_result",
                        "implementation_finished",
                    ].includes(row.event)
                ) {
                    const previous = latestWorkflows.get(row.attemptId);
                    if (
                        !previous || !["publication_confirmed", "workflow_abandoned"].includes(previous.event) ||
                        ["publication_confirmed", "workflow_abandoned"].includes(row.event)
                    ) latestWorkflows.set(row.attemptId, row);
                }
            }
            const incompleteExecutions = new Set<string>();
            for (const [id, row] of starts) {
                const finish = finishes.get(id);
                if (!finish || ["incomplete", "interrupted"].includes(finish.outcome || "")) {
                    incompleteExecutions.add(id);
                    if (
                        localDate(observationTime(row), formatter) < period.end &&
                        (!finish || localDate(observationTime(finish), formatter) >= period.start)
                    ) {
                        incomplete.push(link(projectId, finish || row));
                    }
                }
            }
            for (const row of rows) {
                if (
                    row.event === "execution_finished" && ["incomplete", "interrupted"].includes(row.outcome || "") &&
                    (!row.executionId || !starts.has(row.executionId))
                ) {
                    if (row.executionId) incompleteExecutions.add(row.executionId);
                    if (selected.includes(row)) incomplete.push(link(projectId, row));
                }
            }
            let overlappingUsage = 0;
            const seenUsage = new Set<string>();
            const publicationIds = new Set<string>();
            const repairIds = new Set<string>();
            const validationIds = new Set<string>();
            for (const row of selected) {
                const day = days.get(localDate(observationTime(row), formatter))!;
                if (row.v !== 2) continue;
                if (
                    row.event === "command_started" ||
                    (row.event === "execution_started" && row.executionKind !== "delegated" &&
                        row.executionKind !== "isolated" && row.mode !== "background" &&
                        row.userInitiated === true &&
                        ["interactive", "plan_execution", "quick_fix", "validation_repair"].includes(
                            row.dispatchKind || "",
                        ))
                ) active.add(day.date);
                if (
                    row.event === "execution_started" && row.userInitiated === undefined &&
                    row.dispatchKind === "interactive" && row.executionKind !== "isolated" &&
                    row.executionKind !== "delegated"
                ) {
                    day.totals.activeDaysExclusions++;
                    day.gaps.push("unavailable");
                }
                if (row.event === "model_usage") {
                    const group = `${row.executionId || row.requestId}:${row.turnId || ""}`;
                    const identity = `${row.recorderId || group}:${row.sourceId || row.eventId}`;
                    if (
                        row.aggregationBasis === "alternative" ||
                        seenUsage.has(identity)
                    ) {
                        overlappingUsage++;
                        continue;
                    }
                    seenUsage.add(identity);
                }
                const targets = [day.totals];
                if (["model_usage", "response_latency"].includes(row.event)) {
                    const backend = row.backend || "unavailable";
                    const model = `${row.provider || "unavailable"}/${row.model || "unavailable"}`;
                    if (!backends.has(backend)) backends.set(backend, totals());
                    if (!models.has(model)) models.set(model, totals());
                    targets.push(backends.get(backend)!, models.get(model)!);
                }
                if (row.event === "model_usage") {
                    const finish = row.executionId ? finishes.get(row.executionId) : undefined;
                    if (
                        row.executionId &&
                        (incompleteExecutions.has(row.executionId) || (starts.has(row.executionId) && !finish))
                    ) {
                        for (
                            const key of [
                                "inputTokens",
                                "outputTokens",
                                "cacheReadTokens",
                                "cacheWriteTokens",
                                "tokens",
                                "reportedCostUsd",
                                "estimatedCostUsd",
                            ] as const
                        ) {
                            for (const target of targets) target[key].exclusions++;
                        }
                        day.gaps.push("incomplete");
                        continue;
                    }
                    for (const target of targets) addUsage(target, row);
                    if (
                        day.totals.tokens.exclusions || day.totals.reportedCostUsd.exclusions ||
                        day.totals.estimatedCostUsd.exclusions
                    ) day.gaps.push("unavailable");
                }
                if (
                    row.event === "execution_finished" && ["unavailable", "partial"].includes(row.coverage?.usage || "")
                ) {
                    day.gaps.push("unavailable");
                    if (!rows.some((item) => item.event === "model_usage" && item.executionId === row.executionId)) {
                        day.totals.tokens.exclusions++;
                        day.totals.reportedCostUsd.exclusions++;
                        day.totals.estimatedCostUsd.exclusions++;
                    }
                }
                if (row.event === "response_latency") {
                    for (const target of targets) {
                        if (!incompleteExecutions.has(row.executionId || "") && finite(row.totalLatencyMs)) {
                            target.latencyMs.value += row.totalLatencyMs;
                        } else target.latencyMs.exclusions++;
                    }
                }
                if (
                    row.event === "publication_confirmed" && row.eventId && row.attemptId && row.planId &&
                    row.planKind === "PLANNED_CHANGE" && row.outcome === "succeeded" && !publicationIds.has(row.eventId)
                ) {
                    publicationIds.add(row.eventId);
                    day.totals.publishedChanges++;
                } else if (row.event === "publication_confirmed" && row.planKind !== "PROJECT") {
                    day.totals.publishedChangesExclusions++;
                }
                if (
                    row.event === "validation_attempt" && !validationIds.has(row.operationId || row.eventId || row.ts)
                ) {
                    validationIds.add(row.operationId || row.eventId || row.ts);
                    day.totals.validationAttempts++;
                }
                if (
                    row.event === "repair_round" &&
                    !repairIds.has(row.roundId || row.operationId || row.eventId || row.ts)
                ) {
                    repairIds.add(row.roundId || row.operationId || row.eventId || row.ts);
                    day.totals.repairRounds++;
                }
            }
            for (const row of latestWorkflows.values()) {
                if (localDate(observationTime(row), formatter) >= period.end) continue;
                if (row.event === "publication_confirmed") continue;
                if (row.event === "workflow_abandoned") {
                    const day = days.get(localDate(observationTime(row), formatter));
                    if (day) day.totals.abandoned++;
                } else ongoing.push(link(projectId, row));
            }
            const controls = rows.filter((row) =>
                ["collection_epoch", "history_epoch"].includes(row.event) && typeof row.enabled === "boolean"
            );
            for (const day of daily) {
                const begin = dayBoundary(day.date, formatter);
                const next = new Date(dateNumber(day.date) + 86400000).toISOString().slice(0, 10);
                const end = dayBoundary(next, formatter);
                const intervals = controls.filter((row) => Date.parse(row.ts) < end);
                const preceding = intervals.filter((row) => Date.parse(row.ts) <= begin).at(-1);
                if (!preceding) day.gaps.push("not_yet_collected");
                if (
                    preceding?.enabled === false ||
                    intervals.some((row) => Date.parse(row.ts) >= begin && row.enabled === false)
                ) day.gaps.push("disabled");
                if (!through || Date.parse(through) < end) day.gaps.push("not_yet_collected");
                if (
                    selected.some((row) =>
                        row.v === 1 && !["collection_epoch", "history_epoch", "measurement_gap"].includes(row.event) &&
                        localDate(observationTime(row), formatter) === day.date
                    )
                ) day.gaps.push("legacy");
                if (
                    selected.some((row) =>
                        row.event === "measurement_gap" && localDate(observationTime(row), formatter) === day.date
                    ) || cache.corruptLines || cache.incompleteTail
                ) day.gaps.push("incomplete");
                if (incomplete.some((item) => localDate(Date.parse(item.asOf), formatter) === day.date)) {
                    day.gaps.push("incomplete");
                }
                if (
                    selected.some((row) =>
                        row.executionId && incompleteExecutions.has(row.executionId) &&
                        localDate(observationTime(row), formatter) === day.date
                    )
                ) day.gaps.push("incomplete");
                if (unavailable) day.gaps.push("unavailable");
                day.gaps = [...new Set(day.gaps)];
                day.tokens = day.gaps.length ? null : day.totals.tokens.value;
                day.totals.activeDays = active.has(day.date) ? 1 : 0;
            }
            const total = totals();
            for (const day of daily) sumTotals(total, day.totals);
            total.activeDays = active.size;
            total.ongoing = ongoing.length;
            return {
                projectId,
                recordedThrough: through,
                totals: total,
                daily,
                backends: [...backends].map(([key, totals]) => ({ key, totals })),
                models: [...models].map(([key, totals]) => ({ key, totals })),
                links: selected.filter((row) => row.v === 2).map((row) => link(projectId, row)),
                incomplete,
                ongoing,
                legacy: selected.map(readLegacyWorkflowMetric).filter((row) => row !== null),
                coverage: {
                    corruptLines: cache.corruptLines,
                    incompleteTail: cache.incompleteTail,
                    unavailable,
                    overlappingUsage,
                },
            };
        });
        const total = totals();
        for (const project of projects) sumTotals(total, project.totals);
        const daily = dates.map((date): UsageDay => {
            const day = { date, totals: totals(), gaps: [] as string[], tokens: null as number | null };
            for (const project of projects) {
                const item = project.daily.find((item) => item.date === date)!;
                sumTotals(day.totals, item.totals);
                day.totals.activeDays = Math.max(day.totals.activeDays, item.totals.activeDays);
                day.gaps.push(...item.gaps);
            }
            day.gaps = [...new Set(day.gaps)];
            if (!projects.length) day.gaps.push("not_yet_collected");
            day.tokens = day.gaps.length ? null : day.totals.tokens.value;
            return day;
        });
        total.activeDays = daily.filter((day) => day.totals.activeDays).length;
        const breakdown = (kind: "backends" | "models") => {
            const combined = new Map<string, UsageTotals>();
            for (const project of projects) {
                for (const item of project[kind]) {
                    if (!combined.has(item.key)) combined.set(item.key, totals());
                    sumTotals(combined.get(item.key)!, item.totals);
                }
            }
            return [...combined].map(([key, totals]) => ({ key, totals }));
        };
        const gapCounts: Record<string, number> = {};
        for (const day of daily) for (const gap of day.gaps) gapCounts[gap] = (gapCounts[gap] || 0) + 1;
        // A clear in another process can occur during aggregation, after suffix refresh.
        for (const path of paths) {
            const cache = this.journals.get(path);
            if (cache && this.epoch(path) !== cache.epoch) {
                this.journals.delete(path);
                throw new Error("usage_history_changed");
            }
        }
        return {
            period,
            timeZone,
            recordedThrough:
                projects.map((project) => project.recordedThrough).filter((ts): ts is string => ts !== null).sort().at(
                    -1,
                ) || null,
            totals: total,
            daily,
            projects,
            backends: breakdown("backends"),
            models: breakdown("models"),
            coverage: {
                gapDays: gapCounts,
                incompleteOperations: projects.reduce((sum, project) => sum + project.incomplete.length, 0),
                legacyRecords: projects.reduce((sum, project) => sum + project.legacy.length, 0),
                unavailableProjects: projects.filter((project) => project.coverage.unavailable).length,
            },
        };
    }

    async clear(projectRoots: string[]) {
        const results = [];
        for (const path of journalPaths(projectRoots)) {
            const result = await clearWorkflowMetricJournal(path);
            this.journals.delete(path);
            results.push({ projectId: projectIdentity(path), ...result });
        }
        return results;
    }
}

const reporter = new UsageReporter();
export function queryUsageReport(projectRoots: string[], period: UsagePeriod, timeZone: string) {
    return reporter.query(projectRoots, period, timeZone);
}
export function clearUsageHistory(projectRoots: string[]) {
    return reporter.clear(projectRoots);
}
