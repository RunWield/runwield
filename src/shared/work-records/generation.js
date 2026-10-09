/**
 * @module shared/work-records/generation
 * Generate canonical internal Work Records from completed Plans.
 */

import { AGENTS, isPlannedChangeClassification } from "../../constants.js";
import {
    compareChildPlansByOrder,
    ensurePlanIdentity,
    isChildFeaturePlan,
    isProjectPlan,
    listArchivedPlans,
    listPlans,
    loadArchivedPlan,
    loadPlan,
    updateArchivedPlanFrontMatter,
} from "../../plan-store.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { HostedSession } from "../session/hosted-session.js";
import { runValidationAgentUntilEvent } from "../session/agent-workflow-step.ts";
import { SYSTEM_SEMANTIC_REVIEW_PORT } from "../workflow/validation-session-adapter.ts";
import { settleWorkflowToolEvent } from "../workflow/workflow-tool-events.ts";
import { createWorkRecordCompletedTool } from "../../tools/work-record-completed.ts";
import { dedupeTicketReferencesByUrl } from "../ticket-references.js";
import {
    mergeRecorderDeviationText,
    readPlanDeviations,
    renderPlanDeviationsForWorkRecord,
} from "../plan-deviations.ts";
import { runPlanFrontMatterTransition } from "../workflow/state-transition.ts";
import { buildWorkRecordFileName, deleteWorkRecord, listWorkRecords, writeWorkRecord } from "./store.js";
import { syncWorkRecordToIndex } from "./index-adapter.ts";
import { applyWorkRecordSupersession, WorkRecordSupersessionRollbackError } from "./supersession.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DEFAULT_CLOSURE_REASON = "Reason not specified.";
const SKIPPED_VERIFICATION_TEXT = "RunWield Workflow Validation was skipped";
const USER_VERIFIED_TEXT = "The user attested verification; RunWield Workflow Validation did not establish this result";

/**
 * @typedef {Object} WorkRecordSource
 * @property {boolean} [pendingPublication] - Explicit artifact preparation, never ordinary backfill eligibility
 * @property {"active"|"archived"} sourceKind
 * @property {string} name
 * @property {string} relativePath
 * @property {string} path
 * @property {string} planId
 * @property {string} [documentRevision] - Expected local document revision when recording a published source
 * @property {import('../../plan-store.js').PlanFrontMatter} attrs
 * @property {import('../plan-deviations.ts').PlanDeviation[]} [planDeviations]
 * @property {string} body
 * @property {string} markdown
 * @property {"planned_change"|"epic"} [scope]
 * @property {"verified"|"closed_without_verification"|"user_verified"|"done_enough"} [completionMode]
 * @property {string} [closureReason]
 * @property {string} [executionReport]
 * @property {WorkRecordSource[]} [children]
 * @property {string} [skipReason]
 * @property {import('./schema.ts').WorkRecordResource} [existingRecord]
 */

/**
 * @typedef {Object} GeneratedWorkRecordSections
 * @property {string} title
 * @property {string} summary
 * @property {string} [deviationsFromPlan]
 * @property {string} [deferredWork]
 * @property {string} [futurePlanningNotes]
 * @property {import('./schema.ts').WorkRecordSupersessionCandidate[]} [supersessionProposals]
 */

/**
 * @typedef {Object} GenerationOptions
 * @property {AbortSignal} [signal] - Cancellation of the recording operation
 * @property {() => string} [idGenerator]
 * @property {() => Date} [now]
 * @property {(prompt: string) => Promise<GeneratedWorkRecordSections>} [runRecorderStep]
 * @property {import('./mnemoteca-port.ts').WorkRecordMnemotecaPort} [mnemotecaPort]
 */

/**
 * @typedef {GenerationOptions & { mnemotecaPort: import('./mnemoteca-port.ts').WorkRecordMnemotecaPort }} WorkRecordGenerationOptions
 */

/**
 * @typedef {Object} BackfillResult
 * @property {WorkRecordSource[]} sources
 * @property {WorkRecordSource[]} eligible
 * @property {WorkRecordSource[]} skipped
 * @property {Array<{ source: WorkRecordSource, status: "generated"|"linked"|"failed", recordId?: string, path?: string, error?: string, indexWarning?: string, supersessionProposals?: import('./schema.ts').WorkRecordSupersessionCandidate[] }>} outcomes
 */

/** @param {Date} date */
function iso(date) {
    return date.toISOString();
}

/** @param {unknown} value */
function nonEmptyString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : "";
}

/** @param {string} body */
function extractTitle(body) {
    return String(body || "").match(/^#\s+(.+)$/m)?.[1]?.trim() || "";
}

/** @param {unknown} value */
function conciseError(value) {
    const message = value instanceof Error ? value.message : String(value || "Unknown Work Record generation failure.");
    const normalized = message.replace(/\s+/g, " ").trim();
    if (value instanceof WorkRecordSupersessionRollbackError) return normalized;
    return normalized.slice(0, 240) || "Unknown Work Record generation failure.";
}

/** @param {unknown} value */
function optionalTrimmedString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** @param {string} text */
function parseJsonObjectFromText(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) throw new Error("Recorder returned no structured output.");
    try {
        return JSON.parse(trimmed);
    } catch {
        const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
        if (fenced) return JSON.parse(fenced);
        const start = trimmed.indexOf("{");
        const end = trimmed.lastIndexOf("}");
        if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
        throw new Error("Recorder output must be structured JSON.");
    }
}

/**
 * @param {unknown} value
 * @returns {import('./schema.ts').WorkRecordSupersessionCandidate[] | undefined}
 */
function normalizeSupersessionProposals(value) {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new Error("Recorder supersessionProposals must be an array.");
    const candidates = [];
    const seen = new Set();
    for (const item of value) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new Error("Each Recorder supersession proposal must be an object.");
        }
        const candidate = /** @type {Record<string, unknown>} */ (item);
        const recordId = optionalTrimmedString(candidate.recordId);
        const reason = optionalTrimmedString(candidate.reason);
        if (!recordId || !UUID_RE.test(recordId)) {
            throw new Error("Recorder supersession proposal recordId must be a valid UUID.");
        }
        if (!reason) throw new Error("Recorder supersession proposal reason must be non-blank.");
        const identity = recordId.toLowerCase();
        if (seen.has(identity)) continue;
        seen.add(identity);
        candidates.push({ recordId, reason });
    }
    return candidates.length ? candidates : undefined;
}

/**
 * @param {unknown} value
 * @returns {GeneratedWorkRecordSections}
 */
export function normalizeRecorderOutput(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Recorder output must be a JSON object.");
    }
    const record = /** @type {Record<string, unknown>} */ (value);
    const title = optionalTrimmedString(record.title);
    const summary = optionalTrimmedString(record.summary);
    if (!title) throw new Error("Recorder output requires a non-empty title.");
    if (!summary) throw new Error("Recorder output requires a non-empty summary.");
    const supersessionProposals = normalizeSupersessionProposals(record.supersessionProposals);
    return {
        title,
        summary,
        ...(optionalTrimmedString(record.deviationsFromPlan)
            ? { deviationsFromPlan: optionalTrimmedString(record.deviationsFromPlan) }
            : {}),
        ...(optionalTrimmedString(record.deferredWork)
            ? { deferredWork: optionalTrimmedString(record.deferredWork) }
            : {}),
        ...(optionalTrimmedString(record.futurePlanningNotes)
            ? { futurePlanningNotes: optionalTrimmedString(record.futurePlanningNotes) }
            : {}),
        ...(supersessionProposals ? { supersessionProposals } : {}),
    };
}

/**
 * @param {string} text
 * @returns {GeneratedWorkRecordSections}
 */
export function parseRecorderSections(text) {
    return normalizeRecorderOutput(parseJsonObjectFromText(text));
}

/**
 * @param {WorkRecordSource} source
 * @returns {"verified"|"closed_without_verification"|"user_verified"|"done_enough"|""}
 */
export function deriveWorkRecordCompletionMode(source) {
    if (isProjectPlan(source.attrs) && source.attrs.epicCompletionMode === "done_enough") return "done_enough";
    if (source.attrs.status === "closed_without_verification") return "closed_without_verification";
    if (source.attrs.status === "user_verified") return "user_verified";
    if (
        source.attrs.status === "validated" || source.attrs.status === "verified" ||
        (source.pendingPublication && source.attrs.status === "reviewed")
    ) return "verified";
    return "";
}

/**
 * @param {WorkRecordSource} source
 * @returns {"planned_change"|"epic"|""}
 */
export function deriveWorkRecordScope(source) {
    if (isProjectPlan(source.attrs)) return "epic";
    if (isPlannedChangeClassification(source.attrs.classification) && !isChildFeaturePlan(source)) {
        return "planned_change";
    }
    return "";
}

/** @param {import('./schema.ts').WorkRecordResource[]} records */
export function recordsBySourcePlanId(records) {
    /** @type {Map<string, import('./schema.ts').WorkRecordResource[]>} */
    const map = new Map();
    for (const record of records) {
        for (const planId of record.attrs.provenance?.sourcePlans || []) {
            const existing = map.get(planId) || [];
            existing.push(record);
            map.set(planId, existing);
        }
    }
    return map;
}

/**
 * @param {WorkRecordSource} source
 * @param {Map<string, import('./schema.ts').WorkRecordResource[]>} existingByPlanId
 */
function findLinkableExistingRecord(source, existingByPlanId) {
    const candidates = source.planId ? existingByPlanId.get(source.planId) || [] : [];
    return candidates.find((record) =>
        (record.attrs.status === "approved" ||
            (source.pendingPublication && record.attrs.status === "pending_verification")) &&
        record.attrs.origin === "internal" &&
        record.attrs.scope === source.scope &&
        record.attrs.completionMode === source.completionMode &&
        !record.attrs.archivedAt &&
        !record.attrs.supersededBy
    );
}

/**
 * @param {WorkRecordSource} source
 * @param {Map<string, import('./schema.ts').WorkRecordResource[]>} existingByPlanId
 * @returns {WorkRecordSource}
 */
export function evaluateWorkRecordSource(source, existingByPlanId = new Map()) {
    if (source.attrs.workRecord && source.attrs.workRecord.status !== "failed") {
        return { ...source, skipReason: "existing_backlink" };
    }
    if (isChildFeaturePlan(source)) return { ...source, skipReason: "child_feature" };
    const scope = deriveWorkRecordScope(source);
    if (!scope) return { ...source, skipReason: "unsupported_plan_type" };
    const completionMode = deriveWorkRecordCompletionMode(source);
    if (!completionMode) return { ...source, skipReason: "not_completed" };
    const candidate = {
        ...source,
        scope,
        completionMode,
        executionReport: nonEmptyString(source.attrs.executionReport),
    };
    const existingRecord = findLinkableExistingRecord(candidate, existingByPlanId);
    return {
        ...candidate,
        closureReason: completionMode === "closed_without_verification"
            ? nonEmptyString(source.attrs.closedWithoutVerificationReason) || DEFAULT_CLOSURE_REASON
            : undefined,
        ...(existingRecord ? { existingRecord } : {}),
    };
}

/**
 * @param {string} cwd
 * @returns {Promise<WorkRecordSource[]>}
 */
export async function discoverWorkRecordSources(cwd) {
    /** @type {WorkRecordSource[]} */
    const sources = [];
    for (const entry of await listPlans(cwd)) {
        const loaded = await loadPlan(cwd, entry.name);
        if (!loaded) continue;
        sources.push(buildActiveWorkRecordSource(entry.name, loaded));
    }
    for (const entry of await listArchivedPlans(cwd)) {
        const loaded = await loadArchivedPlan(cwd, entry.name);
        if (!loaded) continue;
        sources.push({
            sourceKind: "archived",
            name: entry.name,
            relativePath: entry.relativePath,
            path: loaded.path,
            planId: loaded.attrs.planId || "",
            attrs: loaded.attrs,
            planDeviations: readPlanDeviations(loaded.attrs.planDeviations),
            body: loaded.body,
            markdown: loaded.markdown,
        });
    }
    return sources;
}

/**
 * @param {string} name
 * @param {{ path: string, markdown: string, attrs: import('../../plan-store.js').PlanFrontMatter, body: string }} loaded
 * @returns {WorkRecordSource}
 */
export function buildActiveWorkRecordSource(name, loaded) {
    return {
        sourceKind: "active",
        name,
        relativePath: `docs/plans/${name}.md`,
        path: loaded.path,
        planId: loaded.attrs.planId || "",
        attrs: loaded.attrs,
        planDeviations: readPlanDeviations(loaded.attrs.planDeviations),
        body: loaded.body,
        markdown: loaded.markdown,
    };
}

/**
 * @param {WorkRecordSource[]} sources
 * @returns {WorkRecordSource[]}
 */
export function attachEpicChildren(sources) {
    return sources.map((source) => {
        if (!isProjectPlan(source.attrs)) return source;
        const children = sources.filter((candidate) =>
            isPlannedChangeClassification(candidate.attrs.classification) && candidate.attrs.parentPlan === source.name
        ).sort(compareChildPlansByOrder);
        return { ...source, children };
    });
}

/**
 * @param {string} cwd
 * @returns {Promise<{ sources: WorkRecordSource[], eligible: WorkRecordSource[], skipped: WorkRecordSource[] }>}
 */
export async function previewWorkRecordBackfill(cwd) {
    const existingByPlanId = recordsBySourcePlanId(await listWorkRecords(cwd, { createDir: false }));
    const sources = attachEpicChildren(await discoverWorkRecordSources(cwd)).map((source) =>
        evaluateWorkRecordSource(source, existingByPlanId)
    );
    return {
        sources,
        eligible: sources.filter((source) => !source.skipReason),
        skipped: sources.filter((source) => source.skipReason),
    };
}

/**
 * @param {string} cwd
 * @param {WorkRecordSource} source
 * @param {Partial<import('../../plan-store.js').PlanFrontMatter>} updates
 */
async function updateSourceFrontMatter(cwd, source, updates) {
    if (source.sourceKind === "archived") return await updateArchivedPlanFrontMatter(cwd, source.name, updates);
    // A Work Record backlink is post-settlement bookkeeping, so it gets an ordinary
    // Plan transaction. Plan Recovery is deliberately not used here: recovery
    // supersedes unresolved recovery journals and retires them on success, which
    // would let a backlink write silently destroy the evidence for an uncertain
    // publication it knows nothing about.
    const transition = await runPlanFrontMatterTransition({
        projectRoot: cwd,
        planName: source.name,
        operation: "work_record_backlink",
        expectedRevision: source.documentRevision,
        updates,
        recoveryAttrs: source.attrs || {},
    });
    if (transition.status !== "committed") {
        throw new Error(transition.message || `Could not link Work Record to Plan ${source.name}.`);
    }
    return /** @type {import('../../plan-store.js').PlanFrontMatter} */ (transition.value);
}

/**
 * @param {string} cwd
 * @param {WorkRecordSource} source
 * @param {WorkRecordGenerationOptions} options
 * @returns {Promise<WorkRecordSource>}
 */
async function ensureSourcePlanId(cwd, source, options) {
    if (source.planId) return source;
    if (source.sourceKind === "active") {
        const resource = await ensurePlanIdentity(cwd, source.name, { idGenerator: options.idGenerator });
        return {
            ...source,
            planId: resource.planId,
            attrs: resource.attrs,
            body: resource.body,
            markdown: resource.markdown,
            children: source.children,
        };
    }
    const planId = options.idGenerator ? options.idGenerator() : crypto.randomUUID();
    const attrs = await updateArchivedPlanFrontMatter(cwd, source.name, { planId });
    return { ...source, planId, attrs };
}

/** @param {string} value */
function stripMarkdown(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
}

/** @param {WorkRecordSource} source */
function declaredSupersessionIds(source) {
    const values = source.attrs.supersedes || [];
    const ids = [];
    const seen = new Set();
    for (const value of values) {
        const id = nonEmptyString(value);
        if (!UUID_RE.test(id)) {
            throw new Error(`Plan supersedes contains an invalid Work Record UUID: ${id || "blank"}.`);
        }
        const identity = id.toLowerCase();
        if (seen.has(identity)) continue;
        seen.add(identity);
        ids.push(id);
    }
    return ids;
}

/**
 * Validate against a fresh canonical read. The supersession operation repeats these checks under its lock.
 * @param {string} cwd
 * @param {string} successorRecordId
 * @param {string[]} predecessorRecordIds
 */
async function validateDeclaredSupersession(cwd, successorRecordId, predecessorRecordIds) {
    if (!predecessorRecordIds.length) return [];
    const records = await listWorkRecords(cwd, { createDir: false });
    const byId = new Map(records.map((record) => [record.attrs.recordId.toLowerCase(), record]));
    const canonicalIds = [];
    for (const predecessorRecordId of predecessorRecordIds) {
        const identity = predecessorRecordId.toLowerCase();
        if (identity === successorRecordId.toLowerCase()) throw new Error("A Work Record cannot supersede itself.");
        const predecessor = byId.get(identity);
        if (!predecessor) throw new Error(`Declared predecessor Work Record was not found: ${predecessorRecordId}.`);
        if (
            predecessor.attrs.supersededBy &&
            predecessor.attrs.supersededBy.toLowerCase() !== successorRecordId.toLowerCase()
        ) {
            throw new Error(
                `Work Record ${predecessor.attrs.recordId} is already superseded by ${predecessor.attrs.supersededBy}.`,
            );
        }
        canonicalIds.push(predecessor.attrs.recordId);
    }
    return canonicalIds;
}

/**
 * Recorder proposals must identify canonical Work Records. Superseded records are
 * still valid candidates because the recorded reason supplies their status context.
 * @param {string} cwd
 * @param {string} successorRecordId
 * @param {import('./schema.ts').WorkRecordSupersessionCandidate[]} candidates
 */
async function validateRecorderProposals(cwd, successorRecordId, candidates) {
    if (!candidates.length) return [];
    const records = await listWorkRecords(cwd, { createDir: false });
    const byId = new Map(records.map((record) => [record.attrs.recordId.toLowerCase(), record]));
    return candidates.map((candidate) => {
        const identity = candidate.recordId.toLowerCase();
        if (identity === successorRecordId.toLowerCase()) {
            throw new Error("Recorder supersession proposal cannot target the successor Work Record itself.");
        }
        const target = byId.get(identity);
        if (!target) {
            throw new Error(`Recorder supersession proposal Work Record was not found: ${candidate.recordId}.`);
        }
        return { ...candidate, recordId: target.attrs.recordId };
    });
}

/**
 * @param {WorkRecordSource} source
 * @param {string} successorRecordId
 * @param {string[]} settledSupersedes
 * @returns {string}
 */
function buildRecorderPrompt(source, successorRecordId, settledSupersedes) {
    return JSON.stringify(
        {
            instruction:
                "Generate a concise Work Record body draft and call work_record_completed with: title, summary, optional deviationsFromPlan, optional deferredWork, optional futurePlanningNotes, and optional supersessionProposals. source.planDeviations are already confirmed and RunWield will insert them deterministically under Deviations from Plan; do not repeat, omit, contradict, or reinterpret them. deviationsFromPlan is only for other meaningful retrospective deviations. supersessionProposals must be an array of {recordId, reason}; each recordId must be a plain UUID and each reason must be non-blank. settledSupersedes are already confirmed and must not be proposed again. Propose only other existing Work Records that this result appears to replace. Distill executionReport facts into the appropriate sections; RunWield will preserve the raw executionReport separately when present.",
            successorRecordId,
            settledSupersedes,
            source: {
                name: source.name,
                path: source.relativePath,
                planId: source.planId,
                scope: source.scope,
                completionMode: source.completionMode,
                deliveryState: source.pendingPublication
                    ? "pending publication; do not claim merged or delivered"
                    : "completed",
                closureReason: source.closureReason,
                userVerificationNote: source.attrs.userVerificationNote,
                userVerifiedAt: source.attrs.userVerifiedAt,
                executionReport: source.executionReport,
                attrs: source.attrs,
                planDeviations: aggregatePlanDeviations(source),
                body: source.body,
                children: (source.children || []).map((child) => ({
                    name: child.name,
                    path: child.relativePath,
                    status: child.attrs.status,
                    summary: child.attrs.summary,
                    planDeviations: child.planDeviations || readPlanDeviations(child.attrs.planDeviations),
                })),
            },
        },
        null,
        2,
    );
}

/**
 * @param {string} cwd
 * @param {WorkRecordSource} source
 * @param {GenerationOptions} [options]
 * @param {string} [successorRecordId]
 * @param {string[]} [settledSupersedes]
 * @returns {Promise<GeneratedWorkRecordSections>}
 */
export async function generateRecorderSections(
    cwd,
    source,
    options = {},
    successorRecordId = crypto.randomUUID(),
    settledSupersedes = [],
) {
    const prompt = buildRecorderPrompt(source, successorRecordId, settledSupersedes);
    if (options.runRecorderStep) return normalizeRecorderOutput(await options.runRecorderStep(prompt));
    const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd });
    const sessionManager = SessionManager.inMemory(cwd);
    try {
        for (let attempt = 1; attempt <= 2; attempt++) {
            const { event, messages } = await runValidationAgentUntilEvent(SYSTEM_SEMANTIC_REVIEW_PORT, {
                hostedSession,
                signal: options.signal,
                cwd,
                agentName: AGENTS.RECORDER,
                userRequest: attempt === 1
                    ? prompt +
                        "\nSubmit the sections by calling work_record_completed. Plain text cannot complete this step."
                    : "No work_record_completed submission was accepted. Use the source already provided to call " +
                        "work_record_completed now. Correct any rejected arguments; do not return JSON as text.",
                sessionManager,
                customTools: [createWorkRecordCompletedTool(hostedSession)],
                includeEditFallback: false,
            }, "work_record_completed");
            if (event) {
                const sections = normalizeRecorderOutput(event.payload);
                settleWorkflowToolEvent(hostedSession, event);
                return sections;
            }
            const lastAssistant = messages.findLast((message) => message.role === "assistant");
            // Keep only protocol metadata, never provider text or private reasoning.
            const stopped = lastAssistant?.role === "assistant" ? lastAssistant.stopReason : undefined;
            const diagnostic = stopped === "error" || stopped === "aborted" || stopped === "length"
                ? `turn ended with ${stopped}`
                : "turn ended without an accepted work_record_completed call";
            if (attempt === 2 || stopped === "error" || stopped === "aborted") {
                throw new Error(`Recorder submission failed after ${attempt} attempt(s): ${diagnostic}`);
            }
        }
        throw new Error("Recorder submission attempts exhausted.");
    } finally {
        hostedSession.dispose();
    }
}

/**
 * @param {WorkRecordSource} source
 * @returns {GeneratedWorkRecordSections}
 */
export function synthesizeWorkRecordSections(source) {
    const title = extractTitle(source.body) || source.attrs.summary || source.name;
    const summary = source.completionMode === "closed_without_verification"
        ? `This work was completed but RunWield Workflow Validation was skipped. Closure reason: ${
            source.closureReason || DEFAULT_CLOSURE_REASON
        }`
        : source.completionMode === "user_verified"
        ? `This work was marked User Verified by the user. RunWield Workflow Validation did not establish this result. User note: ${
            nonEmptyString(source.attrs.userVerificationNote) || DEFAULT_CLOSURE_REASON
        }`
        : source.completionMode === "done_enough"
        ? `${source.attrs.summary || title} The PROJECT Epic was marked done enough${
            source.attrs.epicDoneEnoughSummary ? `: ${source.attrs.epicDoneEnoughSummary}` : "."
        }`
        : source.attrs.summary || `Completed ${title}.`;
    const childLines = (source.children || [])
        .filter((child) => isPlannedChangeClassification(child.attrs.classification))
        .map((child) =>
            `- ${child.name}: ${child.attrs.status}${
                child.attrs.summary ? ` — ${stripMarkdown(child.attrs.summary)}` : ""
            }`
        );
    return {
        title,
        summary,
        ...(childLines.length ? { deferredWork: childLines.join("\n") } : {}),
        futurePlanningNotes: `Source Plan: ${source.relativePath}`,
    };
}

/**
 * @param {WorkRecordSource} source
 * @param {GeneratedWorkRecordSections} sections
 */
function prepareGeneratedSections(source, sections) {
    const normalized = normalizeRecorderOutput(sections);
    if (source.completionMode === "user_verified") {
        const note = nonEmptyString(source.attrs.userVerificationNote) || DEFAULT_CLOSURE_REASON;
        const summaryParts = [];
        if (!normalized.summary.includes(USER_VERIFIED_TEXT)) summaryParts.push(`${USER_VERIFIED_TEXT}.`);
        if (!normalized.summary.includes(note)) summaryParts.push(`User verification note: ${note}`);
        return { ...normalized, summary: [...summaryParts, normalized.summary].join(" ").trim() };
    }
    if (source.completionMode !== "closed_without_verification") return normalized;
    const reason = source.closureReason || DEFAULT_CLOSURE_REASON;
    const summaryParts = [];
    if (!normalized.summary.includes(SKIPPED_VERIFICATION_TEXT)) {
        summaryParts.push(`This work was completed but ${SKIPPED_VERIFICATION_TEXT}.`);
    }
    if (!normalized.summary.includes(reason)) summaryParts.push(`Closure reason: ${reason}`);
    return { ...normalized, summary: [...summaryParts, normalized.summary].join(" ").trim() };
}

/**
 * @param {WorkRecordSource} source
 * @param {GeneratedWorkRecordSections} sections
 */
/**
 * @param {WorkRecordSource} source
 */
export function aggregateWorkRecordTickets(source) {
    if (source.scope === "epic") {
        return dedupeTicketReferencesByUrl(
            source.attrs.tickets,
            ...(source.children || []).sort(compareChildPlansByOrder).map((child) => child.attrs.tickets),
        );
    }
    return dedupeTicketReferencesByUrl(source.attrs.tickets);
}

/** @param {WorkRecordSource} source */
function aggregatePlanDeviations(source) {
    const own = source.planDeviations || readPlanDeviations(source.attrs.planDeviations);
    if (source.scope !== "epic") return own;
    return [
        ...own,
        ...(source.children || [])
            .sort(compareChildPlansByOrder)
            .flatMap((child) => child.planDeviations || readPlanDeviations(child.attrs.planDeviations)),
    ];
}

/**
 * Plans may require durable, deterministic statements in their Work Record.
 * The recorder can improve prose around them, but it cannot omit this section.
 *
 * @param {string} body
 * @returns {string}
 */
export function extractWorkRecordRequirements(body) {
    const lines = String(body || "").split(/\r?\n/);
    const heading = lines.findIndex((line) => line.trim() === "## Work Record Requirements");
    if (heading === -1) return "";
    const collected = [];
    for (const line of lines.slice(heading + 1)) {
        if (/^##\s+/.test(line)) break;
        collected.push(line);
    }
    return collected.join("\n").trim();
}

/**
 * @param {WorkRecordSource} source
 * @param {GeneratedWorkRecordSections} sections
 */
function buildBody(source, sections) {
    const normalized = prepareGeneratedSections(source, sections);
    const lines = [
        `# ${normalized.title}`,
        "",
        "## Summary",
        "",
        normalized.summary,
    ];
    sections = normalized;
    const confirmedDeviationText = renderPlanDeviationsForWorkRecord(aggregatePlanDeviations(source));
    const deviationText = mergeRecorderDeviationText(
        confirmedDeviationText,
        nonEmptyString(sections.deviationsFromPlan),
    );
    if (nonEmptyString(deviationText)) {
        lines.push("", "## Deviations from Plan", "", nonEmptyString(deviationText));
    }
    if (nonEmptyString(sections.deferredWork)) {
        lines.push("", "## Deferred Work", "", nonEmptyString(sections.deferredWork));
    }
    if (nonEmptyString(sections.futurePlanningNotes)) {
        lines.push("", "## Future Planning Notes", "", nonEmptyString(sections.futurePlanningNotes));
    }
    const requiredNotes = extractWorkRecordRequirements(source.body);
    if (requiredNotes) lines.push("", "## Required Record Notes", "", requiredNotes);
    return lines.join("\n");
}

/**
 * @param {string} cwd
 * @param {WorkRecordSource} source
 * @param {import('./schema.ts').WorkRecordResource} record
 * @param {Date} now
 */
async function linkSourceToRecord(cwd, source, record, now) {
    await updateSourceFrontMatter(cwd, source, {
        workRecord: {
            status: "generated",
            recordId: record.attrs.recordId,
            path: record.relativePath,
            lastAttemptAt: iso(now),
        },
    });
}

/**
 * @param {string} cwd
 * @param {import('./schema.ts').WorkRecordResource} record
 * @param {WorkRecordGenerationOptions} options
 */
async function bestEffortSyncGeneratedRecord(cwd, record, options) {
    try {
        await syncWorkRecordToIndex(cwd, record, {
            mnemotecaPort: options.mnemotecaPort,
        });
        return "";
    } catch (error) {
        return `Work Record index sync failed for ${record.attrs.recordId}: ${
            conciseError(error)
        } Run wld wr index rebuild.`;
    }
}

/**
 * @param {string} cwd
 * @param {WorkRecordSource} source
 * @param {Date} now
 * @param {unknown} error
 */
async function recordGenerationFailure(cwd, source, now, error) {
    try {
        await updateSourceFrontMatter(cwd, source, {
            workRecord: {
                status: "failed",
                lastAttemptAt: iso(now),
                error: conciseError(error),
            },
        });
    } catch {
        // The original generation failure is more useful to callers than a secondary backlink failure.
    }
}

/** @param {import('./schema.ts').WorkRecordResource} record */
function pendingSupersessionCandidates(record) {
    return record.attrs.supersessionProposal?.candidates || [];
}

/**
 * @param {string} cwd
 * @param {WorkRecordSource} inputSource
 * @param {WorkRecordGenerationOptions} options
 */
export async function generateWorkRecordForSource(cwd, inputSource, options) {
    const now = options.now ? options.now() : new Date();
    let source = inputSource;
    try {
        source = await ensureSourcePlanId(cwd, source, options);
        const existingByPlanId = recordsBySourcePlanId(await listWorkRecords(cwd));
        source = evaluateWorkRecordSource(source, existingByPlanId);
        if (source.skipReason) {
            throw new Error(`Source is not eligible for Work Record generation: ${source.skipReason}.`);
        }
        let declaredIds = declaredSupersessionIds(source);
        if (source.existingRecord) {
            let record = source.existingRecord;
            let indexWarning = "";
            declaredIds = await validateDeclaredSupersession(cwd, record.attrs.recordId, declaredIds);
            if (source.pendingPublication) {
                // Reuse the exact pending artifact after a crash without publishing index effects.
            } else if (declaredIds.length) {
                const applied = await applyWorkRecordSupersession(cwd, {
                    successorRecordId: record.attrs.recordId,
                    predecessorRecordIds: declaredIds,
                    mnemotecaPort: options.mnemotecaPort,
                });
                record = applied.records.find((candidate) => candidate.attrs.recordId === record.attrs.recordId) ||
                    record;
                indexWarning = applied.indexWarning || "";
            } else {
                indexWarning = await bestEffortSyncGeneratedRecord(cwd, record, options);
            }
            await linkSourceToRecord(cwd, source, record, now);
            const supersessionProposals = pendingSupersessionCandidates(record);
            return {
                source,
                status: "linked",
                recordId: record.attrs.recordId,
                path: record.relativePath,
                ...(supersessionProposals.length ? { supersessionProposals } : {}),
                ...(indexWarning ? { indexWarning } : {}),
            };
        }

        const recordId = options.idGenerator ? options.idGenerator() : crypto.randomUUID();
        declaredIds = await validateDeclaredSupersession(cwd, recordId, declaredIds);
        const sections = await generateRecorderSections(cwd, source, options, recordId, declaredIds);
        const declaredIdentities = new Set(declaredIds.map((id) => id.toLowerCase()));
        const undeclaredProposals = (sections.supersessionProposals || []).filter((candidate) =>
            !declaredIdentities.has(candidate.recordId.toLowerCase())
        );
        const supersessionProposals = await validateRecorderProposals(cwd, recordId, undeclaredProposals);
        /** @type {import('./schema.ts').WorkRecordFrontMatter} */
        const attrs = {
            kind: "work_record",
            recordId,
            status: source.pendingPublication ? "pending_verification" : "approved",
            scope: /** @type {"planned_change"|"epic"} */ (source.scope),
            workKind: source.attrs.workKind,
            origin: "internal",
            completionMode:
                /** @type {"verified"|"closed_without_verification"|"user_verified"|"done_enough"} */ (source
                    .completionMode),
            createdAt: iso(now),
            ...(aggregateWorkRecordTickets(source) ? { tickets: aggregateWorkRecordTickets(source) } : {}),
            ...(declaredIds.length ? { supersedes: declaredIds } : {}),
            ...(supersessionProposals.length ? { supersessionProposal: { candidates: supersessionProposals } } : {}),
            provenance: {
                sourcePlans: [source.planId],
            },
        };
        const body = buildBody(source, sections);
        const title = body.match(/^#\s+(.+)$/m)?.[1] || attrs.recordId;
        const record = await writeWorkRecord(cwd, attrs, body, { fileName: buildWorkRecordFileName(title, now) });
        let settledRecord = record;
        let indexWarning = "";
        if (source.pendingPublication) {
            // Prepared records are committed with the reviewed candidate; publication approves them.
        } else if (declaredIds.length) {
            try {
                const applied = await applyWorkRecordSupersession(cwd, {
                    successorRecordId: recordId,
                    predecessorRecordIds: declaredIds,
                    mnemotecaPort: options.mnemotecaPort,
                });
                settledRecord = applied.records.find((candidate) => candidate.attrs.recordId === recordId) || record;
                indexWarning = applied.indexWarning || "";
            } catch (error) {
                if (error instanceof WorkRecordSupersessionRollbackError) throw error;
                try {
                    await deleteWorkRecord(cwd, record);
                } catch (cleanupError) {
                    throw new Error(
                        `${conciseError(error)} Generated Work Record cleanup also failed: ${
                            conciseError(cleanupError)
                        }`,
                        { cause: error },
                    );
                }
                throw error;
            }
        } else {
            indexWarning = await bestEffortSyncGeneratedRecord(cwd, settledRecord, options);
        }
        await linkSourceToRecord(cwd, source, settledRecord, now);
        const pending = pendingSupersessionCandidates(settledRecord);
        return {
            source,
            status: "generated",
            recordId: settledRecord.attrs.recordId,
            path: settledRecord.relativePath,
            ...(pending.length ? { supersessionProposals: pending } : {}),
            ...(indexWarning ? { indexWarning } : {}),
        };
    } catch (error) {
        await recordGenerationFailure(cwd, source, now, error);
        return { source, status: "failed", error: conciseError(error) };
    }
}

/**
 * @param {string} cwd
 * @param {WorkRecordGenerationOptions} options
 * @returns {Promise<BackfillResult>}
 */
export async function runWorkRecordBackfill(cwd, options) {
    const preview = await previewWorkRecordBackfill(cwd);
    /** @type {BackfillResult["outcomes"]} */
    const outcomes = [];
    for (const source of preview.eligible) {
        outcomes.push(
            /** @type {BackfillResult["outcomes"][number]} */ (await generateWorkRecordForSource(cwd, source, options)),
        );
    }
    return { ...preview, outcomes };
}

/**
 * @param {BackfillResult | Awaited<ReturnType<typeof previewWorkRecordBackfill>>} result
 */
export function formatWorkRecordBackfillPreview(result) {
    const linkable = result.eligible.filter((source) => source.existingRecord).length;
    const generatable = result.eligible.length - linkable;
    const lines = [
        "[RunWield] Work Record backfill preview:",
        `  eligible: ${result.eligible.length}`,
        `  link existing: ${linkable}`,
        `  generate new: ${generatable}`,
        `  skipped: ${result.skipped.length}`,
    ];
    if (result.eligible.length) {
        lines.push("", "Eligible sources:");
        for (const source of result.eligible) {
            const action = source.existingRecord ? `link ${source.existingRecord.relativePath}` : "generate";
            lines.push(
                `  - ${source.name} (${source.sourceKind}, ${source.completionMode}, ${source.scope}) -> ${action}`,
            );
            lines.push(`    path: ${source.relativePath}`);
        }
    }
    const skipCounts = result.skipped.reduce((acc, source) => {
        const key = source.skipReason || "unknown";
        acc.set(key, (acc.get(key) || 0) + 1);
        return acc;
    }, /** @type {Map<string, number>} */ (new Map()));
    if (skipCounts.size) {
        lines.push("", "Skipped sources:");
        for (const [reason, count] of skipCounts) lines.push(`  - ${reason}: ${count}`);
    }
    return lines.join("\n");
}

/** @param {BackfillResult["outcomes"]} outcomes */
export function formatWorkRecordBackfillOutcomes(outcomes) {
    if (!outcomes.length) return "[RunWield] No Work Records generated or linked.";
    const lines = ["[RunWield] Work Record backfill results:"];
    for (const outcome of outcomes) {
        if (outcome.status === "failed") {
            lines.push(`  Failed ${outcome.source.name}: ${outcome.error || "unknown error"}`);
        } else {
            lines.push(
                `  ${outcome.status === "linked" ? "Linked" : "Generated"} ${outcome.source.name}: ${outcome.path}`,
            );
            if (outcome.supersessionProposals?.length) {
                lines.push("    Pending supersession proposals:");
                for (const candidate of outcome.supersessionProposals) {
                    lines.push(`      - ${candidate.recordId}: ${candidate.reason}`);
                }
                lines.push(`    Run wld wr supersede ${outcome.recordId}.`);
            }
            if (outcome.indexWarning) lines.push(`    WARNING: ${outcome.indexWarning}`);
        }
    }
    const failed = outcomes.filter((outcome) => outcome.status === "failed").length;
    lines.push(`[RunWield] ${outcomes.length - failed}/${outcomes.length} source(s) succeeded; ${failed} failed.`);
    return lines.join("\n");
}
