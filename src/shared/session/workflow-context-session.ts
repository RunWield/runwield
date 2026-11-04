/**
 * @module shared/session/workflow-context-session
 *
 * Persists RunWield workflow footer context in Pi's append-only session stream.
 */

import { COMPLEXITIES, normalizeRoutingIntent } from "../../constants.js";

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SegmentHandoffPayload } from "../workflow/execution-segment-handoff.ts";
import type { RuntimeValidationProgress } from "./session-runtime-events.js";
import type { WorkflowProgressFact } from "../workflow/workflow-presentation.ts";
import type { SessionSegmentLineageEvidence } from "../types.js";

export interface LineageSessionManager {
    appendCustomEntry?: (customType: string, data: SessionSegmentLineageEvidence) => string | void;
    getBranch?: () => unknown[];
    getEntries?: () => unknown[];
}

export type WorkflowContext = {
    routingIntent?: string;
    complexity?: string;
    summary?: string;
    planName?: string;
    parentPlan?: string;
    planId?: string;
    status?: string;
    classification?: string;
    progressFacts?: WorkflowProgressFact[];
    validationProgress?: RuntimeValidationProgress;
    canRun?: boolean;
    canResume?: boolean;
    canRecover?: boolean;
    liveQuestion?: boolean;
    livePlanReview?: boolean;
    liveCodeReview?: boolean;
    liveReviewUrl?: string;
};

export interface WorkflowContextTriageMeta {
    routingIntent?: string;
    classification?: string;
    complexity?: string;
    parentPlan?: string;
    planId?: string;
    status?: string;
    validationCheckpoint?: unknown;
    publication?: unknown;
    worktreeStatus?: string | null;
}

export interface WorkflowContextInput {
    planName?: string | null;
    triageMeta?: WorkflowContextTriageMeta | null;
}

export interface WorkflowTriageContextDetails {
    routingIntent: unknown;
    complexity: unknown;
    summary?: unknown;
}

export interface PersistedSessionEntrySummary {
    type?: string;
    role?: string;
    customType?: string;
}

export interface PendingSegmentContinuationEntry {
    payload: SegmentHandoffPayload;
    entryIndex: number;
    entries: PersistedSessionEntrySummary[];
}

interface RawWorkflowContext {
    routingIntent?: unknown;
    complexity?: unknown;
    planName?: unknown;
    parentPlan?: unknown;
    summary?: unknown;
    planId?: unknown;
    status?: unknown;
    classification?: unknown;
    progressFacts?: unknown;
    validationProgress?: unknown;
    canRun?: unknown;
    canResume?: unknown;
    canRecover?: unknown;
}

interface RawWorkflowValidationCheckpoint {
    nextPhase?: unknown;
    state?: unknown;
    repairKind?: unknown;
    updatedAt?: unknown;
}

interface RawWorkflowPublication {
    phase?: unknown;
    failure?: unknown;
    updatedAt?: unknown;
}

interface PersistedCustomSessionEntry extends PersistedSessionEntrySummary {
    data?: unknown;
}

interface PersistedLineageEntry extends PersistedCustomSessionEntry {
    data?: SessionSegmentLineageEvidence;
}

interface PersistedContinuationEntry extends PersistedCustomSessionEntry {
    data?: SegmentHandoffPayload;
}

export const WORKFLOW_CONTEXT_CUSTOM_TYPE = "runwield.workflow_context";
export const SEGMENT_LINEAGE_CUSTOM_TYPE = "runwield.segment_lineage";
export const PENDING_SEGMENT_CONTINUATION_CUSTOM_TYPE = "runwield.pending_segment_continuation";

export function normalizeWorkflowRoutingIntent(value: unknown): string {
    if (typeof value !== "string") return "";
    const normalized = normalizeRoutingIntent(value.trim().toUpperCase());
    return normalized || "";
}

export function normalizeWorkflowComplexity(value: unknown): string {
    if (typeof value !== "string") return "";
    const normalized = value.trim().toUpperCase();
    return COMPLEXITIES.includes(normalized) ? normalized : "";
}

export function normalizeWorkflowPlanName(value: unknown): string {
    if (typeof value !== "string") return "";
    return value
        .trim()
        .replace(/^docs\/plans\//i, "")
        .replace(/\.md$/i, "")
        .replace(/^\/+/, "")
        .trim();
}

function progressFactsFromTriageMeta(triageMeta: WorkflowContextTriageMeta | null): WorkflowProgressFact[] {
    if (!triageMeta) return [];

    const facts: WorkflowProgressFact[] = [];
    const checkpoint = triageMeta.validationCheckpoint;
    if (checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint)) {
        const source = checkpoint as RawWorkflowValidationCheckpoint;
        facts.push({
            kind: "validation_checkpoint",
            phase: typeof source.nextPhase === "string" ? source.nextPhase : null,
            state: typeof source.state === "string" ? source.state : null,
            repairKind: typeof source.repairKind === "string" ? source.repairKind : null,
            updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null,
        });
    }
    const publication = triageMeta.publication;
    if (publication && typeof publication === "object" && !Array.isArray(publication)) {
        const source = publication as RawWorkflowPublication;
        facts.push({
            kind: "publication",
            phase: typeof source.phase === "string" ? source.phase : null,
            failure: Boolean(source.failure),
            updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null,
        });
    }
    const worktreeStatus = typeof triageMeta.worktreeStatus === "string" ? triageMeta.worktreeStatus : "";
    if (worktreeStatus) facts.push({ kind: "registry", status: worktreeStatus });
    return facts;
}

export function normalizeWorkflowContext(value: unknown): WorkflowContext | null {
    if (!value || typeof value !== "object") return null;
    const data = value as RawWorkflowContext;
    const routingIntent = normalizeWorkflowRoutingIntent(data.routingIntent);
    const complexity = normalizeWorkflowComplexity(data.complexity);
    const planName = normalizeWorkflowPlanName(data.planName);
    const parentPlan = normalizeWorkflowPlanName(data.parentPlan);

    const context: WorkflowContext = {};
    if (routingIntent && complexity) {
        context.routingIntent = routingIntent;
        context.complexity = complexity;
        if (typeof data.summary === "string" && data.summary.trim()) context.summary = data.summary.trim();
    }
    if (planName) context.planName = planName;
    if (parentPlan) context.parentPlan = parentPlan;
    if (typeof data.planId === "string" && data.planId.trim()) context.planId = data.planId.trim();
    if (typeof data.status === "string" && data.status.trim()) context.status = data.status.trim();
    if (typeof data.classification === "string" && data.classification.trim()) {
        context.classification = data.classification.trim();
    }
    if (Array.isArray(data.progressFacts)) {
        context.progressFacts = data.progressFacts
            .filter((fact) => fact && typeof fact === "object")
            .map((fact) => ({ ...fact }));
    }
    if (data.validationProgress && typeof data.validationProgress === "object") {
        context.validationProgress = structuredClone(data.validationProgress as RuntimeValidationProgress);
    }
    if (typeof data.canRun === "boolean") context.canRun = data.canRun;
    if (typeof data.canResume === "boolean") context.canResume = data.canResume;
    if (typeof data.canRecover === "boolean") context.canRecover = data.canRecover;

    return Object.keys(context).length > 0 ? context : null;
}

export function recordWorkflowTriageContext(
    sessionManager: SessionManager | undefined | null,
    details: WorkflowTriageContextDetails,
): WorkflowContext | null {
    const routingIntent = normalizeWorkflowRoutingIntent(details.routingIntent);
    const complexity = normalizeWorkflowComplexity(details.complexity);
    if (!routingIntent || !complexity) return readPersistedWorkflowContext(sessionManager);
    return recordWorkflowContext(sessionManager, {
        routingIntent,
        complexity,
        summary: typeof details.summary === "string" ? details.summary.trim() : undefined,
    });
}

export function recordWorkflowPlanName(
    sessionManager: SessionManager | undefined | null,
    planName: unknown,
): WorkflowContext | null {
    const normalizedPlanName = normalizeWorkflowPlanName(planName);
    if (!normalizedPlanName) return readPersistedWorkflowContext(sessionManager);
    try {
        const latest = readPersistedWorkflowContext(sessionManager) || {};
        const next = { ...latest, planName: normalizedPlanName };
        if (latest.planName !== normalizedPlanName) delete next.validationProgress;
        return recordNormalizedWorkflowContext(sessionManager, next);
    } catch (_e) {
        // Workflow-context persistence should never block planning.
        return { planName: normalizedPlanName };
    }
}

export function deriveWorkflowContextFromExecutionWorkflow(
    workflow: WorkflowContextInput | null | undefined,
    planName?: unknown,
): WorkflowContext | null {
    const triageMeta = workflow?.triageMeta && typeof workflow.triageMeta === "object" ? workflow.triageMeta : null;
    const routingIntent =
        normalizeWorkflowRoutingIntent(triageMeta?.routingIntent) ||
        normalizeWorkflowRoutingIntent(triageMeta?.classification);
    const complexity = normalizeWorkflowComplexity(triageMeta?.complexity);
    const normalizedPlanName = normalizeWorkflowPlanName(workflow?.planName || planName);
    const parentPlan = normalizeWorkflowPlanName(triageMeta?.parentPlan);

    const context: WorkflowContext = {};
    if (routingIntent && complexity) {
        context.routingIntent = routingIntent;
        context.complexity = complexity;
    }
    if (normalizedPlanName) context.planName = normalizedPlanName;
    if (parentPlan) context.parentPlan = parentPlan;
    if (typeof triageMeta?.planId === "string" && triageMeta.planId.trim()) context.planId = triageMeta.planId.trim();
    if (typeof triageMeta?.status === "string" && triageMeta.status.trim()) context.status = triageMeta.status.trim();
    const progressFacts = progressFactsFromTriageMeta(triageMeta);
    if (progressFacts.length) context.progressFacts = progressFacts;

    return Object.keys(context).length > 0 ? context : null;
}

export function recordNormalizedWorkflowContext(
    sessionManager: SessionManager | undefined | null,
    context: WorkflowContext | null | undefined,
): WorkflowContext | null {
    const normalized = normalizeWorkflowContext(context);
    if (!normalized) return readPersistedWorkflowContext(sessionManager);
    if (!sessionManager?.appendCustomEntry) return normalized;

    try {
        const latest = readPersistedWorkflowContext(sessionManager);
        if (workflowContextsEqual(latest, normalized)) return latest;
        sessionManager.appendCustomEntry(WORKFLOW_CONTEXT_CUSTOM_TYPE, normalized);
    } catch (_e) {
        // Workflow-context persistence should never block routing, planning, or execution.
    }

    return normalized;
}

export function readPersistedWorkflowContext(
    sessionManager: SessionManager | undefined | null,
): WorkflowContext | null {
    try {
        const entries = getSessionEntries(sessionManager);

        for (let i = entries.length - 1; i >= 0; i--) {
            const context = readWorkflowContextFromEntry(entries[i]);
            if (context) return context;
        }
    } catch (_e) {
        // Older or partially available SessionManagers may fail reads; footer
        // context should simply be absent in that case.
    }

    return null;
}

function recordWorkflowContext(
    sessionManager: SessionManager | undefined | null,
    context: WorkflowContext,
): WorkflowContext | null {
    return recordNormalizedWorkflowContext(sessionManager, context);
}

export function recordSegmentLineageEvidence(
    sessionManager: LineageSessionManager | undefined | null,
    lineage: SessionSegmentLineageEvidence,
): SessionSegmentLineageEvidence | null {
    const normalized = normalizeSegmentLineageEvidence(lineage);
    if (!normalized) return readPersistedSegmentLineageEvidence(sessionManager);
    if (!sessionManager?.appendCustomEntry) return normalized;
    try {
        const existing = readPersistedSegmentLineageEvidence(sessionManager);
        if (
            existing?.segmentId === normalized.segmentId &&
            existing.runwieldSessionId === normalized.runwieldSessionId &&
            existing.parentSegmentId === normalized.parentSegmentId &&
            existing.parentPiSessionId === normalized.parentPiSessionId &&
            existing.lineageGroupKey === normalized.lineageGroupKey &&
            existing.kind === normalized.kind
        )
            return existing;
        sessionManager.appendCustomEntry(SEGMENT_LINEAGE_CUSTOM_TYPE, normalized);
    } catch (_e) {
        return normalized;
    }
    return normalized;
}

export function readPersistedSegmentLineageEvidence(
    sessionManager: LineageSessionManager | undefined | null,
): SessionSegmentLineageEvidence | null {
    try {
        const entries = getSessionEntries(sessionManager);
        for (let i = entries.length - 1; i >= 0; i--) {
            const lineage = readSegmentLineageFromEntry(entries[i]);
            if (lineage) return lineage;
        }
    } catch (_e) {
        // Private segment lineage should never block Session construction.
    }
    return null;
}

export function recordPendingSegmentContinuation(
    sessionManager: SessionManager | undefined | null,
    payload: SegmentHandoffPayload,
): SegmentHandoffPayload {
    if (!sessionManager?.appendCustomEntry) return payload;
    try {
        sessionManager.appendCustomEntry(PENDING_SEGMENT_CONTINUATION_CUSTOM_TYPE, payload);
    } catch (_e) {
        return payload;
    }
    return payload;
}

export function readPersistedPendingSegmentContinuation(
    sessionManager: SessionManager | undefined | null,
): SegmentHandoffPayload | null {
    return readPersistedPendingSegmentContinuationEntry(sessionManager)?.payload ?? null;
}

export function readPersistedPendingSegmentContinuationEntry(
    sessionManager: SessionManager | undefined | null,
): PendingSegmentContinuationEntry | null {
    try {
        const entries = getSessionEntries(sessionManager);
        for (let i = entries.length - 1; i >= 0; i--) {
            const continuation = readPendingSegmentContinuationFromEntry(entries[i]);
            if (continuation !== undefined) {
                return {
                    payload: continuation,
                    entryIndex: i,
                    entries: entries.map((entry) => {
                        const item = (entry || {}) as PersistedSessionEntrySummary;
                        return { type: item.type, role: item.role, customType: item.customType };
                    }),
                };
            }
        }
    } catch (_e) {
        // Pending continuation should never block Session construction.
    }
    return null;
}

export function normalizeSegmentLineageEvidence(
    lineage: SessionSegmentLineageEvidence | null | undefined,
): SessionSegmentLineageEvidence | null {
    if (!lineage || typeof lineage !== "object") return null;
    const segmentId = typeof lineage.segmentId === "string" ? lineage.segmentId.trim() : "";
    const runwieldSessionId = typeof lineage.runwieldSessionId === "string" ? lineage.runwieldSessionId.trim() : "";
    if (!segmentId || !runwieldSessionId) return null;
    return {
        segmentId,
        runwieldSessionId,
        parentSegmentId:
            typeof lineage.parentSegmentId === "string" && lineage.parentSegmentId.trim()
                ? lineage.parentSegmentId.trim()
                : null,
        parentPiSessionId:
            typeof lineage.parentPiSessionId === "string" && lineage.parentPiSessionId.trim()
                ? lineage.parentPiSessionId.trim()
                : null,
        lineageGroupKey:
            typeof lineage.lineageGroupKey === "string" && lineage.lineageGroupKey.trim()
                ? lineage.lineageGroupKey.trim()
                : null,
        kind:
            typeof lineage.kind === "string" && ["planning", "execution", "semantic_repair"].includes(lineage.kind)
                ? lineage.kind
                : undefined,
    };
}

export function workflowContextsEqual(left: WorkflowContext | null, right: WorkflowContext | null): boolean {
    return (
        (left?.routingIntent || "") === (right?.routingIntent || "") &&
        (left?.complexity || "") === (right?.complexity || "") &&
        (left?.summary || "") === (right?.summary || "") &&
        (left?.planName || "") === (right?.planName || "") &&
        (left?.parentPlan || "") === (right?.parentPlan || "") &&
        (left?.planId || "") === (right?.planId || "") &&
        (left?.status || "") === (right?.status || "") &&
        (left?.classification || "") === (right?.classification || "") &&
        Boolean(left?.canRun) === Boolean(right?.canRun) &&
        Boolean(left?.canResume) === Boolean(right?.canResume) &&
        Boolean(left?.canRecover) === Boolean(right?.canRecover) &&
        JSON.stringify(left?.progressFacts || []) === JSON.stringify(right?.progressFacts || []) &&
        JSON.stringify(left?.validationProgress || null) === JSON.stringify(right?.validationProgress || null)
    );
}

function getSessionEntries(sessionManager: LineageSessionManager | undefined | null): unknown[] {
    const entries = sessionManager?.getBranch?.() || sessionManager?.getEntries?.() || [];
    return Array.isArray(entries) ? entries : [];
}

function readWorkflowContextFromEntry(entry: unknown): WorkflowContext | null {
    if (!entry || typeof entry !== "object") return null;
    if ((entry as PersistedCustomSessionEntry).type !== "custom") return null;
    const customType = (entry as PersistedCustomSessionEntry).customType;
    if (customType !== WORKFLOW_CONTEXT_CUSTOM_TYPE) return null;

    const data = (entry as PersistedCustomSessionEntry).data;
    return normalizeWorkflowContext(data);
}

function readSegmentLineageFromEntry(entry: unknown): SessionSegmentLineageEvidence | null {
    if (!entry || typeof entry !== "object") return null;
    if ((entry as PersistedCustomSessionEntry).type !== "custom") return null;
    const customType = (entry as PersistedCustomSessionEntry).customType;
    if (customType !== SEGMENT_LINEAGE_CUSTOM_TYPE) return null;
    const data = (entry as PersistedLineageEntry).data;
    return normalizeSegmentLineageEvidence(data);
}

function readPendingSegmentContinuationFromEntry(entry: unknown) {
    if (!entry || typeof entry !== "object") return undefined;
    if ((entry as PersistedCustomSessionEntry).type !== "custom") return undefined;
    const customType = (entry as PersistedCustomSessionEntry).customType;
    if (customType !== PENDING_SEGMENT_CONTINUATION_CUSTOM_TYPE) return undefined;
    return (entry as PersistedContinuationEntry).data;
}
