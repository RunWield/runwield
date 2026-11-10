import { currentWorkRecordOwner } from "./owner.ts";
/**
 * @module shared/work-records/search
 * Canonical Work Record retrieval hydrated from Markdown, using Mnemoteca only for candidates.
 */

import { findWorkRecordById, listWorkRecords } from "./store.ts";
import { formatWorkRecordScopeLabel, isCurrentWorkRecord, workRecordNotices } from "./list.ts";
import {
    getWorkRecordIndexCollectionName,
    isWorkRecordIndexEmpty,
    rebuildWorkRecordIndex,
    recordIdFromTags,
    runMnemotecaWorkRecordCommand,
} from "./index-adapter.ts";

import type { TicketReference } from "../ticket-references.ts";
import type { WorkRecordResource } from "./schema.ts";
import type { WorkRecordIndexOptions, WorkRecordIndexRebuildResult } from "./index-adapter.ts";

export type WorkRecordAccessMode = "current" | "all";

export interface WorkRecordHydratedResult {
    recordId: string;
    title: string;
    summary: string;
    status: string;
    scope: string;
    workKind?: string;
    origin: string;
    completionMode: string;
    sourcePlans: string[];
    tickets: TicketReference[];
    path: string;
    notices: string[];
}

export interface WorkRecordSearchOptions extends WorkRecordIndexOptions {
    accessMode?: WorkRecordAccessMode;
    includeAll?: boolean;
    limit?: number;
}

export interface WorkRecordReadOptions {
    accessMode?: WorkRecordAccessMode;
}

export interface WorkRecordSearchCandidate {
    recordId: string;
    raw: unknown;
}

export interface WorkRecordSearchResult {
    query: string;
    accessMode: WorkRecordAccessMode;
    records: WorkRecordHydratedResult[];
    staleRecordIds: string[];
    bootstrapped: boolean;
    rebuild: WorkRecordIndexRebuildResult | null;
}

export interface WorkRecordReadResult extends WorkRecordHydratedResult {
    accessMode: WorkRecordAccessMode;
    body: string;
    markdown: string;
}

interface RawSearchResults {
    results?: unknown;
}

interface RawSearchResult {
    metadata?: RawSearchMetadata;
    tags?: unknown;
}

interface RawSearchMetadata {
    tags?: unknown;
}

export function formatHydratedWorkRecord(record: WorkRecordResource): WorkRecordHydratedResult {
    return {
        recordId: record.attrs.recordId,
        title: record.title,
        summary: record.summary,
        status: record.attrs.status,
        scope: record.attrs.scope,
        workKind: record.attrs.workKind,
        origin: record.attrs.origin,
        completionMode: record.attrs.completionMode,
        sourcePlans: record.attrs.provenance?.sourcePlans || [],
        tickets: record.attrs.tickets || [],
        path: currentWorkRecordOwner() ? record.path : record.relativePath,
        notices: workRecordNotices(record),
    };
}

function canAccessRecord(accessMode: WorkRecordAccessMode, record: WorkRecordResource) {
    return accessMode === "all" || isCurrentWorkRecord(record);
}

function asJsonResults(value: unknown): unknown[] {
    if (!value || typeof value !== "object") return [];
    const results = (value as RawSearchResults).results;
    return Array.isArray(results) ? results : [];
}

function extractTags(value: unknown): string[] {
    if (!value || typeof value !== "object") return [];
    const result = value as RawSearchResult;
    const tags: unknown[] = Array.isArray(result.metadata?.tags)
        ? result.metadata.tags
        : Array.isArray(result.tags)
          ? result.tags
          : [];
    return tags.filter((tag) => typeof tag === "string");
}

export function parseWorkRecordSearchJson(output: unknown): WorkRecordSearchCandidate[] {
    if (typeof output !== "string" || !output.trim()) return [];
    const parsed: unknown = JSON.parse(output);
    return asJsonResults(parsed)
        .map((result) => ({ recordId: recordIdFromTags(extractTags(result)), raw: result }))
        .filter((candidate) => candidate.recordId);
}

async function ensureSearchBootstrap(cwd: string, options: WorkRecordIndexOptions) {
    const canonical = await listWorkRecords(cwd, { createDir: false });
    if (!canonical.length) return { bootstrapped: false, rebuild: null, canonical };
    if (!(await isWorkRecordIndexEmpty(cwd, options))) return { bootstrapped: false, rebuild: null, canonical };
    const rebuild = await rebuildWorkRecordIndex(cwd, options);
    return { bootstrapped: true, rebuild, canonical };
}

export async function searchWorkRecords(
    cwd: string,
    query: string,
    options: WorkRecordSearchOptions,
): Promise<WorkRecordSearchResult> {
    const trimmed = String(query || "").trim();
    if (!trimmed) throw new Error("Work Record search query is required.");
    const accessMode = options.includeAll ? "all" : options.accessMode || "current";
    const bootstrap = await ensureSearchBootstrap(cwd, options);
    const collection = await getWorkRecordIndexCollectionName(cwd);
    const output = await runMnemotecaWorkRecordCommand(
        cwd,
        ["search", "--name", collection, "--format", "json", "--limit", String(options.limit || 20), trimmed],
        options,
    );
    let candidates: WorkRecordSearchCandidate[];
    try {
        candidates = parseWorkRecordSearchJson(output);
    } catch (error) {
        throw new Error(
            `Unable to parse Work Record index search results: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const candidate of candidates) {
        if (seen.has(candidate.recordId)) duplicates.add(candidate.recordId);
        seen.add(candidate.recordId);
    }
    if (duplicates.size) {
        throw new Error(
            `Duplicate Work Record index entries for ${[...duplicates].join(
                ", ",
            )}. Run wld wr index rebuild to repair the derived Work Record index.`,
        );
    }
    const recordsById = new Map(bootstrap.canonical.map((record) => [record.attrs.recordId, record]));
    const records: WorkRecordHydratedResult[] = [];
    const stale: string[] = [];
    for (const candidate of candidates) {
        const record = recordsById.get(candidate.recordId);
        if (!record) {
            stale.push(candidate.recordId);
            continue;
        }
        if (!canAccessRecord(accessMode, record)) continue;
        records.push(formatHydratedWorkRecord(record));
    }
    return {
        query: trimmed,
        accessMode,
        records,
        staleRecordIds: stale,
        bootstrapped: bootstrap.bootstrapped,
        rebuild: bootstrap.rebuild,
    };
}

export async function readWorkRecordById(
    cwd: string,
    recordId: string,
    options: WorkRecordReadOptions = {},
): Promise<WorkRecordReadResult> {
    const trimmed = String(recordId || "").trim();
    if (!trimmed) throw new Error("Work Record recordId is required.");
    const accessMode = options.accessMode || "all";
    const record = await findWorkRecordById(cwd, trimmed);
    if (!record) throw new Error(`Work Record not found: ${trimmed}`);
    if (!canAccessRecord(accessMode, record)) {
        throw new Error(`Work Record ${trimmed} is not current and cannot be read in current-only mode.`);
    }
    return { accessMode, ...formatHydratedWorkRecord(record), body: record.body, markdown: record.markdown };
}

export function formatWorkRecordSearchResult(result: WorkRecordHydratedResult) {
    const lines = [
        `- ${result.title}`,
        `  recordId: ${result.recordId}`,
        `  status: ${result.status}`,
        `  work: ${formatWorkRecordScopeLabel(result.scope, result.workKind)}`,
        `  scope: ${result.scope}`,
        ...(result.workKind ? [`  workKind: ${result.workKind}`] : []),
        `  origin: ${result.origin}`,
        `  completionMode: ${result.completionMode}`,
    ];
    if (result.sourcePlans.length) lines.push(`  sourcePlans: ${result.sourcePlans.join(", ")}`);
    const tickets = result.tickets || [];
    if (tickets.length) lines.push(`  tickets: ${tickets.map((ticket) => ticket.url).join(", ")}`);
    lines.push(`  path: ${result.path}`, "  Summary:", ...result.summary.split("\n").map((line) => `    ${line}`));
    for (const notice of result.notices) lines.push(`  ${notice}`);
    return lines.join("\n");
}

export function formatWorkRecordSearchResults(result: WorkRecordSearchResult) {
    const lines = [`[RunWield] Work Record search results for: ${result.query}`];
    if (result.bootstrapped) {
        lines.push(
            `[RunWield] Work Record index was empty; rebuilt ${result.rebuild?.added || 0}/${
                result.rebuild?.total || 0
            } record(s).`,
        );
    }
    if (!result.records.length) {
        lines.push(
            result.accessMode === "all" ? "No matching Work Records found." : "No matching current Work Records found.",
        );
    } else lines.push("", ...result.records.map(formatWorkRecordSearchResult));
    if (result.staleRecordIds.length) {
        lines.push(
            "",
            `WARNING: discarded stale index candidate(s): ${result.staleRecordIds.join(
                ", ",
            )}. Run wld wr index rebuild.`,
        );
    }
    return lines.join("\n");
}

export function formatWorkRecordReadResult(result: WorkRecordReadResult) {
    const lines = [
        `[RunWield] Work Record: ${result.title}`,
        `recordId: ${result.recordId}`,
        `status: ${result.status}`,
        `work: ${formatWorkRecordScopeLabel(result.scope, result.workKind)}`,
        `scope: ${result.scope}`,
        ...(result.workKind ? [`workKind: ${result.workKind}`] : []),
        `origin: ${result.origin}`,
        `completionMode: ${result.completionMode}`,
    ];
    if (result.sourcePlans.length) lines.push(`sourcePlans: ${result.sourcePlans.join(", ")}`);
    const tickets = result.tickets || [];
    if (tickets.length) lines.push(`tickets: ${tickets.map((ticket) => ticket.url).join(", ")}`);
    lines.push(`path: ${result.path}`);
    for (const notice of result.notices) lines.push(notice);
    lines.push("", result.body.trim());
    return lines.join("\n");
}
