/** Per-conversation runtime state owned by a Session Host entry. */

import type { ActiveExecutionWorkflow } from "@runwield/workflow/state";
import type {
    WorkflowEventJournalReader,
    WorkflowEventJournalRecord,
    WorkflowEventJournalWriter,
} from "@runwield/workflow/events";
import type { SessionHostEventSink } from "./host.ts";
import type { ThinkingLevel } from "../../src/shared/session/named-invocation.ts";
import type { ContextUsageState } from "../../src/shared/session/session-context-report.ts";
import type { RuntimeContextModel, RuntimeContextSettingsManager } from "./runtime/types.ts";
import type {
    ImageAttachment,
    NotificationSurface,
    RuntimeManagedSyncStateEvent,
    RuntimeQueuedMessage,
    WorkflowContext,
} from "./events.ts";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
    RuntimeInteractionAdapter,
    RuntimeInteractionRequest,
    RuntimeInteractionResponse,
} from "./interactions.ts";
import type { RemoteSessionRecords } from "../../src/shared/remote/session-protocol.ts";
import type {
    WorkflowContextInput,
    WorkflowTriageContextDetails,
} from "../../src/shared/session/workflow-context-session.ts";
import type { TutorialContext, TutorialContextUpdate } from "../../src/shared/session/tutorial-context-session.ts";
import type { ManagedOperationCapability } from "../../src/shared/session/managed-operation.ts";
import type { McpServerDefinition } from "../../src/shared/mcp/config.ts";
import type { McpIntegration } from "@runwield/pi-ai/mcp";
import type { ManifestPlanAssociation, PlanAssociation } from "../../src/shared/session/plan-association.ts";
import type { AgentHandler } from "../../src/shared/session/agent-handler.ts";
import type { ProjectedSessionSnapshot } from "./session-transcript-manifest.ts";
import type { TranscriptRecord } from "./session-transcript-projection.ts";

import { setCurrentValidationProgress } from "../../src/shared/workflow/validation-progress.ts";
import { isAbsolute } from "node:path";
import { MAX_DELEGATED_READERS } from "../../src/constants.ts";
import { normalizePlanAssociation, PLAN_ASSOCIATION_CUSTOM_TYPE } from "../../src/shared/session/plan-association.ts";
import {
    applyTutorialContextUpdate,
    readPersistedTutorialContext,
    recordTutorialContext,
} from "../../src/shared/session/tutorial-context-session.ts";
import {
    deriveWorkflowContextFromExecutionWorkflow,
    readPersistedWorkflowContext,
    recordNormalizedWorkflowContext,
    recordWorkflowPlanName,
    recordWorkflowTriageContext,
    workflowContextsEqual,
} from "../../src/shared/session/workflow-context-session.ts";
import { RuntimeEventTypes } from "./events.ts";
import { emitHostedSessionRuntimeEvent } from "./event-publication.ts";
import { clearPairCheckpoint } from "../../src/shared/session/pair-checkpoint-session.ts";
import { recordExecutionWorkflowSnapshot } from "../../src/shared/session/execution-workflow-session.ts";
import { BackgroundTasks } from "../../src/shared/session/background-tasks.ts";
import { clearBackgroundSteeringForCompletion } from "./runtime/background-steering.ts";
import { PlanReviewConversationOwner } from "../../src/shared/session/plan-review-conversation.ts";

export type { ThinkingLevel };

/** Display labels and selected model for a root or delegated Agent. */
export interface AgentInfo {
    displayName: string;
    model: string;
    provider: string;
    agentName?: string;
}

/** Agent display information paired with the token used to remove it. */
export type AgentInfoRecord = AgentInfo & { sessionInfoId: string };

/** Event fields used by in-process observers and Plan Review capture. */
export interface HostedRuntimeEventObservation {
    type: string;
    delta?: string;
    messageId?: string;
    agentName?: string;
}

/** Port for a root or delegated Agent's disposal, model, and context usage. */
export interface DisposableLike {
    /** Release the Agent’s resources when the Session no longer uses it. */
    dispose?: () => void | Promise<void>;
    /** Read the Agent’s current context usage when an estimate is available. */
    getContextUsage?: () => ContextUsageState | undefined;
    settingsManager?: RuntimeContextSettingsManager;
    model?: RuntimeContextModel;
}

/** Input buffered while the active Agent is changing. */
export interface AgentTransitionSteering {
    text: string;
    images: ImageAttachment[];
    message?: RuntimeQueuedMessage;
    submissionOrder?: number;
}

/** A steering target with its removal token. */
export interface SteeringTargetRecord {
    steeringTargetId: string;
    session: DisposableLike;
}

/** Extra session manager operations supported by host integrations. */
export interface SessionManagerExtensions {
    /** Record a message through a host adapter’s message writer. */
    addMessage?: (message: Parameters<SessionManager["appendMessage"]>[0]) => void;
    /** Release the manager’s resources when the Session closes. */
    dispose?: () => void | Promise<void>;
}

/** Session manager operations available to the host for transcript reuse and recording. */
export interface MinimalSessionManagerShape extends SessionManagerExtensions {
    /** Read the transcript entries leading to the selected leaf. */
    getBranch?: () => TranscriptRecord[];
    /** Read all transcript entries, including those on other branches. */
    getEntries?: () => TranscriptRecord[];
    /** Read the manager’s native Session ID. */
    getSessionId?: () => string;
    /** Read the selected terminal entry ID, or null for an empty transcript. */
    getLeafId?: () => string | null;
    /** Read the persisted transcript path when this manager has one. */
    getSessionFile?: () => string | undefined;
    /** Read the working directory associated with the transcript. */
    getCwd?: () => string;
    /** Read the current display name when the Session has been named. */
    getSessionName?: () => string | undefined;
    /** Record a Session name change in the transcript. */
    appendSessionInfo?: (name: string) => void;
    /** Record the thinking level selected for subsequent turns. */
    appendThinkingLevelChange?: (level: ThinkingLevel) => void;
    /** Record the provider and model selected for subsequent turns. */
    appendModelChange?: (provider: string, modelId: string) => void;
    /** Append a message to the current transcript branch. */
    appendMessage?: SessionManager["appendMessage"];
    /** Append a typed custom record to the current transcript branch. */
    appendCustomEntry?: (...args: Parameters<SessionManager["appendCustomEntry"]>) => void;
}

/** A Pi session manager or a compatible transcript adapter. */
export type MinimalSessionManagerLike = MinimalSessionManagerShape | (SessionManager & SessionManagerExtensions);

/** A pending request and its answer and cancellation handlers. */
export interface ActiveInteractionRecord {
    request?: RuntimeInteractionRequest;
    abortController?: AbortController;
    answer?: (response: RuntimeInteractionResponse, source?: NotificationSurface) => void;
}

/** Initial identity, transcript, and adapters for a hosted session. */
export interface HostedSessionOptions {
    id?: string;
    cwd?: string;
    sessionManager?: MinimalSessionManagerLike | null;
    eventSink?: SessionHostEventSink | null;
    interactionAdapter?: RuntimeInteractionAdapter;
    managed?: ManagedSessionMetadata | null;
}

type ManagedSessionSyncState = Pick<
    RuntimeManagedSyncStateEvent,
    "type" | "status" | "localGeneration" | "latestGeneration" | "owningSurfaceKind" | "message"
>;

/** Persisted RunWield identity and the current transcript segment and sync state. */
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

/** Agent and model choices to apply when the next managed operation acquires its writer. */
export interface PendingManagedTurnIntent {
    agentName?: string;
    model?: string;
    provider?: string;
    manualModel?: boolean;
    thinkingLevel?: ThinkingLevel;
}

/** A volatile task report attributable to the Agent session that submitted it. */
export interface PendingTaskCompletion {
    agentName: string;
    report: string;
    timestampMs: number;
    owningSession: DisposableLike | null;
}

/** Read the manager's nonempty transcript ID when it supplies one. */
export function getSessionManagerId(value: MinimalSessionManagerLike | null | undefined): string | null {
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

/** Owns per-session agent, interaction, workflow, and transcript state. */
export class HostedSession {
    declare readonly id: string;
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
    #eventSink: HostedSessionOptions["eventSink"];
    readonly #eventObservers = new Set<(event: HostedRuntimeEventObservation) => void>();
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

    /** Initialize a session and restore context from its transcript. */
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
        this.#eventSink = options.eventSink || null;
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

    /** Associate a tool call with the execution that started it. */
    recordToolExecution(callId: string, executionId: string) {
        this.toolExecutionIds.set(callId, executionId);
    }

    /** Find the execution that owns a tool call. */
    getToolExecutionId(callId: string) {
        return this.toolExecutionIds.get(callId);
    }

    /** Release one tool call's execution association. */
    forgetToolExecution(callId: string) {
        this.toolExecutionIds.delete(callId);
    }

    /** Release all tool calls associated with the finished execution. */
    forgetExecutionToolCalls(executionId: string) {
        for (const [callId, owner] of this.toolExecutionIds) {
            if (owner === executionId) this.toolExecutionIds.delete(callId);
        }
    }

    /** Reject operations against a disposed session. */
    assertActive() {
        if (this.disposed) throw new Error(`HostedSession "${this.id}" is disposed`);
    }

    /** Add the current Agent's display information and return its removal token. */
    pushAgentInfo(displayName: string, model: string = "", provider: string = "", agentName: string = ""): string {
        this.assertActive();
        const sessionInfoId = `agent-info-${++this.agentInfoSequence}`;
        this.agentInfoStack.push({ sessionInfoId, displayName, model, provider, ...(agentName ? { agentName } : {}) });
        return sessionInfoId;
    }

    /** Remove an Agent by token, or remove the latest entry when no token is supplied. */
    popAgentInfo(sessionInfoId: string = "") {
        this.assertActive();
        if (!sessionInfoId) {
            this.agentInfoStack.pop();
            return;
        }
        const index = this.agentInfoStack.findIndex((agentInfo) => agentInfo.sessionInfoId === sessionInfoId);
        if (index >= 0) this.agentInfoStack.splice(index, 1);
    }

    /** Replace the Agent display stack with the root Agent's information. */
    resetAgentInfoStack(displayName: string, model: string = "", provider: string = "", agentName: string = "") {
        this.assertActive();
        const sessionInfoId = `agent-info-${++this.agentInfoSequence}`;
        this.agentInfoStack = [{ sessionInfoId, displayName, model, provider, ...(agentName ? { agentName } : {}) }];
    }

    /** Read a copy of the Agent display stack in registration order. */
    getAgentInfoStack() {
        return this.agentInfoStack.map(({ sessionInfoId: _sessionInfoId, ...agentInfo }) => ({ ...agentInfo }));
    }

    /** Read a copy of the latest Agent's display information. */
    getActiveAgentInfo() {
        if (this.agentInfoStack.length === 0) return null;
        const { sessionInfoId: _sessionInfoId, ...agentInfo } = this.agentInfoStack[this.agentInfoStack.length - 1];
        return { ...agentInfo };
    }

    /** Read the latest Agent's display name, or an empty string. */
    getActiveAgentName() {
        return this.getActiveAgentInfo()?.displayName || "";
    }

    /** Record the selected model for the current Agent or set an explicit user override. */
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

    /** Read the effective model and provider, with any user override applied. */
    getActiveModelState() {
        if (this.userModelOverride) {
            return { model: this.userModelOverrideId, provider: this.userModelOverrideProvider };
        }
        if (this.agentInfoStack.length === 0) return { model: "", provider: "" };
        const top = this.agentInfoStack[this.agentInfoStack.length - 1];
        return { model: top.model, provider: top.provider };
    }

    /** Check whether a user override controls model selection. */
    isUserModelOverride() {
        return this.userModelOverride;
    }

    /** Return model selection to the active Agent's settings. */
    clearUserModelOverride() {
        this.assertActive();
        this.userModelOverride = false;
        this.userModelOverrideId = "";
        this.userModelOverrideProvider = "";
    }

    /** Install the active Agent's message handler. */
    setActiveOnMessage(handler: AgentHandler | null) {
        this.assertActive();
        this.activeOnMessage = handler;
    }

    /** Read the current Agent's message handler. */
    getActiveOnMessage() {
        return this.activeOnMessage;
    }

    /** Bind or clear the current managed writer capability. */
    setManagedOperationCapability(capability: ManagedOperationCapability | null) {
        this.assertActive();
        this.managedOperationCapability = capability;
    }

    /** Read the capability held by the current managed operation. */
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

    /** Attach the root transcript and reconcile its workflow and tutorial context. */
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

    /** Read the attached root transcript manager, when available. */
    getRootSessionManager() {
        return this.rootSessionManager;
    }

    /** Read workflow reports from the active root transcript branch or its flat history. */
    getWorkflowEventJournalReader(): WorkflowEventJournalReader | null {
        const manager = this.rootSessionManager;
        const readEntries = manager?.getBranch?.bind(manager) ?? manager?.getEntries?.bind(manager);
        if (!readEntries) return null;

        return {
            read: (customType) =>
                readEntries()
                    .flatMap((entry) =>
                        entry.type === "custom" && entry.customType === customType ? [entry.data] : [],
                    )
                    .filter(
                        (data): data is WorkflowEventJournalRecord =>
                            data !== null &&
                            typeof data === "object" &&
                            "version" in data &&
                            typeof data.version === "number" &&
                            "state" in data &&
                            typeof data.state === "string",
                    ),
        };
    }

    /** Append workflow reports to the root transcript when it accepts custom entries. */
    getWorkflowEventJournalWriter(): WorkflowEventJournalWriter | null {
        const manager = this.rootSessionManager;
        if (!manager?.appendCustomEntry) return null;
        return { append: manager.appendCustomEntry.bind(manager) };
    }

    /** Replace or clear the managed transcript and synchronization metadata. */
    setManagedMetadata(metadata: ManagedSessionMetadata | null) {
        this.assertActive();
        this.managed = metadata ? { ...metadata } : null;
    }

    /** Read a copy of the metadata for the current managed transcript. */
    getManagedMetadata() {
        return this.managed ? { ...this.managed } : null;
    }

    /** Replace the writer's transcript segment and restore context from its successor. */
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

    /** Overlay new Agent and model choices on the next managed turn's settings. */
    mergePendingManagedTurnIntent(intent: PendingManagedTurnIntent) {
        this.assertActive();
        this.pendingManagedTurnIntent = { ...this.pendingManagedTurnIntent, ...intent };
    }

    /** Read a copy of the settings awaiting the next managed turn. */
    getPendingManagedTurnIntent() {
        return { ...this.pendingManagedTurnIntent };
    }

    /** Take and clear the settings queued for the next managed turn. */
    consumePendingManagedTurnIntent() {
        this.assertActive();
        const intent = { ...this.pendingManagedTurnIntent };
        this.pendingManagedTurnIntent = {};
        return intent;
    }

    /** Dispose attached Agents and detach the transcript writer while retaining the session identity. */
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

    /** Replace the runtime's producer event callback or emitter. */
    setEventSink(eventSink: HostedSessionOptions["eventSink"]) {
        this.assertActive();
        this.#eventSink = eventSink;
    }

    /** Read the installed producer event callback or emitter. */
    getEventSink() {
        return this.#eventSink;
    }

    /** Observe producer events and return a function that removes the observer. */
    subscribeRuntimeEvents(observer: (event: HostedRuntimeEventObservation) => void) {
        this.assertActive();
        this.#eventObservers.add(observer);
        return () => this.#eventObservers.delete(observer);
    }

    /** Select the conversation attached to a Plan review and planning Agent. */
    getPlanReviewConversation(review: PlanReviewLookup) {
        this.assertActive();
        return this.planReviewConversations.select(review.planId, review.planningAgentName);
    }

    /** Capture a producer event for Plan review and notify in-process observers. */
    publishRuntimeEvent(event: HostedRuntimeEventObservation) {
        this.planReviewConversations.capture(event);
        for (const observer of this.#eventObservers) {
            try {
                observer(event);
            } catch {
                // Review and presentation observers must not interrupt the agent session.
            }
        }
    }

    /** Install or clear the adapter that presents interaction requests. */
    setInteractionAdapter(adapter: RuntimeInteractionAdapter | null) {
        this.assertActive();
        this.interactionAdapter = adapter;
    }

    /** Read the adapter for presenting interaction requests. */
    getInteractionAdapter() {
        return this.interactionAdapter;
    }

    /** Set the MCP server definitions for the session's current request. */
    setMcpRequestServers(servers: McpServerDefinition[]) {
        this.assertActive();
        this.mcpRequestServers = servers.map((server) => ({ ...server }));
    }

    /** Read copies of the request's MCP server definitions. */
    getMcpRequestServers() {
        return this.mcpRequestServers.map((server) => ({ ...server }));
    }

    /** Install the replacement MCP integration before closing its predecessor. */
    async setMcpIntegration(pool: McpIntegration | null) {
        this.assertActive();
        const previous = this.mcpIntegration;
        this.mcpIntegration = pool;
        if (previous && previous !== pool) await previous.close().catch(() => {});
    }

    /** Read the live MCP integration. */
    getMcpIntegration() {
        return this.mcpIntegration;
    }

    /** List the tools exposed by the root Agent's MCP integration. */
    getMcpRootTools() {
        return this.mcpIntegration?.getTools?.() || [];
    }

    /** Transfer the MCP integration and request servers to a replacement session. */
    moveMcpStateTo(targetHostedSession: HostedSession) {
        this.assertActive();
        targetHostedSession.assertActive();
        targetHostedSession.mcpIntegration = this.mcpIntegration;
        targetHostedSession.mcpRequestServers = this.getMcpRequestServers();
        this.mcpIntegration = null;
    }

    /** Detach the current MCP integration and wait for it to close. */
    async closeMcpIntegration() {
        const pool = this.mcpIntegration;
        this.mcpIntegration = null;
        if (pool) await pool.close();
    }

    /** Register a pending interaction by its request ID. */
    addActiveInteraction(id: string, record: ActiveInteractionRecord) {
        this.assertActive();
        this.activeInteractions.set(id, record);
    }

    /** Remove a settled interaction from the active registry. */
    removeActiveInteraction(id: string) {
        this.activeInteractions.delete(id);
    }

    /** Read a snapshot of the pending interaction registry. */
    getActiveInteractions() {
        return new Map(this.activeInteractions);
    }

    /** Set the review URL displayed across related interactions. */
    setLiveCodeReviewUrl(url: string) {
        this.liveCodeReviewUrl = url;
    }

    /** Read the current review URL, or an empty string. */
    getLiveCodeReviewUrl() {
        return this.liveCodeReviewUrl;
    }

    /** Abort pending requests, clear review state, and report whether requests were pending. */
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

    /** Bind the root Agent to this session and require the active writer for managed roots. */
    setRootAgentSession(session: DisposableLike | null, capability: ManagedOperationCapability | null = null) {
        this.assertActive();
        if (session) this.#assertManagedWritableCapability(capability);
        this.rootAgentSession = session;
    }

    /** Read the root Agent session, when attached. */
    getRootAgentSession() {
        return this.rootAgentSession;
    }

    /** Record the configured name of the root Agent. */
    setRootAgentName(agentName: string | null, capability: ManagedOperationCapability | null = null) {
        this.assertActive();
        if (agentName) this.#assertManagedWritableCapability(capability);
        this.rootAgentName = agentName;
    }

    /** Read the configured name of the root Agent. */
    getRootAgentName() {
        return this.rootAgentName;
    }

    /** Suppress the next Agent-stopped attention notification. */
    suppressNextAgentStoppedAttention() {
        this.suppressAgentStoppedAttention = true;
    }

    /** Take and clear the one-shot Agent-stopped suppression flag. */
    consumeSuppressedAgentStoppedAttention() {
        if (!this.suppressAgentStoppedAttention) return false;
        this.suppressAgentStoppedAttention = false;
        return true;
    }

    /** Keep the latest task report with the steering target that supplied it. */
    recordPendingTaskCompletion(agentName: string, report: string, timestampMs: number = Date.now()) {
        this.assertActive();
        this.pendingTaskCompletion = {
            agentName,
            report,
            timestampMs,
            owningSession: this.getActiveSteeringTargetSession(),
        };
    }

    /** Take the pending task report only when its owner matches the consumer. */
    consumePendingTaskCompletion(owningSession: DisposableLike | null) {
        if (!this.pendingTaskCompletion) return null;
        if (this.pendingTaskCompletion.owningSession !== owningSession) return null;
        const completion = this.pendingTaskCompletion;
        this.pendingTaskCompletion = null;
        return completion;
    }

    /** Read a copy of the pending report for restoring a suspended workflow. */
    getPendingTaskCompletionForRestore() {
        return this.pendingTaskCompletion ? { ...this.pendingTaskCompletion } : null;
    }

    /** Restore the active workflow and its pending completion report from saved state. */
    restoreActiveExecutionWorkflow(
        workflow: ActiveExecutionWorkflow | null,
        pendingTaskCompletion: PendingTaskCompletion | null,
    ) {
        this.assertActive();
        this.activeExecutionWorkflow = workflow;
        this.pendingTaskCompletion = pendingTaskCompletion ? { ...pendingTaskCompletion } : null;
    }

    /** Register a delegated Agent so the host owns its lifetime. */
    addSubAgentSession(session: DisposableLike, capability: ManagedOperationCapability | null = null) {
        this.assertActive();
        this.#assertManagedWritableCapability(capability);
        this.subAgentSessions.add(session);
    }

    /** Release a delegated Agent's registration after it finishes. */
    removeSubAgentSession(session: DisposableLike) {
        this.assertActive();
        this.subAgentSessions.delete(session);
    }

    /** Read a snapshot of the registered delegated Agents. */
    getSubAgentSessions() {
        return new Set(this.subAgentSessions);
    }

    /** Make an Agent the latest steering target and return its removal token. */
    pushSteeringTargetSession(session: DisposableLike) {
        this.assertActive();
        const steeringTargetId = `steering-target-${++this.steeringTargetSequence}`;
        this.steeringTargetStack.push({ steeringTargetId, session });
        return steeringTargetId;
    }

    /** Remove a steering target by token, or remove the latest target without a token. */
    popSteeringTargetSession(steeringTargetId: string) {
        this.assertActive();
        if (!steeringTargetId) {
            this.steeringTargetStack.pop();
            return;
        }
        const index = this.steeringTargetStack.findIndex((entry) => entry.steeringTargetId === steeringTargetId);
        if (index >= 0) this.steeringTargetStack.splice(index, 1);
    }

    /** Read the Agent that currently receives steering input. */
    getActiveSteeringTargetSession() {
        if (this.steeringTargetStack.length === 0) return null;
        return this.steeringTargetStack[this.steeringTargetStack.length - 1].session;
    }

    /** Start an exclusive Agent change and return the token needed to finish it. */
    beginAgentTransition(): string {
        this.assertActive();
        if (this.agentTransitionId) throw new Error("An Agent transition is already active");
        this.agentTransitionId = `agent-transition-${crypto.randomUUID()}`;
        return this.agentTransitionId;
    }

    /** Check whether an Agent change is in progress. */
    isAgentTransitioning(): boolean {
        return Boolean(this.agentTransitionId);
    }

    /** Read the token for the in-progress Agent change. */
    getAgentTransitionId(): string | null {
        return this.agentTransitionId;
    }

    /** Buffer steering during an Agent change, ordered by submission when available. */
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

    /** Clear the in-progress Agent change when the token matches. */
    completeAgentTransition(transitionId: string) {
        this.assertActive();
        if (this.agentTransitionId === transitionId) this.agentTransitionId = null;
    }

    /** Track steering input whose preparation has started. */
    beginAgentSteeringPreparation(messageId: string) {
        this.assertActive();
        this.agentSteeringPreparations.add(messageId);
    }

    /** Mark one steering input prepared and wake waiters after all work settles. */
    completeAgentSteeringPreparation(messageId: string) {
        if (!this.agentSteeringPreparations.delete(messageId) || this.agentSteeringPreparations.size > 0) return;
        for (const resolve of this.agentSteeringPreparationWaiters) resolve();
        this.agentSteeringPreparationWaiters.clear();
    }

    /** Check whether any steering input is being prepared. */
    hasAgentSteeringPreparations(): boolean {
        return this.agentSteeringPreparations.size > 0;
    }

    /** Wait for outstanding steering preparation to settle. */
    async waitForAgentSteeringPreparations(): Promise<void> {
        if (!this.hasAgentSteeringPreparations()) return;
        await new Promise((resolve) => this.agentSteeringPreparationWaiters.add(() => resolve(undefined)));
    }

    /** Read copies of the steering inputs buffered during the Agent change. */
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

    /** Drain the buffered steering inputs in queue order. */
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

    /** Remove a buffered steering input by its message ID. */
    removeAgentTransitionSteering(messageId: string) {
        const index = this.agentTransitionSteering.findIndex((entry) => entry.message?.id === messageId);
        if (index < 0) return false;
        this.agentTransitionSteering.splice(index, 1);
        return true;
    }

    /** Empty the transition queue and return the removed inputs. */
    clearAgentTransitionSteering(): AgentTransitionSteering[] {
        return this.consumeAgentTransitionSteering();
    }

    /** Restore missing steering inputs before newer queued items without duplicating them. */
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

    /** Acquire a shared read or exclusive write delegation and return its idempotent release. */
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

    /** Read the number of delegated readers and whether a writer owns the lease. */
    getDelegatedAgentLeaseState() {
        return { readers: this.delegatedReaderCount, writer: this.delegatedWriterActive };
    }

    /** Read the thinking level selected for the active Agent. */
    getThinkingLevel() {
        return this.activeThinkingLevel;
    }

    /** Record the thinking level selected for the active Agent. */
    setThinkingLevel(level: ThinkingLevel) {
        this.assertActive();
        this.activeThinkingLevel = level;
    }

    /** Set the current project context for the Agent. */
    setProjectStateContext(context: string) {
        this.assertActive();
        this.projectStateContext = context;
    }

    /** Read the current project context for the Agent. */
    getProjectStateContext() {
        return this.projectStateContext;
    }

    /** Read a copy of the session's workflow context for display and routing. */
    getWorkflowContext() {
        return this.workflowContext ? { ...this.workflowContext } : null;
    }

    /** Read a copy of the current tutorial progress. */
    getTutorialContext() {
        return this.tutorialContext
            ? { ...this.tutorialContext, shownExplanationIds: [...this.tutorialContext.shownExplanationIds] }
            : null;
    }

    /** Apply an eligible tutorial update and record it through the active writer. */
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

    /** Replace the workflow context and persist it when requested. */
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

    /** Record the triage details that identify the current workflow. */
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

    /** Update the current Plan label without disrupting planning when persistence fails. */
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

    /** Derive and persist session context from the active Plan execution. */
    setWorkflowExecutionContext(details: WorkflowContextInput) {
        if (this.disposed) return;
        const nextContext = deriveWorkflowContextFromExecutionWorkflow(details);
        if (!nextContext) return;
        this.replaceWorkflowContext(nextContext, { persist: true });
    }

    /** Append and stage a Plan association for the current managed transcript segment. */
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

    /** Validate and record the active execution workflow in the root transcript. */
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

    /** Read the current execution workflow, if one is active. */
    getActiveExecutionWorkflow() {
        return this.activeExecutionWorkflow;
    }

    /** Allow a background completion warning once for each cycle. */
    warnBackgroundCompletion(cycle: string) {
        if (this.backgroundCompletionWarning === cycle) return false;
        this.backgroundCompletionWarning = cycle;
        return true;
    }

    /** Allow a future background completion warning for the same cycle. */
    resetBackgroundCompletionWarning() {
        this.backgroundCompletionWarning = null;
    }

    /** Suppress background output, clear queued steering, and wait for task settlement. */
    async settleBackgroundTasksForCompletion() {
        // Suppress synchronously before any result can enter a new turn.
        const settlement = this.backgroundTasks.cancelAllAndSuppress();
        try {
            await clearBackgroundSteeringForCompletion(this);
        } finally {
            await settlement;
        }
    }

    /** Update the project root after validating the replacement absolute path. */
    rebindProjectRoot(cwd: string) {
        this.assertActive();
        this.cwd = requireAbsoluteProjectRoot(cwd, "cwd");
    }

    /** Read the workflow execution checkout, falling back to the session project root. */
    getActiveExecutionCwd() {
        return this.activeExecutionWorkflow?.executionCwd || this.cwd;
    }

    /** Clear execution state and record the cleared workflow in the transcript. */
    clearActiveExecutionWorkflow() {
        this.assertActive();
        if (this.rootSessionManager) this.#assertManagedWritableCapability(this.managedOperationCapability);
        clearPairCheckpoint(this, "workflow_cleared");
        this.liveCodeReviewUrl = "";
        this.activeExecutionWorkflow = null;
        recordExecutionWorkflowSnapshot(this);
        this.pendingTaskCompletion = null;
    }

    /** Claim the active turn slot if no turn currently owns it. */
    beginTurn(turnId: string) {
        this.assertActive();
        if (this.activeTurnId) return false;
        this.activeTurnId = turnId;
        return true;
    }

    /** Release the active turn slot only when the ID matches its owner. */
    endTurn(turnId: string) {
        if (this.activeTurnId !== turnId) return false;
        this.activeTurnId = null;
        return true;
    }

    /** Read the active turn ID, if the slot is occupied. */
    getActiveTurnId() {
        return this.activeTurnId;
    }

    /** Check whether a turn currently owns the session. */
    isTurnActive() {
        return Boolean(this.activeTurnId);
    }

    /** Cancel owned work, release session resources, and clear references. */
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
        this.#eventSink = null;
        this.#eventObservers.clear();
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
