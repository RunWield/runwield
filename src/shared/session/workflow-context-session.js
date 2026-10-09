/**
 * @module shared/session/workflow-context-session
 *
 * Persists RunWield workflow footer context in Pi's append-only session stream.
 */

import { COMPLEXITIES, normalizeRoutingIntent } from "../../constants.js";

export const WORKFLOW_CONTEXT_CUSTOM_TYPE = "runwield.workflow_context";
export const SEGMENT_LINEAGE_CUSTOM_TYPE = "runwield.segment_lineage";
export const PENDING_SEGMENT_CONTINUATION_CUSTOM_TYPE = "runwield.pending_segment_continuation";

/** @typedef {import('../workflow/execution-segment-handoff.ts').SegmentHandoffPayload} SegmentHandoffPayload */
/** @typedef {import('./session-runtime-events.js').RuntimeValidationProgress} RuntimeValidationProgress */

/**
 * @typedef {Object} LineageSessionManager
 * @property {(customType: string, data: import('../types.js').SessionSegmentLineageEvidence) => string | void} [appendCustomEntry]
 * @property {() => unknown[]} [getBranch]
 * @property {() => unknown[]} [getEntries]
 */

/**
 * @typedef {Object} WorkflowContext
 * @property {string} [routingIntent]
 * @property {string} [complexity]
 * @property {string} [summary]
 * @property {string} [planName]
 * @property {string} [parentPlan]
 * @property {string} [planId]
 * @property {string} [status]
 * @property {string} [classification]
 * @property {Array<import('../workflow/workflow-presentation.ts').WorkflowProgressFact>} [progressFacts]
 * @property {import('./session-runtime-events.js').RuntimeValidationProgress} [validationProgress]
 * @property {boolean} [canRun]
 * @property {boolean} [canResume]
 * @property {boolean} [canRecover]
 * @property {boolean} [liveQuestion]
 * @property {boolean} [livePlanReview]
 * @property {boolean} [liveCodeReview]
 * @property {string} [liveReviewUrl]
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeWorkflowRoutingIntent(value) {
    if (typeof value !== "string") return "";
    const normalized = normalizeRoutingIntent(value.trim().toUpperCase());
    return normalized || "";
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeWorkflowComplexity(value) {
    if (typeof value !== "string") return "";
    const normalized = value.trim().toUpperCase();
    return COMPLEXITIES.includes(normalized) ? normalized : "";
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeWorkflowPlanName(value) {
    if (typeof value !== "string") return "";
    return value
        .trim()
        .replace(/^docs\/plans\//i, "")
        .replace(/\.md$/i, "")
        .replace(/^\/+/, "")
        .trim();
}

/**
 * @param {Record<string, unknown> | null} triageMeta
 * @returns {Array<import('../workflow/workflow-presentation.ts').WorkflowProgressFact>}
 */
function progressFactsFromTriageMeta(triageMeta) {
    if (!triageMeta) return [];
    /** @type {Array<import('../workflow/workflow-presentation.ts').WorkflowProgressFact>} */
    const facts = [];
    const checkpoint = triageMeta.validationCheckpoint;
    if (checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint)) {
        const source = /** @type {Record<string, unknown>} */ (checkpoint);
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
        const source = /** @type {Record<string, unknown>} */ (publication);
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

/**
 * @param {unknown} value
 * @returns {WorkflowContext | null}
 */
export function normalizeWorkflowContext(value) {
    if (!value || typeof value !== "object") return null;
    const data = /** @type {Record<string, unknown>} */ (value);
    const routingIntent = normalizeWorkflowRoutingIntent(data.routingIntent);
    const complexity = normalizeWorkflowComplexity(data.complexity);
    const planName = normalizeWorkflowPlanName(data.planName);
    const parentPlan = normalizeWorkflowPlanName(data.parentPlan);

    /** @type {WorkflowContext} */
    const context = {};
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
        context.validationProgress = structuredClone(
            /** @type {RuntimeValidationProgress} */ (data.validationProgress),
        );
    }
    if (typeof data.canRun === "boolean") context.canRun = data.canRun;
    if (typeof data.canResume === "boolean") context.canResume = data.canResume;
    if (typeof data.canRecover === "boolean") context.canRecover = data.canRecover;

    return Object.keys(context).length > 0 ? context : null;
}

/**
 * @param {import('@earendil-works/pi-coding-agent').SessionManager | undefined | null} sessionManager
 * @param {{ routingIntent: unknown, complexity: unknown, summary?: unknown }} details
 * @returns {WorkflowContext | null}
 */
export function recordWorkflowTriageContext(sessionManager, details) {
    const routingIntent = normalizeWorkflowRoutingIntent(details.routingIntent);
    const complexity = normalizeWorkflowComplexity(details.complexity);
    if (!routingIntent || !complexity) return readPersistedWorkflowContext(sessionManager);
    return recordWorkflowContext(sessionManager, {
        routingIntent,
        complexity,
        summary: typeof details.summary === "string" ? details.summary.trim() : undefined,
    });
}

/**
 * @param {import('@earendil-works/pi-coding-agent').SessionManager | undefined | null} sessionManager
 * @param {unknown} planName
 * @returns {WorkflowContext | null}
 */
export function recordWorkflowPlanName(sessionManager, planName) {
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

/**
 * @typedef {Object} WorkflowContextTriageMeta
 * @property {string} [routingIntent]
 * @property {string} [classification]
 * @property {string} [complexity]
 * @property {string} [parentPlan]
 * @property {string} [planId]
 * @property {string} [status]
 * @property {unknown} [validationCheckpoint]
 * @property {unknown} [publication]
 * @property {string|null} [worktreeStatus]
 */

/**
 * @typedef {Object} WorkflowContextInput
 * @property {string | null} [planName]
 * @property {WorkflowContextTriageMeta | null} [triageMeta]
 */

/**
 * @param {WorkflowContextInput | null | undefined} workflow
 * @param {unknown} [planName]
 * @returns {WorkflowContext | null}
 */
export function deriveWorkflowContextFromExecutionWorkflow(workflow, planName) {
    const triageMeta = workflow?.triageMeta && typeof workflow.triageMeta === "object" ? workflow.triageMeta : null;
    const routingIntent = normalizeWorkflowRoutingIntent(triageMeta?.routingIntent) ||
        normalizeWorkflowRoutingIntent(triageMeta?.classification);
    const complexity = normalizeWorkflowComplexity(triageMeta?.complexity);
    const normalizedPlanName = normalizeWorkflowPlanName(workflow?.planName || planName);
    const parentPlan = normalizeWorkflowPlanName(triageMeta?.parentPlan);

    /** @type {WorkflowContext} */
    const context = {};
    if (routingIntent && complexity) {
        context.routingIntent = routingIntent;
        context.complexity = complexity;
    }
    if (normalizedPlanName) context.planName = normalizedPlanName;
    if (parentPlan) context.parentPlan = parentPlan;
    if (typeof triageMeta?.planId === "string" && triageMeta.planId.trim()) context.planId = triageMeta.planId.trim();
    if (typeof triageMeta?.status === "string" && triageMeta.status.trim()) context.status = triageMeta.status.trim();
    const progressFacts = progressFactsFromTriageMeta(/** @type {Record<string, unknown> | null} */ (triageMeta));
    if (progressFacts.length) context.progressFacts = progressFacts;

    return Object.keys(context).length > 0 ? context : null;
}

/**
 * @param {import('@earendil-works/pi-coding-agent').SessionManager | undefined | null} sessionManager
 * @param {WorkflowContext | null | undefined} context
 * @returns {WorkflowContext | null}
 */
export function recordNormalizedWorkflowContext(sessionManager, context) {
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

/**
 * @param {import('@earendil-works/pi-coding-agent').SessionManager | undefined | null} sessionManager
 * @returns {WorkflowContext | null}
 */
export function readPersistedWorkflowContext(sessionManager) {
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

/**
 * @param {import('@earendil-works/pi-coding-agent').SessionManager | undefined | null} sessionManager
 * @param {WorkflowContext} context
 * @returns {WorkflowContext | null}
 */
function recordWorkflowContext(sessionManager, context) {
    return recordNormalizedWorkflowContext(sessionManager, context);
}

/**
 * @param {WorkflowContext | null} left
 * @param {WorkflowContext | null} right
 * @returns {boolean}
 */
/**
 * @param {LineageSessionManager | undefined | null} sessionManager
 * @param {import('../types.js').SessionSegmentLineageEvidence} lineage
 * @returns {import('../types.js').SessionSegmentLineageEvidence | null}
 */
export function recordSegmentLineageEvidence(sessionManager, lineage) {
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
        ) return existing;
        sessionManager.appendCustomEntry(SEGMENT_LINEAGE_CUSTOM_TYPE, normalized);
    } catch (_e) {
        return normalized;
    }
    return normalized;
}

/**
 * @param {LineageSessionManager | undefined | null} sessionManager
 * @returns {import('../types.js').SessionSegmentLineageEvidence | null}
 */
export function readPersistedSegmentLineageEvidence(sessionManager) {
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

/**
 * @param {import('@earendil-works/pi-coding-agent').SessionManager | undefined | null} sessionManager
 * @param {SegmentHandoffPayload} payload
 * @returns {SegmentHandoffPayload}
 */
export function recordPendingSegmentContinuation(sessionManager, payload) {
    if (!sessionManager?.appendCustomEntry) return payload;
    try {
        sessionManager.appendCustomEntry(PENDING_SEGMENT_CONTINUATION_CUSTOM_TYPE, payload);
    } catch (_e) {
        return payload;
    }
    return payload;
}

/**
 * @param {import('@earendil-works/pi-coding-agent').SessionManager | undefined | null} sessionManager
 * @returns {SegmentHandoffPayload | null}
 */
export function readPersistedPendingSegmentContinuation(sessionManager) {
    return readPersistedPendingSegmentContinuationEntry(sessionManager)?.payload ?? null;
}

/**
 * @param {import('@earendil-works/pi-coding-agent').SessionManager | undefined | null} sessionManager
 * @returns {{ payload: SegmentHandoffPayload, entryIndex: number, entries: Array<{ type?: string, role?: string, customType?: string }> } | null}
 */
export function readPersistedPendingSegmentContinuationEntry(sessionManager) {
    try {
        const entries = getSessionEntries(sessionManager);
        for (let i = entries.length - 1; i >= 0; i--) {
            const continuation = readPendingSegmentContinuationFromEntry(entries[i]);
            if (continuation !== undefined) {
                return {
                    payload: continuation,
                    entryIndex: i,
                    entries: entries.map((entry) => {
                        const item = /** @type {{ type?: string, role?: string, customType?: string }} */ (entry || {});
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

/**
 * @param {import('../types.js').SessionSegmentLineageEvidence | null | undefined} lineage
 * @returns {import('../types.js').SessionSegmentLineageEvidence | null}
 */
export function normalizeSegmentLineageEvidence(lineage) {
    if (!lineage || typeof lineage !== "object") return null;
    const segmentId = typeof lineage.segmentId === "string" ? lineage.segmentId.trim() : "";
    const runwieldSessionId = typeof lineage.runwieldSessionId === "string" ? lineage.runwieldSessionId.trim() : "";
    if (!segmentId || !runwieldSessionId) return null;
    return {
        segmentId,
        runwieldSessionId,
        parentSegmentId: typeof lineage.parentSegmentId === "string" && lineage.parentSegmentId.trim()
            ? lineage.parentSegmentId.trim()
            : null,
        parentPiSessionId: typeof lineage.parentPiSessionId === "string" && lineage.parentPiSessionId.trim()
            ? lineage.parentPiSessionId.trim()
            : null,
        lineageGroupKey: typeof lineage.lineageGroupKey === "string" && lineage.lineageGroupKey.trim()
            ? lineage.lineageGroupKey.trim()
            : null,
        kind: typeof lineage.kind === "string" && ["planning", "execution", "semantic_repair"].includes(lineage.kind)
            ? lineage.kind
            : undefined,
    };
}

/**
 * @param {WorkflowContext | null} left
 * @param {WorkflowContext | null} right
 * @returns {boolean}
 */
export function workflowContextsEqual(left, right) {
    return (left?.routingIntent || "") === (right?.routingIntent || "") &&
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
        JSON.stringify(left?.validationProgress || null) === JSON.stringify(right?.validationProgress || null);
}

/**
 * @param {LineageSessionManager | undefined | null} sessionManager
 * @returns {unknown[]}
 */
function getSessionEntries(sessionManager) {
    const entries = sessionManager?.getBranch?.() || sessionManager?.getEntries?.() || [];
    return Array.isArray(entries) ? entries : [];
}

/**
 * @param {unknown} entry
 * @returns {WorkflowContext | null}
 */
function readWorkflowContextFromEntry(entry) {
    if (!entry || typeof entry !== "object") return null;
    if (/** @type {{ type?: string }} */ (entry).type !== "custom") return null;
    const customType = /** @type {{ customType?: string }} */ (entry).customType;
    if (customType !== WORKFLOW_CONTEXT_CUSTOM_TYPE) return null;

    const data = /** @type {{ data?: unknown }} */ (entry).data;
    return normalizeWorkflowContext(data);
}

/**
 * @param {unknown} entry
 * @returns {import('../types.js').SessionSegmentLineageEvidence | null}
 */
function readSegmentLineageFromEntry(entry) {
    if (!entry || typeof entry !== "object") return null;
    if (/** @type {{ type?: string }} */ (entry).type !== "custom") return null;
    const customType = /** @type {{ customType?: string }} */ (entry).customType;
    if (customType !== SEGMENT_LINEAGE_CUSTOM_TYPE) return null;
    const data = /** @type {{ data?: import('../types.js').SessionSegmentLineageEvidence }} */ (entry).data;
    return normalizeSegmentLineageEvidence(data);
}

/** @param {unknown} entry */
function readPendingSegmentContinuationFromEntry(entry) {
    if (!entry || typeof entry !== "object") return undefined;
    if (/** @type {{ type?: string }} */ (entry).type !== "custom") return undefined;
    const customType = /** @type {{ customType?: string }} */ (entry).customType;
    if (customType !== PENDING_SEGMENT_CONTINUATION_CUSTOM_TYPE) return undefined;
    return /** @type {{ data?: SegmentHandoffPayload }} */ (entry).data;
}
