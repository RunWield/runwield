import {
    SessionContinuationService,
    stableHash,
    codeFromError,
    requireReceipt,
} from "../../../shared/session/session-continuation-service.ts";
/**
 * @typedef {Object} CodeReviewRefreshContext
 * @property {string} cwd
 * @property {string} targetBranch
 * @property {string} [targetBaseRef]
 */

import { readSessionDisplayName, readCommittedSessionTimeline } from "../../../shared/session/session-history.ts";
export { readSessionName } from "../../../shared/session/session-history.ts";
/**
 * @typedef {Object} LiveCodeReviewOptions
 * @property {string} projectId
 * @property {string} operationId
 * @property {string} interactionId
 * @property {string} runwieldSessionId
 */
import { validateSequenceReviewDecision } from "../../../shared/workflow/sequence-review.ts";
import { resolveWorkflowPlanLocation } from "../../../shared/workflow/plan-location.ts";
/* @module ui/workspace/server/session-continuation */

import { mergePlanAssociations } from "../../../shared/session/plan-association.ts";

import {
    projectLiveSessionInfo,
    readLiveSessionConnection,
    subscribeLiveSessionAttention,
} from "../../../shared/session/live-session-connection.ts";

import { findPlanEvidenceById } from "../../../plan-store.js";
import { getMergedCustomSetting } from "../../../shared/settings.js";

import { normalizeBrowserNotificationPolicy } from "../../../shared/session/notification-content.ts";
import { applySharedPlanReviewDecision } from "../../../shared/workflow/plan-review-actions.ts";
import { loadPlanActionEvidence } from "../../../shared/workflow/plan-actions.ts";
import { loadReviewFeedbackImages } from "../../../shared/workflow/review-feedback-images.ts";
import { getWorktreeReviewDiff, WorktreeReviewComparisonError } from "../../../shared/workflow/git-snapshot.ts";

import { getCommittedTranscriptAuthorityFacts } from "../../../shared/session/session-transcript-projection.js";
import { requireOwnerProjectRoot, sessionBelongsToOwnerProject } from "./owner-projects.ts";

export { ImageSubmissionValidationError } from "../../../shared/session/session-continuation-service.ts";
/** @typedef {import('../../../shared/session/session-history.ts').SessionListOptions} SessionListOptions */
/** @typedef {{ requestHash: string, settled: Promise<void> }} PendingCreateRequest */
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

/** @param {import('../../../shared/session/session-runtime-interactions.ts').RuntimeInteractionRequest} request */
function safePlanReviewReference(request) {
    const meta = request._meta && typeof request._meta === "object" ? request._meta : {};
    const triageMeta =
        meta.triageMeta && typeof meta.triageMeta === "object"
            ? /** @type {Record<string, unknown>} */ (meta.triageMeta)
            : {};
    const planId =
        typeof meta.planId === "string" && meta.planId.trim()
            ? meta.planId.trim()
            : typeof triageMeta.planId === "string" && triageMeta.planId.trim()
              ? triageMeta.planId.trim()
              : typeof meta.planName === "string" && meta.planName.trim()
                ? meta.planName.trim()
                : "";
    if (!planId) return null;
    const planName = typeof meta.planName === "string" && meta.planName.trim() ? meta.planName.trim() : planId;
    const classification =
        typeof meta.classification === "string" && meta.classification.trim()
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
        expectedWorktree:
            meta.expectedWorktree && typeof meta.expectedWorktree === "object" ? meta.expectedWorktree : null,
        previousPlan: typeof meta.previousPlan === "string" && meta.previousPlan.trim() ? meta.previousPlan : null,
        planVersions: Array.isArray(meta.planVersions)
            ? meta.planVersions.flatMap((entry) =>
                  entry && typeof entry === "object" && typeof entry.plan === "string"
                      ? [
                            {
                                plan: entry.plan,
                                timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
                            },
                        ]
                      : [],
              )
            : [],
    };
}

/** @param {import('../../../shared/session/session-runtime-interactions.ts').RuntimeInteractionRequest} request */
function safeCodeReviewReference(request) {
    const meta = request._meta && typeof request._meta === "object" ? request._meta : {};
    const rawPatch = typeof meta.diffText === "string" ? meta.diffText : "";
    const planName =
        typeof meta.planName === "string" && meta.planName.trim() ? meta.planName.trim() : "Workspace changes";
    const planTitle = typeof meta.planTitle === "string" && meta.planTitle.trim() ? meta.planTitle.trim() : planName;
    const conversation = meta.reviewConversation;
    const conversationEvents =
        conversation &&
        typeof conversation === "object" &&
        "events" in conversation &&
        Array.isArray(conversation.events)
            ? conversation.events
            : [];
    return {
        rawPatch,
        conversationEvents,
        gitRef: `RunWield workflow diff: ${planName}`,
        planName,
        planTitle,
        agentLabel:
            typeof meta.agentLabel === "string" && meta.agentLabel.trim()
                ? meta.agentLabel.trim()
                : "Reviewer Feedback Engineer",
    };
}

/** @param {import('../../../shared/session/session-runtime-interactions.ts').RuntimeInteractionRequest} request */
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
    const decision =
        source._meta && typeof source._meta === "object"
            ? /** @type {Record<string, unknown>} */ (source._meta)
            : source;
    // Feedback and review chat may omit approved, but an explicit decision must be boolean.
    if (Object.hasOwn(decision, "approved") && typeof decision.approved !== "boolean") {
        throw new Error("Plan review approved must be a boolean.");
    }
    return decision;
}

/** @param {unknown} response @returns {import("../../../shared/session/session-runtime-interactions.ts").RuntimeInteractionResponse} */
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

/** @param {import('../../../shared/owner-coordination/index.ts').OwnerCoordinationStore} store @param {{ transcriptCwd: string }} session @param {string} projectId */
/** @typedef {import('../../../shared/session/session-continuation-service.ts').ContinuationOperationRecord<WorkspaceInteractionRequest>} WorkspaceOperationRecord */
/**
 * @typedef {import('../../../shared/session/session-runtime-interactions.ts').RuntimeInteractionRequest & WorkspaceReviewPresentation} WorkspaceInteractionRequest
 */
/**
 * @typedef {Object} WorkspaceReviewPresentation
 * @property {ReturnType<typeof safePlanReviewReference>} [planReview]
 * @property {ReturnType<typeof safeCodeReviewReference>} [codeReview]
 * @property {ReturnType<typeof safeArtifactReviewReference>} [artifactReview]
 */

/**
 * @typedef {Object} WorkspaceAttentionNotification
 * @property {import('../../../shared/session/session-runtime-events.js').RuntimeAttentionRequestedEvent} event
 * @property {string} url
 * @property {import('../../../shared/session/notification-content.ts').BrowserNotificationPolicy} policy
 */

/** @typedef {{ operationId: string, reviewUrl: string }} WorkspacePlanReviewStarted */

/** @extends {SessionContinuationService<WorkspaceInteractionRequest>} */
export class WorkspaceSessionContinuationService extends SessionContinuationService {
    /**
     * @param {{ store: import('../../../shared/owner-coordination/index.ts').OwnerCoordinationStore }} options
     */
    constructor(options) {
        super(options);
        /** @type {Set<(notification: WorkspaceAttentionNotification) => void>} */
        this.notificationListeners = new Set();
        /** @type {Map<string, Promise<() => void>>} */
        this.remoteNotificationStreams = new Map();
        /** @type {Map<string, CodeReviewRefreshContext>} */
        this.codeReviewRefreshContexts = new Map();
        /** @type {Map<string, import('../../../shared/session/notification-content.ts').BrowserNotificationPolicy>} */
        this.notificationPolicies = new Map();
    }

    closeAdapter() {
        this.notificationListeners.clear();
        for (const operationId of this.remoteNotificationStreams.keys()) this.closeRemoteNotifications(operationId);
        this.codeReviewRefreshContexts.clear();
        this.notificationPolicies.clear();
    }
    /** @param {string} operationId */
    operationSettled(operationId) {
        this.closeRemoteNotifications(operationId);
    }
    /** @param {string} operationId @param {WorkspaceOperationRecord} record */
    setOperation(operationId, record) {
        const previous = this.operations.get(operationId);
        if (this.closed || (previous && previous.status !== "running")) return;
        const policy =
            record.status === "running"
                ? this.resolveBrowserNotificationPolicy(record.projectId)
                : this.notificationPolicies.get(operationId) || this.resolveBrowserNotificationPolicy(record.projectId);
        this.notificationPolicies.set(operationId, policy);
        super.setOperation(operationId, record);
    }
    /** @param {string} operationId */
    getOperation(operationId) {
        const snapshot = super.getOperation(operationId);
        const live = this.operations.get(operationId);
        return {
            ...snapshot,
            browserNotificationPolicy:
                this.notificationPolicies.get(operationId) ||
                (live?.projectId ? this.resolveBrowserNotificationPolicy(live.projectId) : undefined),
        };
    }

    /** @param {string} operationId */
    closeRemoteNotifications(operationId) {
        const stream = this.remoteNotificationStreams.get(operationId);
        if (!stream) return;
        this.remoteNotificationStreams.delete(operationId);
        void stream.then((close) => close()).catch(() => {});
    }

    /** @param {WorkspaceOperationRecord} record @param {import("../../../shared/session/session-runtime-events.js").SessionRuntimeEvent} event */
    notifyAttention(record, event) {
        if (event.type !== "attention_requested" || event.notificationSurface !== "workspace" || event.eventId) return;
        if (!record.runwieldSessionId) return;
        const notification = {
            event,
            url: `/projects/${encodeURIComponent(record.projectId)}/sessions/${encodeURIComponent(
                record.runwieldSessionId,
            )}`,
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

    /** @param {string} projectId */
    resolveBrowserNotificationPolicy(projectId) {
        const project = typeof this.store.getProjectById === "function" ? this.store.getProjectById(projectId) : null;
        const raw = project ? getMergedCustomSetting("notifications", project.currentRoot) : undefined;
        return normalizeBrowserNotificationPolicy(raw);
    }

    /**
     * @param {string} runwieldSessionId
     * @param {{ projectId?: string, cursorEventId?: string, limit?: number, latest?: boolean, beforeEventId?: string }} [options]
     */
    async timeline(runwieldSessionId, options = {}) {
        const session = this.store.getSessionById(runwieldSessionId);
        if (!session || (options.projectId && !sessionBelongsToOwnerProject(this.store, session, options.projectId))) {
            throw new Error("Session not found.");
        }
        const projection = await readCommittedSessionTimeline(this.store, this.runtime, runwieldSessionId, options);
        const inspected = this.store.inspectSessionActivation(runwieldSessionId);
        const { state } = projection;
        if (!("ok" in projection)) return projection;
        if (projection.ok) {
            /** @type {import('../../../shared/session/live-session-connection.ts').LiveSessionInfo | null | undefined} */
            let liveInfo = projectLiveSessionInfo(
                this.runtime
                    .listSessions()
                    .find((item) => item.managed?.runwieldSessionId === runwieldSessionId && !item.managed.dormant) ||
                    null,
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
            projection.snapshot.name = liveInfo?.name || (await readSessionDisplayName(paths));
            projection.snapshot.contextUsage = liveInfo?.contextUsage || null;
            projection.snapshot.systemContextTokens = liveInfo?.systemContextTokens ?? null;
        }
        return browserTimelineProjection(projection);
    }

    /**
     * @param {string} operationId
     * @param {import('../../../shared/session/session-runtime-interactions.ts').RuntimeInteractionRequest} request
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
                    ...(typeof meta.targetBaseRef === "string" ? { targetBaseRef: meta.targetBaseRef } : {}),
                });
            }
        }
        const reviewUrl = planReview
            ? `/projects/${encodeURIComponent(current.projectId)}/plans/${encodeURIComponent(
                  planReview.planId,
              )}?session=${encodeURIComponent(current.runwieldSessionId || "")}&operation=${encodeURIComponent(
                  operationId,
              )}&interaction=${encodeURIComponent(interactionId)}`
            : codeReview
              ? `/projects/${encodeURIComponent(current.projectId)}/sessions/${encodeURIComponent(
                    current.runwieldSessionId || "",
                )}/review/code?operation=${encodeURIComponent(operationId)}&interaction=${encodeURIComponent(interactionId)}`
              : artifactReview
                ? `/projects/${encodeURIComponent(current.projectId)}/sessions/${encodeURIComponent(
                      current.runwieldSessionId || "",
                  )}/artifacts/${encodeURIComponent(artifactReview.artifactId)}`
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
                              /** @param {import('../../../shared/session/session-runtime-interactions.ts').RuntimeInteractionOption} option */ (
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
                    ...(planReview && { planReview, reviewUrl: reviewUrl || undefined }),
                    ...(codeReview && { codeReview, reviewUrl: reviewUrl || undefined }),
                    ...(artifactReview && { artifactReview, reviewUrl: reviewUrl || undefined }),
                },
            },
            answer,
        });
    }
    /** @param {string} operationId @param {import('../../../shared/session/session-runtime-interactions.ts').RuntimeInteractionRequest} request */
    async prepareInteraction(operationId, request) {
        const options = { operationId };
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
                ...(plan &&
                    !request._meta?.reviewedSource && {
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
        const receipt = requireReceipt(
            this.store.createOrGetOperationReceipt({
                deviceId: options.deviceId || null,
                requestId: options.requestId,
                requestHash,
                runwieldSessionId: options.runwieldSessionId,
                projectId: options.projectId,
                expectedGeneration: options.expectedGeneration,
                kind: "plan_action",
            }),
        );
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
                const adopted =
                    retainedId && this.runtime.getSessionSnapshot(retainedId)
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
                const generation =
                    this.runtime.getSessionSnapshot(runtimeSessionId)?.managed?.generation ??
                    options.expectedGeneration;
                const status = ["busy", "unanswered", "missing_plan", "identity_mismatch", "not_reviewable"].includes(
                    result.kind,
                )
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
    /** @param {import('../../../shared/session/session-continuation-service.ts').InteractionAnswerRequest} options @param {WorkspaceOperationRecord} operation */
    async resolveInteractionResponse(options, operation) {
        if (!operation.liveInteraction || !operation.answer || !operation.runwieldSessionId) {
            throw new Error("Live Workspace interaction is not available.");
        }
        let runtimeResponse = acceptedInteractionResponse(options.response);
        const request = operation.liveInteraction.request;
        const planReview =
            request?.planReview && typeof request.planReview === "object"
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
                /** @type {import('../../../shared/workflow/sequence-review.ts').SequenceReviewDocument[]} */ (
                    planReview.sequenceDocuments
                ),
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
            const source =
                planReview.reviewedSource && typeof planReview.reviewedSource === "object"
                    ? /** @type {Record<string, unknown>} */ (planReview.reviewedSource)
                    : null;
            if (
                !source ||
                typeof source.markdown !== "string" ||
                typeof source.path !== "string" ||
                typeof source.planName !== "string" ||
                !source.attrs ||
                typeof source.attrs !== "object"
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
                    /** @type {import('../../../plan-store.js').PlanFrontMatter['classification']} */ (
                        planReview.classification
                    ),
                trustedWorkKind: attrs.workKind,
                expectedSessionId: operation.runwieldSessionId,
                reviewEvidence: {
                    planId,
                    runwieldSessionId: operation.runwieldSessionId,
                    status: String(planReview.expectedStatus || ""),
                    worktree:
                        /** @type {import('../../../shared/workflow/plan-actions.ts').PlanWorktreeExpectation} */ (
                            planReview.expectedWorktree
                        ),
                },
                decision:
                    /** @type {import('../../../shared/workflow/plan-review-actions.ts').SharedPlanReviewDecision} */ (
                        decision
                    ),
            });
            if (actionResult.recoveryRequired) {
                const result = {
                    status: "recovery_required",
                    message: actionResult.recoveryRequired.message,
                    entryIds: actionResult.recoveryRequired.entryIds,
                };
                return result;
            }
            if (actionResult.cancellationReason) {
                const message =
                    actionResult.feedback || "Plan review evidence is stale. Reload the Plan and review again.";
                operation.answer.reject(new Error(message));
                this.setOperation(options.operationId, {
                    ...operation,
                    liveInteraction: undefined,
                    answer: null,
                });
                throw new Error(message);
            }
            const images = await loadReviewFeedbackImages(
                /** @type {import('../../../shared/workflow/review-feedback-images.ts').ReviewImageDecision} */ (
                    decision
                ),
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

        return runtimeResponse;
    }
    /** @param {string} operationId @param {string} interactionId */
    interactionAnswered(operationId, interactionId) {
        this.codeReviewRefreshContexts.delete(`${operationId}:${interactionId}`);
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
        const planReview =
            request.planReview && typeof request.planReview === "object"
                ? /** @type {Record<string, unknown>} */ (request.planReview)
                : null;
        if (!planReview || planReview.planId !== options.planId) return null;
        return { operationId: options.operationId, interactionId: options.interactionId, request };
    }

    /**
     * @param {LiveCodeReviewOptions} options
     */
    async liveCodeReviewRequest(options) {
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
        const codeReview =
            request.codeReview && typeof request.codeReview === "object"
                ? /** @type {Record<string, unknown>} */ (request.codeReview)
                : null;
        if (!codeReview || typeof codeReview.rawPatch !== "string") return null;
        return { ...request, codeReview: { ...codeReview, rawPatch: codeReview.rawPatch } };
    }

    /**
     * @param {LiveCodeReviewOptions} options
     */
    async getLiveCodeReviewCheckout(options) {
        if (!(await this.liveCodeReviewRequest(options))) return null;
        const refresh = this.codeReviewRefreshContexts.get(`${options.operationId}:${options.interactionId}`);
        return refresh ? { ...refresh } : null;
    }

    /**
     * @param {LiveCodeReviewOptions} options
     */
    async getLiveCodeReview(options) {
        const request = await this.liveCodeReviewRequest(options);
        if (!request) return null;
        const codeReview = request.codeReview;
        const refresh = this.codeReviewRefreshContexts.get(`${options.operationId}:${options.interactionId}`);
        let rawPatch = String(codeReview.rawPatch);
        if (refresh) {
            try {
                rawPatch = await getWorktreeReviewDiff(refresh.cwd, refresh.targetBranch, refresh.targetBaseRef);
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
        const live = [...this.operations.entries()].find(
            ([, operation]) =>
                operation.projectId === options.projectId &&
                operation.runwieldSessionId === options.runwieldSessionId &&
                operation.status === "running",
        );
        if (live) {
            const existingReview = /** @type {ReturnType<typeof safePlanReviewReference>} */ (
                live[1].liveInteraction?.request.planReview
            );
            if (!review || existingReview?.planId !== planId) {
                throw new Error("This Session is busy.");
            }
            return await this.waitForPlanReview(live[0]);
        }
        const state = this.store.inspectSessionActivation(options.runwieldSessionId);
        if (state.activation?.state !== "idle") throw new Error("This Session is busy.");
        const receipt = requireReceipt(
            this.store.createOrGetOperationReceipt({
                deviceId: options.deviceId || null,
                requestId: options.requestId,
                requestHash,
                runwieldSessionId: options.runwieldSessionId,
                projectId: options.projectId,
                expectedGeneration: options.expectedGeneration,
                kind: "continuation",
            }),
        );
        if (!receipt.wasCreated || receipt.status !== "accepted") {
            return review ? await this.waitForPlanReview(receipt.operationId) : this.getOperation(receipt.operationId);
        }
        const session = this.store.getSessionById(options.runwieldSessionId);
        if (!session) throw new Error("Session not found.");
        await this.closingRetainedSessions.get(options.runwieldSessionId);
        const retainedId = this.retainedSessions.get(options.runwieldSessionId)?.sessionId;
        const adopted =
            retainedId && this.runtime.getSessionSnapshot(retainedId)
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
        const unsubscribe = this.runtime.subscribeSessionEvents(adopted.sessionId, (event) =>
            this.appendOperationEvent(operationId, event),
        );
        this.runBackgroundOperation(async () => {
            let error;
            try {
                const status = String(options.triageMeta?.status || "");
                const result =
                    options.action === "retry_work_record"
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
}

/** @param {{ store: import('../../../shared/owner-coordination/index.ts').OwnerCoordinationStore }} options */
export function createWorkspaceSessionContinuationService(options) {
    return new WorkspaceSessionContinuationService(options);
}
