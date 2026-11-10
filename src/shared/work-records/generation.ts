/**
 * @module shared/work-records/generation
 * Generate canonical internal Work Records from completed Plans.
 */

import type { PlanFrontMatter, PlanTextLoaded } from "../../plan-store.js";
import type { PlanDeviation } from "../plan-deviations.ts";
import type { WorkRecordMnemotecaPort } from "./mnemoteca-port.ts";
import type {
    WorkRecordCompletionMode,
    WorkRecordFrontMatter,
    WorkRecordResource,
    WorkRecordScope,
    WorkRecordSections,
    WorkRecordSupersessionCandidate,
} from "./schema.ts";
import { ValidationHostRejected, ValidationHostWait } from "../workflow/validation-host-contract.ts";
import { AGENTS, isPlannedChangeClassification } from "../../constants.ts";
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
import { HostedSession } from "../session/hosted-session.ts";
import { runValidationAgentUntilEvent } from "../session/agent-workflow-step.ts";
import { SYSTEM_SEMANTIC_REVIEW_PORT } from "../workflow/validation-session-adapter.ts";
import { settleWorkflowToolEvent } from "../workflow/workflow-tool-events.ts";
import { createWorkRecordCompletedTool } from "../../tools/work-record-completed.ts";
import { dedupeTicketReferencesByUrl } from "../ticket-references.ts";
import { readPlanDeviations, renderPlanDeviationsForWorkRecord } from "../plan-deviations.ts";
import { runPlanFrontMatterTransition } from "../workflow/state-transition.ts";
import { buildWorkRecordFileName, deleteWorkRecord, listWorkRecords, writeWorkRecord } from "./store.ts";
import { syncWorkRecordToIndex } from "./index-adapter.ts";
import { applyWorkRecordSupersession, WorkRecordSupersessionRollbackError } from "./supersession.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DEFAULT_CLOSURE_REASON = "Reason not specified.";
const SKIPPED_VERIFICATION_TEXT = "RunWield Workflow Validation was skipped";
const DONE_ENOUGH_TEXT = "The Epic was closed as done enough.";
const USER_VERIFIED_TEXT = "The user attested verification; RunWield Workflow Validation did not establish this result";

type GeneratedWorkRecordScope = Extract<WorkRecordScope, "planned_change" | "epic">;

export interface WorkRecordSource {
    /** Explicit artifact preparation, never ordinary backfill eligibility. */
    pendingPublication?: boolean;
    sourceKind: "active" | "archived";
    name: string;
    relativePath: string;
    path: string;
    planId: string;

    /** Expected local document revision when recording a published source. */
    documentRevision?: string;
    attrs: PlanFrontMatter;
    planDeviations?: PlanDeviation[];
    body: string;
    markdown: string;
    scope?: GeneratedWorkRecordScope;
    completionMode?: WorkRecordCompletionMode;
    closureReason?: string;
    executionReport?: string;
    children?: WorkRecordSource[];
    skipReason?: string;
    existingRecord?: WorkRecordResource;
}

export interface GeneratedWorkRecordSections extends Pick<WorkRecordSections, "title" | "summary"> {
    outOfScope?: string;
    futurePlanningNotes?: string;
    supersessionProposals?: WorkRecordSupersessionCandidate[];
}

export interface GenerationOptions {
    /** Cancellation of the recording operation. */
    signal?: AbortSignal;
    idGenerator?: () => string;
    now?: () => Date;
    runRecorderStep?: (prompt: string) => Promise<GeneratedWorkRecordSections>;
    mnemotecaPort?: WorkRecordMnemotecaPort;
}

export interface WorkRecordGenerationOptions extends GenerationOptions {
    mnemotecaPort: WorkRecordMnemotecaPort;
}

interface WorkRecordBackfillPreview {
    sources: WorkRecordSource[];
    eligible: WorkRecordSource[];
    skipped: WorkRecordSource[];
}

export interface WorkRecordGenerationOutcome {
    source: WorkRecordSource;
    status: "generated" | "linked" | "failed";
    recordId?: string;
    path?: string;
    error?: string;
    indexWarning?: string;
    supersessionProposals?: WorkRecordSupersessionCandidate[];
}

export interface BackfillResult extends WorkRecordBackfillPreview {
    outcomes: WorkRecordGenerationOutcome[];
}

type ActiveWorkRecordPlan = Pick<PlanTextLoaded, "path" | "markdown" | "attrs" | "body">;
type WorkRecordsBySourcePlanId = Map<string, WorkRecordResource[]>;
type RecorderInputFields = Record<string, unknown>;
type RecorderProposalFields = Partial<Record<keyof WorkRecordSupersessionCandidate, unknown>>;

function iso(date: Date) {
    return date.toISOString();
}

function nonEmptyString(value: string | null | undefined) {
    return typeof value === "string" && value.trim() ? value.trim() : "";
}

function conciseError(value: unknown) {
    const message = value instanceof Error ? value.message : String(value || "Unknown Work Record generation failure.");
    const normalized = message.replace(/\s+/g, " ").trim();
    if (value instanceof WorkRecordSupersessionRollbackError) return normalized;
    return normalized.slice(0, 240) || "Unknown Work Record generation failure.";
}

function optionalTrimmedString(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseJsonObjectFromText(text: string): unknown {
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

function normalizeSupersessionProposals(value: unknown): WorkRecordSupersessionCandidate[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new Error("Recorder supersessionProposals must be an array.");
    const candidates = [];
    const seen = new Set();
    for (const item of value) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new Error("Each Recorder supersession proposal must be an object.");
        }
        const candidate = item as RecorderProposalFields;
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

// Recorder submissions cross the model boundary and need runtime shape checks.
export function normalizeRecorderOutput(value: unknown): GeneratedWorkRecordSections {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Recorder output must be a JSON object.");
    }
    const record = value as RecorderInputFields;
    for (const key of Object.keys(record)) {
        if (
            ![
                "title",
                "summary",
                "deviationsFromPlan",
                "deferredWork",
                "outOfScope",
                "futurePlanningNotes",
                "supersessionProposals",
            ].includes(key)
        ) {
            throw new Error(`Recorder output field is not supported: ${key}.`);
        }
        if (key !== "supersessionProposals" && typeof record[key] !== "string") {
            throw new Error(`Recorder output ${key} must be text.`);
        }
    }
    const title = optionalTrimmedString(record.title);
    const summary = optionalTrimmedString(record.summary);
    if (!title) throw new Error("Recorder output requires a non-empty title.");
    if (!summary) throw new Error("Recorder output requires a non-empty summary.");
    const supersessionProposals = normalizeSupersessionProposals(record.supersessionProposals);
    return {
        title,
        summary,
        ...(optionalTrimmedString(record.outOfScope) ? { outOfScope: optionalTrimmedString(record.outOfScope) } : {}),
        ...(optionalTrimmedString(record.futurePlanningNotes)
            ? { futurePlanningNotes: optionalTrimmedString(record.futurePlanningNotes) }
            : {}),
        ...(supersessionProposals ? { supersessionProposals } : {}),
    };
}

export function parseRecorderSections(text: string): GeneratedWorkRecordSections {
    return normalizeRecorderOutput(parseJsonObjectFromText(text));
}

export function deriveWorkRecordCompletionMode(source: WorkRecordSource): WorkRecordCompletionMode | "" {
    if (isProjectPlan(source.attrs) && source.attrs.epicCompletionMode === "done_enough") return "done_enough";
    if (source.attrs.status === "closed_without_verification") return "closed_without_verification";
    if (source.attrs.status === "user_verified") return "user_verified";
    if (
        source.attrs.status === "validated" ||
        source.attrs.status === "verified" ||
        (source.pendingPublication && source.attrs.status === "reviewed")
    )
        return "verified";
    return "";
}

export function deriveWorkRecordScope(source: WorkRecordSource): GeneratedWorkRecordScope | "" {
    if (isProjectPlan(source.attrs)) return "epic";
    if (isPlannedChangeClassification(source.attrs.classification) && !isChildFeaturePlan(source)) {
        return "planned_change";
    }
    return "";
}

export function recordsBySourcePlanId(records: WorkRecordResource[]): WorkRecordsBySourcePlanId {
    const map: WorkRecordsBySourcePlanId = new Map();
    for (const record of records) {
        for (const planId of record.attrs.provenance?.sourcePlans || []) {
            const existing = map.get(planId) || [];
            existing.push(record);
            map.set(planId, existing);
        }
    }
    return map;
}

function findLinkableExistingRecord(source: WorkRecordSource, existingByPlanId: WorkRecordsBySourcePlanId) {
    const candidates = source.planId ? existingByPlanId.get(source.planId) || [] : [];
    return candidates.find(
        (record) =>
            (record.attrs.status === "approved" ||
                (source.pendingPublication && record.attrs.status === "pending_verification")) &&
            record.attrs.origin === "internal" &&
            record.attrs.scope === source.scope &&
            record.attrs.completionMode === source.completionMode &&
            !record.attrs.archivedAt &&
            !record.attrs.supersededBy,
    );
}

export function evaluateWorkRecordSource(
    source: WorkRecordSource,
    existingByPlanId: WorkRecordsBySourcePlanId = new Map(),
): WorkRecordSource {
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
        closureReason:
            completionMode === "closed_without_verification"
                ? nonEmptyString(source.attrs.closedWithoutVerificationReason) || DEFAULT_CLOSURE_REASON
                : undefined,
        ...(existingRecord ? { existingRecord } : {}),
    };
}

export async function discoverWorkRecordSources(cwd: string): Promise<WorkRecordSource[]> {
    const sources: WorkRecordSource[] = [];
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

export function buildActiveWorkRecordSource(name: string, loaded: ActiveWorkRecordPlan): WorkRecordSource {
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

export function attachEpicChildren(sources: WorkRecordSource[]): WorkRecordSource[] {
    return sources.map((source) => {
        if (!isProjectPlan(source.attrs)) return source;
        const children = sources
            .filter(
                (candidate) =>
                    isPlannedChangeClassification(candidate.attrs.classification) &&
                    candidate.attrs.parentPlan === source.name,
            )
            .sort(compareChildPlansByOrder);
        return { ...source, children };
    });
}

export async function previewWorkRecordBackfill(cwd: string): Promise<WorkRecordBackfillPreview> {
    const existingByPlanId = recordsBySourcePlanId(await listWorkRecords(cwd, { createDir: false }));
    const sources = attachEpicChildren(await discoverWorkRecordSources(cwd)).map((source) =>
        evaluateWorkRecordSource(source, existingByPlanId),
    );
    return {
        sources,
        eligible: sources.filter((source) => !source.skipReason),
        skipped: sources.filter((source) => source.skipReason),
    };
}

async function updateSourceFrontMatter(cwd: string, source: WorkRecordSource, updates: Partial<PlanFrontMatter>) {
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
    return transition.value;
}

async function ensureSourcePlanId(
    cwd: string,
    source: WorkRecordSource,
    options: WorkRecordGenerationOptions,
): Promise<WorkRecordSource> {
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

function declaredSupersessionIds(source: WorkRecordSource) {
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
 */
async function validateDeclaredSupersession(cwd: string, successorRecordId: string, predecessorRecordIds: string[]) {
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
 */
export async function validateRecorderProposals(
    cwd: string,
    successorRecordId: string,
    candidates: WorkRecordSupersessionCandidate[],
) {
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

function buildRecorderPrompt(source: WorkRecordSource, successorRecordId: string, settledSupersedes: string[]) {
    return JSON.stringify(
        {
            successorRecordId,
            settledSupersedes,
            source: {
                name: source.name,
                path: source.relativePath,
                planId: source.planId,
                scope: source.scope,
                completionMode: source.completionMode,
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

export async function generateRecorderSections(
    cwd: string,
    source: WorkRecordSource,
    options: GenerationOptions = {},
    successorRecordId: string = crypto.randomUUID(),
    settledSupersedes: string[] = [],
): Promise<GeneratedWorkRecordSections> {
    const prompt = buildRecorderPrompt(source, successorRecordId, settledSupersedes);
    if (options.runRecorderStep) return normalizeRecorderOutput(await options.runRecorderStep(prompt));
    const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd });
    const sessionManager = SessionManager.inMemory(cwd);
    try {
        for (let attempt = 1; attempt <= 2; attempt++) {
            const { event, messages } = await runValidationAgentUntilEvent(
                SYSTEM_SEMANTIC_REVIEW_PORT,
                {
                    hostedSession,
                    signal: options.signal,
                    cwd,
                    agentName: AGENTS.RECORDER,
                    userRequest:
                        attempt === 1
                            ? prompt
                            : "No work_record_completed submission was accepted. Use the source already provided to call " +
                              "work_record_completed now. Correct any rejected arguments; do not return JSON as text.",
                    sessionManager,
                    customTools: [createWorkRecordCompletedTool(hostedSession)],
                    includeEditFallback: false,
                },
                "work_record_completed",
            );
            if (event) {
                const sections = normalizeRecorderOutput(event.payload);
                settleWorkflowToolEvent(hostedSession, event);
                return sections;
            }
            const lastAssistant = messages.findLast((message) => message.role === "assistant");
            // Keep only protocol metadata, never provider text or private reasoning.
            const stopped = lastAssistant?.role === "assistant" ? lastAssistant.stopReason : undefined;
            const diagnostic =
                stopped === "error" || stopped === "aborted" || stopped === "length"
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

function prepareGeneratedSections(source: WorkRecordSource, sections: GeneratedWorkRecordSections) {
    const normalized = normalizeRecorderOutput(sections);
    if (source.completionMode === "user_verified") {
        const note =
            nonEmptyString(source.attrs.userVerificationNote)
                .replace(/[\u2500-\u257f]/g, "")
                .replace(/\s+/g, " ")
                .trim() || DEFAULT_CLOSURE_REASON;
        const summaryParts = [];
        if (!normalized.summary.includes(USER_VERIFIED_TEXT)) summaryParts.push(`${USER_VERIFIED_TEXT}.`);
        if (!normalized.summary.includes(note)) summaryParts.push(`User verification note: ${note}`);
        return { ...normalized, summary: [...summaryParts, normalized.summary].join(" ").trim() };
    }
    if (source.completionMode === "done_enough" && !normalized.summary.includes(DONE_ENOUGH_TEXT)) {
        return { ...normalized, summary: `${DONE_ENOUGH_TEXT} ${normalized.summary}` };
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

export function aggregateWorkRecordTickets(source: WorkRecordSource) {
    if (source.scope === "epic") {
        return dedupeTicketReferencesByUrl(
            source.attrs.tickets,
            ...(source.children || []).sort(compareChildPlansByOrder).map((child) => child.attrs.tickets),
        );
    }
    return dedupeTicketReferencesByUrl(source.attrs.tickets);
}

function aggregatePlanDeviations(source: WorkRecordSource) {
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
 */
export function extractWorkRecordRequirements(body: string) {
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

function buildBody(source: WorkRecordSource, sections: GeneratedWorkRecordSections) {
    const normalized = prepareGeneratedSections(source, sections);
    const lines = [`# ${normalized.title}`, "", "## Summary", "", normalized.summary];
    sections = normalized;
    const deviationText = renderPlanDeviationsForWorkRecord(aggregatePlanDeviations(source));
    if (deviationText) lines.push("", "## Deviations from Plan", "", deviationText);
    if (nonEmptyString(sections.outOfScope)) {
        lines.push("", "## Out of Scope", "", nonEmptyString(sections.outOfScope));
    }
    if (nonEmptyString(sections.futurePlanningNotes)) {
        lines.push("", "## Future Planning Notes", "", nonEmptyString(sections.futurePlanningNotes));
    }
    const requiredNotes = extractWorkRecordRequirements(source.body);
    if (requiredNotes) lines.push("", "## Required Record Notes", "", requiredNotes);
    return lines.join("\n");
}

async function linkSourceToRecord(cwd: string, source: WorkRecordSource, record: WorkRecordResource, now: Date) {
    await updateSourceFrontMatter(cwd, source, {
        workRecord: {
            status: "generated",
            recordId: record.attrs.recordId,
            path: record.relativePath,
            lastAttemptAt: iso(now),
        },
    });
}

async function bestEffortSyncGeneratedRecord(
    cwd: string,
    record: WorkRecordResource,
    options: WorkRecordGenerationOptions,
) {
    try {
        await syncWorkRecordToIndex(cwd, record, {
            mnemotecaPort: options.mnemotecaPort,
        });
        return "";
    } catch (error) {
        return `Work Record index sync failed for ${record.attrs.recordId}: ${conciseError(
            error,
        )} Run wld wr index rebuild.`;
    }
}

async function recordGenerationFailure(cwd: string, source: WorkRecordSource, now: Date, error: unknown) {
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

function pendingSupersessionCandidates(record: WorkRecordResource) {
    return record.attrs.supersessionProposal?.candidates || [];
}

export async function generateWorkRecordForSource(
    cwd: string,
    inputSource: WorkRecordSource,
    options: WorkRecordGenerationOptions,
): Promise<WorkRecordGenerationOutcome> {
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
                record =
                    applied.records.find((candidate) => candidate.attrs.recordId === record.attrs.recordId) || record;
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

        const recordId =
            source.attrs.validationCheckpoint?.hostRecorder?.recordId ||
            (options.idGenerator ? options.idGenerator() : crypto.randomUUID());
        declaredIds = await validateDeclaredSupersession(cwd, recordId, declaredIds);
        const sections = await generateRecorderSections(cwd, source, options, recordId, declaredIds);
        const declaredIdentities = new Set(declaredIds.map((id) => id.toLowerCase()));
        const undeclaredProposals = (sections.supersessionProposals || []).filter(
            (candidate) => !declaredIdentities.has(candidate.recordId.toLowerCase()),
        );
        const supersessionProposals = await validateRecorderProposals(cwd, recordId, undeclaredProposals);

        // A source without a scope or completion mode was rejected above.
        const attrs: WorkRecordFrontMatter = {
            kind: "work_record",
            recordId,
            status: source.pendingPublication ? "pending_verification" : "approved",
            scope: source.scope!,
            workKind: source.attrs.workKind,
            origin: "internal",
            completionMode: source.completionMode!,
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
                        `${conciseError(error)} Generated Work Record cleanup also failed: ${conciseError(
                            cleanupError,
                        )}`,
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
        if (error instanceof ValidationHostWait || error instanceof ValidationHostRejected) throw error;
        await recordGenerationFailure(cwd, source, now, error);
        return { source, status: "failed", error: conciseError(error) };
    }
}

export async function runWorkRecordBackfill(
    cwd: string,
    options: WorkRecordGenerationOptions,
): Promise<BackfillResult> {
    const preview = await previewWorkRecordBackfill(cwd);

    const outcomes: WorkRecordGenerationOutcome[] = [];
    for (const source of preview.eligible) {
        outcomes.push(await generateWorkRecordForSource(cwd, source, options));
    }
    return { ...preview, outcomes };
}

export function formatWorkRecordBackfillPreview(result: WorkRecordBackfillPreview | BackfillResult) {
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
    }, new Map<string, number>());
    if (skipCounts.size) {
        lines.push("", "Skipped sources:");
        for (const [reason, count] of skipCounts) lines.push(`  - ${reason}: ${count}`);
    }
    return lines.join("\n");
}

export function formatWorkRecordBackfillOutcomes(outcomes: WorkRecordGenerationOutcome[]) {
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
