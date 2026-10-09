import { validateSequenceReviewDecision } from "../../../shared/workflow/sequence-review.ts";
import { resolveWorkflowPlanLocation } from "../../../shared/workflow/plan-location.ts";
/* @module ui/workspace/server/session-continuation */

import { mergePlanAssociations } from "../../../shared/session/plan-association.ts";
import { appendLiveSessionEvent } from "../../../shared/session/live-session-events.ts";
import {
    projectLiveSessionInfo,
    readLiveSessionConnection,
    subscribeLiveSessionAttention,
    waitForSessionActivationSettlement,
} from "../../../shared/session/live-session-connection.ts";
import { createHash } from "node:crypto";
import { findPlanEvidenceById } from "../../../plan-store.js";
import {
    clearMascotEnabledCache,
    getMergedCustomSetting,
    getSettingsManager,
    isMascotEnabled,
} from "../../../shared/settings.js";
import {
    applyUserAgentSelection,
    applyUserModelSelection,
    getDefaultUserAgentOption,
    listUserAgentOptions,
    listUserModelOptions,
    requireUserAgentOption,
    requireUserModelOption,
} from "../../../shared/session/user-selection.ts";
import { normalizeBrowserNotificationPolicy } from "../../../shared/session/notification-content.ts";
import { applySharedPlanReviewDecision } from "../../../shared/workflow/plan-review-actions.ts";
import { loadPlanActionEvidence } from "../../../shared/workflow/plan-actions.ts";
import { loadReviewFeedbackImages } from "../../../shared/workflow/review-feedback-images.ts";
import { getWorktreeReviewDiff, WorktreeReviewComparisonError } from "../../../shared/workflow/git-snapshot.ts";
import {
    createSessionRuntime,
    deriveManagedSessionContinuationDecision,
    listPromptTemplates,
    listSkills,
} from "../../../shared/session/session-runtime.ts";
import { getRunWieldSessionDir } from "../../../shared/session/root-session.js";
import { projectAggregateTranscript } from "../../../shared/session/session-transcript-manifest.ts";
import {
    captureTranscriptEvidence,
    getCommittedTranscriptAuthorityFacts,
    summarizeProjectedEntries,
    summarizeResumableTranscript,
    validateExpiredControlTranscriptEvidence,
} from "../../../shared/session/session-transcript-projection.js";
import { requireOwnerProjectRoot, sessionBelongsToOwnerProject } from "./owner-projects.ts";

/** A rejected image submission has not been accepted as an operation. */
export class ImageSubmissionValidationError extends Error {
    /** @param {string} message */
    constructor(message = "Cannot attach image.") {
        super(message);
        this.name = "ImageSubmissionValidationError";
    }
}

/** @typedef {"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"} WorkspaceThinkingLevel */
/** @typedef {{ name: string, firstMessage: string }} SessionListInfo */
/**
 * @typedef {Object} SessionListOptions
 * @property {number} [page]
 * @property {number} [pageSize]
 * @property {boolean} [includeEmpty]
 * @property {boolean} [includeTotal]
 * @property {string} [planId]
 * @property {"active" | "archived" | "all"} [archiveState]
 * @property {string[]} [excludedPlanIds]
 * @property {string[]} [excludedSessionIds]
 */
/** @typedef {{ operationId: string, status: string, runwieldSessionId: string | null, generation: number | null }} CreateSessionResult */
/** @typedef {{ requestHash: string, settled: Promise<void> }} PendingCreateRequest */
/** @typedef {(value?: void | PromiseLike<void>) => void} VoidResolver */
/** @typedef {{ size: number, mtime: number | undefined, ctime: number | undefined, info: SessionListInfo }} SessionListInfoCacheEntry */
/** @type {Map<string, SessionListInfoCacheEntry>} */
const sessionListInfoCache = new Map();

/** @param {unknown} value */
function stableHash(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** @param {unknown} error */
function codeFromError(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not enabled")) return "rollout_disabled";
    if (message.includes("reconcile")) return "reconcile_required";
    if (message.includes("activation")) return "activation_unavailable";
    return "invalid_state";
}

/** @template T @param {T | null} receipt @returns {T} */
function requireReceipt(receipt) {
    if (!receipt) throw new Error("Operation receipt was not created.");
    return receipt;
}

/** @param {{ ok: boolean, events?: unknown[], segments?: unknown[] }} projection */
function browserTimelineProjection(projection) {
    if (!projection.ok) return projection;
    return {
        ...projection,
        events: Array.isArray(projection.events)
            ? projection.events.map((event) => {
                if (!event || typeof event !== "object") return event;
                const { _meta, ...safeEvent } = /** @type {Record<string, unknown>} */ (event);
                return safeEvent;
            })
            : projection.events,
        segments: Array.isArray(projection.segments) ? projection.segments : [],
    };
}

/** @param {import('../../../shared/session/session-runtime-interactions.js').RuntimeInteractionRequest} request */
function safePlanReviewReference(request) {
    const meta = request._meta && typeof request._meta === "object" ? request._meta : {};
    const triageMeta = meta.triageMeta && typeof meta.triageMeta === "object"
        ? /** @type {Record<string, unknown>} */ (meta.triageMeta)
        : {};
    const planId = typeof meta.planId === "string" && meta.planId.trim()
        ? meta.planId.trim()
        : typeof triageMeta.planId === "string" && triageMeta.planId.trim()
        ? triageMeta.planId.trim()
        : typeof meta.planName === "string" && meta.planName.trim()
        ? meta.planName.trim()
        : "";
    if (!planId) return null;
    const planName = typeof meta.planName === "string" && meta.planName.trim() ? meta.planName.trim() : planId;
    const classification = typeof meta.classification === "string" && meta.classification.trim()
        ? meta.classification.trim()
        : typeof triageMeta.classification === "string"
        ? triageMeta.classification
        : "PLANNED_CHANGE";
    return {
        planId,
        planName,
        sequenceDocuments: Array.isArray(meta.sequenceDocuments) ? meta.sequenceDocuments : undefined,
        agentLabel: typeof meta.agentLabel === "string" && meta.agentLabel.trim() ? meta.agentLabel.trim() : "Planner",
        classification,
        expectedRevision: typeof meta.expectedRevision === "string" ? meta.expectedRevision : null,
        reviewedSource: meta.reviewedSource && typeof meta.reviewedSource === "object" ? meta.reviewedSource : null,
        expectedStatus: typeof meta.expectedStatus === "string" ? meta.expectedStatus : null,
        expectedWorktree: meta.expectedWorktree && typeof meta.expectedWorktree === "object"
            ? meta.expectedWorktree
            : null,
        previousPlan: typeof meta.previousPlan === "string" && meta.previousPlan.trim() ? meta.previousPlan : null,
        planVersions: Array.isArray(meta.planVersions)
            ? meta.planVersions.flatMap((entry) =>
                entry && typeof entry === "object" && typeof entry.plan === "string"
                    ? [{
                        plan: entry.plan,
                        timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
                    }]
                    : []
            )
            : [],
    };
}

/** @param {import('../../../shared/session/session-runtime-interactions.js').RuntimeInteractionRequest} request */
function safeCodeReviewReference(request) {
    const meta = request._meta && typeof request._meta === "object" ? request._meta : {};
    const rawPatch = typeof meta.diffText === "string" ? meta.diffText : "";
    const planName = typeof meta.planName === "string" && meta.planName.trim()
        ? meta.planName.trim()
        : "Workspace changes";
    const planTitle = typeof meta.planTitle === "string" && meta.planTitle.trim() ? meta.planTitle.trim() : planName;
    const conversation = meta.reviewConversation;
    const conversationEvents = conversation && typeof conversation === "object" && "events" in conversation &&
            Array.isArray(conversation.events)
        ? conversation.events
        : [];
    return {
        rawPatch,
        conversationEvents,
        gitRef: `RunWield workflow diff: ${planName}`,
        planName,
        planTitle,
        agentLabel: typeof meta.agentLabel === "string" && meta.agentLabel.trim()
            ? meta.agentLabel.trim()
            : "Reviewer Feedback Engineer",
    };
}

/** @param {import('../../../shared/session/session-runtime-interactions.js').RuntimeInteractionRequest} request */
function safeArtifactReviewReference(request) {
    const meta = request._meta && typeof request._meta === "object" ? request._meta : {};
    const artifactId = typeof meta.artifactId === "string" ? meta.artifactId.trim() : "";
    if (!artifactId) return null;
    return {
        artifactId,
        title: typeof meta.title === "string" && meta.title.trim() ? meta.title.trim() : "Session artifact",
        kind: typeof meta.artifactKind === "string" ? meta.artifactKind : "report",
        path: typeof meta.artifactPath === "string" ? meta.artifactPath : "",
    };
}

/** @param {unknown} response */
function readPlanReviewDecisionMeta(response) {
    if (!response || typeof response !== "object") return {};
    const source = /** @type {Record<string, unknown>} */ (response);
    return source._meta && typeof source._meta === "object"
        ? /** @type {Record<string, unknown>} */ (source._meta)
        : source;
}

/** @param {unknown} response @returns {import("../../../shared/session/session-runtime-interactions.js").RuntimeInteractionResponse} */
function acceptedInteractionResponse(response) {
    if (response && typeof response === "object") {
        const source = /** @type {Record<string, unknown>} */ (response);
        const outcome = source.outcome;
        switch (outcome) {
            case "selected":
            case "text":
            case "accepted":
            case "canceled":
            case "unsupported":
            case "blocked":
                return { ...source, outcome };
        }
        return { outcome: "accepted", _meta: source };
    }
    return { outcome: "unsupported", message: "Workspace interaction response is invalid." };
}

/** @param {string} value */
function compactSessionName(value) {
    return value.trim().replace(/\s+/g, " ");
}

/** @param {string} transcriptPath */
async function readSessionListInfo(transcriptPath) {
    try {
        const stat = await Deno.stat(transcriptPath);
        const cached = sessionListInfoCache.get(transcriptPath);
        if (
            cached && cached.size === stat.size && cached.mtime === stat.mtime?.getTime() &&
            cached.ctime === stat.ctime?.getTime()
        ) return cached.info;
        const entries = [];
        const transcript = await Deno.readTextFile(transcriptPath);
        for (const line of transcript.split("\n")) {
            if (!line.trim()) continue;
            try {
                const entry = JSON.parse(line);
                entries.push(entry);
            } catch {
                // Use complete records while the active writer appends its next entry.
            }
        }
        const name = summarizeProjectedEntries(entries).name;
        const info = {
            name: typeof name === "string" ? compactSessionName(name) : "",
            firstMessage: compactSessionName(summarizeResumableTranscript(entries).firstMessage || "").slice(0, 100),
        };
        sessionListInfoCache.set(transcriptPath, {
            size: stat.size,
            mtime: stat.mtime?.getTime(),
            ctime: stat.ctime?.getTime(),
            info,
        });
        if (sessionListInfoCache.size > 512) {
            const oldest = sessionListInfoCache.keys().next().value;
            if (oldest) sessionListInfoCache.delete(oldest);
        }
        return info;
    } catch {
        return { name: "", firstMessage: "" };
    }
}

/** @param {string} transcriptPath */
export async function readSessionName(transcriptPath) {
    const info = await readSessionListInfo(transcriptPath);
    return info.name || info.firstMessage;
}

/** @param {string[]} paths */
async function readSessionDisplayName(paths) {
    const infos = await Promise.all(paths.map(readSessionListInfo));
    const savedName = infos.findLast((info) => info.name)?.name || "";
    const name = savedName && !/^untitled(?: session)?$/i.test(savedName) ? savedName : "";
    return name || infos.find((info) => info.firstMessage)?.firstMessage || "";
}

/** @param {import('../../../shared/owner-coordination/index.js').OwnerCoordinationStore} store @param {{ transcriptCwd: string }} session @param {string} projectId */
/**
 * @typedef {Object} WorkspaceOperationRecord
 * @property {string} status
 * @property {string} projectId
 * @property {import("../../../shared/session/session-runtime-events.js").SessionRuntimeEvent[]} events
 * @property {boolean} [remote]
 * @property {import("../../../shared/session/live-session-connection.ts").LiveSessionInfo | null} [sessionInfo]
 * @property {import("../../../shared/session/session-runtime-events.js").RuntimeQueuedMessage[]} [queuedMessages]
 * @property {string} [error]
 * @property {number | null} [generation]
 * @property {string | null} [runwieldSessionId]
 * @property {string} [runtimeSessionId]
 * @property {string} [planId]
 * @property {number} [expectedGeneration]
 * @property {{ agentName?: string, model?: string, provider?: string }} [pendingConfiguration]
 * @property {{ interactionId: string, request: Record<string, unknown> }} [liveInteraction]
 * @property {import('../../../shared/session/notification-content.ts').BrowserNotificationPolicy} [browserNotificationPolicy]
 * @property {{ resolve: (value: import("../../../shared/session/session-runtime-interactions.js").RuntimeInteractionResponse) => void | Promise<void>, reject: (error: Error) => void } | null} [answer]
 */

/**
 * @typedef {Object} WorkspaceAttentionNotification
 * @property {import('../../../shared/session/session-runtime-events.js').RuntimeAttentionRequestedEvent} event
 * @property {string} url
 * @property {import('../../../shared/session/notification-content.ts').BrowserNotificationPolicy} policy
 */

/** @typedef {{ operationId: string, reviewUrl: string }} WorkspacePlanReviewStarted */

export class WorkspaceSessionContinuationService {
    /**
     * @param {{ store: import('../../../shared/owner-coordination/index.js').OwnerCoordinationStore }} options
     */
    constructor(options) {
        this.store = options.store;
        this.ownerInstanceId = crypto.randomUUID();
        this.runtime = createSessionRuntime({
            sessionStore: this.store,
            ownerProcessKind: "workspace",
            ownerInstanceId: this.ownerInstanceId,
        });
        /** @type {Map<string, WorkspaceOperationRecord>} */
        this.operations = new Map();
        /** @type {Map<string, Set<(snapshot: Record<string, unknown>) => void>>} */
        this.operationListeners = new Map();
        /** @type {Map<string, Set<(status: string) => void>>} */
        this.operationChanges = new Map();
        /** @type {Set<(notification: WorkspaceAttentionNotification) => void>} */
        this.notificationListeners = new Set();
        /** @type {Map<string, Promise<() => void>>} */
        this.remoteNotificationStreams = new Map();
        /** @type {Map<string, { requestHash: string, operationId: string }>} */
        this.createRequests = new Map();
        /** @type {Map<string, PendingCreateRequest>} */
        this.pendingCreateRequests = new Map();
        /** @type {Map<string, { cwd: string, targetBranch: string }>} */
        this.codeReviewRefreshContexts = new Map();
        /** @type {Map<string, { sessionId: string, unsubscribe: () => void }>} */
        this.retainedSessions = new Map();
        this.closingRetainedSessions = new Map();
        this.openingContinuations = new Map();
        /** @type {Set<Promise<void>>} */
        this.backgroundOperations = new Set();
        this.closed = false;
        /** @type {Promise<void> | null} */
        this.closing = null;
    }

    /** @param {() => Promise<void>} work */
    runBackgroundOperation(work) {
        const operation = Promise.resolve().then(work);
        this.backgroundOperations.add(operation);
        // Attach both handlers now so a failure cannot become an unhandled rejection
        // while shutdown waits for all in-flight operations to settle.
        void operation.then(
            () => this.backgroundOperations.delete(operation),
            (error) => {
                this.backgroundOperations.delete(operation);
                console.error("[Workspace] Background operation failed:", error);
            },
        );
    }

    close() {
        if (this.closing) return this.closing;
        this.closing = (async () => {
            while (this.backgroundOperations.size) await Promise.all(this.backgroundOperations);
            await Promise.all(this.closingRetainedSessions.values());
            await this.runtime.closeAllSessionsWhenIdle();
            this.closed = true;
            for (const retained of this.retainedSessions.values()) retained.unsubscribe();
            this.retainedSessions.clear();
            this.operationListeners.clear();
            this.operationChanges.clear();
            this.notificationListeners.clear();
            for (const operationId of this.remoteNotificationStreams.keys()) this.closeRemoteNotifications(operationId);
            this.operations.clear();
            this.createRequests.clear();
            this.pendingCreateRequests.clear();
            this.openingContinuations.clear();
            this.codeReviewRefreshContexts.clear();
        })();
        return this.closing;
    }

    /** @param {string} operationId */
    notifyOperation(operationId) {
        const status = this.operations.get(operationId)?.status || "unknown";
        for (const listener of [...(this.operationChanges.get(operationId) || [])]) listener(status);
        const listeners = this.operationListeners.get(operationId);
        if (!listeners?.size) return;
        const snapshot = this.getOperation(operationId);
        for (const listener of [...listeners]) listener(snapshot);
    }

    /** @param {string} operationId @param {WorkspaceOperationRecord} record */
    setOperation(operationId, record) {
        if (this.closed) return;
        const previous = this.operations.get(operationId);
        if (previous?.status !== "running" && previous) return;
        if (record.status === "running") {
            this.operations.set(operationId, {
                ...record,
                browserNotificationPolicy: this.resolveBrowserNotificationPolicy(record.projectId),
            });
        } else {
            const stopped =
                /** @type {import('../../../shared/session/session-runtime-events.js').RuntimeAttentionRequestedEvent | undefined} */ (
                    record.events.findLast((event) =>
                        event.type === "attention_requested" && event.reason === "agentStopped" && !event.eventId &&
                        !event.notificationSurface
                    )
                );
            this.operations.set(operationId, {
                status: record.status,
                projectId: record.projectId,
                runwieldSessionId: record.runwieldSessionId || null,
                generation: record.generation ?? null,
                error: record.error,
                events: stopped
                    ? [{
                        type: stopped.type,
                        reason: stopped.reason,
                        agentName: stopped.agentName,
                        sessionName: stopped.sessionName,
                        sessionId: stopped.sessionId,
                        timestamp: stopped.timestamp,
                    }]
                    : [],
                browserNotificationPolicy: previous?.browserNotificationPolicy ||
                    this.resolveBrowserNotificationPolicy(record.projectId),
            });
            this.closeRemoteNotifications(operationId);
        }
        this.notifyOperation(operationId);
    }

    /** @param {string} operationId */
    closeRemoteNotifications(operationId) {
        const stream = this.remoteNotificationStreams.get(operationId);
        if (!stream) return;
        this.remoteNotificationStreams.delete(operationId);
        void stream.then((close) => close()).catch(() => {});
    }

    /** Release a task owner only when no task, result, or user submission still needs it.
     * @param {string} runwieldSessionId
     */
    async releaseRetainedIfDrained(runwieldSessionId) {
        const retained = this.retainedSessions.get(runwieldSessionId);
        if (!retained || this.openingContinuations.has(runwieldSessionId)) return;
        if (
            [...this.operations.values()].some((operation) =>
                operation.runwieldSessionId === runwieldSessionId && operation.status === "running"
            )
        ) return;
        const tasks = this.runtime.getSessionBackgroundTaskState(retained.sessionId);
        if (tasks && (tasks.active > 0 || tasks.pending > 0)) return;
        // Remove ownership synchronously before awaiting disposal; a new submission
        // waits on this promise rather than adopting a duplicate live owner.
        this.retainedSessions.delete(runwieldSessionId);
        retained.unsubscribe();
        const closing = this.runtime.closeSessionWhenIdle(retained.sessionId);
        this.closingRetainedSessions.set(runwieldSessionId, closing);
        try {
            await closing;
        } finally {
            if (this.closingRetainedSessions.get(runwieldSessionId) === closing) {
                this.closingRetainedSessions.delete(runwieldSessionId);
            }
        }
    }

    /** @param {string} sessionId @param {string} operationId */
    preserveTaskOwnerOrClose(sessionId, operationId) {
        const snapshot = this.runtime.getSessionSnapshot(sessionId);
        const runwieldSessionId = snapshot?.managed?.runwieldSessionId;
        const tasks = this.runtime.getSessionBackgroundTaskState(sessionId);
        if (runwieldSessionId && (snapshot?.busy || tasks?.active || tasks?.pending)) {
            this.retainContinuationSession(runwieldSessionId, sessionId, operationId);
        } else {
            void this.runtime.closeSessionWhenIdle(sessionId);
        }
    }

    /** @param {string} runwieldSessionId @param {string} sessionId @param {string} operationId */
    retainContinuationSession(runwieldSessionId, sessionId, operationId) {
        const previous = this.retainedSessions.get(runwieldSessionId);
        if (previous) previous.unsubscribe();
        let currentOperationId = operationId;
        let unsubscribe = () => {};
        /** @param {import("../../../shared/session/session-runtime-events.js").SessionRuntimeEvent} event */
        const receive = (event) => {
            // Transcript replay describes saved work; it must not reopen background operations.
            if (event.eventId) return;
            if (event.type === "session_replaced" && event.reason === "prompt_template") {
                const nextId = event.newSessionId;
                const oldId = sessionId;
                unsubscribe();
                sessionId = nextId;
                const record = this.operations.get(currentOperationId);
                if (record?.status === "running") {
                    record.runtimeSessionId = nextId;
                    record.events = [];
                    record.runwieldSessionId = this.runtime.getSessionSnapshot(nextId)?.managed?.runwieldSessionId ||
                        null;
                }
                this.retainedSessions.set(runwieldSessionId, { sessionId: nextId, unsubscribe: () => unsubscribe() });
                unsubscribe = this.runtime.subscribeSessionEvents(nextId, receive);
                void this.runtime.closeSessionWhenIdle(oldId);
                return;
            }
            if (event.type === "user_message" && event.origin === "background_task_result") {
                currentOperationId = `background:${runwieldSessionId}:${event.taskId}`;
                this.setOperation(currentOperationId, {
                    status: "running",
                    projectId: this.operations.get(operationId)?.projectId || "",
                    runwieldSessionId,
                    runtimeSessionId: sessionId,
                    events: [],
                });
                this.runtime.setInteractionAdapter(
                    sessionId,
                    this.createInteractionAdapter({ operationId: currentOperationId }),
                );
            }
            this.appendOperationEvent(currentOperationId, event);
            if (event.type === "busy_changed" && !event.busy && currentOperationId !== operationId) {
                const record = this.operations.get(currentOperationId);
                if (record) this.setOperation(currentOperationId, { ...record, status: "completed" });
            }
            if (
                event.type === "busy_changed" && !event.busy || event.type === "background_task_settled" ||
                event.type === "cancellation"
            ) {
                queueMicrotask(() => void this.releaseRetainedIfDrained(runwieldSessionId));
            }
        };
        unsubscribe = this.runtime.subscribeSessionEvents(sessionId, receive);
        this.retainedSessions.set(runwieldSessionId, { sessionId, unsubscribe: () => unsubscribe() });
    }

    /** @param {string} operationId @param {import("../../../shared/session/session-runtime-events.js").SessionRuntimeEvent} event */
    appendOperationEvent(operationId, event) {
        const record = this.operations.get(operationId);
        if (!record || record.status !== "running") return;
        appendLiveSessionEvent(record.events, event);
        if (!record.runwieldSessionId && record.runtimeSessionId) {
            record.runwieldSessionId =
                this.runtime.getSessionSnapshot(record.runtimeSessionId)?.managed?.runwieldSessionId || null;
        }
        this.notifyAttention(record, event);
        this.notifyOperation(operationId);
    }

    /** Follow a user-approved new Session while retaining the original workflow Session.
     * @param {string} operationId
     * @param {string} sessionId
     */
    subscribeOperationSession(operationId, sessionId) {
        let unsubscribe = () => {};
        /** @param {import("../../../shared/session/session-runtime-events.js").SessionRuntimeEvent} event */
        const receive = (event) => {
            this.appendOperationEvent(operationId, event);
            if (event.type !== "session_replaced" || event.reason !== "prompt_template") return;
            unsubscribe();
            const record = this.operations.get(operationId);
            if (record?.status === "running") {
                record.runtimeSessionId = event.newSessionId;
                record.runwieldSessionId =
                    this.runtime.getSessionSnapshot(event.newSessionId)?.managed?.runwieldSessionId || null;
                record.events = [];
            }
            unsubscribe = this.runtime.subscribeSessionEvents(event.newSessionId, receive);
        };
        unsubscribe = this.runtime.subscribeSessionEvents(sessionId, receive);
        return () => unsubscribe();
    }

    /** @param {WorkspaceOperationRecord} record @param {import("../../../shared/session/session-runtime-events.js").SessionRuntimeEvent} event */
    notifyAttention(record, event) {
        if (event.type !== "attention_requested" || event.notificationSurface !== "workspace" || event.eventId) return;
        if (!record.runwieldSessionId) return;
        const notification = {
            event,
            url: `/projects/${encodeURIComponent(record.projectId)}/sessions/${
                encodeURIComponent(record.runwieldSessionId)
            }`,
            policy: this.resolveBrowserNotificationPolicy(record.projectId),
        };
        for (const listener of this.notificationListeners) {
            try {
                listener(notification);
            } catch (error) {
                console.warn("Workspace notification subscriber disconnected:", error);
            }
        }
    }

    /** @param {(notification: WorkspaceAttentionNotification) => void} listener */
    subscribeNotifications(listener) {
        this.notificationListeners.add(listener);
        return () => this.notificationListeners.delete(listener);
    }

    /** @param {string} operationId @param {WorkspaceOperationRecord | undefined} operation */
    async watchRemoteNotifications(operationId, operation) {
        if (this.closed || !operation?.remote || !operation.runwieldSessionId) return;
        let stream = this.remoteNotificationStreams.get(operationId);
        if (!stream) {
            stream = subscribeLiveSessionAttention(operation.runwieldSessionId, operationId, (event) => {
                this.notifyAttention(operation, event);
            });
            this.remoteNotificationStreams.set(operationId, stream);
        }
        try {
            await stream;
            if (this.operations.get(operationId)?.status !== "running") this.closeRemoteNotifications(operationId);
        } catch (error) {
            if (this.remoteNotificationStreams.get(operationId) === stream) {
                this.remoteNotificationStreams.delete(operationId);
            }
            throw error;
        }
    }

    /** Observe state changes without constructing transcript snapshots until the reader asks.
     * @param {string} operationId @param {(status: string) => void} listener
     */
    subscribeOperationChanges(operationId, listener) {
        let listeners = this.operationChanges.get(operationId);
        if (!listeners) {
            listeners = new Set();
            this.operationChanges.set(operationId, listeners);
        }
        listeners.add(listener);
        listener(this.operations.get(operationId)?.status || this.getOperation(operationId).status);
        return () => {
            listeners.delete(listener);
            if (!listeners.size) this.operationChanges.delete(operationId);
        };
    }

    /** @param {string} projectId */
    resolveBrowserNotificationPolicy(projectId) {
        const project = typeof this.store.getProjectById === "function" ? this.store.getProjectById(projectId) : null;
        const raw = project ? getMergedCustomSetting("notifications", project.currentRoot) : undefined;
        return normalizeBrowserNotificationPolicy(raw);
    }

    /** @param {string} operationId @param {(snapshot: Record<string, unknown>) => void} listener */
    subscribeOperation(operationId, listener) {
        let listeners = this.operationListeners.get(operationId);
        if (!listeners) {
            listeners = new Set();
            this.operationListeners.set(operationId, listeners);
        }
        listeners.add(listener);
        listener(this.getOperation(operationId));
        return () => {
            const current = this.operationListeners.get(operationId);
            if (!current) return;
            current.delete(listener);
            if (!current.size) this.operationListeners.delete(operationId);
        };
    }

    /**
     * @param {string} projectId
     */
    async listSessionOptions(projectId) {
        const projectRoot = requireOwnerProjectRoot(this.store, projectId);
        const settings = getSettingsManager(projectRoot);
        const agentOptions = await listUserAgentOptions(projectRoot);
        const defaultAgent = await getDefaultUserAgentOption(projectRoot);
        const models = await listUserModelOptions();
        const defaultProvider = settings.getDefaultProvider?.() || "";
        const defaultModel = settings.getDefaultModel?.() || "";
        const defaultThinkingLevel = settings.getDefaultThinkingLevel?.() || "default";
        const [templates, skills, commandRegistry] = await Promise.all([
            listPromptTemplates({ cwd: projectRoot }),
            listSkills({ cwd: projectRoot }),
            import("../../../cmd/registry.js"),
        ]);
        const builtins = commandRegistry.getSlashCommandDefinitions("workspace");
        // Options load infrequently, unlike animation renders. Refresh settings
        // edited by another surface/process before publishing visibility.
        clearMascotEnabledCache();
        return {
            mascot: isMascotEnabled(projectRoot),
            defaults: {
                agentName: defaultAgent.name,
                model: defaultAgent.defaults.model || defaultModel,
                provider: defaultAgent.defaults.provider || defaultProvider,
                thinkingLevel: defaultAgent.defaults.thinkingLevel || defaultThinkingLevel,
            },
            agents: agentOptions,
            commands: [
                ...builtins.map((command) => ({
                    name: command.name,
                    description: command.description,
                    kind: "action",
                })),
                ...templates.filter((template) => !commandRegistry.getCommandDefinition(template.name))
                    .map((template) => ({ name: template.name, description: template.description, kind: "prompt" })),
                ...skills.map((skill) => ({
                    name: `skill:${skill.name}`,
                    description: skill.description,
                    kind: "prompt",
                })),
            ],
            models,
            thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        };
    }

    /**
     * @param {string} projectId
     * @param {SessionListOptions} [options]
     */
    async listSessions(projectId, options = {}) {
        const page = typeof options.page === "number" && Number.isInteger(options.page) && options.page >= 0
            ? options.page
            : 0;
        const pageSize =
            typeof options.pageSize === "number" && Number.isInteger(options.pageSize) && options.pageSize > 0
                ? Math.min(options.pageSize, 100)
                : 30;
        const start = page * pageSize;
        const excludedSessions = new Set(options.excludedSessionIds || []);
        const excludedPlans = new Set(options.excludedPlanIds || []);
        // Navigation needs one visible page and a lookahead, not a count of every transcript.
        const visibleLimit = options.includeTotal === false ? start + pageSize + 1 : Infinity;
        // One recovered catalog snapshot per request; paging the catalog would rescan
        // and reparse every manifest (and recovery descriptor) for each 100 rows.
        const result = await this.store.listProjectSessions(projectId, {
            all: true,
            catalog: false,
            archiveState: options.planId ? "all" : options.archiveState,
        });
        const visible = [];
        // Keep transcript reads bounded; never load all large histories in parallel.
        for (const session of result.sessions) {
            // Filter stable identities before opening transcript files. Sidebar expansion
            // needs only five unseen names, regardless of the Project's history size.
            if (excludedSessions.has(session.runwieldSessionId)) continue;
            if (options.planId || excludedPlans.size) {
                const associations = this.store.listSessionPlanAssociations(session.runwieldSessionId, projectId)
                    .filter((entry) => entry.committedGeneration !== null);
                if (options.planId && !associations.some((entry) => entry.planId === options.planId)) continue;
                if (associations.some((entry) => excludedPlans.has(entry.planId))) continue;
            }
            const segments = this.store.listSessionTranscriptSegments(session.runwieldSessionId);
            const paths = segments.length
                ? [...segments].sort((a, b) => a.ordinal - b.ordinal).map((segment) => segment.transcriptPath)
                : [session.transcriptPath].filter(Boolean);
            const displayName = await readSessionDisplayName(paths);
            if (!options.includeEmpty && !displayName) continue;
            visible.push({ ...session, displayName });
            if (visible.length >= visibleLimit) break;
        }
        return {
            ...result,
            page,
            pageSize,
            total: options.includeTotal === false ? null : visible.length,
            hasNext: start + pageSize < visible.length,
            hasPrevious: page > 0 && start < visible.length,
            diagnostics: result.diagnostics || [],
            sessions: visible.slice(start, start + pageSize).map((session) => {
                const inspected = this.store.inspectSessionActivation(session.runwieldSessionId);
                return {
                    runwieldSessionId: session.runwieldSessionId,
                    projectId,
                    displayName: session.displayName,
                    archivedAt: session.archivedAt,
                    headerTimestamp: session.headerTimestamp,
                    lastCatalogedAt: session.lastCatalogedAt,
                    state: inspected.activation?.state || "missing_activation",
                    generation: inspected.generation?.generation ?? null,
                    activeSurface: inspected.activation?.state === "active"
                        ? inspected.activation.ownerProcessKind
                        : null,
                    recoveryCategory: inspected.activation?.state === "active"
                        ? "wait_for_owner"
                        : inspected.activation?.state || "idle",
                    bootstrapRequired: inspected.activation?.state === "uninitialized",
                };
            }),
        };
    }

    /**
     * @param {string} runwieldSessionId
     * @param {number} expectedGeneration
     */
    async adoptIdleManagedSession(runwieldSessionId, expectedGeneration) {
        const session = this.store.getSessionById(runwieldSessionId);
        if (!session) throw new Error("Session not found.");
        const inspected = this.store.inspectSessionActivation(runwieldSessionId);
        if (inspected.activation?.state !== "idle") {
            throw new Error("This Session is still busy. Wait for it to finish, then try again.");
        }
        if (!inspected.generation || inspected.generation.generation !== expectedGeneration) {
            throw new Error("Configuration requires the exact committed generation.");
        }
        const retainedId = this.retainedSessions.get(runwieldSessionId)?.sessionId;
        if (retainedId && this.runtime.getSessionSnapshot(retainedId)) return { sessionId: retainedId };
        const projection = await projectAggregateTranscript({
            cwd: session.transcriptCwd,
            sessionDir: getRunWieldSessionDir(session.transcriptCwd),
            runwieldSessionId,
            generation: inspected.generation,
            segments: this.store.listSessionTranscriptSegments(runwieldSessionId),
            limit: 500,
        });
        if (!projection.ok) throw new Error(projection.message);
        const committedFacts = getCommittedTranscriptAuthorityFacts(projection);
        return this.runtime.adoptManagedSession({
            session,
            generation: expectedGeneration,
            activeAgent: committedFacts.activeAgent,
            model: committedFacts.model,
            provider: committedFacts.provider,
            thinkingLevel: committedFacts.thinkingLevel,
            workflowContext:
                /** @type {import('../../../shared/session/workflow-context-session.js').WorkflowContext | null} */ (committedFacts
                    .workflowContext || null),
        });
    }

    /**
     * @param {string} runwieldSessionId
     * @param {{ projectId?: string, cursorEventId?: string, limit?: number, latest?: boolean, beforeEventId?: string }} [options]
     */
    async timeline(runwieldSessionId, options = {}) {
        const session = this.store.getSessionById(runwieldSessionId);
        if (
            !session || (options.projectId && !sessionBelongsToOwnerProject(this.store, session, options.projectId))
        ) {
            throw new Error("Session not found.");
        }
        let inspected = this.store.inspectSessionActivation(runwieldSessionId);
        if (
            ["uncertain", "reconcile_required"].includes(inspected.activation?.state || "") ||
            (!inspected.generation && inspected.activation?.state === "uninitialized")
        ) {
            await this.runtime.ensureInitialSessionGeneration(runwieldSessionId);
            inspected = this.store.inspectSessionActivation(runwieldSessionId);
        }
        const state = inspected.activation?.state || "uninitialized";
        const activeSurface = state === "active" ? inspected.activation?.ownerProcessKind || null : null;
        if (!inspected.generation) {
            return {
                state,
                activeSurface,
                recoveryCategory: state,
                bootstrapRequired: true,
                generation: null,
                complete: true,
                events: [],
                artifacts: this.store.listSessionArtifacts(runwieldSessionId),
            };
        }
        const projection = await projectAggregateTranscript({
            cwd: session.transcriptCwd,
            sessionDir: getRunWieldSessionDir(session.transcriptCwd),
            runwieldSessionId,
            generation: inspected.generation,
            segments: this.store.listSessionTranscriptSegments(runwieldSessionId),
            cursorEventId: options.cursorEventId,
            limit: options.limit,
            latest: options.latest,
            beforeEventId: options.beforeEventId,
        });
        if (projection.ok) {
            /** @type {import('../../../shared/session/live-session-connection.ts').LiveSessionInfo | null | undefined} */
            let liveInfo = projectLiveSessionInfo(
                this.runtime.listSessions().find((item) =>
                    item.managed?.runwieldSessionId === runwieldSessionId && !item.managed.dormant
                ) || null,
            );
            if (!liveInfo && state === "active" && inspected.activation?.operationId) {
                try {
                    liveInfo = (await readLiveSessionConnection(runwieldSessionId, inspected.activation.operationId))
                        .sessionInfo;
                } catch {
                    // Committed information remains available when the running surface cannot be reached.
                }
            }
            const segments = this.store.listSessionTranscriptSegments(runwieldSessionId);
            const paths = segments.length
                ? [...segments].sort((a, b) => a.ordinal - b.ordinal).map((segment) => segment.transcriptPath)
                : [session.transcriptPath].filter(Boolean);
            if (liveInfo) {
                const planAssociations = mergePlanAssociations(
                    getCommittedTranscriptAuthorityFacts(projection).planAssociations,
                    liveInfo.planAssociations,
                );
                const sessionStats = liveInfo.sessionStats || projection.snapshot.sessionStats;
                Object.assign(projection.snapshot, liveInfo, { planAssociations, sessionStats });
            }
            projection.snapshot.name = liveInfo?.name || await readSessionDisplayName(paths);
            projection.snapshot.contextUsage = liveInfo?.contextUsage || null;
            projection.snapshot.systemContextTokens = liveInfo?.systemContextTokens ?? null;
        }
        return {
            state: state || "idle",
            activeSurface,
            recoveryCategory: state || "idle",
            bootstrapRequired: false,
            artifacts: this.store.listSessionArtifacts(runwieldSessionId),
            ...browserTimelineProjection(projection),
        };
    }

    /**
     * @param {string | undefined} agentName
     * @param {string} projectRoot
     */
    async validateAgentSelection(agentName, projectRoot) {
        if (typeof agentName !== "string" || !agentName) return;
        await requireUserAgentOption(agentName, projectRoot);
    }

    /**
     * @param {string | undefined} model
     * @param {string | undefined} provider
     */
    async validateModelSelection(model, provider) {
        if (typeof model !== "string" || !model) return;
        await requireUserModelOption(model, provider || "");
    }

    /**
     * @param {string | undefined} thinkingLevel
     * @param {{ thinkingLevels: string[] }} sessionOptions
     */
    validateThinkingSelection(thinkingLevel, sessionOptions) {
        if (typeof thinkingLevel !== "string" || !thinkingLevel) return;
        if (!sessionOptions.thinkingLevels.includes(thinkingLevel)) {
            throw new Error("Selected thinking level is not supported.");
        }
    }

    /**
     * @param {string} runwieldSessionId
     * @param {number} expectedGeneration
     * @returns {{ operationId: string, record: WorkspaceOperationRecord } | null}
     */
    findActiveWorkspaceOperation(runwieldSessionId, expectedGeneration) {
        for (const [operationId, record] of this.operations.entries()) {
            if (
                record.runwieldSessionId === runwieldSessionId && record.expectedGeneration === expectedGeneration &&
                record.runtimeSessionId && (record.status === "running" || record.status === "accepted")
            ) {
                return { operationId, record };
            }
        }
        return null;
    }

    /**
     * @param {string} runtimeSessionId
     * @param {{ agentName?: string, model?: string, provider?: string }} pendingConfiguration
     */
    async applyPendingConfiguration(runtimeSessionId, pendingConfiguration) {
        if (pendingConfiguration.agentName) {
            const result = await applyUserAgentSelection(
                this.runtime,
                runtimeSessionId,
                pendingConfiguration.agentName,
            );
            if (!result.ok) throw new Error(result.error || "Selected Agent could not be applied.");
        }
        if (pendingConfiguration.model) {
            const result = await applyUserModelSelection(
                this.runtime,
                runtimeSessionId,
                pendingConfiguration.model,
                pendingConfiguration.provider || "",
            );
            if (!result.ok) throw new Error(result.error || "Selected model could not be applied.");
        }
    }

    /**
     * @param {{ projectId: string, runwieldSessionId: string, expectedGeneration: number, agentName?: string, model?: string, provider?: string, thinkingLevel?: string }} options
     */
    async configureSession(options) {
        const session = this.store.getSessionById(options.runwieldSessionId);
        if (!session || !sessionBelongsToOwnerProject(this.store, session, options.projectId)) {
            throw new Error("Session not found.");
        }
        const projectRoot = requireOwnerProjectRoot(this.store, options.projectId);
        const sessionOptions = await this.listSessionOptions(options.projectId);
        await this.validateAgentSelection(options.agentName, projectRoot);
        await this.validateModelSelection(options.model, options.provider);
        this.validateThinkingSelection(options.thinkingLevel, sessionOptions);
        const activeOperation = this.findActiveWorkspaceOperation(
            options.runwieldSessionId,
            options.expectedGeneration,
        );
        if (activeOperation) {
            const pendingConfiguration = {
                ...(options.agentName ? {} : activeOperation.record.pendingConfiguration || {}),
                ...(options.agentName ? { agentName: options.agentName } : {}),
                ...(options.model ? { model: options.model, provider: options.provider || "" } : {}),
            };
            if (options.thinkingLevel) {
                const runtimeSessionId = activeOperation.record.runtimeSessionId;
                if (!runtimeSessionId) throw new Error("Active Runtime Session is not available.");
                const thinkingLevel = /** @type {WorkspaceThinkingLevel} */ (options.thinkingLevel);
                const result = await this.runtime.setSessionThinkingLevel(runtimeSessionId, thinkingLevel);
                if (!result?.ok) throw new Error(result?.error || "Selected thinking level could not be applied.");
            }
            const hasPendingConfiguration = Object.keys(pendingConfiguration).length > 0;
            this.setOperation(activeOperation.operationId, {
                ...activeOperation.record,
                pendingConfiguration: hasPendingConfiguration ? pendingConfiguration : undefined,
            });
            return {
                ok: true,
                status: hasPendingConfiguration ? "staged" : "applied",
                operationId: activeOperation.operationId,
                pendingConfiguration: hasPendingConfiguration ? pendingConfiguration : null,
                generation: options.expectedGeneration,
            };
        }
        const adopted = await this.adoptIdleManagedSession(options.runwieldSessionId, options.expectedGeneration);
        try {
            if (typeof options.agentName === "string" && options.agentName) {
                const result = await applyUserAgentSelection(this.runtime, adopted.sessionId, options.agentName);
                if (!result.ok) throw new Error(result.error || "Selected Agent could not be applied.");
            }
            if (typeof options.model === "string" && options.model) {
                const result = await applyUserModelSelection(
                    this.runtime,
                    adopted.sessionId,
                    options.model,
                    options.provider || "",
                );
                if (!result.ok) throw new Error(result.error || "Selected model could not be applied.");
            }
            if (typeof options.thinkingLevel === "string" && options.thinkingLevel) {
                const thinkingLevel = /** @type {WorkspaceThinkingLevel} */ (options.thinkingLevel);
                const result = await this.runtime.setSessionThinkingLevel(adopted.sessionId, thinkingLevel);
                if (!result?.ok) throw new Error(result?.error || "Selected thinking level could not be applied.");
            }
            const snapshot = this.runtime.getSessionSnapshot(adopted.sessionId);
            return {
                ok: true,
                status: "applied",
                generation: snapshot?.managed?.generation ?? options.expectedGeneration,
            };
        } finally {
            if (adopted.sessionId !== this.retainedSessions.get(options.runwieldSessionId)?.sessionId) {
                void this.runtime.closeSession(adopted.sessionId);
            }
        }
    }

    /**
     * @typedef {Object} WorkspaceSessionArchiveRequest
     * @property {string} projectId
     * @property {string} runwieldSessionId
     * @property {boolean} [confirmed]
     */
    /** @param {WorkspaceSessionArchiveRequest} options */
    async archiveSession(options) {
        requireOwnerProjectRoot(this.store, options.projectId);
        const session = this.store.getSessionById(options.runwieldSessionId);
        if (!session || !sessionBelongsToOwnerProject(this.store, session, options.projectId)) {
            throw new Error("Session not found.");
        }
        const inspected = this.store.inspectSessionActivation(options.runwieldSessionId);
        if (inspected.activation?.state === "active") {
            if (options.confirmed !== true) {
                throw new Error("This Session is busy. Confirm to stop its work and archive it.");
            }
            const live = await this.liveSession(options.projectId, options.runwieldSessionId);
            if (!live.operation) throw new Error("No running turn to stop. Refresh and try again.");
            const canceled = await this.cancelOperation({ operationId: live.operation.operationId });
            if (!canceled?.ok) throw new Error("Could not stop this Session. Try again.");
            await waitForSessionActivationSettlement(this.store, options.runwieldSessionId);
        }
        const archived = this.store.archiveSession(options.runwieldSessionId, options.projectId);
        return { runwieldSessionId: archived.runwieldSessionId, archivedAt: archived.archivedAt };
    }

    /** @param {WorkspaceSessionArchiveRequest} options */
    unarchiveSession(options) {
        requireOwnerProjectRoot(this.store, options.projectId);
        const session = this.store.getSessionById(options.runwieldSessionId);
        if (!session || !sessionBelongsToOwnerProject(this.store, session, options.projectId)) {
            throw new Error("Session not found.");
        }
        const restored = this.store.unarchiveSession(options.runwieldSessionId, options.projectId);
        return { runwieldSessionId: restored.runwieldSessionId, archivedAt: restored.archivedAt };
    }

    /**
     * @param {{ operationId: string }} options
     */
    async cancelOperation(options) {
        const operation = this.operations.get(options.operationId);
        if (operation?.remote && operation.runwieldSessionId) {
            await readLiveSessionConnection(operation.runwieldSessionId, options.operationId, { action: "cancel" });
            return { ok: true };
        }
        if (!operation?.runtimeSessionId) throw new Error("No running turn to stop.");
        return this.runtime.cancelSession(operation.runtimeSessionId);
    }

    /**
     * @typedef {Object} WorkspaceSteeringRequest
     * @property {string} projectId
     * @property {string} operationId
     * @property {string} requestId
     * @property {string} text
     * @property {import('../../../shared/session/types.js').ImageAttachment[]} images
     */
    /** @param {WorkspaceSteeringRequest} options */
    async steerOperation(options) {
        const operation = this.operations.get(options.operationId);
        if (
            operation?.projectId !== options.projectId || operation.status !== "running" || !operation.runwieldSessionId
        ) {
            throw new Error("The turn has finished. Send your message as a follow-up.");
        }
        const activation = this.store.inspectSessionActivation(operation.runwieldSessionId).activation;
        if (activation?.state !== "active" || !activation.operationId) return { ok: true, queued: false };
        await this.watchRemoteNotifications(activation.operationId, operation);
        return await readLiveSessionConnection(operation.runwieldSessionId, activation.operationId, {
            action: "steer",
            inputSurface: "workspace",
            requestId: options.requestId,
            text: options.text,
            images: options.images,
        });
    }

    /**
     * @param {{ deviceId?: string | null, projectId: string, runwieldSessionId: string, requestId: string }} options
     */
    async bootstrap(options) {
        const session = this.store.getSessionById(options.runwieldSessionId);
        if (!session || !sessionBelongsToOwnerProject(this.store, session, options.projectId)) {
            throw new Error("Session not found.");
        }
        const receipt = requireReceipt(this.store.createOrGetOperationReceipt({
            deviceId: options.deviceId || null,
            requestId: options.requestId,
            requestHash: stableHash({ kind: "bootstrap", session: options.runwieldSessionId }),
            runwieldSessionId: options.runwieldSessionId,
            projectId: options.projectId,
            expectedGeneration: null,
            kind: "bootstrap",
        }));
        const existing = this.store.inspectSessionActivation(options.runwieldSessionId);
        if (existing.generation) {
            return {
                operationId: receipt.operationId,
                generation: existing.generation.generation,
                status: "completed",
            };
        }
        if (["uncertain", "reconcile_required"].includes(existing.activation?.state || "")) {
            const recovered = await this.runtime.ensureInitialSessionGeneration(options.runwieldSessionId);
            const generation = recovered.generation?.generation ?? 0;
            this.store.updateOperationReceipt(receipt.operationId, {
                status: "completed",
                resultGeneration: generation,
            });
            return { operationId: receipt.operationId, generation, status: "completed" };
        }
        const proof = this.store.acquireSessionActivation({
            runwieldSessionId: options.runwieldSessionId,
            projectId: options.projectId,
            ownerInstanceId: this.ownerInstanceId,
            ownerProcessKind: "workspace",
            operationId: receipt.operationId,
            expectedGeneration: null,
            phase: "bootstrap",
        });
        try {
            const evidence = await captureTranscriptEvidence({
                transcriptPath: session.transcriptPath,
                transcriptCwd: session.transcriptCwd,
            });
            const checkpointProof = this.store.changeSessionActivationPhase(proof, "checkpointing");
            this.store.publishGenerationAndRelease(checkpointProof, {
                generation: 0,
                byteLength: evidence.byteLength,
                terminalEntryId: evidence.terminalEntryId,
                digestHex: evidence.digestHex,
            });
            this.store.updateOperationReceipt(receipt.operationId, { status: "completed", resultGeneration: 0 });
            return { operationId: receipt.operationId, generation: 0, status: "completed" };
        } catch (error) {
            const errorCode = codeFromError(error);
            this.store.markSessionReconcileRequired({
                runwieldSessionId: options.runwieldSessionId,
                projectId: options.projectId,
            }, { reason: errorCode });
            this.store.updateOperationReceipt(receipt.operationId, {
                status: "failed",
                errorCode,
                errorMessage: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    /**
     * @param {string} operationId
     * @param {import('../../../shared/session/session-runtime-interactions.js').RuntimeInteractionRequest} request
     * @param {NonNullable<WorkspaceOperationRecord['answer']>} answer
     */
    registerInteraction(operationId, request, answer) {
        const current = this.operations.get(operationId);
        if (!current) throw new Error("The running turn is no longer available.");
        const interactionId = String(request.id);
        const planReview = request.type === "plan_review" ? safePlanReviewReference(request) : null;
        const codeReview = request.type === "code_review" ? safeCodeReviewReference(request) : null;
        const artifactReview = request.type === "artifact_review" ? safeArtifactReviewReference(request) : null;
        if (codeReview) {
            const meta = request._meta && typeof request._meta === "object" ? request._meta : {};
            const executionCwd = typeof meta.executionCwd === "string" ? meta.executionCwd.trim() : "";
            const targetBranch = typeof meta.targetBranch === "string" ? meta.targetBranch.trim() : "";
            if (executionCwd && targetBranch) {
                this.codeReviewRefreshContexts.set(`${operationId}:${interactionId}`, {
                    cwd: executionCwd,
                    targetBranch,
                });
            }
        }
        const reviewUrl = planReview
            ? `/projects/${encodeURIComponent(current.projectId)}/plans/${
                encodeURIComponent(planReview.planId)
            }?session=${encodeURIComponent(current.runwieldSessionId || "")}&operation=${
                encodeURIComponent(operationId)
            }&interaction=${encodeURIComponent(interactionId)}`
            : codeReview
            ? `/projects/${encodeURIComponent(current.projectId)}/sessions/${
                encodeURIComponent(current.runwieldSessionId || "")
            }/review/code?operation=${encodeURIComponent(operationId)}&interaction=${encodeURIComponent(interactionId)}`
            : artifactReview
            ? `/projects/${encodeURIComponent(current.projectId)}/sessions/${
                encodeURIComponent(current.runwieldSessionId || "")
            }/artifacts/${encodeURIComponent(artifactReview.artifactId)}`
            : null;
        if ((planReview || codeReview) && reviewUrl) {
            const meta = request._meta && typeof request._meta === "object" ? request._meta : {};
            if (typeof meta.onSurfaceReady === "function") meta.onSurfaceReady({ url: reviewUrl, opened: false });
        }
        this.setOperation(operationId, {
            ...current,
            liveInteraction: {
                interactionId,
                request: {
                    id: interactionId,
                    type: request.type,
                    prompt: request.prompt,
                    options: Array.isArray(request.options)
                        ? request.options.map(
                            /** @param {import('../../../shared/session/session-runtime-interactions.js').RuntimeInteractionOption} option */ (
                                option,
                            ) => ({
                                value: option.value,
                                label: option.label,
                                description: option.description,
                            }),
                        )
                        : [],
                    defaultValue: request.defaultValue,
                    placeholder: request.placeholder,
                    allowEmpty: request.allowEmpty === true,
                    ...(planReview && { planReview, reviewUrl }),
                    ...(codeReview && { codeReview, reviewUrl }),
                    ...(artifactReview && { artifactReview, reviewUrl }),
                },
            },
            answer,
        });
    }

    /**
     * @param {{ operationId: string }} options
     */
    createInteractionAdapter(options) {
        return {
            supportsInteraction: () => true,
            /** @param {import('../../../shared/session/session-runtime-interactions.js').RuntimeInteractionRequest} request @param {AbortSignal} [signal] */
            requestInteraction: async (request, signal) => {
                const reviewPlanId = request.type === "plan_review" ? safePlanReviewReference(request)?.planId : null;
                if (reviewPlanId) {
                    const operation = this.operations.get(options.operationId);
                    if (!operation) throw new Error("Workspace operation is not running.");
                    const root = requireOwnerProjectRoot(this.store, operation.projectId);
                    const evidence = await loadPlanActionEvidence(root, reviewPlanId);
                    if (evidence.kind !== "success") throw new Error(evidence.message);
                    // Freeze the document presented for this interaction. The decision must
                    // not substitute the latest Plan as the source that the user reviewed.
                    const plan = Array.isArray(request._meta?.sequenceDocuments)
                        ? null
                        : await findPlanEvidenceById(root, reviewPlanId);
                    request._meta = {
                        ...request._meta,
                        expectedRevision: evidence.evidence.revision,
                        expectedStatus: evidence.evidence.status,
                        expectedWorktree: evidence.evidence.worktree,
                        ...(plan && !request._meta?.reviewedSource && {
                            reviewedSource: {
                                planName: plan.planName,
                                path: plan.path,
                                markdown: plan.markdown,
                                revision: plan.revision,
                                attrs: plan.attrs,
                            },
                        }),
                    };
                }
                const interactionId = String(request.id || crypto.randomUUID());
                return new Promise((resolve, reject) => {
                    const current = this.operations.get(options.operationId);
                    if (!current || current.status !== "running") {
                        reject(new Error("Workspace operation is not running."));
                        return;
                    }
                    this.registerInteraction(options.operationId, request, { resolve, reject });
                    const abort = () => {
                        const latest = this.operations.get(options.operationId);
                        if (latest?.liveInteraction?.interactionId === interactionId) {
                            this.setOperation(options.operationId, {
                                ...latest,
                                liveInteraction: undefined,
                                answer: null,
                            });
                        }
                        reject(new DOMException("Interaction canceled.", "AbortError"));
                    };
                    signal?.addEventListener("abort", abort, { once: true });
                    if (signal?.aborted) abort();
                });
            },
            cancelAll: () => {
                const current = this.operations.get(options.operationId);
                current?.answer?.reject(new Error("Interaction canceled."));
            },
        };
    }

    /**
     * @param {{ deviceId?: string | null, projectId: string, requestId: string, text: string, images?: import("../../../shared/session/types.js").ImageAttachment[], agentName?: string, model?: string, provider?: string, thinkingLevel?: string }} options
     * @returns {Promise<CreateSessionResult>}
     */
    async createSession(options) {
        if (!options.text?.trim() && !options.images?.length) throw new Error("A message or image is required.");
        await Promise.resolve();
        const project = this.store.getProjectById(options.projectId);
        if (!project || project.lifecycle !== "enabled") throw new Error("Project not found.");
        const projectRoot = requireOwnerProjectRoot(this.store, options.projectId);
        const defaultAgent = await getDefaultUserAgentOption(projectRoot);
        const launch = {
            agentName: options.agentName || defaultAgent.name,
            model: options.model || "",
            provider: options.provider || "",
            thinkingLevel: options.thinkingLevel || "default",
        };
        const sessionOptions = await this.listSessionOptions(options.projectId);
        await this.validateAgentSelection(launch.agentName, projectRoot);
        await this.validateModelSelection(launch.model, launch.provider);
        if (launch.thinkingLevel !== "default" && !sessionOptions.thinkingLevels.includes(launch.thinkingLevel)) {
            throw new Error("Selected thinking level is not supported.");
        }
        const requestHash = stableHash({
            kind: "create",
            projectId: options.projectId,
            text: options.text,
            images: options.images || [],
            launch,
        });
        const createKey = `${options.deviceId || ""}:${options.projectId}:${options.requestId}`;
        const existing = this.createRequests.get(createKey);
        if (existing) {
            if (existing.requestHash !== requestHash) {
                throw new Error("Operation request id was reused with different input");
            }
            const operation = this.operations.get(existing.operationId);
            return {
                operationId: existing.operationId,
                status: operation?.status || "running",
                runwieldSessionId: operation?.runwieldSessionId || null,
                generation: operation?.generation ?? null,
            };
        }
        const pending = this.pendingCreateRequests.get(createKey);
        if (pending) {
            if (pending.requestHash !== requestHash) {
                throw new Error("Operation request id was reused with different input");
            }
            await pending.settled;
            return await this.createSession(options);
        }
        /** @type {VoidResolver} */
        let releasePending = () => {};
        const reservation = {
            requestHash,
            settled: new Promise((resolve) => {
                releasePending = resolve;
            }),
        };
        this.pendingCreateRequests.set(createKey, reservation);
        try {
            let preparedSessionId = "";
            let preparedModelOverride = "";
            if ((options.images || []).length > 0) {
                try {
                    const created = await this.runtime.createInteractiveSession({
                        cwd: project.currentRoot,
                        mode: "new",
                        deferManagedActivationUntilAgentReady: true,
                    });
                    preparedSessionId = created.sessionId;
                    if (launch.model) {
                        const modelResult = await this.runtime.reconfigureSessionModel(
                            preparedSessionId,
                            launch.model,
                            launch.provider,
                        );
                        if (!modelResult?.ok) throw new Error("Selected model could not be applied.");
                    }
                    if (launch.thinkingLevel !== "default") {
                        const thinkingLevel = /** @type {WorkspaceThinkingLevel} */ (launch.thinkingLevel);
                        const thinkingResult = await this.runtime.setSessionThinkingLevel(
                            preparedSessionId,
                            thinkingLevel,
                        );
                        if (!thinkingResult?.ok) throw new Error("Selected thinking level could not be applied.");
                    }
                    const preflight = await this.runtime.preflightUserTurnImages(preparedSessionId, {
                        initialRequest: options.text,
                        initialImages: options.images || [],
                        agentName: launch.agentName,
                    });
                    if (!preflight.ok) throw new ImageSubmissionValidationError(preflight.message);
                    preparedModelOverride = "preparedModelOverride" in preflight
                        ? preflight.preparedModelOverride || ""
                        : "";
                } catch (error) {
                    if (preparedSessionId) this.runtime.closeSessionWhenIdle(preparedSessionId);
                    throw error;
                }
            }
            const repeated = this.createRequests.get(createKey);
            if (repeated) {
                if (preparedSessionId) this.runtime.closeSessionWhenIdle(preparedSessionId);
                if (repeated.requestHash !== requestHash) {
                    throw new Error("Operation request id was reused with different input");
                }
                const operation = this.operations.get(repeated.operationId);
                return {
                    operationId: repeated.operationId,
                    status: operation?.status || "running",
                    runwieldSessionId: operation?.runwieldSessionId || null,
                    generation: operation?.generation ?? null,
                };
            }
            const operationId = crypto.randomUUID();
            this.createRequests.set(createKey, { requestHash, operationId });
            this.setOperation(operationId, {
                status: "running",
                projectId: options.projectId,
                events: [],
                runwieldSessionId: null,
            });
            this.runBackgroundOperation(async () => {
                let sessionId = preparedSessionId;
                let unsubscribe = () => {};
                try {
                    if (!sessionId) {
                        const created = await this.runtime.createInteractiveSession({
                            cwd: project.currentRoot,
                            mode: "new",
                            deferManagedActivationUntilAgentReady: true,
                        });
                        sessionId = created.sessionId;
                    }
                    this.setOperation(operationId, {
                        ...(this.operations.get(operationId) || { projectId: options.projectId, events: [] }),
                        status: "running",
                        runtimeSessionId: sessionId,
                        runwieldSessionId: this.runtime.getSessionSnapshot(sessionId)?.managed?.runwieldSessionId ||
                            null,
                    });
                    this.runtime.setInteractionAdapter(sessionId, this.createInteractionAdapter({ operationId }));
                    unsubscribe = this.subscribeOperationSession(operationId, sessionId);
                    if (!preparedSessionId) {
                        if (launch.model) {
                            const modelResult = await applyUserModelSelection(
                                this.runtime,
                                sessionId,
                                launch.model,
                                launch.provider,
                            );
                            if (!modelResult.ok) {
                                throw new Error(modelResult.error || "Selected model could not be applied.");
                            }
                        }
                        if (launch.thinkingLevel !== "default") {
                            const thinkingLevel = /** @type {WorkspaceThinkingLevel} */ (launch.thinkingLevel);
                            const thinkingResult = await this.runtime.setSessionThinkingLevel(sessionId, thinkingLevel);
                            if (!thinkingResult?.ok) throw new Error("Selected thinking level could not be applied.");
                        }
                    }
                    const result = await this.runtime.promptUserTurn(sessionId, {
                        initialRequest: options.text,
                        initialImages: options.images || [],
                        agentName: launch.agentName,
                        preparedModelOverride,
                    });
                    const snapshot = this.runtime.getSessionSnapshot(sessionId);
                    const runwieldSessionId = snapshot?.managed?.runwieldSessionId || null;
                    const generation = snapshot?.managed?.generation ?? (result.ok ? 1 : 0);
                    this.setOperation(operationId, {
                        ...(this.operations.get(operationId) || { projectId: options.projectId, events: [] }),
                        status: result.ok ? "completed" : "failed",
                        generation,
                        runwieldSessionId,
                        error: result.error,
                    });
                } catch (error) {
                    this.setOperation(operationId, {
                        ...(this.operations.get(operationId) || { projectId: options.projectId, events: [] }),
                        status: "failed",
                        error: codeFromError(error),
                    });
                } finally {
                    unsubscribe();
                    if (sessionId) this.preserveTaskOwnerOrClose(sessionId, operationId);
                }
            });
            return { operationId, status: "running", runwieldSessionId: null, generation: null };
        } finally {
            if (this.pendingCreateRequests.get(createKey) === reservation) {
                this.pendingCreateRequests.delete(createKey);
            }
            releasePending();
        }
    }

    /**
     * Open the saved Plan review without sending a user turn. A running review keeps its
     * existing operation and interaction; a dormant Session gets a new operation.
     * @param {{ deviceId?: string | null, projectId: string, runwieldSessionId: string, requestId: string, expectedGeneration: number }} options
     */
    async startPlanReview(options) {
        const session = this.store.getSessionById(options.runwieldSessionId);
        if (!session || !sessionBelongsToOwnerProject(this.store, session, options.projectId)) {
            throw new Error("Session not found.");
        }
        const requestHash = stableHash({
            kind: "reopen_plan_review",
            session: options.runwieldSessionId,
            expectedGeneration: options.expectedGeneration,
        });
        const existing = this.store.findOperationReceiptByRequest({
            deviceId: options.deviceId || null,
            requestId: options.requestId,
            requestHash,
            runwieldSessionId: options.runwieldSessionId,
        });
        if (existing && existing.projectId === options.projectId) {
            return {
                kind: "starting",
                operationId: existing.operationId,
                status: this.operations.get(existing.operationId)?.status || existing.status,
                ...(existing.resultBody || {}),
            };
        }
        const live = await this.liveSession(options.projectId, options.runwieldSessionId);
        const running = live.operation;
        if (running?.status === "running") {
            const review = running.liveInteraction?.request;
            if (review?.type === "plan_review") {
                return {
                    kind: review.reviewUrl ? "live" : "starting",
                    operationId: running.operationId,
                    url: review.reviewUrl || undefined,
                };
            }
            // The runtime can see a review before the Workspace operation receives it.
            const local = this.operations.get(running.operationId);
            if (local?.runtimeSessionId) {
                const result = await this.runtime.reopenPlanReview(local.runtimeSessionId);
                if (result.kind === "live" || result.kind === "starting") {
                    return { ...result, operationId: running.operationId };
                }
            }
            return { kind: "busy", message: "This Session is busy with other work." };
        }
        if (!this.store.getLastPlanReview(options.runwieldSessionId, options.projectId)) {
            return { kind: "no_reference", message: "This Session has no previous Plan review." };
        }
        let inspected = this.store.inspectSessionActivation(options.runwieldSessionId);
        if (!inspected.generation || inspected.generation.generation !== options.expectedGeneration) {
            throw new Error("Plan review requires the exact committed generation.");
        }
        if (inspected.activation?.state !== "idle") {
            try {
                await this.forceRecoverSessionControl({
                    projectId: options.projectId,
                    runwieldSessionId: options.runwieldSessionId,
                    expectedGeneration: options.expectedGeneration,
                });
            } catch (error) {
                if (error instanceof Error && error.message.includes("still open in another RunWield surface")) {
                    return { kind: "busy", message: "This Session is busy with other work." };
                }
                throw error;
            }
            inspected = this.store.inspectSessionActivation(options.runwieldSessionId);
            if (inspected.activation?.state !== "idle") {
                throw new Error("This Session needs recovery before it can open a Plan review.");
            }
        }
        const receipt = requireReceipt(this.store.createOrGetOperationReceipt({
            deviceId: options.deviceId || null,
            requestId: options.requestId,
            requestHash,
            runwieldSessionId: options.runwieldSessionId,
            projectId: options.projectId,
            expectedGeneration: options.expectedGeneration,
            kind: "plan_action",
        }));
        if (receipt.status !== "accepted" || this.operations.has(receipt.operationId)) {
            return { kind: "starting", operationId: receipt.operationId, status: receipt.status };
        }
        // Recovery can commit the killed owner's transcript as a newer generation.
        // Keep the caller's generation in the receipt, but adopt the recovered one.
        if (!inspected.generation) throw new Error("Recovered Session generation is missing.");
        const recoveredGeneration = inspected.generation.generation;
        this.store.updateOperationReceipt(receipt.operationId, { status: "running" });
        this.setOperation(receipt.operationId, {
            status: "running",
            projectId: options.projectId,
            events: [],
            runwieldSessionId: options.runwieldSessionId,
            expectedGeneration: recoveredGeneration,
        });
        this.runBackgroundOperation(async () => {
            let runtimeSessionId = "";
            let unsubscribe = () => {};
            try {
                await this.closingRetainedSessions.get(options.runwieldSessionId);
                const retainedId = this.retainedSessions.get(options.runwieldSessionId)?.sessionId;
                const adopted = retainedId && this.runtime.getSessionSnapshot(retainedId)
                    ? { sessionId: retainedId }
                    : this.runtime.adoptManagedSession({ session, generation: recoveredGeneration });
                runtimeSessionId = adopted.sessionId;
                this.setOperation(receipt.operationId, {
                    ...(this.operations.get(receipt.operationId) || {
                        projectId: options.projectId,
                        events: [],
                        status: "running",
                    }),
                    runtimeSessionId,
                });
                this.runtime.setInteractionAdapter(
                    runtimeSessionId,
                    this.createInteractionAdapter({
                        operationId: receipt.operationId,
                    }),
                );
                unsubscribe = this.runtime.subscribeSessionEvents(runtimeSessionId, (event) => {
                    this.appendOperationEvent(receipt.operationId, event);
                });
                const result = await this.runtime.reopenPlanReview(runtimeSessionId);
                const generation = this.runtime.getSessionSnapshot(runtimeSessionId)?.managed?.generation ??
                    options.expectedGeneration;
                const status =
                    ["busy", "unanswered", "missing_plan", "identity_mismatch", "not_reviewable"].includes(result.kind)
                        ? "failed"
                        : "completed";
                this.store.updateOperationReceipt(receipt.operationId, {
                    status,
                    resultGeneration: generation,
                    resultBody: result,
                    ...(status === "failed" && { errorMessage: result.message }),
                });
                this.setOperation(receipt.operationId, {
                    ...(this.operations.get(receipt.operationId) || { projectId: options.projectId, events: [] }),
                    status,
                    generation,
                    ...(status === "failed" && { error: result.message }),
                });
            } catch (error) {
                const errorCode = codeFromError(error);
                this.store.updateOperationReceipt(receipt.operationId, {
                    status: "failed",
                    errorCode,
                    errorMessage: error instanceof Error ? error.message : String(error),
                });
                this.setOperation(receipt.operationId, {
                    ...(this.operations.get(receipt.operationId) || { projectId: options.projectId, events: [] }),
                    status: "failed",
                    error: error instanceof Error ? error.message : String(error),
                });
            } finally {
                unsubscribe();
                if (runtimeSessionId) this.preserveTaskOwnerOrClose(runtimeSessionId, receipt.operationId);
            }
        });
        return { kind: "starting", operationId: receipt.operationId, status: "running" };
    }

    /** @param {string} runwieldSessionId @param {{ sessionId: string } | null} adopted */
    releasePreflightSession(runwieldSessionId, adopted) {
        if (adopted?.sessionId && adopted.sessionId !== this.retainedSessions.get(runwieldSessionId)?.sessionId) {
            void this.runtime.closeSession(adopted.sessionId);
        }
    }

    /**
     * @param {{ deviceId?: string | null, projectId: string, runwieldSessionId: string, requestId: string, expectedGeneration: number, text: string, images?: Array<{ base64: string, mimeType: string }> }} options
     */
    async startContinuation(options) {
        if (!options.text?.trim() && !options.images?.length) throw new Error("A message or image is required.");
        this.openingContinuations.set(
            options.runwieldSessionId,
            (this.openingContinuations.get(options.runwieldSessionId) || 0) + 1,
        );
        try {
            await this.closingRetainedSessions.get(options.runwieldSessionId);
            const requestHash = stableHash({
                kind: "continuation",
                session: options.runwieldSessionId,
                expectedGeneration: options.expectedGeneration,
                text: options.text,
                images: options.images || [],
            });
            const existingReceipt = this.store.findOperationReceiptByRequest({
                deviceId: options.deviceId || null,
                requestId: options.requestId,
                requestHash,
                runwieldSessionId: options.runwieldSessionId,
            });
            if (existingReceipt && existingReceipt.projectId === options.projectId) {
                return {
                    operationId: existingReceipt.operationId,
                    status: this.operations.get(existingReceipt.operationId)?.status || existingReceipt.status,
                    generation: existingReceipt.resultGeneration,
                };
            }
            const session = this.store.getSessionById(options.runwieldSessionId);
            if (!session || !sessionBelongsToOwnerProject(this.store, session, options.projectId)) {
                throw new Error("Session not found.");
            }
            const inspected = this.store.inspectSessionActivation(options.runwieldSessionId);
            if (!inspected.generation || inspected.generation.generation !== options.expectedGeneration) {
                throw new Error("Continuation requires the exact committed generation.");
            }
            if (inspected.activation?.state === "active") {
                throw new Error(
                    "This Session is still busy. Keep the message queued in this browser until it finishes.",
                );
            }
            if (inspected.activation?.state !== "idle") {
                throw new Error("This Session needs recovery before it can accept messages.");
            }
            const projection = await projectAggregateTranscript({
                cwd: session.transcriptCwd,
                sessionDir: getRunWieldSessionDir(session.transcriptCwd),
                runwieldSessionId: options.runwieldSessionId,
                generation: inspected.generation,
                segments: this.store.listSessionTranscriptSegments(options.runwieldSessionId),
                limit: 500,
            });
            if (!projection.ok) throw new Error(projection.message);
            const committedFacts = getCommittedTranscriptAuthorityFacts(projection);
            const decision = deriveManagedSessionContinuationDecision({
                activation: inspected.activation,
                generation: inspected.generation,
                projection,
                expectedGeneration: options.expectedGeneration,
            });
            if (!decision.ok) throw new Error(decision.message);
            let preflightAdopted = null;
            let preparedModelOverride = "";
            if ((options.images || []).length > 0) {
                try {
                    const retained = this.retainedSessions.get(options.runwieldSessionId)?.sessionId;
                    preflightAdopted = retained && this.runtime.getSessionSnapshot(retained)
                        ? { sessionId: retained }
                        : this.runtime.adoptManagedSession({
                            session,
                            generation: options.expectedGeneration,
                            activeAgent: committedFacts.activeAgent,
                            model: committedFacts.model,
                            provider: committedFacts.provider,
                            thinkingLevel: committedFacts.thinkingLevel,
                            workflowContext:
                                /** @type {import('../../../shared/session/workflow-context-session.js').WorkflowContext | null} */ (committedFacts
                                    .workflowContext || null),
                        });
                    const preflight = await this.runtime.preflightUserTurnImages(preflightAdopted.sessionId, {
                        initialRequest: options.text,
                        initialImages: options.images || [],
                        agentName: decision.agentName,
                    });
                    if (!preflight.ok) throw new ImageSubmissionValidationError(preflight.message);
                    preparedModelOverride = "preparedModelOverride" in preflight
                        ? preflight.preparedModelOverride || ""
                        : "";
                } catch (error) {
                    this.releasePreflightSession(options.runwieldSessionId, preflightAdopted);
                    throw error;
                }
            }
            const matchingReceipt = this.store.findOperationReceiptByRequest({
                deviceId: options.deviceId || null,
                requestId: options.requestId,
                requestHash,
                runwieldSessionId: options.runwieldSessionId,
            });
            if (matchingReceipt && matchingReceipt.projectId === options.projectId) {
                this.releasePreflightSession(options.runwieldSessionId, preflightAdopted);
                return {
                    operationId: matchingReceipt.operationId,
                    status: this.operations.get(matchingReceipt.operationId)?.status || matchingReceipt.status,
                    generation: matchingReceipt.resultGeneration,
                };
            }
            const currentSession = this.store.getSessionById(options.runwieldSessionId);
            if (!currentSession || !sessionBelongsToOwnerProject(this.store, currentSession, options.projectId)) {
                this.releasePreflightSession(options.runwieldSessionId, preflightAdopted);
                throw new Error("Session not found.");
            }
            const currentState = this.store.inspectSessionActivation(options.runwieldSessionId);
            if (!currentState.generation || currentState.generation.generation !== options.expectedGeneration) {
                this.releasePreflightSession(options.runwieldSessionId, preflightAdopted);
                throw new Error("Continuation requires the exact committed generation.");
            }
            if (currentState.activation?.state === "active") {
                this.releasePreflightSession(options.runwieldSessionId, preflightAdopted);
                throw new Error(
                    "This Session is still busy. Keep the message queued in this browser until it finishes.",
                );
            }
            if (currentState.activation?.state !== "idle") {
                this.releasePreflightSession(options.runwieldSessionId, preflightAdopted);
                throw new Error("This Session needs recovery before it can accept messages.");
            }
            let receipt;
            try {
                receipt = requireReceipt(this.store.createOrGetOperationReceipt({
                    deviceId: options.deviceId || null,
                    requestId: options.requestId,
                    requestHash,
                    runwieldSessionId: options.runwieldSessionId,
                    projectId: options.projectId,
                    expectedGeneration: options.expectedGeneration,
                    kind: "continuation",
                }));
            } catch (error) {
                this.releasePreflightSession(options.runwieldSessionId, preflightAdopted);
                throw error;
            }
            if (this.operations.has(receipt.operationId)) {
                this.releasePreflightSession(options.runwieldSessionId, preflightAdopted);
                return {
                    operationId: receipt.operationId,
                    status: this.operations.get(receipt.operationId)?.status || "running",
                };
            }
            if (receipt.status !== "accepted") {
                this.releasePreflightSession(options.runwieldSessionId, preflightAdopted);
                return {
                    operationId: receipt.operationId,
                    status: receipt.status,
                    generation: receipt.resultGeneration,
                };
            }
            this.store.updateOperationReceipt(receipt.operationId, { status: "running" });
            this.setOperation(receipt.operationId, {
                status: "running",
                projectId: options.projectId,
                events: [],
                runwieldSessionId: options.runwieldSessionId,
                expectedGeneration: options.expectedGeneration,
            });
            const retainedId = this.retainedSessions.get(options.runwieldSessionId)?.sessionId;
            const retainedSessionId = retainedId && this.runtime.getSessionSnapshot(retainedId) ? retainedId : null;
            const adopted = preflightAdopted ||
                (retainedSessionId ? { sessionId: retainedSessionId } : this.runtime.adoptManagedSession({
                    session,
                    generation: options.expectedGeneration,
                    activeAgent: committedFacts.activeAgent,
                    model: committedFacts.model,
                    provider: committedFacts.provider,
                    thinkingLevel: committedFacts.thinkingLevel,
                    workflowContext:
                        /** @type {import('../../../shared/session/workflow-context-session.js').WorkflowContext | null} */ (committedFacts
                            .workflowContext || null),
                }));
            this.setOperation(receipt.operationId, {
                ...(this.operations.get(receipt.operationId) || { projectId: options.projectId, events: [] }),
                status: "running",
                runtimeSessionId: adopted.sessionId,
            });
            this.runtime.setInteractionAdapter(
                adopted.sessionId,
                this.createInteractionAdapter({ operationId: receipt.operationId }),
            );
            this.retainContinuationSession(options.runwieldSessionId, adopted.sessionId, receipt.operationId);
            this.runBackgroundOperation(async () => {
                try {
                    const result = await this.runtime.promptUserTurn(adopted.sessionId, {
                        initialRequest: options.text,
                        initialImages: options.images || [],
                        agentName: decision.agentName,
                        preparedModelOverride,
                    });
                    const effectiveSessionId = result.replacementSessionId || adopted.sessionId;
                    const effectiveSnapshot = this.runtime.getSessionSnapshot(effectiveSessionId);
                    let generation = effectiveSnapshot?.managed?.generation ?? options.expectedGeneration;
                    /** @type {"completed" | "failed"} */
                    let status = result.ok ? "completed" : "failed";
                    let error = result.error;
                    const pendingConfiguration = this.operations.get(receipt.operationId)?.pendingConfiguration || null;
                    if (result.ok && pendingConfiguration && Object.keys(pendingConfiguration).length) {
                        try {
                            await this.applyPendingConfiguration(effectiveSessionId, pendingConfiguration);
                            const snapshot = this.runtime.getSessionSnapshot(effectiveSessionId);
                            generation = snapshot?.managed?.generation ?? generation;
                        } catch (configurationError) {
                            status = "failed";
                            error = configurationError instanceof Error
                                ? configurationError.message
                                : String(configurationError || "Configuration change failed.");
                        }
                    }
                    this.store.updateOperationReceipt(receipt.operationId, {
                        status,
                        resultGeneration: generation,
                        errorCode: error || null,
                        errorMessage: error || null,
                    });
                    this.setOperation(receipt.operationId, {
                        ...(this.operations.get(receipt.operationId) || { projectId: options.projectId, events: [] }),
                        status,
                        generation,
                        error,
                        pendingConfiguration: status === "completed" ? undefined : pendingConfiguration || undefined,
                    });
                } catch (error) {
                    const errorCode = codeFromError(error);
                    this.store.updateOperationReceipt(receipt.operationId, {
                        status: "failed",
                        errorCode,
                        errorMessage: error instanceof Error ? error.message : String(error),
                    });
                    this.setOperation(receipt.operationId, {
                        ...(this.operations.get(receipt.operationId) || { projectId: options.projectId, events: [] }),
                        status: "failed",
                        error: errorCode,
                    });
                } finally {
                    void this.releaseRetainedIfDrained(options.runwieldSessionId);
                }
            });
            return { operationId: receipt.operationId, status: "running" };
        } finally {
            const remaining = (this.openingContinuations.get(options.runwieldSessionId) || 1) - 1;
            if (remaining) this.openingContinuations.set(options.runwieldSessionId, remaining);
            else this.openingContinuations.delete(options.runwieldSessionId);
        }
    }

    /**
     * @param {{ deviceId?: string | null, projectId: string, operationId: string, interactionId: string, runwieldSessionId?: string | null, requestId: string, response: unknown }} options
     */
    async answerInteraction(options) {
        const operation = this.operations.get(options.operationId);
        const durable = this.store.getOperationReceipt(options.operationId);
        const operationProjectId = operation?.projectId || durable?.projectId || null;
        if (operationProjectId !== options.projectId) {
            throw new Error("Live Workspace interaction is not available for this Project.");
        }
        const requestHash = stableHash({
            kind: "interaction_answer",
            operationId: options.operationId,
            interactionId: options.interactionId,
            response: options.response,
        });
        const operationSessionId = operation?.runwieldSessionId || options.runwieldSessionId || null;
        const existingReceipt = operationSessionId
            ? this.store.findOperationReceiptByRequest({
                deviceId: options.deviceId || null,
                requestId: options.requestId,
                requestHash,
                runwieldSessionId: operationSessionId,
            })
            : null;
        if (existingReceipt?.status === "completed" && existingReceipt.resultBody) return existingReceipt.resultBody;
        if (existingReceipt && existingReceipt.status !== "accepted") {
            throw new Error("Interaction answer request is already in progress.");
        }
        if (!operation || operation.status !== "running" || !operation.liveInteraction || !operation.answer) {
            throw new Error("Live Workspace interaction is not available.");
        }
        if (operation.liveInteraction.interactionId !== options.interactionId) {
            throw new Error("Interaction id does not match the live Workspace operation.");
        }
        if (options.runwieldSessionId && operation.runwieldSessionId !== options.runwieldSessionId) {
            throw new Error("Interaction Session does not match the live Workspace operation.");
        }
        if (!operation.runwieldSessionId) throw new Error("Live Workspace interaction is missing Session evidence.");
        const receipt = existingReceipt || requireReceipt(this.store.createOrGetOperationReceipt({
            deviceId: options.deviceId || null,
            requestId: options.requestId,
            requestHash,
            runwieldSessionId: operation.runwieldSessionId,
            projectId: options.projectId,
            expectedGeneration: null,
            kind: "plan_action",
        }));
        this.store.updateOperationReceipt(receipt.operationId, { status: "running" });
        try {
            let runtimeResponse = acceptedInteractionResponse(options.response);
            const request = operation.liveInteraction.request;
            const planReview = request?.planReview && typeof request.planReview === "object"
                ? /** @type {Record<string, unknown>} */ (request.planReview)
                : null;
            if (request?.type === "plan_review" && Array.isArray(planReview?.sequenceDocuments)) {
                const decision = readPlanReviewDecisionMeta(options.response);
                const location = await resolveWorkflowPlanLocation(
                    requireOwnerProjectRoot(this.store, options.projectId),
                    String(planReview.planName),
                );
                await validateSequenceReviewDecision(
                    location.documentRoot,
                    /** @type {import('../../../shared/workflow/sequence-review.ts').SequenceReviewDocument[]} */ (planReview
                        .sequenceDocuments),
                    /** @type {import('../../../shared/workflow/sequence-review.ts').SequenceReviewDecision} */ (decision),
                );
                runtimeResponse = {
                    outcome: "accepted",
                    _meta: {
                        approved: decision.approved === true,
                        approvalAction: decision.approvalAction,
                        feedback: decision.feedback,
                        sequenceDecision: decision,
                        ...(decision.conversationTurn === true && { conversationTurn: true }),
                    },
                };
            } else if (request?.type === "plan_review" && planReview) {
                const root = requireOwnerProjectRoot(this.store, options.projectId);
                const planId = String(planReview.planId || "");
                const source = planReview.reviewedSource && typeof planReview.reviewedSource === "object"
                    ? /** @type {Record<string, unknown>} */ (planReview.reviewedSource)
                    : null;
                if (
                    !source || typeof source.markdown !== "string" || typeof source.path !== "string" ||
                    typeof source.planName !== "string" || !source.attrs || typeof source.attrs !== "object"
                ) {
                    throw new Error("Live review source is missing. Reload the Plan and review again.");
                }
                const attrs = /** @type {import('../../../plan-store.js').PlanFrontMatter} */ (source.attrs);
                const decision = readPlanReviewDecisionMeta(options.response);
                const actionResult = await applySharedPlanReviewDecision({
                    cwd: root,
                    planName: source.planName,
                    planPath: source.path,
                    planWithFrontMatter: source.markdown,
                    planRevision: String(source.revision || planReview.expectedRevision || ""),
                    originalAttrs: attrs,
                    trustedClassification:
                        /** @type {import('../../../plan-store.js').PlanFrontMatter['classification']} */ (planReview
                            .classification),
                    trustedWorkKind: attrs.workKind,
                    expectedSessionId: operation.runwieldSessionId,
                    reviewEvidence: {
                        planId,
                        runwieldSessionId: operation.runwieldSessionId,
                        status: String(planReview.expectedStatus || ""),
                        worktree:
                            /** @type {import('../../../shared/workflow/plan-actions.ts').PlanWorktreeExpectation} */ (planReview
                                .expectedWorktree),
                    },
                    decision:
                        /** @type {import('../../../shared/workflow/plan-review-actions.ts').SharedPlanReviewDecision} */ (decision),
                });
                if (actionResult.recoveryRequired) {
                    const result = {
                        status: "recovery_required",
                        message: actionResult.recoveryRequired.message,
                        entryIds: actionResult.recoveryRequired.entryIds,
                    };
                    this.store.updateOperationReceipt(receipt.operationId, {
                        status: "completed",
                        resultBody: { result },
                    });
                    return result;
                }
                if (actionResult.cancellationReason) {
                    const message = actionResult.feedback ||
                        "Plan review evidence is stale. Reload the Plan and review again.";
                    operation.answer.reject(new Error(message));
                    this.setOperation(options.operationId, {
                        ...operation,
                        liveInteraction: undefined,
                        answer: null,
                    });
                    throw new Error(message);
                }
                const images = await loadReviewFeedbackImages(
                    /** @type {import('../../../shared/workflow/review-feedback-images.ts').ReviewImageDecision} */ (decision),
                    root,
                );
                runtimeResponse = {
                    outcome: "accepted",
                    _meta: {
                        ...actionResult,
                        ...(decision.conversationTurn === true && { conversationTurn: true }),
                        ...(images.length > 0 && { images }),
                    },
                };
            }
            await operation.answer.resolve(runtimeResponse);
            this.codeReviewRefreshContexts.delete(`${options.operationId}:${options.interactionId}`);
            this.setOperation(options.operationId, { ...operation, liveInteraction: undefined, answer: null });
            const result = { status: "accepted" };
            this.store.updateOperationReceipt(receipt.operationId, { status: "completed", resultBody: result });
            return result;
        } catch (error) {
            this.store.updateOperationReceipt(receipt.operationId, {
                status: "failed",
                errorCode: "interaction_answer_failed",
                errorMessage: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    /**
     * @param {{ projectId: string, operationId: string, interactionId: string, runwieldSessionId: string, planId: string }} options
     */
    async getLivePlanReview(options) {
        if (!this.operations.has(options.operationId) || this.operations.get(options.operationId)?.remote) {
            await this.liveSession(options.projectId, options.runwieldSessionId);
        }
        const operation = this.operations.get(options.operationId);
        if (!operation || operation.status !== "running" || operation.projectId !== options.projectId) return null;
        if (operation.runwieldSessionId !== options.runwieldSessionId) return null;
        if (!operation.liveInteraction || operation.liveInteraction.interactionId !== options.interactionId) {
            return null;
        }
        const request = operation.liveInteraction.request || {};
        if (request.type !== "plan_review") return null;
        const planReview = request.planReview && typeof request.planReview === "object"
            ? /** @type {Record<string, unknown>} */ (request.planReview)
            : null;
        if (!planReview || planReview.planId !== options.planId) return null;
        return { operationId: options.operationId, interactionId: options.interactionId, request };
    }

    /**
     * @param {{ projectId: string, operationId: string, interactionId: string, runwieldSessionId: string }} options
     */
    async getLiveCodeReview(options) {
        if (!this.operations.has(options.operationId) || this.operations.get(options.operationId)?.remote) {
            await this.liveSession(options.projectId, options.runwieldSessionId);
        }
        const operation = this.operations.get(options.operationId);
        if (!operation || operation.status !== "running" || operation.projectId !== options.projectId) return null;
        if (operation.runwieldSessionId !== options.runwieldSessionId) return null;
        if (!operation.liveInteraction || operation.liveInteraction.interactionId !== options.interactionId) {
            return null;
        }
        const request = operation.liveInteraction.request || {};
        if (request.type !== "code_review") return null;
        const codeReview = request.codeReview && typeof request.codeReview === "object"
            ? /** @type {Record<string, unknown>} */ (request.codeReview)
            : null;
        if (!codeReview || typeof codeReview.rawPatch !== "string") return null;
        const refresh = this.codeReviewRefreshContexts.get(`${options.operationId}:${options.interactionId}`);
        let rawPatch = String(codeReview.rawPatch);
        if (refresh) {
            try {
                rawPatch = await getWorktreeReviewDiff(refresh.cwd, refresh.targetBranch);
            } catch (error) {
                if (error instanceof WorktreeReviewComparisonError) throw error;
                // Keep the last complete interaction patch while the checkout is temporarily unreadable.
            }
        }
        return {
            operationId: options.operationId,
            interactionId: options.interactionId,
            request: { ...request, codeReview: { ...codeReview, rawPatch } },
        };
    }

    /**
     * @param {{ projectId: string, runwieldSessionId: string, expectedGeneration: number, expectedCurrentSegmentId?: string | null }} options
     */
    async forceRecoverSessionControl(options) {
        const session = this.store.getSessionById(options.runwieldSessionId);
        if (!session || !sessionBelongsToOwnerProject(this.store, session, options.projectId)) {
            throw new Error("Session not found.");
        }
        const inspected = this.store.inspectSessionActivation(options.runwieldSessionId);
        if (!inspected.generation) {
            return await this.runtime.ensureInitialSessionGeneration(options.runwieldSessionId);
        }
        const projection = await projectAggregateTranscript({
            cwd: session.transcriptCwd,
            sessionDir: getRunWieldSessionDir(session.transcriptCwd),
            runwieldSessionId: options.runwieldSessionId,
            generation: inspected.generation,
            segments: this.store.listSessionTranscriptSegments(options.runwieldSessionId),
            limit: 1,
        });
        if (!projection.ok) throw new Error(projection.message);
        const currentSegment = this.store.listSessionTranscriptSegments(options.runwieldSessionId)
            .find((segment) => segment.segmentId === inspected.generation?.currentSegmentId);
        if (!currentSegment) throw new Error("Current transcript segment is missing.");
        const evidence = await validateExpiredControlTranscriptEvidence({
            transcriptPath: currentSegment.transcriptPath,
            transcriptCwd: currentSegment.transcriptCwd,
            committedGeneration: inspected.generation,
        });
        return this.store.recoverSessionControl({
            runwieldSessionId: options.runwieldSessionId,
            projectId: options.projectId,
            expectedFence: inspected.activation?.fence ?? 0,
            expectedGeneration: options.expectedGeneration,
            expectedCurrentSegmentId: options.expectedCurrentSegmentId ?? inspected.generation.currentSegmentId,
            ownerInstanceId: this.ownerInstanceId,
            ownerProcessKind: "workspace",
            transcriptEvidence: { ...evidence, currentSegmentId: inspected.generation.currentSegmentId },
        });
    }

    /**
     * Open a saved Plan review without requiring the user to create an empty Session first.
     * The request receipt keeps retries attached to the same Session and review.
     * @param {Omit<Parameters<WorkspaceSessionContinuationService["startPlanWorkflowHandoff"]>[0], "runwieldSessionId" | "expectedGeneration">} options
     * @returns {ReturnType<WorkspaceSessionContinuationService["startPlanWorkflowOperation"]>}
     */
    async startSavedPlanReview(options) {
        const requestHash = stableHash({
            kind: "saved_plan_review",
            projectId: options.projectId,
            planId: options.triageMeta?.planId,
            action: options.action,
        });
        const key = `plan:${options.deviceId || ""}:${options.projectId}:${options.requestId}`;
        const pending = this.pendingCreateRequests.get(key);
        if (pending) {
            if (pending.requestHash !== requestHash) {
                throw new Error("Operation request id was reused with different input");
            }
            await pending.settled;
            return await this.startSavedPlanReview(options);
        }
        const existing = this.store.findOperationReceiptByRequest({
            deviceId: options.deviceId,
            requestId: options.requestId,
            requestHash,
            projectId: options.projectId,
        });
        if (existing) {
            const operation = this.getOperation(existing.operationId);
            return operation.liveInteraction?.request.planReview
                ? await this.waitForPlanReview(existing.operationId)
                : operation;
        }
        if (!["approved", "ready_for_work"].includes(String(options.triageMeta?.status))) {
            throw new Error("Plan review requires an approved Plan waiting for execution.");
        }
        const ready = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        this.pendingCreateRequests.set(key, { requestHash, settled: ready.promise });
        try {
            const created = await this.runtime.createInteractiveSession({
                cwd: requireOwnerProjectRoot(this.store, options.projectId),
                mode: "new",
            });
            const managed = this.runtime.getSessionSnapshot(created.sessionId)?.managed;
            if (!managed) throw new Error("Plan review Session could not be created.");
            await this.runtime.recordPlanAssociation(created.sessionId, {
                planId: String(options.triageMeta?.planId),
                planName: options.planName,
                purpose: "review",
            });
            const generation = this.store.inspectSessionActivation(managed.runwieldSessionId).generation?.generation;
            if (generation === undefined) throw new Error("Plan review Session generation is unavailable.");
            await this.runtime.closeSessionWhenIdle(created.sessionId);
            return await this.startPlanWorkflowOperation(
                {
                    ...options,
                    runwieldSessionId: managed.runwieldSessionId,
                    expectedGeneration: generation,
                },
                true,
                requestHash,
            );
        } finally {
            this.pendingCreateRequests.delete(key);
            ready.resolve();
        }
    }

    /**
     * @param {{ requestId: string, deviceId?: string | null, action?: string, runwieldSessionId: string, projectId: string, expectedGeneration: number, planName: string, planContent?: string, triageMeta?: Record<string, unknown>, reviewFeedback?: string, reviewImages?: Array<{ base64: string, mimeType: string }> }} options
     */
    async startPlanWorkflowHandoff(options) {
        const session = this.store.getSessionById(options.runwieldSessionId);
        if (!session || !sessionBelongsToOwnerProject(this.store, session, options.projectId)) {
            throw new Error("Session not found.");
        }
        const requestHash = stableHash({
            kind: "plan_workflow",
            action: options.action || "run",
            session: options.runwieldSessionId,
            planId: options.triageMeta?.planId,
            generation: options.expectedGeneration,
        });
        const existing = this.store.findOperationReceiptByRequest({
            deviceId: options.deviceId || null,
            requestId: options.requestId,
            requestHash,
            runwieldSessionId: options.runwieldSessionId,
        });
        if (existing?.projectId === options.projectId) {
            const operation = this.operations.get(existing.operationId);
            if (operation?.liveInteraction?.request.planReview) {
                return await this.waitForPlanReview(existing.operationId);
            }
            return this.getOperation(existing.operationId);
        }
        const inspected = this.store.inspectSessionActivation(options.runwieldSessionId);
        if (!inspected.generation || inspected.generation.generation !== options.expectedGeneration) {
            throw new Error("Plan execution requires the exact committed generation.");
        }
        if (!options.triageMeta) throw new Error("Plan execution handoff requires approval-time Plan action evidence.");
        const status = String(options.triageMeta.status || "");
        if (options.action === "retry_work_record") {
            // The existing retry authority resolves sealed publication evidence. A preserved
            // primary Plan can still say ready_for_work after successful remote delivery.
            return await this.startPlanWorkflowOperation(options, false, requestHash);
        }
        const review = ["approved", "ready_for_work"].includes(status);
        if (options.action === "review_plan" && !review) {
            throw new Error("Plan review requires an approved Plan waiting for execution. Refresh its progress.");
        }
        if (
            !review &&
            ![
                "in_progress",
                "failed",
                "ready_for_decomposition",
                "implemented",
                "reviewed",
                "validated_ci",
                "reviewed",
                "validated",
            ].includes(status)
        ) {
            throw new Error("This Plan has no continuation available. Refresh its progress.");
        }
        return await this.startPlanWorkflowOperation(options, review, requestHash);
    }

    /**
     * @param {Parameters<WorkspaceSessionContinuationService["startPlanWorkflowHandoff"]>[0]} options
     * @param {boolean} review
     * @param {string} requestHash
     */
    async startPlanWorkflowOperation(options, review, requestHash) {
        const planId = String(options.triageMeta?.planId || "");
        const live = [...this.operations.entries()].find(([, operation]) =>
            operation.projectId === options.projectId && operation.runwieldSessionId === options.runwieldSessionId &&
            operation.status === "running"
        );
        if (live) {
            const existingReview =
                /** @type {ReturnType<typeof safePlanReviewReference>} */ (live[1].liveInteraction?.request.planReview);
            if (!review || existingReview?.planId !== planId) {
                throw new Error("This Session is busy.");
            }
            return await this.waitForPlanReview(live[0]);
        }
        const state = this.store.inspectSessionActivation(options.runwieldSessionId);
        if (state.activation?.state !== "idle") throw new Error("This Session is busy.");
        const receipt = requireReceipt(this.store.createOrGetOperationReceipt({
            deviceId: options.deviceId || null,
            requestId: options.requestId,
            requestHash,
            runwieldSessionId: options.runwieldSessionId,
            projectId: options.projectId,
            expectedGeneration: options.expectedGeneration,
            kind: "continuation",
        }));
        if (!receipt.wasCreated || receipt.status !== "accepted") {
            return review ? await this.waitForPlanReview(receipt.operationId) : this.getOperation(receipt.operationId);
        }
        const session = this.store.getSessionById(options.runwieldSessionId);
        if (!session) throw new Error("Session not found.");
        await this.closingRetainedSessions.get(options.runwieldSessionId);
        const retainedId = this.retainedSessions.get(options.runwieldSessionId)?.sessionId;
        const adopted = retainedId && this.runtime.getSessionSnapshot(retainedId)
            ? { sessionId: retainedId }
            : this.runtime.adoptManagedSession({ session, generation: options.expectedGeneration });
        const operationId = receipt.operationId;
        this.store.updateOperationReceipt(operationId, { status: "running" });
        this.setOperation(operationId, {
            status: "running",
            projectId: options.projectId,
            planId,
            events: [],
            runwieldSessionId: options.runwieldSessionId,
            runtimeSessionId: adopted.sessionId,
            expectedGeneration: options.expectedGeneration,
        });
        this.runtime.setInteractionAdapter(adopted.sessionId, this.createInteractionAdapter({ operationId }));
        const unsubscribe = this.runtime.subscribeSessionEvents(
            adopted.sessionId,
            (event) => this.appendOperationEvent(operationId, event),
        );
        this.runBackgroundOperation(async () => {
            let error;
            try {
                const status = String(options.triageMeta?.status || "");
                const result = options.action === "retry_work_record"
                    ? await this.runtime.retryWorkRecord(adopted.sessionId, options.planName)
                    : review
                    ? await this.runtime.reviewSavedPlan(adopted.sessionId, planId)
                    : status === "ready_for_decomposition"
                    ? await this.runtime.runSlicerAgent(adopted.sessionId, {
                        planName: options.planName,
                        triageMeta: options.triageMeta,
                    })
                    : ["in_progress", "failed"].includes(status)
                    ? await this.resumePlanExecution(adopted.sessionId, options)
                    : await this.runtime.runValidation(adopted.sessionId, {
                        planName: options.planName,
                        planContent: options.planContent || "",
                        triageMeta: options.triageMeta,
                        trigger: options.action === "recover" ? "repair" : "session_resume",
                        expectedGeneration: options.expectedGeneration,
                    });
                if (result?.error) throw new Error(result.error);
                if (result && "kind" in result && result.kind === "failed") {
                    throw new Error(result.reason || "Plan continuation failed. Open the Session for details.");
                }
            } catch (failure) {
                error = failure instanceof Error ? failure.message : String(failure);
            } finally {
                const generation = this.store.inspectSessionActivation(options.runwieldSessionId).generation
                    ?.generation;
                const status = error ? "failed" : "completed";
                this.store.updateOperationReceipt(operationId, {
                    status,
                    resultGeneration: generation,
                    errorCode: error ? "plan_workflow_failed" : null,
                    errorMessage: error || null,
                });
                this.setOperation(operationId, {
                    projectId: options.projectId,
                    events: [],
                    ...this.operations.get(operationId),
                    status,
                    generation,
                    error,
                });
                unsubscribe();
                this.preserveTaskOwnerOrClose(adopted.sessionId, operationId);
            }
        });
        return review ? await this.waitForPlanReview(operationId) : { operationId, status: "running" };
    }

    /**
     * @param {string} sessionId
     * @param {Parameters<WorkspaceSessionContinuationService["startPlanWorkflowHandoff"]>[0]} options
     */
    async resumePlanExecution(sessionId, options) {
        const result = await this.runtime.executePlan(sessionId, {
            planName: options.planName,
            triageMeta: options.triageMeta,
            expectedGeneration: options.expectedGeneration,
        });
        if (result.error || !result.executionComplete) return result;
        return await this.runtime.runValidation(sessionId, {
            planName: options.planName,
            planContent: options.planContent || "",
            triageMeta: options.triageMeta,
            executionContext: result.executionContext,
            trigger: "execution_completion",
        });
    }

    /** @param {string} operationId */
    async waitForPlanReview(operationId) {
        /** @type {PromiseWithResolvers<WorkspacePlanReviewStarted>} */
        const ready = Promise.withResolvers();
        const unsubscribe = this.subscribeOperation(operationId, () => {
            const operation = this.operations.get(operationId);
            const reviewUrl = operation?.liveInteraction?.request.reviewUrl;
            if (typeof reviewUrl === "string" && reviewUrl) ready.resolve({ operationId, reviewUrl });
            else if (!operation || operation.status !== "running") {
                ready.reject(new Error(operation?.error || "Plan review is no longer active. Refresh and try again."));
            }
        });
        try {
            return await ready.promise;
        } finally {
            unsubscribe();
        }
    }

    /** @param {string} projectId @param {string} runwieldSessionId */
    async liveSession(projectId, runwieldSessionId) {
        const session = this.store.getSessionById(runwieldSessionId);
        if (!session || !sessionBelongsToOwnerProject(this.store, session, projectId)) {
            throw new Error("Session not found.");
        }
        const inspected = this.store.inspectSessionActivation(runwieldSessionId);
        const state = inspected.activation?.state || "uninitialized";
        const generation = inspected.generation?.generation ?? null;
        const local = [...this.operations.entries()].find(([, operation]) =>
            !operation.remote && operation.runwieldSessionId === runwieldSessionId && operation.status === "running"
        );
        if (local) return { state, generation, operation: this.getOperation(local[0]) };
        const operationId = inspected.activation?.operationId;
        if (state !== "active" || !operationId) return { state, generation, operation: null };
        let live;
        try {
            live = await readLiveSessionConnection(runwieldSessionId, operationId);
        } catch {
            // The process may still be opening or finishing its turn. Retry on the next observation.
            return { state, generation, operation: null };
        }
        this.setOperation(operationId, {
            status: "running",
            projectId,
            runwieldSessionId,
            remote: true,
            generation,
            events: live.events,
            sessionInfo: live.sessionInfo,
            queuedMessages: live.queuedMessages,
        });
        if (live.interaction) {
            const interactionId = live.interaction.id;
            this.registerInteraction(operationId, live.interaction, {
                resolve: async (response) => {
                    await this.watchRemoteNotifications(operationId, this.operations.get(operationId));
                    await readLiveSessionConnection(runwieldSessionId, operationId, {
                        action: "answer",
                        inputSurface: "workspace",
                        interactionId,
                        response,
                    });
                },
                reject: () => {
                    void readLiveSessionConnection(runwieldSessionId, operationId, {
                        action: "answer",
                        inputSurface: "workspace",
                        interactionId,
                        response: { outcome: "canceled" },
                    }).catch(() => {});
                },
            });
        }
        return { state, generation, operation: this.getOperation(operationId) };
    }

    /** @param {string} operationId */
    async refreshOperation(operationId) {
        const operation = this.operations.get(operationId);
        if (operation?.remote && operation.runwieldSessionId && operation.status === "running") {
            const live = await this.liveSession(operation.projectId, operation.runwieldSessionId);
            if (
                live.operation?.operationId !== operationId &&
                (live.state !== "active" || live.operation || live.generation !== operation.generation)
            ) {
                this.setOperation(operationId, {
                    ...operation,
                    status: live.state === "idle" || live.generation !== operation.generation ? "completed" : "unknown",
                    liveInteraction: undefined,
                    answer: null,
                });
            } else if (!live.operation) {
                this.setOperation(operationId, { ...operation, liveInteraction: undefined, answer: null });
            }
        }
        return this.getOperation(operationId);
    }

    /** @param {string} operationId */
    getOperation(operationId) {
        const live = this.operations.get(operationId);
        const durable = this.store.getOperationReceipt(operationId);
        const sessionInfo = live?.runtimeSessionId
            ? projectLiveSessionInfo(this.runtime.getSessionSnapshot(live.runtimeSessionId))
            : live?.sessionInfo || null;
        if (!durable) {
            if (!live) return { operationId, status: "unknown", events: [] };
            const { answer: _answer, runtimeSessionId: _runtimeSessionId, ...snapshot } = live;
            return {
                operationId,
                ...snapshot,
                sessionInfo,
                queuedMessages: live.runtimeSessionId
                    ? this.runtime.getQueuedMessages(live.runtimeSessionId)
                    : live.queuedMessages || [],
            };
        }
        if (!live && (durable.status === "accepted" || durable.status === "running")) {
            return {
                operationId,
                status: "unknown",
                generation: durable.resultGeneration,
                error: "operation_not_running",
                events: [],
            };
        }
        return {
            operationId,
            runwieldSessionId: live?.runwieldSessionId || durable.runwieldSessionId,
            status: durable.status,
            generation: durable.resultGeneration,
            error: durable.errorMessage || durable.errorCode,
            events: live?.events || [],
            sessionInfo,
            queuedMessages: live?.runtimeSessionId
                ? this.runtime.getQueuedMessages(live.runtimeSessionId)
                : live?.queuedMessages || [],
            liveInteraction: live?.liveInteraction || null,
            pendingConfiguration: live?.pendingConfiguration || null,
            browserNotificationPolicy: live?.browserNotificationPolicy ||
                (live?.projectId ? this.resolveBrowserNotificationPolicy(live.projectId) : undefined),
        };
    }
}

/** @param {{ store: import('../../../shared/owner-coordination/index.js').OwnerCoordinationStore }} options */
export function createWorkspaceSessionContinuationService(options) {
    return new WorkspaceSessionContinuationService(options);
}
