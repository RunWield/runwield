/**
 * @module shared/session/hosted-session
 * Per-conversation runtime state owned by a SessionHost entry.
 */

import type { ActiveExecutionWorkflow } from "./execution-workflow-session.ts";
import type { ThinkingLevel } from "./named-invocation.ts";
import type { ContextUsageState } from "./session-context-report.ts";
import type { RuntimeContextModel, RuntimeContextSettingsManager } from "./runtime/types.ts";
import type { ImageAttachment } from "./image-attachments.ts";
import type {
    NotificationSurface,
    RuntimeManagedSyncStateEvent,
    RuntimeQueuedMessage,
} from "./session-runtime-events.ts";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
    RuntimeInteractionAdapter,
    RuntimeInteractionRequest,
    RuntimeInteractionResponse,
} from "./session-runtime-interactions.ts";
import type { RemoteSessionRecords } from "../remote/session-protocol.ts";
import type {
    LineageSessionManager,
    WorkflowContext,
    WorkflowContextInput,
    WorkflowTriageContextDetails,
} from "./workflow-context-session.ts";
import type { TutorialContext, TutorialContextUpdate } from "./tutorial-context-session.ts";
import type { ManagedOperationCapability } from "./managed-operation.ts";
import type { McpServerDefinition } from "../mcp/config.ts";
import type { McpIntegration } from "../mcp/integration.ts";
import type { ManifestPlanAssociation, PlanAssociation } from "./plan-association.ts";
import type { AgentHandler } from "./agent-handler.ts";
import type { ProjectedSessionSnapshot } from "./session-transcript-manifest.ts";

import { setCurrentValidationProgress } from "../workflow/validation-progress.ts";
import { isAbsolute } from "node:path";
import { MAX_DELEGATED_READERS } from "../../constants.ts";
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
} from "./workflow-context-session.ts";
import { emitHostedSessionRuntimeEvent, RuntimeEventTypes } from "./session-runtime-events.ts";
import { clearPairCheckpoint } from "./pair-checkpoint-session.ts";
import { recordExecutionWorkflowSnapshot } from "./execution-workflow-session.ts";
import { BackgroundTasks } from "./background-tasks.ts";
import { clearBackgroundSteeringForCompletion } from "./runtime/turns.ts";
import { PlanReviewConversationOwner } from "./plan-review-conversation.ts";

export type { ActiveExecutionWorkflow, ThinkingLevel };

export interface AgentInfo {
    displayName: string;
    model: string;
    provider: string;
    agentName?: string;
}

export type AgentInfoRecord = AgentInfo & { sessionInfoId: string };

export interface HostedRuntimeEventObservation {
    type: string;
    delta?: string;
    messageId?: string;
    agentName?: string;
}

export interface DisposableLike {
    dispose?: () => void | Promise<void>;
    getContextUsage?: () => ContextUsageState | undefined;
    settingsManager?: RuntimeContextSettingsManager;
    model?: RuntimeContextModel;
}

export interface AgentTransitionSteering {
    text: string;
    images: ImageAttachment[];
    message?: RuntimeQueuedMessage;
    submissionOrder?: number;
}

export interface SteeringTargetRecord {
    steeringTargetId: string;
    session: DisposableLike;
}

export interface SessionManagerExtensions {
    addMessage?: (message: Parameters<SessionManager["appendMessage"]>[0]) => void;
    dispose?: () => void | Promise<void>;
}

export interface MinimalSessionManagerShape
    extends SessionManagerExtensions, Pick<LineageSessionManager, "getBranch" | "getEntries"> {
    getSessionId?: () => string;
    getLeafId?: () => string | null;
    getSessionFile?: () => string | undefined;
    getCwd?: () => string;
    getSessionName?: () => string | undefined;
    appendSessionInfo?: (name: string) => void;
    appendThinkingLevelChange?: (level: ThinkingLevel) => void;
    appendModelChange?: (provider: string, modelId: string) => void;
    appendMessage?: SessionManager["appendMessage"];
    appendCustomEntry?: (...args: Parameters<SessionManager["appendCustomEntry"]>) => void;
}

export type MinimalSessionManagerLike = MinimalSessionManagerShape | (SessionManager & SessionManagerExtensions);

export interface ActiveInteractionRecord {
    request?: RuntimeInteractionRequest;
    abortController?: AbortController;
    answer?: (response: RuntimeInteractionResponse, source?: NotificationSurface) => void;
}

export interface HostedSessionOptions {
    id?: string;
    cwd?: string;
    sessionManager?: MinimalSessionManagerLike | null;
    // Legacy adapters supply callbacks or emitters that accept different event shapes.
    eventSink?: unknown;
    interactionAdapter?: RuntimeInteractionAdapter;
    managed?: ManagedSessionMetadata | null;
}

type ManagedSessionSyncState = Pick<
    RuntimeManagedSyncStateEvent,
    "type" | "status" | "localGeneration" | "latestGeneration" | "owningSurfaceKind" | "message"
>;

export interface ManagedSessionMetadata {
    runwieldSessionId: string;
    projectId: string;
    piSessionId: string;
    transcriptPath: string;
    currentSegmentId?: string;
    generation: number | null;
    acknowledgedGeneration?: number | null;
    acknowledgedEventId?: string | null;
    acknowledgedEventOrdinal?: number | null;
    remoteRecords?: RemoteSessionRecords;
    committedSummary?: ProjectedSessionSnapshot;
    syncState?: ManagedSessionSyncState | null;
    name: string | null;
    activeAgent: string | null;
    model?: string | null;
    provider?: string | null;
    thinkingLevel?: string | null;
    workflowContext: WorkflowContext | null;
    tutorialContext?: TutorialContext | null;
}

interface ManagedTranscriptSegment {
    piSessionId: string;
    transcriptPath: string;
    currentSegmentId: string;
    sessionManager: MinimalSessionManagerLike;
}

interface PlanReviewLookup {
    planId: string;
    planningAgentName: string;
}

interface WorkflowContextReplacementOptions {
    persist?: boolean;
}

type PlanAssociationInput = Partial<Pick<PlanAssociation, "planId" | "planName" | "purpose">>;

export interface PendingManagedTurnIntent {
    agentName?: string;
    model?: string;
    provider?: string;
    manualModel?: boolean;
    thinkingLevel?: ThinkingLevel;
}

export interface PendingTaskCompletion {
    agentName: string;
    report: string;
    timestampMs: number;
    owningSession: DisposableLike | null;
}

function getSessionManagerId(value: MinimalSessionManagerLike | null | undefined) {
    if (!value || typeof value !== "object" || !("getSessionId" in value) || typeof value.getSessionId !== "function") {
        return null;
    }
    const id = value.getSessionId();
    return typeof id === "string" && id ? id : null;
}

function getSessionManagerCwd(value: MinimalSessionManagerLike | null | undefined) {
    if (!value || typeof value !== "object" || !("getCwd" in value) || typeof value.getCwd !== "function") {
        return null;
    }
    const cwd = value.getCwd();
    return typeof cwd === "string" && cwd ? cwd : null;
}

function requireAbsoluteProjectRoot(cwd: string | null | undefined, source: string): string {
    if (!cwd) throw new Error(`HostedSession requires an absolute project root (${source})`);
    if (!isAbsolute(cwd)) throw new Error(`HostedSession project root must be absolute: ${cwd}`);
    return cwd;
}

function disposeIfPresent(value: DisposableLike | null | undefined) {
    if (!value || typeof value !== "object" || !("dispose" in value) || typeof value.dispose !== "function") return;
    try {
        value.dispose();
    } catch {
        // Disposal is best-effort so one bad runtime object does not prevent
        // the HostedSession from clearing the rest of its owned references.
    }
}

function disposeIfPresentAsync(value: DisposableLike | null | undefined) {
    if (!value || typeof value !== "object" || !("dispose" in value) || typeof value.dispose !== "function") return;
    try {
        return Promise.resolve(value.dispose()).catch(() => undefined);
    } catch {
        // Disposal is best-effort so one bad runtime object does not prevent
        // the HostedSession from clearing the rest of its owned references.
    }
}

export class HostedSession {
    declare id: string;
    declare cwd: string;
    declare disposed: boolean;
    declare backgroundTasks: BackgroundTasks;
    declare backgroundCompletionWarning: string | null;
    declare agentInfoStack: AgentInfoRecord[];
    declare agentInfoSequence: number;
    declare userModelOverrideId: string;
    declare userModelOverrideProvider: string;
    declare userModelOverride: boolean;
    declare activeThinkingLevel: ThinkingLevel;
    declare activeOnMessage: AgentHandler | null;
    declare rootSessionManager: MinimalSessionManagerLike | null;
    declare eventSink: HostedSessionOptions["eventSink"];
    declare eventObservers: Set<(event: HostedRuntimeEventObservation) => void>;
    declare planReviewConversations: PlanReviewConversationOwner;
    declare interactionAdapter: RuntimeInteractionAdapter | null;
    declare activeInteractions: Map<string, ActiveInteractionRecord>;
    declare liveCodeReviewUrl: string;
    declare rootAgentSession: DisposableLike | null;
    declare rootAgentName: string | null;
    declare subAgentSessions: Set<DisposableLike>;
    declare steeringTargetStack: SteeringTargetRecord[];
    declare steeringTargetSequence: number;
    declare agentTransitionId: string | null;
    declare agentTransitionSteering: AgentTransitionSteering[];
    declare agentSteeringPreparations: Set<string>;
    declare agentSteeringPreparationWaiters: Set<() => void>;
    declare delegatedReaderCount: number;
    declare delegatedWriterActive: boolean;
    declare projectStateContext: string;
    declare workflowContext: WorkflowContext | null;
    declare tutorialContext: TutorialContext | null;
    declare activeExecutionWorkflow: ActiveExecutionWorkflow | null;
    declare pendingTaskCompletion: PendingTaskCompletion | null;
    declare suppressAgentStoppedAttention: boolean;
    declare notificationSurface: NotificationSurface | null;
    declare localInputSurface: NotificationSurface | null;
    declare agentStoppedAttentionTurnId: string | null;
    declare activeTurnId: string | null;
    declare activeCommandInvocationId: string | null;
    declare toolExecutionIds: Map<string, string>;
    declare generatedTaskTurnId: string | null;
    declare metricsHumanInputPending: boolean;
    declare managed: ManagedSessionMetadata | null;
    declare managedOperationCapability: ManagedOperationCapability | null;
    declare pendingManagedTurnIntent: PendingManagedTurnIntent;
    declare mcpIntegration: McpIntegration | null;
    declare mcpRequestServers: McpServerDefinition[];

    constructor(options: HostedSessionOptions) {
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
        this.backgroundCompletionWarning = null;

        this.agentInfoStack = [];
        this.agentInfoSequence = 0;
        this.userModelOverrideId = "";
        this.userModelOverrideProvider = "";
        this.userModelOverride = false;
        this.activeThinkingLevel = "off";
        this.activeOnMessage = null;
        this.rootSessionManager = options.sessionManager || null;
        this.eventSink = options.eventSink || null;
        this.eventObservers = new Set();
        this.planReviewConversations = new PlanReviewConversationOwner();
        this.interactionAdapter = options.interactionAdapter || null;
        this.activeInteractions = new Map();
        // Browser review lifetime spans the gaps between interaction requests, including repair and CI.
        this.liveCodeReviewUrl = "";
        this.rootAgentSession = null;
        this.rootAgentName = null;
        this.subAgentSessions = new Set();
        this.steeringTargetStack = [];
        this.steeringTargetSequence = 0;
        this.agentTransitionId = null;
        this.agentTransitionSteering = [];
        this.agentSteeringPreparations = new Set();
        this.agentSteeringPreparationWaiters = new Set();
        this.delegatedReaderCount = 0;
        this.delegatedWriterActive = false;
        this.projectStateContext = "";
        this.workflowContext = readPersistedWorkflowContext(this.rootSessionManager);
        this.tutorialContext =
            readPersistedTutorialContext(this.rootSessionManager) || options.managed?.tutorialContext || null;
        this.activeExecutionWorkflow = null;
        this.pendingTaskCompletion = null;
        this.suppressAgentStoppedAttention = false;
        this.notificationSurface = null;
        this.localInputSurface = null;
        this.agentStoppedAttentionTurnId = null;
        this.activeTurnId = null;
        /** Opaque ID for a named invocation while its resulting work runs. */
        this.activeCommandInvocationId = null;
        this.toolExecutionIds = new Map();
        this.generatedTaskTurnId = null;
        /** Consumed once by the first execution started for an accepted human input. */
        this.metricsHumanInputPending = false;
        this.managed = options.managed || null;
        this.managedOperationCapability = null;
        this.pendingManagedTurnIntent = {};
        this.mcpIntegration = null;
        this.mcpRequestServers = [];
    }

    recordToolExecution(callId: string, executionId: string) {
        this.toolExecutionIds.set(callId, executionId);
    }

    getToolExecutionId(callId: string) {
        return this.toolExecutionIds.get(callId);
    }

    forgetToolExecution(callId: string) {
        this.toolExecutionIds.delete(callId);
    }

    forgetExecutionToolCalls(executionId: string) {
        for (const [callId, owner] of this.toolExecutionIds) {
            if (owner === executionId) this.toolExecutionIds.delete(callId);
        }
    }

    assertActive() {
        if (this.disposed) throw new Error(`HostedSession "${this.id}" is disposed`);
    }

    pushAgentInfo(displayName: string, model: string = "", provider: string = "", agentName: string = ""): string {
        this.assertActive();
        const sessionInfoId = `agent-info-${++this.agentInfoSequence}`;
        this.agentInfoStack.push({ sessionInfoId, displayName, model, provider, ...(agentName ? { agentName } : {}) });
        return sessionInfoId;
    }

    popAgentInfo(sessionInfoId: string = "") {
        this.assertActive();
        if (!sessionInfoId) {
            this.agentInfoStack.pop();
            return;
        }
        const index = this.agentInfoStack.findIndex((agentInfo) => agentInfo.sessionInfoId === sessionInfoId);
        if (index >= 0) this.agentInfoStack.splice(index, 1);
    }

    resetAgentInfoStack(displayName: string, model: string = "", provider: string = "", agentName: string = "") {
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

    setActiveModelState(model: string, provider: string = "", isUserOverride: boolean = false) {
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

    setActiveOnMessage(handler: AgentHandler | null) {
        this.assertActive();
        this.activeOnMessage = handler;
    }

    getActiveOnMessage() {
        return this.activeOnMessage;
    }

    setManagedOperationCapability(capability: ManagedOperationCapability | null) {
        this.assertActive();
        this.managedOperationCapability = capability;
    }

    getManagedOperationCapability() {
        return this.managedOperationCapability;
    }

    #assertManagedWritableCapability(capability: ManagedOperationCapability | null) {
        if (!this.managed) return;
        if (!capability || capability !== this.managedOperationCapability) {
            throw new Error("managed_operation_required");
        }
        capability.assertLive();
    }

    setRootSessionManager(
        sessionManager: MinimalSessionManagerLike | null,
        capability: ManagedOperationCapability | null = null,
    ) {
        this.assertActive();
        if (sessionManager) this.#assertManagedWritableCapability(capability);
        const previous = this.workflowContext;
        this.rootSessionManager = sessionManager;
        if (!sessionManager) return;

        this.tutorialContext = readPersistedTutorialContext(sessionManager);
        const persisted = readPersistedWorkflowContext(sessionManager);
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

    setManagedMetadata(metadata: ManagedSessionMetadata | null) {
        this.assertActive();
        this.managed = metadata ? { ...metadata } : null;
    }

    getManagedMetadata() {
        return this.managed ? { ...this.managed } : null;
    }

    replaceManagedTranscriptSegment(segment: ManagedTranscriptSegment) {
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
        const persisted = readPersistedWorkflowContext(segment.sessionManager);
        if (persisted) this.replaceWorkflowContext(persisted, { persist: false });
        this.tutorialContext = readPersistedTutorialContext(segment.sessionManager);
    }

    mergePendingManagedTurnIntent(intent: PendingManagedTurnIntent) {
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
        this.liveCodeReviewUrl = "";
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

    setEventSink(eventSink: HostedSessionOptions["eventSink"]) {
        this.assertActive();
        this.eventSink = eventSink;
    }

    getEventSink() {
        return this.eventSink;
    }

    subscribeRuntimeEvents(observer: (event: HostedRuntimeEventObservation) => void) {
        this.assertActive();
        this.eventObservers.add(observer);
        return () => this.eventObservers.delete(observer);
    }

    getPlanReviewConversation(review: PlanReviewLookup) {
        this.assertActive();
        return this.planReviewConversations.select(review.planId, review.planningAgentName);
    }

    publishRuntimeEvent(event: HostedRuntimeEventObservation) {
        this.planReviewConversations.capture(event);
        for (const observer of this.eventObservers) {
            try {
                observer(event);
            } catch {
                // Review and presentation observers must not interrupt the agent session.
            }
        }
    }

    setInteractionAdapter(adapter: RuntimeInteractionAdapter | null) {
        this.assertActive();
        this.interactionAdapter = adapter;
    }

    getInteractionAdapter() {
        return this.interactionAdapter;
    }

    setMcpRequestServers(servers: McpServerDefinition[]) {
        this.assertActive();
        this.mcpRequestServers = servers.map((server) => ({ ...server }));
    }

    getMcpRequestServers() {
        return this.mcpRequestServers.map((server) => ({ ...server }));
    }

    async setMcpIntegration(pool: McpIntegration | null) {
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

    moveMcpStateTo(targetHostedSession: HostedSession) {
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

    addActiveInteraction(id: string, record: ActiveInteractionRecord) {
        this.assertActive();
        this.activeInteractions.set(id, record);
    }

    removeActiveInteraction(id: string) {
        this.activeInteractions.delete(id);
    }

    getActiveInteractions() {
        return new Map(this.activeInteractions);
    }

    setLiveCodeReviewUrl(url: string) {
        this.liveCodeReviewUrl = url;
    }

    getLiveCodeReviewUrl() {
        return this.liveCodeReviewUrl;
    }

    cancelActiveInteractions() {
        this.liveCodeReviewUrl = "";
        const canceled = this.activeInteractions.size > 0;
        for (const record of this.activeInteractions.values()) {
            record.abortController?.abort();
        }
        this.interactionAdapter?.cancelAll?.();
        this.activeInteractions.clear();
        return canceled;
    }

    setRootAgentSession(session: DisposableLike | null, capability: ManagedOperationCapability | null = null) {
        this.assertActive();
        if (session) this.#assertManagedWritableCapability(capability);
        this.rootAgentSession = session;
    }

    getRootAgentSession() {
        return this.rootAgentSession;
    }

    setRootAgentName(agentName: string | null, capability: ManagedOperationCapability | null = null) {
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

    recordPendingTaskCompletion(agentName: string, report: string, timestampMs: number = Date.now()) {
        this.assertActive();
        this.pendingTaskCompletion = {
            agentName,
            report,
            timestampMs,
            owningSession: this.getActiveSteeringTargetSession(),
        };
    }

    consumePendingTaskCompletion(owningSession: DisposableLike | null) {
        if (!this.pendingTaskCompletion) return null;
        if (this.pendingTaskCompletion.owningSession !== owningSession) return null;
        const completion = this.pendingTaskCompletion;
        this.pendingTaskCompletion = null;
        return completion;
    }

    getPendingTaskCompletionForRestore() {
        return this.pendingTaskCompletion ? { ...this.pendingTaskCompletion } : null;
    }

    restoreActiveExecutionWorkflow(
        workflow: ActiveExecutionWorkflow | null,
        pendingTaskCompletion: PendingTaskCompletion | null,
    ) {
        this.assertActive();
        this.activeExecutionWorkflow = workflow;
        this.pendingTaskCompletion = pendingTaskCompletion ? { ...pendingTaskCompletion } : null;
    }

    addSubAgentSession(session: DisposableLike, capability: ManagedOperationCapability | null = null) {
        this.assertActive();
        this.#assertManagedWritableCapability(capability);
        this.subAgentSessions.add(session);
    }

    removeSubAgentSession(session: DisposableLike) {
        this.assertActive();
        this.subAgentSessions.delete(session);
    }

    getSubAgentSessions() {
        return new Set(this.subAgentSessions);
    }

    pushSteeringTargetSession(session: DisposableLike) {
        this.assertActive();
        const steeringTargetId = `steering-target-${++this.steeringTargetSequence}`;
        this.steeringTargetStack.push({ steeringTargetId, session });
        return steeringTargetId;
    }

    popSteeringTargetSession(steeringTargetId: string) {
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

    beginAgentTransition(): string {
        this.assertActive();
        if (this.agentTransitionId) throw new Error("An Agent transition is already active");
        this.agentTransitionId = `agent-transition-${crypto.randomUUID()}`;
        return this.agentTransitionId;
    }

    isAgentTransitioning(): boolean {
        return Boolean(this.agentTransitionId);
    }

    getAgentTransitionId(): string | null {
        return this.agentTransitionId;
    }

    queueAgentTransitionSteering(
        text: string,
        images: ImageAttachment[] = [],
        message?: RuntimeQueuedMessage,
        submissionOrder?: number,
    ): boolean {
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
        const laterEntryIndex =
            submissionOrder === undefined
                ? -1
                : this.agentTransitionSteering.findIndex(
                      (current) => current.submissionOrder !== undefined && current.submissionOrder > submissionOrder,
                  );
        if (laterEntryIndex < 0) this.agentTransitionSteering.push(entry);
        else this.agentTransitionSteering.splice(laterEntryIndex, 0, entry);
        return true;
    }

    completeAgentTransition(transitionId: string) {
        this.assertActive();
        if (this.agentTransitionId === transitionId) this.agentTransitionId = null;
    }

    beginAgentSteeringPreparation(messageId: string) {
        this.assertActive();
        this.agentSteeringPreparations.add(messageId);
    }

    completeAgentSteeringPreparation(messageId: string) {
        if (!this.agentSteeringPreparations.delete(messageId) || this.agentSteeringPreparations.size > 0) return;
        for (const resolve of this.agentSteeringPreparationWaiters) resolve();
        this.agentSteeringPreparationWaiters.clear();
    }

    hasAgentSteeringPreparations(): boolean {
        return this.agentSteeringPreparations.size > 0;
    }

    async waitForAgentSteeringPreparations(): Promise<void> {
        if (!this.hasAgentSteeringPreparations()) return;
        await new Promise((resolve) => this.agentSteeringPreparationWaiters.add(() => resolve(undefined)));
    }

    listAgentTransitionSteering(): AgentTransitionSteering[] {
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

    consumeAgentTransitionSteering(): AgentTransitionSteering[] {
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

    removeAgentTransitionSteering(messageId: string) {
        const index = this.agentTransitionSteering.findIndex((entry) => entry.message?.id === messageId);
        if (index < 0) return false;
        this.agentTransitionSteering.splice(index, 1);
        return true;
    }

    clearAgentTransitionSteering(): AgentTransitionSteering[] {
        return this.consumeAgentTransitionSteering();
    }

    restoreAgentTransitionSteering(entries: AgentTransitionSteering[]) {
        const missingEntries = entries.filter(
            (entry) =>
                !this.agentTransitionSteering.some((current) =>
                    entry.message?.id
                        ? current.message?.id === entry.message.id
                        : !current.message &&
                          current.text === entry.text &&
                          JSON.stringify(current.images) === JSON.stringify(entry.images),
                ),
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

    acquireDelegatedAgentLease(mode: "read" | "write"): () => void {
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

    setThinkingLevel(level: ThinkingLevel) {
        this.assertActive();
        this.activeThinkingLevel = level;
    }

    setProjectStateContext(context: string) {
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

    updateTutorialContext(update: TutorialContextUpdate, committedPlanAssociations: ManifestPlanAssociation[] = []) {
        if (this.disposed) throw new Error("tutorial_context_not_writable");
        const capability = this.getManagedOperationCapability?.() || null;
        this.#assertManagedWritableCapability(capability);
        if (!this.managed || !this.rootSessionManager?.appendCustomEntry) {
            throw new Error("tutorial_context_not_writable");
        }
        const nextContext = applyTutorialContextUpdate(this.tutorialContext, update);
        if (!nextContext) throw new Error("tutorial_context_invalid");
        if (nextContext.planId && nextContext.planId !== this.tutorialContext?.planId) {
            const hasCommittedAssociation = committedPlanAssociations.some(
                (association) =>
                    association.planId === nextContext.planId && Number.isInteger(association.committedGeneration),
            );
            if (!hasCommittedAssociation) throw new Error("tutorial_context_plan_association_required");
        }
        const recorded = recordTutorialContext(this.rootSessionManager, nextContext);
        if (!recorded) throw new Error("tutorial_context_invalid");
        this.tutorialContext = recorded;
        return this.getTutorialContext();
    }

    replaceWorkflowContext(nextContext: WorkflowContext | null, options: WorkflowContextReplacementOptions = {}) {
        if (this.disposed) return;
        const previous = this.workflowContext;
        let normalized = nextContext;
        try {
            if (options.persist) {
                normalized = recordNormalizedWorkflowContext(this.rootSessionManager, nextContext);
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

    setWorkflowTriageContext(details: WorkflowTriageContextDetails) {
        if (this.disposed) return;
        try {
            const hasWorkflowContextPersistence = typeof this.rootSessionManager?.appendCustomEntry === "function";
            const recordedContext = recordWorkflowTriageContext(this.rootSessionManager, details);
            const nextContext =
                recordedContext && !hasWorkflowContextPersistence
                    ? { ...this.workflowContext, ...recordedContext }
                    : recordedContext || this.workflowContext;
            if (nextContext) delete nextContext.validationProgress;
            this.replaceWorkflowContext(nextContext, { persist: false });
        } catch (_e) {
            // Footer-context persistence is fail-open and must not block triage.
        }
    }

    setWorkflowPlanName(planName: string) {
        if (this.disposed) return;
        try {
            const hasWorkflowContextPersistence = typeof this.rootSessionManager?.appendCustomEntry === "function";
            const recordedContext = recordWorkflowPlanName(this.rootSessionManager, planName);
            const nextContext =
                recordedContext && !hasWorkflowContextPersistence
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

    setWorkflowExecutionContext(details: WorkflowContextInput) {
        if (this.disposed) return;
        const nextContext = deriveWorkflowContextFromExecutionWorkflow(details);
        if (!nextContext) return;
        this.replaceWorkflowContext(nextContext, { persist: true });
    }

    recordPlanAssociation(details: PlanAssociationInput) {
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

    setActiveExecutionWorkflow(workflow: ActiveExecutionWorkflow | null) {
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
                workflow.collaborationStyle !== undefined &&
                workflow.collaborationStyle !== "autonomous" &&
                workflow.collaborationStyle !== "pair"
            ) {
                throw new Error("setActiveExecutionWorkflow: collaborationStyle must be autonomous or pair");
            }
            if (
                workflow.collaborationRecommendation !== undefined &&
                workflow.collaborationRecommendation !== "autonomous" &&
                workflow.collaborationRecommendation !== "pair"
            ) {
                throw new Error("setActiveExecutionWorkflow: collaborationRecommendation must be autonomous or pair");
            }
            if (
                workflow.pairCheckpointCount !== undefined &&
                (!Number.isInteger(workflow.pairCheckpointCount) || workflow.pairCheckpointCount < 0)
            ) {
                throw new Error("setActiveExecutionWorkflow: pairCheckpointCount must be a non-negative integer");
            }
            if (
                workflow.pairPauseReason !== undefined &&
                workflow.pairPauseReason !== "stop" &&
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

    warnBackgroundCompletion(cycle: string) {
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

    rebindProjectRoot(cwd: string) {
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
        this.liveCodeReviewUrl = "";
        this.activeExecutionWorkflow = null;
        recordExecutionWorkflowSnapshot(this);
        this.pendingTaskCompletion = null;
    }

    beginTurn(turnId: string) {
        this.assertActive();
        if (this.activeTurnId) return false;
        this.activeTurnId = turnId;
        return true;
    }

    endTurn(turnId: string) {
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
        this.liveCodeReviewUrl = "";
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
