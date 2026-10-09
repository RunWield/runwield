/**
 * @module shared/work-records/search
 * Canonical Work Record retrieval hydrated from Markdown, using Mnemoteca only for candidates.
 */

import { findWorkRecordById, listWorkRecords } from "./store.js";
import { formatWorkRecordScopeLabel, isCurrentWorkRecord, workRecordNotices } from "./list.ts";
import {
    getWorkRecordIndexCollectionName,
    isWorkRecordIndexEmpty,
    rebuildWorkRecordIndex,
    recordIdFromTags,
    runMnemotecaWorkRecordCommand,
} from "./index-adapter.ts";

/** @typedef {"current"|"all"} WorkRecordAccessMode */

/**
 * @typedef {Object} WorkRecordHydratedResult
 * @property {string} recordId
 * @property {string} title
 * @property {string} summary
 * @property {string} status
 * @property {string} scope
 * @property {string|undefined} [workKind]
 * @property {string} origin
 * @property {string} completionMode
 * @property {string[]} sourcePlans
 * @property {import('../ticket-references.js').TicketReference[]} tickets
 * @property {string} path
 * @property {string[]} notices
 */

/** @param {import('./schema.ts').WorkRecordResource} record */
export function formatHydratedWorkRecord(record) {
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
        path: record.relativePath,
        notices: workRecordNotices(record),
    };
}

/**
 * @param {WorkRecordAccessMode} accessMode
 * @param {import('./schema.ts').WorkRecordResource} record
 */
function canAccessRecord(accessMode, record) {
    return accessMode === "all" || isCurrentWorkRecord(record);
}

/** @param {unknown} value */
function asJsonResults(value) {
    if (!value || typeof value !== "object") return [];
    const results = /** @type {{ results?: unknown }} */ (value).results;
    return Array.isArray(results) ? results : [];
}

/** @param {unknown} value */
function extractTags(value) {
    if (!value || typeof value !== "object") return [];
    const result = /** @type {{ metadata?: { tags?: unknown }, tags?: unknown }} */ (value);
    const tags = Array.isArray(result.metadata?.tags)
        ? result.metadata.tags
        : Array.isArray(result.tags)
        ? result.tags
        : [];
    return tags.filter((tag) => typeof tag === "string");
}

/** @param {unknown} output */
export function parseWorkRecordSearchJson(output) {
    if (typeof output !== "string" || !output.trim()) return [];
    const parsed = JSON.parse(output);
    return asJsonResults(parsed).map((result) => ({ recordId: recordIdFromTags(extractTags(result)), raw: result }))
        .filter((candidate) => candidate.recordId);
}

/**
 * @param {string} cwd
 * @param {{ mnemotecaPort: import('./mnemoteca-port.ts').WorkRecordMnemotecaPort }} options
 */
async function ensureSearchBootstrap(cwd, options) {
    const canonical = await listWorkRecords(cwd, { createDir: false });
    if (!canonical.length) return { bootstrapped: false, rebuild: null, canonical };
    if (!(await isWorkRecordIndexEmpty(cwd, options))) return { bootstrapped: false, rebuild: null, canonical };
    const rebuild = await rebuildWorkRecordIndex(cwd, options);
    return { bootstrapped: true, rebuild, canonical };
}

/**
 * @param {string} cwd
 * @param {string} query
 * @param {{ accessMode?: WorkRecordAccessMode, includeAll?: boolean, limit?: number, mnemotecaPort: import('./mnemoteca-port.ts').WorkRecordMnemotecaPort }} options
 */
export async function searchWorkRecords(cwd, query, options) {
    const trimmed = String(query || "").trim();
    if (!trimmed) throw new Error("Work Record search query is required.");
    const accessMode = options.includeAll ? "all" : options.accessMode || "current";
    const bootstrap = await ensureSearchBootstrap(cwd, options);
    const collection = await getWorkRecordIndexCollectionName(cwd);
    const output = await runMnemotecaWorkRecordCommand(cwd, [
        "search",
        "--name",
        collection,
        "--format",
        "json",
        "--limit",
        String(options.limit || 20),
        trimmed,
    ], options);
    let candidates;
    try {
        candidates = parseWorkRecordSearchJson(output);
    } catch (error) {
        throw new Error(
            `Unable to parse Work Record index search results: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
    const seen = new Set();
    const duplicates = new Set();
    for (const candidate of candidates) {
        if (seen.has(candidate.recordId)) duplicates.add(candidate.recordId);
        seen.add(candidate.recordId);
    }
    if (duplicates.size) {
        throw new Error(
            `Duplicate Work Record index entries for ${
                [...duplicates].join(", ")
            }. Run wld wr index rebuild to repair the derived Work Record index.`,
        );
    }
    const recordsById = new Map(bootstrap.canonical.map((record) => [record.attrs.recordId, record]));
    const records = [];
    const stale = [];
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

/**
 * @param {string} cwd
 * @param {string} recordId
 * @param {{ accessMode?: WorkRecordAccessMode }} [options]
 */
export async function readWorkRecordById(cwd, recordId, options = {}) {
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

/** @param {WorkRecordHydratedResult} result */
export function formatWorkRecordSearchResult(result) {
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

/** @param {Awaited<ReturnType<typeof searchWorkRecords>>} result */
export function formatWorkRecordSearchResults(result) {
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
            `WARNING: discarded stale index candidate(s): ${
                result.staleRecordIds.join(", ")
            }. Run wld wr index rebuild.`,
        );
    }
    return lines.join("\n");
}

/** @param {Awaited<ReturnType<typeof readWorkRecordById>>} result */
export function formatWorkRecordReadResult(result) {
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
