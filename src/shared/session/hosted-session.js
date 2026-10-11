/**
 * @module shared/session/hosted-session
 * Per-conversation runtime state owned by a SessionHost entry.
 */

import { setCurrentValidationProgress } from "../workflow/validation-progress.ts";
import { isAbsolute } from "@std/path";
import { MAX_DELEGATED_READERS } from "../../constants.js";
import { normalizePlanAssociation, PLAN_ASSOCIATION_CUSTOM_TYPE } from "./plan-association.ts";
import {
    applyTutorialContextUpdate,
    readPersistedTutorialContext,
    recordTutorialContext,
} from "./tutorial-context-session.ts";
import {
    deriveWorkflowContextFromExecutionWorkflow,
    readPersistedWorkflowContext,
    recordNormalizedWorkflowContext,
    recordWorkflowPlanName,
    recordWorkflowTriageContext,
    workflowContextsEqual,
} from "./workflow-context-session.js";
import { emitHostedSessionRuntimeEvent, RuntimeEventTypes } from "./session-runtime-events.js";
import { clearPairCheckpoint } from "./pair-checkpoint-session.ts";
import { recordExecutionWorkflowSnapshot } from "./execution-workflow-session.ts";
import { BackgroundTasks } from "./background-tasks.ts";
import { clearBackgroundSteeringForCompletion } from "./runtime/turns.ts";
import { PlanReviewConversationOwner } from "./plan-review-conversation.ts";

/**
 * @typedef {Object} AgentInfo
 * @property {string} displayName
 * @property {string} model
 * @property {string} provider
 * @property {string} [agentName]
 */

/**
 * @typedef {AgentInfo & { sessionInfoId: string }} AgentInfoRecord
 */

/**
 * @typedef {"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"} ThinkingLevel
 */

/** @typedef {import('../types.js').ActiveExecutionWorkflow} ActiveExecutionWorkflow */

/**
 * @typedef {Object} HostedRuntimeEventObservation
 * @property {string} type
 * @property {string} [delta]
 * @property {string} [messageId]
 * @property {string} [agentName]
 */

/**
 * @typedef {Object} DisposableLike
 * @property {() => void | Promise<void>} [dispose]
 * @property {() => {tokens?: number | null, contextWindow?: number | null, percent?: number | null} | undefined} [getContextUsage]
 * @property {{getCompactionSettings?: () => {enabled?: boolean}}} [settingsManager]
 * @property {{contextWindow?: number}} [model]
 */

/**
 * @typedef {Object} AgentTransitionSteering
 * @property {string} text
 * @property {import('./types.js').ImageAttachment[]} images
 * @property {import('./session-runtime-events.js').RuntimeQueuedMessage} [message]
 * @property {number} [submissionOrder]
 */

/**
 * @typedef {Object} SteeringTargetRecord
 * @property {string} steeringTargetId
 * @property {DisposableLike} session
 */

/**
 * @typedef {Object} MinimalSessionManagerShape
 * @property {() => string} [getSessionId]
 * @property {() => string | null} [getLeafId]
 * @property {() => string | undefined} [getSessionFile]
 * @property {() => string} [getCwd]
 * @property {() => string | undefined} [getSessionName]
 * @property {(name: string) => void} [appendSessionInfo]
 * @property {(level: ThinkingLevel) => void} [appendThinkingLevelChange]
 * @property {(provider: string, modelId: string) => void} [appendModelChange]
 * @property {() => unknown[]} [getBranch]
 * @property {() => unknown[]} [getEntries]
 * @property {import('@earendil-works/pi-coding-agent').SessionManager['appendMessage']} [appendMessage]
 * @property {(message: unknown) => void} [addMessage]
 * @property {(customType: string, data: unknown) => void} [appendCustomEntry]
 * @property {() => void | Promise<void>} [dispose]
 */

/**
 * @typedef {Object} SessionManagerExtensions
 * @property {(message: unknown) => void} [addMessage]
 * @property {() => void | Promise<void>} [dispose]
 */

/** @typedef {MinimalSessionManagerShape | (import('@earendil-works/pi-coding-agent').SessionManager & SessionManagerExtensions)} MinimalSessionManagerLike */

/**
 * @typedef {Object} ActiveInteractionRecord
 * @property {import('./session-runtime-interactions.js').RuntimeInteractionRequest} [request]
 * @property {AbortController} [abortController]
 * @property {(response: import('./session-runtime-interactions.js').RuntimeInteractionResponse, source?: import('./session-runtime-events.js').NotificationSurface) => void} [answer]
 */

/**
 * @typedef {Object} HostedSessionOptions
 * @property {string} [id]
 * @property {string} [cwd]
 * @property {MinimalSessionManagerLike | null} [sessionManager]
 * @property {unknown} [eventSink]
 * @property {import('./session-runtime-interactions.js').RuntimeInteractionAdapter} [interactionAdapter]
 * @property {ManagedSessionMetadata | null} [managed]
 */

/**
 * @typedef {Object} ManagedSessionMetadata
 * @property {string} runwieldSessionId
 * @property {string} projectId
 * @property {string} piSessionId
 * @property {string} transcriptPath
 * @property {string} [currentSegmentId]
 * @property {number | null} generation
 * @property {number | null} [acknowledgedGeneration]
 * @property {string | null} [acknowledgedEventId]
 * @property {number | null} [acknowledgedEventOrdinal]
 * @property {Object} [committedSummary]
 * @property {{ type: "managed_sync_state_changed", status: import('./session-runtime-events.js').RuntimeManagedSyncStatus, localGeneration: number | null, latestGeneration: number | null, owningSurfaceKind?: "workspace" | "tui" | "acp" | "unknown", message?: string } | null} [syncState]
 * @property {string | null} name
 * @property {string | null} activeAgent
 * @property {string | null} [model]
 * @property {string | null} [provider]
 * @property {string | null} [thinkingLevel]
 * @property {import('./workflow-context-session.js').WorkflowContext | null} workflowContext
 * @property {import('./tutorial-context-session.ts').TutorialContext | null} [tutorialContext]
 */

/**
 * @typedef {Object} PendingManagedTurnIntent
 * @property {string} [agentName]
 * @property {string} [model]
 * @property {string} [provider]
 * @property {boolean} [manualModel]
 * @property {ThinkingLevel} [thinkingLevel]
 */

/**
 * @typedef {Object} PendingTaskCompletion
 * @property {string} agentName
 * @property {string} report
 * @property {number} timestampMs
 * @property {DisposableLike | null} owningSession
 */

/** @param {unknown} value */
function getSessionManagerId(value) {
    if (!value || typeof value !== "object" || !("getSessionId" in value) || typeof value.getSessionId !== "function") {
        return null;
    }
    const id = value.getSessionId();
    return typeof id === "string" && id ? id : null;
}

/** @param {unknown} value */
function getSessionManagerCwd(value) {
    if (!value || typeof value !== "object" || !("getCwd" in value) || typeof value.getCwd !== "function") {
        return null;
    }
    const cwd = value.getCwd();
    return typeof cwd === "string" && cwd ? cwd : null;
}

/**
 * @param {string | null | undefined} cwd
 * @param {string} source
 * @returns {string}
 */
function requireAbsoluteProjectRoot(cwd, source) {
    if (!cwd) throw new Error(`HostedSession requires an absolute project root (${source})`);
    if (!isAbsolute(cwd)) throw new Error(`HostedSession project root must be absolute: ${cwd}`);
    return cwd;
}

/** @param {unknown} value */
function disposeIfPresent(value) {
    if (!value || typeof value !== "object" || !("dispose" in value) || typeof value.dispose !== "function") return;
    try {
        value.dispose();
    } catch {
        // Disposal is best-effort so one bad runtime object does not prevent
        // the HostedSession from clearing the rest of its owned references.
    }
}

/** @param {unknown} value */
function disposeIfPresentAsync(value) {
    if (!value || typeof value !== "object" || !("dispose" in value) || typeof value.dispose !== "function") return;
    try {
        return Promise.resolve(value.dispose()).catch(() => undefined);
    } catch {
        // Disposal is best-effort so one bad runtime object does not prevent
        // the HostedSession from clearing the rest of its owned references.
    }
}

export class HostedSession {
    /**
     * @param {HostedSessionOptions} options
     */
    constructor(options) {
        const id = options?.id || getSessionManagerId(options?.sessionManager);
        if (!id) throw new Error("HostedSession requires an id");
        this.id = id;
        const sessionManagerCwd = getSessionManagerCwd(options.sessionManager);
        this.cwd = requireAbsoluteProjectRoot(
            sessionManagerCwd || options.cwd,
            sessionManagerCwd ? "sessionManager" : "cwd",
        );
        this.disposed = false;
        /** Session-owned tasks are independent of disposable root and turn state. */
        this.backgroundTasks = new BackgroundTasks(this);
        /** @type {string | null} */
        this.backgroundCompletionWarning = null;

        /** @type {AgentInfoRecord[]} */
        this.agentInfoStack = [];
        this.agentInfoSequence = 0;
        this.userModelOverrideId = "";
        this.userModelOverrideProvider = "";
        this.userModelOverride = false;
        /** @type {ThinkingLevel} */
        this.activeThinkingLevel = "off";
        /** @type {Function | null} */
        this.activeOnMessage = null;
        /** @type {MinimalSessionManagerLike | null} */
        this.rootSessionManager = options.sessionManager || null;
        /** @type {unknown} */
        this.eventSink = options.eventSink || null;
        /** @type {Set<(event: HostedRuntimeEventObservation) => void>} */
        this.eventObservers = new Set();
        this.planReviewConversations = new PlanReviewConversationOwner();
        /** @type {import('./session-runtime-interactions.js').RuntimeInteractionAdapter | null} */
        this.interactionAdapter = options.interactionAdapter || null;
        /** @type {Map<string, ActiveInteractionRecord>} */
        this.activeInteractions = new Map();
        /** @type {DisposableLike | null} */
        this.rootAgentSession = null;
        /** @type {string | null} */
        this.rootAgentName = null;
        /** @type {Set<DisposableLike>} */
        this.subAgentSessions = new Set();
        /** @type {SteeringTargetRecord[]} */
        this.steeringTargetStack = [];
        this.steeringTargetSequence = 0;
        /** @type {string | null} */
        this.agentTransitionId = null;
        /** @type {AgentTransitionSteering[]} */
        this.agentTransitionSteering = [];
        /** @type {Set<string>} */
        this.agentSteeringPreparations = new Set();
        /** @type {Set<() => void>} */
        this.agentSteeringPreparationWaiters = new Set();
        this.delegatedReaderCount = 0;
        this.delegatedWriterActive = false;
        this.projectStateContext = "";
        /** @type {import('./workflow-context-session.js').WorkflowContext | null} */
        this.workflowContext = readPersistedWorkflowContext(
            /** @type {import('@earendil-works/pi-coding-agent').SessionManager | null} */ (this.rootSessionManager),
        );
        /** @type {import('./tutorial-context-session.ts').TutorialContext | null} */
        this.tutorialContext = readPersistedTutorialContext(this.rootSessionManager) ||
            options.managed?.tutorialContext || null;
        /** @type {ActiveExecutionWorkflow | null} */
        this.activeExecutionWorkflow = null;
        /** @type {PendingTaskCompletion | null} */
        this.pendingTaskCompletion = null;
        this.suppressAgentStoppedAttention = false;
        /** @type {import('./session-runtime-events.js').NotificationSurface | null} */
        this.notificationSurface = null;
        /** @type {import('./session-runtime-events.js').NotificationSurface | null} */
        this.localInputSurface = null;
        /** @type {string | null} */
        this.agentStoppedAttentionTurnId = null;
        /** @type {string | null} */
        this.activeTurnId = null;
        /** Opaque ID for a named invocation while its resulting work runs. */
        /** @type {string | null} */
        this.activeCommandInvocationId = null;
        /** @type {Map<string, string>} Active call IDs to their owning execution IDs. */
        this.toolExecutionIds = new Map();
        /** @type {string | null} */
        this.generatedTaskTurnId = null;
        /** @type {ManagedSessionMetadata | null} */
        this.managed = options.managed || null;
        /** @type {import('./managed-operation.ts').ManagedOperationCapability | null} */
        this.managedOperationCapability = null;
        /** @type {PendingManagedTurnIntent} */
        this.pendingManagedTurnIntent = {};
        /** @type {import('../mcp/integration.ts').McpIntegration | null} */
        this.mcpIntegration = null;
        /** @type {import('../mcp/config.ts').McpServerDefinition[]} */
        this.mcpRequestServers = [];
    }

    /** @param {string} callId @param {string} executionId */
    recordToolExecution(callId, executionId) {
        this.toolExecutionIds.set(callId, executionId);
    }

    /** @param {string} callId */
    getToolExecutionId(callId) {
        return this.toolExecutionIds.get(callId);
    }

    /** @param {string} callId */
    forgetToolExecution(callId) {
        this.toolExecutionIds.delete(callId);
    }

    /** @param {string} executionId */
    forgetExecutionToolCalls(executionId) {
        for (const [callId, owner] of this.toolExecutionIds) {
            if (owner === executionId) this.toolExecutionIds.delete(callId);
        }
    }

    assertActive() {
        if (this.disposed) throw new Error(`HostedSession "${this.id}" is disposed`);
    }

    /**
     * @param {string} displayName
     * @param {string} [model]
     * @param {string} [provider]
     * @param {string} [agentName]
     * @returns {string}
     */
    pushAgentInfo(displayName, model = "", provider = "", agentName = "") {
        this.assertActive();
        const sessionInfoId = `agent-info-${++this.agentInfoSequence}`;
        this.agentInfoStack.push({ sessionInfoId, displayName, model, provider, ...(agentName ? { agentName } : {}) });
        return sessionInfoId;
    }

    /** @param {string} [sessionInfoId] */
    popAgentInfo(sessionInfoId = "") {
        this.assertActive();
        if (!sessionInfoId) {
            this.agentInfoStack.pop();
            return;
        }
        const index = this.agentInfoStack.findIndex((agentInfo) => agentInfo.sessionInfoId === sessionInfoId);
        if (index >= 0) this.agentInfoStack.splice(index, 1);
    }

    /** @param {string} displayName @param {string} [model] @param {string} [provider] @param {string} [agentName] */
    resetAgentInfoStack(displayName, model = "", provider = "", agentName = "") {
        this.assertActive();
        const sessionInfoId = `agent-info-${++this.agentInfoSequence}`;
        this.agentInfoStack = [{ sessionInfoId, displayName, model, provider, ...(agentName ? { agentName } : {}) }];
    }

    getAgentInfoStack() {
        return this.agentInfoStack.map(({ sessionInfoId: _sessionInfoId, ...agentInfo }) => ({ ...agentInfo }));
    }

    getActiveAgentInfo() {
        if (this.agentInfoStack.length === 0) return null;
        const { sessionInfoId: _sessionInfoId, ...agentInfo } = this.agentInfoStack[this.agentInfoStack.length - 1];
        return { ...agentInfo };
    }

    getActiveAgentName() {
        return this.getActiveAgentInfo()?.displayName || "";
    }

    /** @param {string} model @param {string} [provider] @param {boolean} [isUserOverride] */
    setActiveModelState(model, provider = "", isUserOverride = false) {
        this.assertActive();
        if (isUserOverride) {
            this.userModelOverrideId = model;
            this.userModelOverrideProvider = provider;
            this.userModelOverride = true;
            return;
        }
        if (this.agentInfoStack.length > 0) {
            const top = this.agentInfoStack[this.agentInfoStack.length - 1];
            top.model = model;
            top.provider = provider;
        }
    }

    getActiveModelState() {
        if (this.userModelOverride) {
            return { model: this.userModelOverrideId, provider: this.userModelOverrideProvider };
        }
        if (this.agentInfoStack.length === 0) return { model: "", provider: "" };
        const top = this.agentInfoStack[this.agentInfoStack.length - 1];
        return { model: top.model, provider: top.provider };
    }

    isUserModelOverride() {
        return this.userModelOverride;
    }

    clearUserModelOverride() {
        this.assertActive();
        this.userModelOverride = false;
        this.userModelOverrideId = "";
        this.userModelOverrideProvider = "";
    }

    /** @param {Function | null} handler */
    setActiveOnMessage(handler) {
        this.assertActive();
        this.activeOnMessage = handler;
    }

    getActiveOnMessage() {
        return this.activeOnMessage;
    }

    /** @param {import('./managed-operation.ts').ManagedOperationCapability | null} capability */
    setManagedOperationCapability(capability) {
        this.assertActive();
        this.managedOperationCapability = capability;
    }

    getManagedOperationCapability() {
        return this.managedOperationCapability;
    }

    /** @param {import('./managed-operation.ts').ManagedOperationCapability | null} capability */
    #assertManagedWritableCapability(capability) {
        if (!this.managed) return;
        if (!capability || capability !== this.managedOperationCapability) {
            throw new Error("managed_operation_required");
        }
        capability.assertLive();
    }

    /** @param {MinimalSessionManagerLike | null} sessionManager @param {import('./managed-operation.ts').ManagedOperationCapability | null} [capability] */
    setRootSessionManager(sessionManager, capability = null) {
        this.assertActive();
        if (sessionManager) this.#assertManagedWritableCapability(capability);
        const previous = this.workflowContext;
        this.rootSessionManager = sessionManager;
        if (!sessionManager) return;

        this.tutorialContext = readPersistedTutorialContext(sessionManager);
        const persisted = readPersistedWorkflowContext(
            /** @type {import('@earendil-works/pi-coding-agent').SessionManager} */ (sessionManager),
        );
        if (persisted) {
            this.replaceWorkflowContext(persisted, { persist: false });
            return;
        }
        if (previous) {
            this.replaceWorkflowContext(previous, { persist: true });
        }
    }

    getRootSessionManager() {
        return this.rootSessionManager;
    }

    /** @param {ManagedSessionMetadata | null} metadata */
    setManagedMetadata(metadata) {
        this.assertActive();
        this.managed = metadata ? { ...metadata } : null;
    }

    getManagedMetadata() {
        return this.managed ? { ...this.managed } : null;
    }

    /** @param {{ piSessionId: string, transcriptPath: string, currentSegmentId: string, sessionManager: MinimalSessionManagerLike }} segment */
    replaceManagedTranscriptSegment(segment) {
        this.assertActive();
        if (!this.managed) throw new Error("Session metadata is unavailable");
        this.#assertManagedWritableCapability(this.managedOperationCapability);
        disposeIfPresent(this.rootSessionManager);
        this.rootSessionManager = segment.sessionManager;
        recordExecutionWorkflowSnapshot(this);
        this.managed = {
            ...this.managed,
            piSessionId: segment.piSessionId,
            transcriptPath: segment.transcriptPath,
            currentSegmentId: segment.currentSegmentId,
        };
        const persisted = readPersistedWorkflowContext(
            /** @type {import('@earendil-works/pi-coding-agent').SessionManager} */ (segment.sessionManager),
        );
        if (persisted) this.replaceWorkflowContext(persisted, { persist: false });
        this.tutorialContext = readPersistedTutorialContext(segment.sessionManager);
    }

    /** @param {PendingManagedTurnIntent} intent */
    mergePendingManagedTurnIntent(intent) {
        this.assertActive();
        this.pendingManagedTurnIntent = { ...this.pendingManagedTurnIntent, ...intent };
    }

    getPendingManagedTurnIntent() {
        return { ...this.pendingManagedTurnIntent };
    }

    consumePendingManagedTurnIntent() {
        this.assertActive();
        const intent = { ...this.pendingManagedTurnIntent };
        this.pendingManagedTurnIntent = {};
        return intent;
    }

    dehydrateManagedSession() {
        this.assertActive();
        disposeIfPresent(this.rootAgentSession);
        for (const session of this.subAgentSessions) disposeIfPresent(session);
        disposeIfPresent(this.rootSessionManager);
        this.activeOnMessage = null;
        this.rootSessionManager = null;
        this.interactionAdapter?.cancelAll?.();
        this.activeInteractions.clear();
        this.rootAgentSession = null;
        this.rootAgentName = null;
        this.agentInfoStack = [];
        this.userModelOverrideId = "";
        this.userModelOverrideProvider = "";
        this.userModelOverride = false;
        this.activeThinkingLevel = "off";
        this.subAgentSessions.clear();
        // Background read leases outlive this root operation and release on child settlement.
        this.activeTurnId = null;
        this.steeringTargetStack = [];
        this.managedOperationCapability = null;
    }

    /** @param {unknown} eventSink */
    setEventSink(eventSink) {
        this.assertActive();
        this.eventSink = eventSink;
    }

    getEventSink() {
        return this.eventSink;
    }

    /** @param {(event: HostedRuntimeEventObservation) => void} observer */
    subscribeRuntimeEvents(observer) {
        this.assertActive();
        this.eventObservers.add(observer);
        return () => this.eventObservers.delete(observer);
    }

    /** @param {{ planId: string, planningAgentName: string }} review */
    getPlanReviewConversation(review) {
        this.assertActive();
        return this.planReviewConversations.select(review.planId, review.planningAgentName);
    }

    /** @param {HostedRuntimeEventObservation} event */
    publishRuntimeEvent(event) {
        this.planReviewConversations.capture(event);
        for (const observer of this.eventObservers) {
            try {
                observer(event);
            } catch {
                // Review and presentation observers must not interrupt the agent session.
            }
        }
    }

    /**
     * @param {import('./session-runtime-interactions.js').RuntimeInteractionAdapter | null} adapter
     */
    setInteractionAdapter(adapter) {
        this.assertActive();
        this.interactionAdapter = adapter;
    }

    getInteractionAdapter() {
        return this.interactionAdapter;
    }

    /** @param {import('../mcp/config.ts').McpServerDefinition[]} servers */
    setMcpRequestServers(servers) {
        this.assertActive();
        this.mcpRequestServers = servers.map((server) => ({ ...server }));
    }

    getMcpRequestServers() {
        return this.mcpRequestServers.map((server) => ({ ...server }));
    }

    /** @param {import('../mcp/integration.ts').McpIntegration | null} pool */
    async setMcpIntegration(pool) {
        this.assertActive();
        const previous = this.mcpIntegration;
        this.mcpIntegration = pool;
        if (previous && previous !== pool) await previous.close().catch(() => {});
    }

    getMcpIntegration() {
        return this.mcpIntegration;
    }

    getMcpRootTools() {
        return this.mcpIntegration?.getTools?.() || [];
    }

    /** @param {HostedSession} targetHostedSession */
    moveMcpStateTo(targetHostedSession) {
        this.assertActive();
        targetHostedSession.assertActive();
        targetHostedSession.mcpIntegration = this.mcpIntegration;
        targetHostedSession.mcpRequestServers = this.getMcpRequestServers();
        this.mcpIntegration = null;
    }

    async closeMcpIntegration() {
        const pool = this.mcpIntegration;
        this.mcpIntegration = null;
        if (pool) await pool.close();
    }

    /** @param {string} id @param {ActiveInteractionRecord} record */
    addActiveInteraction(id, record) {
        this.assertActive();
        this.activeInteractions.set(id, record);
    }

    /** @param {string} id */
    removeActiveInteraction(id) {
        this.activeInteractions.delete(id);
    }

    getActiveInteractions() {
        return new Map(this.activeInteractions);
    }

    cancelActiveInteractions() {
        const canceled = this.activeInteractions.size > 0;
        for (const record of this.activeInteractions.values()) {
            record.abortController?.abort();
        }
        this.interactionAdapter?.cancelAll?.();
        this.activeInteractions.clear();
        return canceled;
    }

    /** @param {DisposableLike | null} session */
    /** @param {DisposableLike | null} session @param {import('./managed-operation.ts').ManagedOperationCapability | null} [capability] */
    setRootAgentSession(session, capability = null) {
        this.assertActive();
        if (session) this.#assertManagedWritableCapability(capability);
        this.rootAgentSession = session;
    }

    getRootAgentSession() {
        return this.rootAgentSession;
    }

    /** @param {string | null} agentName @param {import('./managed-operation.ts').ManagedOperationCapability | null} [capability] */
    setRootAgentName(agentName, capability = null) {
        this.assertActive();
        if (agentName) this.#assertManagedWritableCapability(capability);
        this.rootAgentName = agentName;
    }

    getRootAgentName() {
        return this.rootAgentName;
    }

    suppressNextAgentStoppedAttention() {
        this.suppressAgentStoppedAttention = true;
    }

    consumeSuppressedAgentStoppedAttention() {
        if (!this.suppressAgentStoppedAttention) return false;
        this.suppressAgentStoppedAttention = false;
        return true;
    }

    /**
     * @param {string} agentName
     * @param {string} report
     * @param {number} timestampMs
     */
    recordPendingTaskCompletion(agentName, report, timestampMs = Date.now()) {
        this.assertActive();
        this.pendingTaskCompletion = {
            agentName,
            report,
            timestampMs,
            owningSession: this.getActiveSteeringTargetSession(),
        };
    }

    /** @param {DisposableLike | null} owningSession */
    consumePendingTaskCompletion(owningSession) {
        if (!this.pendingTaskCompletion) return null;
        if (this.pendingTaskCompletion.owningSession !== owningSession) return null;
        const completion = this.pendingTaskCompletion;
        this.pendingTaskCompletion = null;
        return completion;
    }

    getPendingTaskCompletionForRestore() {
        return this.pendingTaskCompletion ? { ...this.pendingTaskCompletion } : null;
    }

    /** @param {ActiveExecutionWorkflow | null} workflow @param {PendingTaskCompletion | null} pendingTaskCompletion */
    restoreActiveExecutionWorkflow(workflow, pendingTaskCompletion) {
        this.assertActive();
        this.activeExecutionWorkflow = workflow;
        this.pendingTaskCompletion = pendingTaskCompletion ? { ...pendingTaskCompletion } : null;
    }

    /** @param {DisposableLike} session @param {import('./managed-operation.ts').ManagedOperationCapability | null} [capability] */
    addSubAgentSession(session, capability = null) {
        this.assertActive();
        this.#assertManagedWritableCapability(capability);
        this.subAgentSessions.add(session);
    }

    /** @param {DisposableLike} session */
    removeSubAgentSession(session) {
        this.assertActive();
        this.subAgentSessions.delete(session);
    }

    getSubAgentSessions() {
        return new Set(this.subAgentSessions);
    }

    /** @param {DisposableLike} session */
    pushSteeringTargetSession(session) {
        this.assertActive();
        const steeringTargetId = `steering-target-${++this.steeringTargetSequence}`;
        this.steeringTargetStack.push({ steeringTargetId, session });
        return steeringTargetId;
    }

    /** @param {string} steeringTargetId */
    popSteeringTargetSession(steeringTargetId) {
        this.assertActive();
        if (!steeringTargetId) {
            this.steeringTargetStack.pop();
            return;
        }
        const index = this.steeringTargetStack.findIndex((entry) => entry.steeringTargetId === steeringTargetId);
        if (index >= 0) this.steeringTargetStack.splice(index, 1);
    }

    getActiveSteeringTargetSession() {
        if (this.steeringTargetStack.length === 0) return null;
        return this.steeringTargetStack[this.steeringTargetStack.length - 1].session;
    }

    /** @returns {string} */
    beginAgentTransition() {
        this.assertActive();
        if (this.agentTransitionId) throw new Error("An Agent transition is already active");
        this.agentTransitionId = `agent-transition-${crypto.randomUUID()}`;
        return this.agentTransitionId;
    }

    /** @returns {boolean} */
    isAgentTransitioning() {
        return Boolean(this.agentTransitionId);
    }

    /** @returns {string | null} */
    getAgentTransitionId() {
        return this.agentTransitionId;
    }

    /**
     * @param {string} text
     * @param {import('./types.js').ImageAttachment[]} images
     * @param {import('./session-runtime-events.js').RuntimeQueuedMessage} [message]
     * @param {number} [submissionOrder]
     * @returns {boolean}
     */
    queueAgentTransitionSteering(text, images = [], message, submissionOrder) {
        if (!this.agentTransitionId) return false;
        const entry = {
            text,
            images: images.map((image) => ({ ...image })),
            ...(message
                ? {
                    message: {
                        ...message,
                        images: message.images.map((image) => ({ ...image })),
                    },
                }
                : {}),
            ...(submissionOrder === undefined ? {} : { submissionOrder }),
        };
        const laterEntryIndex = submissionOrder === undefined
            ? -1
            : this.agentTransitionSteering.findIndex((current) =>
                current.submissionOrder !== undefined && current.submissionOrder > submissionOrder
            );
        if (laterEntryIndex < 0) this.agentTransitionSteering.push(entry);
        else this.agentTransitionSteering.splice(laterEntryIndex, 0, entry);
        return true;
    }

    /** @param {string} transitionId */
    completeAgentTransition(transitionId) {
        this.assertActive();
        if (this.agentTransitionId === transitionId) this.agentTransitionId = null;
    }

    /** @param {string} messageId */
    beginAgentSteeringPreparation(messageId) {
        this.assertActive();
        this.agentSteeringPreparations.add(messageId);
    }

    /** @param {string} messageId */
    completeAgentSteeringPreparation(messageId) {
        if (!this.agentSteeringPreparations.delete(messageId) || this.agentSteeringPreparations.size > 0) return;
        for (const resolve of this.agentSteeringPreparationWaiters) resolve();
        this.agentSteeringPreparationWaiters.clear();
    }

    /** @returns {boolean} */
    hasAgentSteeringPreparations() {
        return this.agentSteeringPreparations.size > 0;
    }

    /** @returns {Promise<void>} */
    async waitForAgentSteeringPreparations() {
        if (!this.hasAgentSteeringPreparations()) return;
        await new Promise((resolve) => this.agentSteeringPreparationWaiters.add(() => resolve(undefined)));
    }

    /** @returns {AgentTransitionSteering[]} */
    listAgentTransitionSteering() {
        return this.agentTransitionSteering.map((entry) => ({
            text: entry.text,
            images: entry.images.map((image) => ({ ...image })),
            ...(entry.message
                ? {
                    message: {
                        ...entry.message,
                        images: entry.message.images.map((image) => ({ ...image })),
                    },
                }
                : {}),
        }));
    }

    /** @returns {AgentTransitionSteering[]} */
    consumeAgentTransitionSteering() {
        const steering = this.agentTransitionSteering;
        this.agentTransitionSteering = [];
        return steering.map((entry) => ({
            text: entry.text,
            images: entry.images.map((image) => ({ ...image })),
            ...(entry.message
                ? {
                    message: {
                        ...entry.message,
                        images: entry.message.images.map((image) => ({ ...image })),
                    },
                }
                : {}),
        }));
    }

    /** @param {string} messageId */
    removeAgentTransitionSteering(messageId) {
        const index = this.agentTransitionSteering.findIndex((entry) => entry.message?.id === messageId);
        if (index < 0) return false;
        this.agentTransitionSteering.splice(index, 1);
        return true;
    }

    /** @returns {AgentTransitionSteering[]} */
    clearAgentTransitionSteering() {
        return this.consumeAgentTransitionSteering();
    }

    /** @param {AgentTransitionSteering[]} entries */
    restoreAgentTransitionSteering(entries) {
        const missingEntries = entries.filter((entry) =>
            !this.agentTransitionSteering.some((current) =>
                entry.message?.id
                    ? current.message?.id === entry.message.id
                    : !current.message && current.text === entry.text &&
                        JSON.stringify(current.images) === JSON.stringify(entry.images)
            )
        );
        this.agentTransitionSteering = [
            ...missingEntries.map((entry) => ({
                text: entry.text,
                images: entry.images.map((image) => ({ ...image })),
                ...(entry.message
                    ? {
                        message: {
                            ...entry.message,
                            images: entry.message.images.map((image) => ({ ...image })),
                        },
                    }
                    : {}),
            })),
            ...this.agentTransitionSteering,
        ];
    }

    /**
     * @param {"read" | "write"} mode
     * @returns {() => void}
     */
    acquireDelegatedAgentLease(mode) {
        this.assertActive();
        if (mode === "read") {
            if (this.delegatedWriterActive) {
                throw new Error("A delegated writer is already running; read delegations must wait.");
            }
            if (this.delegatedReaderCount >= MAX_DELEGATED_READERS) {
                throw new Error(`Too many delegated readers are running; maximum is ${MAX_DELEGATED_READERS}.`);
            }
            this.delegatedReaderCount++;
            let released = false;
            return () => {
                if (released) return;
                released = true;
                this.delegatedReaderCount = Math.max(0, this.delegatedReaderCount - 1);
            };
        }

        if (this.delegatedWriterActive || this.delegatedReaderCount > 0) {
            throw new Error(
                "A delegated reader or writer is already running; write delegation requires exclusive access.",
            );
        }
        this.delegatedWriterActive = true;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.delegatedWriterActive = false;
        };
    }

    getDelegatedAgentLeaseState() {
        return { readers: this.delegatedReaderCount, writer: this.delegatedWriterActive };
    }

    getThinkingLevel() {
        return this.activeThinkingLevel;
    }

    /** @param {ThinkingLevel} level */
    setThinkingLevel(level) {
        this.assertActive();
        this.activeThinkingLevel = level;
    }

    /** @param {string} context */
    setProjectStateContext(context) {
        this.assertActive();
        this.projectStateContext = context;
    }

    getProjectStateContext() {
        return this.projectStateContext;
    }

    getWorkflowContext() {
        return this.workflowContext ? { ...this.workflowContext } : null;
    }

    getTutorialContext() {
        return this.tutorialContext
            ? { ...this.tutorialContext, shownExplanationIds: [...this.tutorialContext.shownExplanationIds] }
            : null;
    }

    /**
     * @param {import('./tutorial-context-session.ts').TutorialContextUpdate} update
     * @param {import('./plan-association.ts').ManifestPlanAssociation[]} committedPlanAssociations
     */
    updateTutorialContext(update, committedPlanAssociations = []) {
        if (this.disposed) throw new Error("tutorial_context_not_writable");
        const capability = this.getManagedOperationCapability?.() || null;
        this.#assertManagedWritableCapability(capability);
        if (!this.managed || !this.rootSessionManager?.appendCustomEntry) {
            throw new Error("tutorial_context_not_writable");
        }
        const nextContext = applyTutorialContextUpdate(this.tutorialContext, update);
        if (!nextContext) throw new Error("tutorial_context_invalid");
        if (nextContext.planId && nextContext.planId !== this.tutorialContext?.planId) {
            const hasCommittedAssociation = committedPlanAssociations.some((association) =>
                association.planId === nextContext.planId && Number.isInteger(association.committedGeneration)
            );
            if (!hasCommittedAssociation) throw new Error("tutorial_context_plan_association_required");
        }
        const recorded = recordTutorialContext(this.rootSessionManager, nextContext);
        if (!recorded) throw new Error("tutorial_context_invalid");
        this.tutorialContext = recorded;
        return this.getTutorialContext();
    }

    /**
     * @param {import('./workflow-context-session.js').WorkflowContext | null} nextContext
     * @param {{ persist?: boolean }} options
     */
    replaceWorkflowContext(nextContext, options = {}) {
        if (this.disposed) return;
        const previous = this.workflowContext;
        let normalized = nextContext;
        try {
            if (options.persist) {
                normalized = recordNormalizedWorkflowContext(
                    /** @type {import('@earendil-works/pi-coding-agent').SessionManager | null} */ (this
                        .rootSessionManager),
                    nextContext,
                );
            }
        } catch (_e) {
            // Footer-context persistence is fail-open; keep normalized in-memory context below.
        }
        setCurrentValidationProgress(this, normalized?.validationProgress);
        this.workflowContext = normalized ? { ...normalized } : null;
        if (workflowContextsEqual(previous, this.workflowContext) || !this.workflowContext) return;
        emitHostedSessionRuntimeEvent(this, {
            type: RuntimeEventTypes.WORKFLOW_CONTEXT_CHANGED,
            workflowContext: { ...this.workflowContext },
        });
    }

    /** @param {{ routingIntent: unknown, complexity: unknown, summary?: unknown }} details */
    setWorkflowTriageContext(details) {
        if (this.disposed) return;
        try {
            const hasWorkflowContextPersistence = typeof this.rootSessionManager?.appendCustomEntry === "function";
            const recordedContext = recordWorkflowTriageContext(
                /** @type {import('@earendil-works/pi-coding-agent').SessionManager | null} */ (this
                    .rootSessionManager),
                details,
            );
            const nextContext = recordedContext && !hasWorkflowContextPersistence
                ? { ...this.workflowContext, ...recordedContext }
                : recordedContext || this.workflowContext;
            if (nextContext) delete nextContext.validationProgress;
            this.replaceWorkflowContext(nextContext, { persist: false });
        } catch (_e) {
            // Footer-context persistence is fail-open and must not block triage.
        }
    }

    /** @param {unknown} planName */
    setWorkflowPlanName(planName) {
        if (this.disposed) return;
        try {
            const hasWorkflowContextPersistence = typeof this.rootSessionManager?.appendCustomEntry === "function";
            const recordedContext = recordWorkflowPlanName(
                /** @type {import('@earendil-works/pi-coding-agent').SessionManager | null} */ (this
                    .rootSessionManager),
                planName,
            );
            const nextContext = recordedContext && !hasWorkflowContextPersistence
                ? { ...this.workflowContext, ...recordedContext }
                : recordedContext || this.workflowContext;
            if (nextContext && nextContext.planName !== this.workflowContext?.planName) {
                delete nextContext.validationProgress;
            }
            this.replaceWorkflowContext(nextContext, { persist: false });
        } catch (_e) {
            // Footer-context persistence is fail-open and must not block planning.
        }
    }

    /** @param {import('./workflow-context-session.js').WorkflowContextInput} details */
    setWorkflowExecutionContext(details) {
        if (this.disposed) return;
        const nextContext = deriveWorkflowContextFromExecutionWorkflow(details);
        if (!nextContext) return;
        this.replaceWorkflowContext(nextContext, { persist: true });
    }

    /** @param {{ planId?: unknown, planName?: unknown, purpose?: unknown }} details */
    recordPlanAssociation(details) {
        if (this.disposed) throw new Error("plan_association_not_writable");
        const capability = this.getManagedOperationCapability?.() || null;
        this.#assertManagedWritableCapability(capability);
        const managed = this.getManagedMetadata?.();
        const rawEntry = {
            planId: details?.planId,
            planName: details?.planName,
            purpose: details?.purpose,
            segmentId: managed?.currentSegmentId,
            segmentKind: capability?.getCurrentSegmentKind?.() || "session",
            recordedAt: new Date().toISOString(),
        };
        const entry = normalizePlanAssociation(rawEntry);
        if (!entry || !this.rootSessionManager?.appendCustomEntry || !capability?.stagePlanAssociation) {
            throw new Error("plan_association_not_writable");
        }
        this.rootSessionManager.appendCustomEntry(PLAN_ASSOCIATION_CUSTOM_TYPE, entry);
        capability.stagePlanAssociation(entry);
        return entry;
    }

    /** @param {ActiveExecutionWorkflow | null} workflow */
    setActiveExecutionWorkflow(workflow) {
        this.assertActive();
        if (workflow) {
            const owner = workflow.executionAgent;
            if (owner !== "engineer" && owner !== "frontend-engineer") {
                throw new Error(
                    "setActiveExecutionWorkflow: active execution workflow requires executionAgent engineer or frontend-engineer",
                );
            }
            if (workflow.executionStarted !== undefined && typeof workflow.executionStarted !== "boolean") {
                throw new Error("setActiveExecutionWorkflow: executionStarted must be boolean");
            }
            if (
                workflow.executionAttemptStartedAtMs !== undefined &&
                (!Number.isFinite(workflow.executionAttemptStartedAtMs) || workflow.executionAttemptStartedAtMs < 0)
            ) {
                throw new Error(
                    "setActiveExecutionWorkflow: executionAttemptStartedAtMs must be a non-negative number",
                );
            }
            if (
                workflow.collaborationStyle !== undefined && workflow.collaborationStyle !== "autonomous" &&
                workflow.collaborationStyle !== "pair"
            ) {
                throw new Error("setActiveExecutionWorkflow: collaborationStyle must be autonomous or pair");
            }
            if (
                workflow.collaborationRecommendation !== undefined &&
                workflow.collaborationRecommendation !== "autonomous" && workflow.collaborationRecommendation !== "pair"
            ) {
                throw new Error(
                    "setActiveExecutionWorkflow: collaborationRecommendation must be autonomous or pair",
                );
            }
            if (
                workflow.pairCheckpointCount !== undefined &&
                (!Number.isInteger(workflow.pairCheckpointCount) || workflow.pairCheckpointCount < 0)
            ) {
                throw new Error("setActiveExecutionWorkflow: pairCheckpointCount must be a non-negative integer");
            }
            if (
                workflow.pairPauseReason !== undefined && workflow.pairPauseReason !== "stop" &&
                workflow.pairPauseReason !== "canceled"
            ) {
                throw new Error("setActiveExecutionWorkflow: pairPauseReason must be stop or canceled");
            }
        }
        if (this.rootSessionManager) this.#assertManagedWritableCapability(this.managedOperationCapability);
        if (workflow) this.pendingTaskCompletion = null;
        this.activeExecutionWorkflow = workflow;
        recordExecutionWorkflowSnapshot(this);
    }

    getActiveExecutionWorkflow() {
        return this.activeExecutionWorkflow;
    }

    /** @param {string} cycle */
    warnBackgroundCompletion(cycle) {
        if (this.backgroundCompletionWarning === cycle) return false;
        this.backgroundCompletionWarning = cycle;
        return true;
    }

    resetBackgroundCompletionWarning() {
        this.backgroundCompletionWarning = null;
    }

    async settleBackgroundTasksForCompletion() {
        // Suppress synchronously before any result can enter a new turn.
        const settlement = this.backgroundTasks.cancelAllAndSuppress();
        try {
            await clearBackgroundSteeringForCompletion(this);
        } finally {
            await settlement;
        }
    }

    /** @param {string} cwd */
    rebindProjectRoot(cwd) {
        this.assertActive();
        this.cwd = requireAbsoluteProjectRoot(cwd, "cwd");
    }

    getActiveExecutionCwd() {
        return this.activeExecutionWorkflow?.executionCwd || this.cwd;
    }

    clearActiveExecutionWorkflow() {
        this.assertActive();
        if (this.rootSessionManager) this.#assertManagedWritableCapability(this.managedOperationCapability);
        clearPairCheckpoint(this, "workflow_cleared");
        this.activeExecutionWorkflow = null;
        recordExecutionWorkflowSnapshot(this);
        this.pendingTaskCompletion = null;
    }

    /** @param {string} turnId */
    beginTurn(turnId) {
        this.assertActive();
        if (this.activeTurnId) return false;
        this.activeTurnId = turnId;
        return true;
    }

    /** @param {string} turnId */
    endTurn(turnId) {
        if (this.activeTurnId !== turnId) return false;
        this.activeTurnId = null;
        return true;
    }

    getActiveTurnId() {
        return this.activeTurnId;
    }

    isTurnActive() {
        return Boolean(this.activeTurnId);
    }

    async dispose() {
        if (this.disposed) return;
        await this.backgroundTasks.cancelAllAndSuppress();
        await this.planReviewConversations.dispose();
        const pendingDisposals = [
            disposeIfPresentAsync(this.rootAgentSession),
            ...Array.from(this.subAgentSessions, (session) => disposeIfPresentAsync(session)),
            disposeIfPresentAsync(this.rootSessionManager),
        ];
        this.agentInfoStack = [];
        this.userModelOverrideId = "";
        this.userModelOverrideProvider = "";
        this.userModelOverride = false;
        this.activeThinkingLevel = "off";
        this.activeOnMessage = null;
        this.rootSessionManager = null;
        this.eventSink = null;
        this.eventObservers.clear();
        this.interactionAdapter?.cancelAll?.();
        this.interactionAdapter = null;
        this.activeInteractions.clear();
        this.toolExecutionIds.clear();
        this.rootAgentSession = null;
        this.rootAgentName = null;
        this.subAgentSessions.clear();
        this.delegatedReaderCount = 0;
        this.delegatedWriterActive = false;
        this.projectStateContext = "";
        this.workflowContext = null;
        this.activeExecutionWorkflow = null;
        this.pendingTaskCompletion = null;
        this.activeTurnId = null;
        this.steeringTargetStack = [];
        this.agentTransitionId = null;
        this.agentTransitionSteering = [];
        this.agentSteeringPreparations.clear();
        for (const resolve of this.agentSteeringPreparationWaiters) resolve();
        this.agentSteeringPreparationWaiters.clear();
        this.disposed = true;
        await Promise.all(pendingDisposals);
        await this.closeMcpIntegration();
        this.mcpRequestServers = [];
        this.managed = null;
    }
}
